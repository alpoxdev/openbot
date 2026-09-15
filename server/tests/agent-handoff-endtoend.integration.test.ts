import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { AbstractAgent } from "@ag-ui/client";
import type { BaseEvent, Message, RunAgentInput } from "@ag-ui/client";
import { Observable } from "rxjs";
import { createHandoffDesk, HANDOFF_KIND } from "../src/agents/handoff";
import { createHandoffDelivery } from "../src/agents/handoff-delivery";
import { createHandoffRunner } from "../src/agents/handoff-runner";
import { handoffTool } from "../src/agents/handoff-tool";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createAuditStore } from "../src/audit";
import { createConversationEngine } from "../src/conversations/engine";
import { createConversationStore } from "../src/conversations/store";
import { createDatabase } from "../src/db/client";
import {
  agents,
  agentProfiles,
  auditEvents,
  conversationEvents,
  conversationRuns,
  conversationThreads,
  pluginGrants,
  userRoles,
  users,
  workItems,
} from "../src/db/schema";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * This suite is intentionally a real queue → delivery → engine path. A fake engine can prove that
 * delivery calls the right methods, but only PostgreSQL can prove that the model context and durable
 * transcript are kept separate without duplicating the asking thread.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createConversationStore(database);
const queue = createWorkQueue(database);
const profiles = createAgentProfileStore(database);
const auditStore = createAuditStore(database);
const prefix = `handoff-e2e-${randomUUID().slice(0, 8)}`;
let fixture: Fixture | undefined;

type Fixture = {
  actorId: string;
  askerId: string;
  targetId: string;
  askingThreadId: string;
  targetThreadId: string;
  askingRunId: string;
  prior: Message[];
};

const actor = (id: string) => ({ id, role: "user" as const });

/**
 * A small but valid AG-UI implementation. The engine invokes `runAgent`, which applies these events
 * and persists the resulting assistant message. Capturing the prepared input also makes accidental
 * omission or duplication of the saved asking history observable.
 */
class DeterministicAgent extends AbstractAgent {
  readonly inputs: RunAgentInput[] = [];
  aborts = 0;
  onStarted?: () => void;

  constructor(
    agentId: string,
    private readonly response: string,
    private readonly hang = false,
  ) {
    super({ agentId, threadId: "unassigned" });
  }

  run(input: RunAgentInput) {
    this.inputs.push(structuredClone(input));
    this.onStarted?.();
    if (this.hang) {
      return new Observable<BaseEvent>(() => () => {
        // The engine's abortRun must tear down this subscription.
      });
    }
    return new Observable<BaseEvent>((subscriber) => {
      const messageId = `answer-${this.agentId}-${this.inputs.length}`;
      subscriber.next({
        type: "RUN_STARTED",
        threadId: input.threadId,
        runId: input.runId,
      });
      subscriber.next({
        type: "TEXT_MESSAGE_START",
        messageId,
        role: "assistant",
      });
      subscriber.next({
        type: "TEXT_MESSAGE_CONTENT",
        messageId,
        delta: this.response,
      });
      subscriber.next({ type: "TEXT_MESSAGE_END", messageId });
      subscriber.next({
        type: "RUN_FINISHED",
        threadId: input.threadId,
        runId: input.runId,
      });
      subscriber.complete();
    });
  }

  abortRun() {
    this.aborts += 1;
    super.abortRun();
  }
}

async function seedFixture(
  prior: Message[] = [
    {
      id: "saved-user",
      role: "user",
      content: [
        { type: "text", text: "the saved invoice says Tuesday" },
        { type: "image", url: "https://example.test/invoice.png" },
      ],
    },
    {
      id: "saved-assistant",
      role: "assistant",
      content: "I will ask the specialist.",
    },
  ],
) {
  const id = (suffix: string) =>
    `${prefix}-${suffix}-${randomUUID().slice(0, 6)}`;
  const actorId = id("actor");
  const askerId = id("asker");
  const targetId = id("target");
  const askingThreadId = id("asking-thread");
  const targetThreadId = id("target-thread");
  const askingRunId = id("asking-run");
  fixture = {
    actorId,
    askerId,
    targetId,
    askingThreadId,
    targetThreadId,
    askingRunId,
    prior,
  };

  await database.insert(users).values({
    id: actorId,
    email: `${actorId}@example.test`,
  });
  await database.insert(userRoles).values({ userId: actorId, role: "user" });
  for (const [agentId, name] of [
    [askerId, "Asker"],
    [targetId, "Target"],
  ]) {
    await database.insert(agents).values({
      id: agentId,
      name,
      type: "built_in",
      configuration: {},
    });
    await database.insert(agentProfiles).values({
      agentId,
      ownerUserId: actorId,
      title: "",
      roleDescription: "",
      avatarSeed: agentId,
      visibility: "public",
    });
  }
  await database.insert(pluginGrants).values({
    kind: "bot",
    ref: targetId,
    agentId: askerId,
    grantedBy: actorId,
  });

  await store.createThread({
    id: askingThreadId,
    ownerUserId: actorId,
    agentId: askerId,
    provenance: "local",
  });
  await store.publishBaseline(actor(actorId), askingThreadId, {
    messages: prior,
    state: {},
    baselineSequence: 0n,
  });
  await database
    .update(conversationThreads)
    .set({ localReadiness: "ready" })
    .where(eq(conversationThreads.id, askingThreadId));

  return fixture;
}

async function cleanFixture() {
  if (!fixture) return;
  const current = fixture;
  await database
    .delete(workItems)
    .where(
      and(
        eq(workItems.kind, HANDOFF_KIND),
        sql`${workItems.payload}->>'runId' = ${current.askingRunId}`,
      ),
    );
  await database
    .delete(conversationThreads)
    .where(
      inArray(conversationThreads.id, [
        current.askingThreadId,
        current.targetThreadId,
      ]),
    );
  await database
    .delete(pluginGrants)
    .where(eq(pluginGrants.agentId, current.askerId));
  await database
    .delete(agentProfiles)
    .where(eq(agentProfiles.agentId, current.askerId));
  await database
    .delete(agentProfiles)
    .where(eq(agentProfiles.agentId, current.targetId));
  await database.delete(agents).where(eq(agents.id, current.askerId));
  await database.delete(agents).where(eq(agents.id, current.targetId));
  await database.delete(users).where(eq(users.id, current.actorId));
  fixture = undefined;
}

beforeEach(async () => {
  await cleanFixture();
});

afterEach(async () => {
  await cleanFixture();
});

afterAll(async () => {
  await database.$client.end({ timeout: 5 });
});

function makeDesk(current: Fixture) {
  return createHandoffDesk({
    queue,
    profiles,
    actorFor: async (id) => (id === current.actorId ? actor(id) : null),
    mayAddress: async (fromBotId, toBotId) => {
      const rows = await database
        .select({ ref: pluginGrants.ref })
        .from(pluginGrants)
        .where(
          and(
            eq(pluginGrants.kind, "bot"),
            eq(pluginGrants.agentId, fromBotId),
          ),
        );
      return rows.some((row) => row.ref === toBotId);
    },
    auditStore,
    caps: { maxDepth: 2, maxPerRun: 3 },
  });
}

function makeRunner(
  current: Fixture,
  agentsById: Map<string, DeterministicAgent>,
  options: { deadlineMs?: number; runIds?: string[] } = {},
) {
  let runNumber = 0;
  const runIds = options.runIds ?? [
    `${prefix}-delivery-1`,
    `${prefix}-delivery-2`,
  ];
  const signed: Array<{ runId: string; initiator?: unknown }> = [];
  const engine = createConversationEngine({
    store,
    leaseMs: 30_000,
    pollMs: 10,
    replicaId: `${prefix}-engine-${randomUUID().slice(0, 6)}`,
  });
  const delivery = createHandoffDelivery({
    engine,
    agentFor: async ({ botId }) => agentsById.get(botId) ?? null,
    mintThreadId: () => current.targetThreadId,
    newRunId: () =>
      runIds[runNumber++] ?? `${prefix}-delivery-extra-${runNumber}`,
    deadlineMs: options.deadlineMs,
    announce: async () => {},
  });
  const runner = createHandoffRunner({
    queue,
    owner: `${prefix}-replica-${randomUUID().slice(0, 6)}`,
    auditStore,
    sign: (work) => {
      signed.push({ runId: work.runId, initiator: work.initiator });
      return JSON.stringify({
        botId: work.toBotId,
        runId: work.runId,
        initiator: work.initiator,
      });
    },
    delivery,
    maxAttempts: 1,
  });
  return { runner, engine, signed };
}

describe("handoff delivery against PostgreSQL and the conversation engine", () => {
  test("honors the persisted Bot grant at the handoff boundary", async () => {
    const current = await seedFixture();
    await database
      .delete(pluginGrants)
      .where(eq(pluginGrants.agentId, current.askerId));
    const result = await handoffTool({
      desk: makeDesk(current),
      from: {
        botId: current.askerId,
        actorId: current.actorId,
        runId: current.askingRunId,
        threadId: current.askingThreadId,
        depth: 0,
      },
      hasSomebodyToAsk: true,
      maxDepth: 2,
      maxPerRun: 3,
    })!.execute({ bot: current.targetId, task: "must be refused" });

    expect(result).toContain("not been given");
    const queued = await database
      .select({ key: workItems.key })
      .from(workItems)
      .where(
        and(
          eq(workItems.kind, HANDOFF_KIND),
          sql`${workItems.payload}->>'runId' = ${current.askingRunId}`,
        ),
      );
    expect(queued).toEqual([]);
  });

  test("forwards full saved context, persists shown-only input, then relays without duplication", async () => {
    const current = await seedFixture();
    const targetAgent = new DeterministicAgent(
      current.targetId,
      "Tuesday morning, from the specialist.",
    );
    const askerAgent = new DeterministicAgent(
      current.askerId,
      "I will tell you what the specialist found.",
    );
    const agentsById = new Map([
      [current.targetId, targetAgent],
      [current.askerId, askerAgent],
    ]);
    const { runner, signed } = makeRunner(current, agentsById);
    const desk = makeDesk(current);
    const tool = handoffTool({
      desk,
      from: {
        botId: current.askerId,
        actorId: current.actorId,
        runId: current.askingRunId,
        threadId: current.askingThreadId,
        depth: 0,
        initiator: { kind: "routine", id: `${prefix}-routine` },
      },
      hasSomebodyToAsk: true,
      maxDepth: 2,
      maxPerRun: 3,
    });
    expect(tool).not.toBeNull();
    const handed = await tool!.execute({
      bot: current.targetId,
      task: "find the outage window",
      constraints: "yesterday only",
      expecting: "a date range",
    });
    expect(handed).toContain("Target");

    const first = await runner.sweep();
    expect(first.delivered).toEqual([current.targetId]);
    expect(signed[0]).toEqual({
      runId: current.askingRunId,
      initiator: { kind: "routine", id: `${prefix}-routine` },
    });
    const offeredAudit = await database
      .select({
        initiatorKind: auditEvents.initiatorKind,
        initiatorId: auditEvents.initiatorId,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.eventType, "agent.handoff_offered"),
          eq(auditEvents.targetId, current.targetId),
        ),
      );
    expect(offeredAudit).toContainEqual({
      initiatorKind: "routine",
      initiatorId: `${prefix}-routine`,
    });

    const forwardInput = targetAgent.inputs[0];
    expect(forwardInput?.messages.map((message) => message.id)).toEqual([
      "saved-user",
      "saved-assistant",
      `handoff-${prefix}-delivery-1`,
    ]);
    expect(JSON.stringify(forwardInput?.messages)).toContain(
      "the saved invoice says Tuesday",
    );
    expect(JSON.stringify(forwardInput?.messages)).toContain(
      "find the outage window",
    );
    const targetSnapshot = await store.readSnapshot(
      actor(current.actorId),
      current.targetThreadId,
    );
    expect(
      targetSnapshot.snapshot.messages.map((message) => message.role),
    ).toEqual(["user", "assistant"]);
    expect(targetSnapshot.snapshot.messages[0]).toMatchObject({
      role: "user",
      content:
        "Asker asked Target for this on your behalf: find the outage window",
    });
    expect(targetSnapshot.snapshot.messages[0]?.content).not.toContain(
      "Constraints:",
    );
    expect(targetSnapshot.snapshot.messages[1]).toMatchObject({
      role: "assistant",
      content: "Tuesday morning, from the specialist.",
    });

    // The first delivery leaves exactly one durable relay row. The relay is an existing asking
    // thread, so it must not register a second thread or append the model-only handoff user message.
    const second = await runner.sweep();
    expect(second.delivered).toEqual([current.askerId]);
    expect(signed[1]).toEqual({
      runId: current.askingRunId,
      initiator: { kind: "routine", id: `${prefix}-routine` },
    });
    const relayInput = askerAgent.inputs[0];
    expect(relayInput?.messages.map((message) => message.id)).toEqual([
      "saved-user",
      "saved-assistant",
      `handoff-${prefix}-delivery-2`,
    ]);
    expect(JSON.stringify(relayInput?.messages)).toContain(
      "Tuesday morning, from the specialist.",
    );
    const askingSnapshot = await store.readSnapshot(
      actor(current.actorId),
      current.askingThreadId,
    );
    expect(
      askingSnapshot.snapshot.messages.filter(
        (message) => message.id === "saved-user",
      ),
    ).toHaveLength(1);
    expect(
      askingSnapshot.snapshot.messages.filter(
        (message) => message.id === `handoff-${prefix}-delivery-2`,
      ),
    ).toHaveLength(0);
    expect(
      askingSnapshot.snapshot.messages.filter(
        (message) => message.role === "assistant",
      ),
    ).toHaveLength(2);
    expect(
      askingSnapshot.snapshot.messages.some(
        (message) =>
          message.role === "assistant" &&
          message.content === "I will tell you what the specialist found.",
      ),
    ).toBe(true);
  });

  test("a timed-out delivery stops the actual engine run and records a terminal error", async () => {
    const current = await seedFixture();
    const targetAgent = new DeterministicAgent(current.targetId, "", true);
    const started = new Promise<void>((resolve) => {
      targetAgent.onStarted = resolve;
    });
    const agentsById = new Map([[current.targetId, targetAgent]]);
    const { runner } = makeRunner(current, agentsById, {
      deadlineMs: 1_000,
      runIds: [`${prefix}-delivery-timeout`],
    });
    const desk = makeDesk(current);
    const tool = handoffTool({
      desk,
      from: {
        botId: current.askerId,
        actorId: current.actorId,
        runId: current.askingRunId,
        threadId: current.askingThreadId,
        depth: 0,
      },
      hasSomebodyToAsk: true,
      maxDepth: 2,
      maxPerRun: 3,
    });
    await tool!.execute({ bot: current.targetId, task: "hold until stopped" });

    const sweeping = runner.sweep();
    await started;
    const report = await sweeping;
    expect(report.skipped[0]?.reason).toContain("did not finish within");
    expect(targetAgent.aborts).toBeGreaterThan(0);

    // Delivery does not return until the exact run has committed its durable stopped terminal state.
    // Reading immediately here guards against a timeout callback that only fire-and-forgets stop().
    const settledAtReturn = await database
      .select({ status: conversationRuns.status })
      .from(conversationRuns)
      .where(eq(conversationRuns.id, `${prefix}-delivery-timeout`));
    expect(settledAtReturn[0]?.status).toBe("stopped");

    let status: string | undefined;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const rows = await database
        .select({ status: conversationRuns.status })
        .from(conversationRuns)
        .where(eq(conversationRuns.id, `${prefix}-delivery-timeout`));
      status = rows[0]?.status;
      if (status === "stopped" || status === "failed") break;
      await Bun.sleep(20);
    }
    expect(status).toBe("stopped");
    const events = await database
      .select({ type: conversationEvents.type })
      .from(conversationEvents)
      .where(eq(conversationEvents.runId, `${prefix}-delivery-timeout`));
    expect(events.map((event) => event.type)).toContain("RUN_ERROR");
    expect(events.map((event) => event.type)).not.toContain("RUN_FINISHED");
  });
});
