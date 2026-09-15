import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { AbstractAgent } from "@ag-ui/client";
import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import { Observable, firstValueFrom } from "rxjs";
import { eq } from "drizzle-orm";
import { createConversationEngine } from "../src/conversations/engine";
import type { ConversationObservation } from "../src/conversations/observability";
import { actorBoundRunner } from "../src/conversations/runner";
import { createConversationStore } from "../src/conversations/store";
import {
  ConversationAccessError,
  ConversationConflictError,
} from "../src/conversations/types";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelAgents,
  channelMemberships,
  channels,
  conversationEvents,
  conversationRuns,
  conversationThreads,
  revokedAccess,
  userRoles,
  users,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createConversationStore(database);

const prefix = `conv-runner-${randomUUID().slice(0, 8)}`;
const created = {
  users: [] as string[],
  agents: [] as string[],
  channels: [] as string[],
  threads: [] as string[],
  emails: [] as string[],
};

afterEach(async () => {
  for (const id of created.threads.splice(0)) {
    await database
      .delete(conversationThreads)
      .where(eq(conversationThreads.id, id));
  }
  for (const id of created.channels.splice(0)) {
    await database.delete(channels).where(eq(channels.id, id));
  }
  for (const id of created.agents.splice(0)) {
    await database.delete(agents).where(eq(agents.id, id));
  }
  for (const email of created.emails.splice(0)) {
    await database.delete(revokedAccess).where(eq(revokedAccess.email, email));
  }
  for (const id of created.users.splice(0)) {
    await database.delete(users).where(eq(users.id, id));
  }
});

afterAll(async () => {
  await database.$client.close();
});

function validTurn(
  threadId: string,
  runId: string,
  messageId: string,
  text: string,
): BaseEvent[] {
  return [
    { type: "RUN_STARTED", threadId, runId },
    { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId, delta: text },
    { type: "TEXT_MESSAGE_END", messageId },
    { type: "RUN_FINISHED", threadId, runId },
  ];
}

class ScriptedAgent extends AbstractAgent {
  lastPrepared: RunAgentInput | undefined;
  runs = 0;
  teardowns = 0;
  hold?: { release: () => void };
  releaseHold() {
    this.hold?.release();
  }
  constructor(
    agentId: string,
    private readonly script: BaseEvent[],
    private readonly holdUntilStop = false,
  ) {
    super({ agentId, threadId: "pending" });
  }
  run(input: RunAgentInput) {
    this.runs += 1;
    this.lastPrepared = input;
    return new Observable<BaseEvent>((subscriber) => {
      let stopped = false;
      const emit = async () => {
        if (this.holdUntilStop) {
          await new Promise<void>((resolve) => {
            this.hold = { release: resolve };
          });
        }
        if (stopped) return;
        for (const event of this.script) subscriber.next(event);
        subscriber.complete();
      };
      void emit();
      return () => {
        stopped = true;
        this.teardowns += 1;
        this.hold?.release();
      };
    });
  }
}

class FailingAgent extends AbstractAgent {
  constructor(
    agentId: string,
    private readonly failure: Error,
  ) {
    super({ agentId, threadId: "pending" });
  }
  run() {
    return new Observable<BaseEvent>((subscriber) => {
      subscriber.error(this.failure);
    });
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

async function seedOwnerAgent() {
  const userId = `${prefix}-user-${randomUUID()}`;
  await database.insert(users).values({
    id: userId,
    email: `${userId}@example.test`,
  });
  await database.insert(userRoles).values({ userId, role: "user" });
  created.users.push(userId);
  created.emails.push(`${userId}@example.test`);
  const agentId = `${prefix}-agent-${randomUUID()}`;
  await database.insert(agents).values({
    id: agentId,
    name: "runner",
    type: "built_in",
    configuration: {},
  });
  await database.insert(agentProfiles).values({
    agentId,
    ownerUserId: userId,
    title: "Runner fixture",
    roleDescription: "Test",
    avatarSeed: "test",
    visibility: "public",
  });
  created.agents.push(agentId);
  return { userId, agentId };
}

async function readyThread(ownerUserId: string, agentId: string) {
  const threadId = `${prefix}-thread-${randomUUID()}`;
  created.threads.push(threadId);
  await store.createThread({
    id: threadId,
    ownerUserId,
    agentId,
    provenance: "local",
  });
  await database
    .update(conversationThreads)
    .set({ localReadiness: "ready" })
    .where(eq(conversationThreads.id, threadId));
  return threadId;
}

async function readyChannelThread(
  ownerUserId: string,
  canonicalAgentId: string,
  memberAgentId: string,
) {
  const channelId = `${prefix}-channel-${randomUUID()}`;
  await database.insert(channels).values({
    id: channelId,
    name: "Runner fixture channel",
    description: "Runner fixture channel",
  });
  await database.insert(channelMemberships).values({
    channelId,
    userId: ownerUserId,
  });
  await database.insert(channelAgents).values([
    { channelId, agentId: canonicalAgentId },
    { channelId, agentId: memberAgentId },
  ]);
  created.channels.push(channelId);

  const threadId = `${prefix}-channel-thread-${randomUUID()}`;
  created.threads.push(threadId);
  await store.createThread({
    id: threadId,
    ownerUserId,
    channelId,
    agentId: canonicalAgentId,
    provenance: "local",
    localReadiness: "ready",
  });
  return { channelId, threadId };
}

async function collectUntil(
  observable: Observable<BaseEvent>,
  predicate: (events: BaseEvent[]) => boolean,
  timeoutMs = 8_000,
) {
  const events: BaseEvent[] = [];
  return await new Promise<BaseEvent[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      sub.unsubscribe();
      reject(
        new Error(
          `timed out waiting for events; saw ${events.map((event) => event.type).join(",")}`,
        ),
      );
    }, timeoutMs);
    const sub = observable.subscribe({
      next(event) {
        events.push(event);
        if (predicate(events)) {
          clearTimeout(timer);
          sub.unsubscribe();
          resolve(events);
        }
      },
      error(error) {
        clearTimeout(timer);
        reject(error);
      },
      complete() {
        clearTimeout(timer);
        resolve(events);
      },
    });
  });
}

describe("conversation engine + actorBoundRunner", () => {
  test.each([
    {
      label: "text",
      events: [
        {
          type: "TEXT_MESSAGE_START",
          messageId: "prior-user",
          role: "assistant",
        },
        {
          type: "TEXT_MESSAGE_CONTENT",
          messageId: "prior-user",
          delta: "corrupted",
        },
        { type: "TEXT_MESSAGE_END", messageId: "prior-user" },
      ],
    },
    {
      label: "activity",
      events: [
        {
          type: "ACTIVITY_SNAPSHOT",
          messageId: "prior-activity",
          activityType: "test",
          content: { overwritten: true },
        },
      ],
    },
    {
      label: "tool parent",
      events: [
        {
          type: "TOOL_CALL_START",
          toolCallId: "new-call",
          toolCallName: "test",
          parentMessageId: "prior-answer",
        },
        { type: "TOOL_CALL_ARGS", toolCallId: "new-call", delta: "{}" },
        { type: "TOOL_CALL_END", toolCallId: "new-call" },
      ],
    },
    {
      label: "tool identity",
      events: [
        {
          type: "TOOL_CALL_START",
          toolCallId: "prior-call",
          toolCallName: "test",
          parentMessageId: "new-parent",
        },
        {
          type: "TOOL_CALL_ARGS",
          toolCallId: "prior-call",
          delta: '{"corrupted":true}',
        },
        { type: "TOOL_CALL_END", toolCallId: "prior-call" },
      ],
    },
    {
      label: "completed tool result",
      events: [
        {
          type: "TOOL_CALL_RESULT",
          messageId: "replacement-result",
          toolCallId: "prior-call",
          content: "corrupted",
          role: "tool",
        },
      ],
    },
  ])(
    "refuses provider output that mutates accepted history: $label",
    async (attack) => {
      const owner = await seedOwnerAgent();
      const threadId = await readyThread(owner.userId, owner.agentId);
      const engine = createConversationEngine({ store, pollMs: 5 });
      const actor = { id: owner.userId };
      const firstId = randomUUID();
      const first = new ScriptedAgent(owner.agentId, [
        { type: "RUN_STARTED", threadId, runId: firstId },
        {
          type: "TEXT_MESSAGE_START",
          messageId: "prior-answer",
          role: "assistant",
        },
        {
          type: "TEXT_MESSAGE_CONTENT",
          messageId: "prior-answer",
          delta: "Original answer",
        },
        {
          type: "TOOL_CALL_START",
          toolCallId: "prior-call",
          toolCallName: "test",
          parentMessageId: "prior-answer",
        },
        {
          type: "TOOL_CALL_ARGS",
          toolCallId: "prior-call",
          delta: '{"original":true}',
        },
        { type: "TOOL_CALL_END", toolCallId: "prior-call" },
        {
          type: "TOOL_CALL_RESULT",
          messageId: "prior-result",
          toolCallId: "prior-call",
          content: "Original result",
          role: "tool",
        },
        { type: "TEXT_MESSAGE_END", messageId: "prior-answer" },
        {
          type: "ACTIVITY_SNAPSHOT",
          messageId: "prior-activity",
          activityType: "test",
          content: { original: true },
        },
        { type: "RUN_FINISHED", threadId, runId: firstId },
      ]);
      const common = { actor, threadId, agentId: owner.agentId };
      await collectUntil(
        engine.run({
          ...common,
          agent: first,
          input: {
            threadId,
            runId: firstId,
            messages: [
              { id: "prior-user", role: "user", content: "Original question" },
            ],
            state: {},
            tools: [],
            context: [],
            forwardedProps: {},
          },
        }),
        (events) => events.some((event) => event.type === "RUN_FINISHED"),
      );
      const before = (await store.readSnapshot(actor, threadId)).snapshot
        .messages;
      expect(before.map((message) => message.id)).toEqual([
        "prior-user",
        "prior-answer",
        "prior-result",
        "prior-activity",
      ]);
      const runId = randomUUID();
      const events = await collectUntil(
        engine.run({
          ...common,
          agent: new ScriptedAgent(owner.agentId, [
            { type: "RUN_STARTED", threadId, runId },
            ...(attack.events as BaseEvent[]),
            { type: "RUN_FINISHED", threadId, runId },
          ]),
          input: {
            threadId,
            runId,
            messages: [
              { id: "next-user", role: "user", content: "Next question" },
            ],
            state: {},
            tools: [],
            context: [],
            forwardedProps: {},
          },
        }),
        (events) =>
          events.some(
            (event) =>
              event.type === "RUN_ERROR" || event.type === "RUN_FINISHED",
          ),
      );
      expect(events.at(-1)?.type).toBe("RUN_ERROR");
      const after = (await store.readSnapshot(actor, threadId)).snapshot
        .messages;
      expect(after.slice(0, before.length)).toEqual(before);
      expect(JSON.stringify(after)).not.toContain("corrupted");
    },
  );

  test("busy notifications follow actual execution and cannot fail a persisted turn", async () => {
    const owner = await seedOwnerAgent();
    const threadId = await readyThread(owner.userId, owner.agentId);
    const runId = randomUUID();
    const notifications: boolean[] = [];
    let resolveFinished!: () => void;
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });
    const engine = createConversationEngine({
      store,
      pollMs: 5,
      onRunBusy: ({ threadId: notifiedThread, busy }) => {
        expect(notifiedThread).toBe(threadId);
        notifications.push(busy);
        if (busy) throw new Error("presence transport unavailable");
        resolveFinished();
      },
    });
    const agent = new ScriptedAgent(
      owner.agentId,
      validTurn(threadId, runId, "answer", "Durable answer"),
    );
    const request = {
      actor: { id: owner.userId },
      threadId,
      agentId: owner.agentId,
      agent,
      input: {
        threadId,
        runId,
        messages: [
          { id: "question", role: "user" as const, content: "Question" },
        ],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      },
    };
    await collectUntil(engine.run(request), (events) =>
      events.some((event) => event.type === "RUN_FINISHED"),
    );
    await finished;
    expect(notifications).toEqual([true, false]);
    expect(
      (await store.readSnapshot(request.actor, threadId)).snapshot.messages.map(
        (message) => message.content,
      ),
    ).toEqual(["Question", "Durable answer"]);
    await collectUntil(engine.run(request), (events) =>
      events.some((event) => event.type === "RUN_FINISHED"),
    );
    expect(notifications).toEqual([true, false]);
  });

  test("a pending historical tool can receive its first result without rewriting its call", async () => {
    const owner = await seedOwnerAgent();
    const threadId = await readyThread(owner.userId, owner.agentId);
    const actor = { id: owner.userId };
    const engine = createConversationEngine({ store, pollMs: 5 });
    const firstId = randomUUID();
    const input = {
      threadId,
      messages: [],
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
    };
    await collectUntil(
      engine.run({
        actor,
        threadId,
        agentId: owner.agentId,
        agent: new ScriptedAgent(owner.agentId, [
          { type: "RUN_STARTED", threadId, runId: firstId },
          {
            type: "TOOL_CALL_START",
            toolCallId: "pending-call",
            toolCallName: "test",
            parentMessageId: "pending-parent",
          },
          { type: "TOOL_CALL_ARGS", toolCallId: "pending-call", delta: "{}" },
          { type: "TOOL_CALL_END", toolCallId: "pending-call" },
          { type: "RUN_FINISHED", threadId, runId: firstId },
        ]),
        input: { ...input, runId: firstId },
      }),
      (events) => events.some((event) => event.type === "RUN_FINISHED"),
    );
    const before = (await store.readSnapshot(actor, threadId)).snapshot
      .messages;
    const runId = randomUUID();
    await collectUntil(
      engine.run({
        actor,
        threadId,
        agentId: owner.agentId,
        agent: new ScriptedAgent(owner.agentId, [
          { type: "RUN_STARTED", threadId, runId },
          {
            type: "TOOL_CALL_RESULT",
            messageId: "resumed-result",
            toolCallId: "pending-call",
            content: "Approved result",
            role: "tool",
          },
          ...validTurn(threadId, runId, "resumed-answer", "Done").slice(1),
        ]),
        input: { ...input, runId },
      }),
      (events) => events.some((event) => event.type === "RUN_FINISHED"),
    );
    const after = (await store.readSnapshot(actor, threadId)).snapshot.messages;
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.map((message) => message.id)).toEqual([
      "pending-parent",
      "resumed-result",
      "resumed-answer",
    ]);
  });

  test("first observed event is RUN_STARTED and user structured content survives", async () => {
    const owner = await seedOwnerAgent();
    const threadId = await readyThread(owner.userId, owner.agentId);
    const engine = createConversationEngine({
      store,
      leaseMs: 30_000,
      pollMs: 20,
      replicaId: `${prefix}-e1`,
    });
    const runId = `${threadId}-run`;
    const runner = actorBoundRunner(engine, {
      actor: { id: owner.userId },
      agentId: owner.agentId,
      threadId,
      allow: new Set(["run", "connect", "isRunning", "stop"]),
      stopRunId: runId,
    });
    const userMessage = {
      id: "user-structured",
      role: "user" as const,
      content: [{ type: "text" as const, text: "remember this block" }],
    };
    const agent = new ScriptedAgent(
      owner.agentId,
      validTurn(threadId, runId, "assistant-1", "noted"),
    );
    const input: RunAgentInput = {
      threadId,
      runId,
      messages: [userMessage],
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
    };
    const events = await collectUntil(
      runner.run({ threadId, agent, input }),
      (seen) => seen.some((event) => event.type === "RUN_FINISHED"),
    );
    expect(events[0]?.type).toBe("RUN_STARTED");
    expect(events.map((event) => event.type)).toContain("TEXT_MESSAGE_CONTENT");
    const snapshot = await engine.readSnapshot({ id: owner.userId }, threadId);
    const storedUser = snapshot.snapshot.messages.find(
      (message) => message.id === "user-structured",
    );
    expect(storedUser).toBeDefined();
    expect(JSON.stringify(storedUser)).toContain("remember this block");
    expect(
      snapshot.snapshot.messages.some(
        (message) => message.id === "assistant-1",
      ),
    ).toBe(true);
  });

  test("A/B isolation, duplicate runId does not execute twice", async () => {
    const a = await seedOwnerAgent();
    const b = await seedOwnerAgent();
    const threadA = await readyThread(a.userId, a.agentId);
    const threadB = await readyThread(b.userId, b.agentId);
    const engine = createConversationEngine({
      store,
      leaseMs: 30_000,
      pollMs: 20,
      replicaId: `${prefix}-e2`,
    });
    const runA = `${threadA}-run`;
    const runnerA = actorBoundRunner(engine, {
      actor: { id: a.userId },
      agentId: a.agentId,
      threadId: threadA,
      allow: new Set(["run", "connect", "isRunning", "stop"]),
      stopRunId: runA,
    });
    const runnerB = actorBoundRunner(engine, {
      actor: { id: b.userId },
      agentId: b.agentId,
      threadId: threadB,
      allow: new Set(["run", "connect", "isRunning", "stop"]),
      stopRunId: `${threadB}-run`,
    });
    const agentA = new ScriptedAgent(
      a.agentId,
      validTurn(threadA, runA, "a1", "ok"),
    );
    const inputA: RunAgentInput = {
      threadId: threadA,
      runId: runA,
      messages: [{ id: "u1", role: "user", content: "hi" }],
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
    };
    const first = await collectUntil(
      runnerA.run({ threadId: threadA, agent: agentA, input: inputA }),
      (seen) =>
        seen[0]?.type === "RUN_STARTED" &&
        seen.some((event) => event.type === "RUN_FINISHED"),
    );
    expect(first[0]?.type).toBe("RUN_STARTED");
    await expect(
      runnerB.isRunning({ threadId: threadA }),
    ).rejects.toBeInstanceOf(ConversationAccessError);

    const secondAgent = new ScriptedAgent(
      a.agentId,
      validTurn(threadA, runA, "a2", "second"),
    );
    await collectUntil(
      runnerA.run({
        threadId: threadA,
        agent: secondAgent,
        input: inputA,
      }),
      () => true,
      2_000,
    ).catch(() => undefined);
    const starts = await database
      .select()
      .from(conversationEvents)
      .where(eq(conversationEvents.threadId, threadA));
    expect(
      starts.filter((row) => row.type === "TEXT_MESSAGE_START").length,
    ).toBe(1);
    expect(
      starts.some((row) => JSON.stringify(row.payload).includes("second")),
    ).toBe(false);
  });

  test("channel member runs remain engine-authorized without changing the canonical thread agent", async () => {
    const owner = await seedOwnerAgent();
    const member = await seedOwnerAgent();
    const { threadId } = await readyChannelThread(
      owner.userId,
      owner.agentId,
      member.agentId,
    );
    const engine = createConversationEngine({
      store,
      pollMs: 5,
      replicaId: `${prefix}-channel-member`,
    });
    const runId = `${threadId}-member-run`;
    const events = await collectUntil(
      engine.run({
        actor: { id: owner.userId },
        threadId,
        agentId: member.agentId,
        agent: new ScriptedAgent(
          member.agentId,
          validTurn(threadId, runId, "member-answer", "member"),
        ),
        input: {
          threadId,
          runId,
          messages: [
            { id: "member-question", role: "user", content: "member" },
          ],
          state: {},
          tools: [],
          context: [],
          forwardedProps: {},
        },
      }),
      (seen) => seen.some((event) => event.type === "RUN_FINISHED"),
    );

    expect(events.some((event) => event.type === "RUN_FINISHED")).toBe(true);
    expect(
      (await store.readSnapshot({ id: owner.userId }, threadId)).thread.agentId,
    ).toBe(owner.agentId);
    expect(
      (
        await store.readSnapshot({ id: owner.userId }, threadId)
      ).snapshot.messages.map((message) => message.id),
    ).toEqual(["member-question", "member-answer"]);
  });

  test("a delayed Stop stays pinned to A1 and cannot stop A2 or another actor's B run", async () => {
    const a = await seedOwnerAgent();
    const b = await seedOwnerAgent();
    const threadA = await readyThread(a.userId, a.agentId);
    const threadB = await readyThread(b.userId, b.agentId);
    const engine = createConversationEngine({
      store,
      pollMs: 5,
      replicaId: `${prefix}-delayed-stop`,
    });
    const runA1 = `${threadA}-a1`;
    const runB = `${threadB}-b`;
    const agentA1 = new ScriptedAgent(
      a.agentId,
      validTurn(threadA, runA1, "a1-answer", "A1"),
      true,
    );
    const agentB = new ScriptedAgent(
      b.agentId,
      validTurn(threadB, runB, "b-answer", "B"),
      true,
    );
    const staleA1Runner = actorBoundRunner(engine, {
      actor: { id: a.userId },
      agentId: a.agentId,
      threadId: threadA,
      allow: new Set(["isRunning", "stop"]),
      stopRunId: runA1,
    });
    const start = (input: {
      actorId: string;
      threadId: string;
      agentId: string;
      runId: string;
      agent: ScriptedAgent;
      messageId: string;
    }) =>
      collectUntil(
        engine.run({
          actor: { id: input.actorId },
          threadId: input.threadId,
          agentId: input.agentId,
          agent: input.agent,
          input: {
            threadId: input.threadId,
            runId: input.runId,
            messages: [
              {
                id: input.messageId,
                role: "user" as const,
                content: input.runId,
              },
            ],
            state: {},
            tools: [],
            context: [],
            forwardedProps: {},
          },
        }),
        (seen) => seen.some((event) => event.type === "RUN_FINISHED"),
      );

    const a1 = start({
      actorId: a.userId,
      threadId: threadA,
      agentId: a.agentId,
      runId: runA1,
      agent: agentA1,
      messageId: "a1-question",
    });
    await Bun.sleep(40);
    expect(await staleA1Runner.isRunning({ threadId: threadA })).toBe(true);
    // End A1 through the real engine, leaving the runner's captured A1 scope
    // available to exercise the delayed-stop race below.
    expect(
      await engine.stop({
        actor: { id: a.userId },
        threadId: threadA,
        agentId: a.agentId,
        runId: runA1,
      }),
    ).toBe(true);
    await a1.catch(() => undefined);

    const runA2 = `${threadA}-a2`;
    const agentA2 = new ScriptedAgent(
      a.agentId,
      validTurn(threadA, runA2, "a2-answer", "A2"),
      true,
    );
    const a2 = start({
      actorId: a.userId,
      threadId: threadA,
      agentId: a.agentId,
      runId: runA2,
      agent: agentA2,
      messageId: "a2-question",
    });
    const bRun = start({
      actorId: b.userId,
      threadId: threadB,
      agentId: b.agentId,
      runId: runB,
      agent: agentB,
      messageId: "b-question",
    });
    await Bun.sleep(40);

    // This is the delayed dispatcher Stop: its actor/thread/agent/run scope was
    // captured for A1, but A2 is now the active run on A's thread.
    expect(await staleA1Runner.stop({ threadId: threadA })).toBe(false);
    expect(await staleA1Runner.isRunning({ threadId: threadA })).toBe(true);
    expect(
      await engine.isRunning({
        actor: { id: b.userId },
        threadId: threadB,
        agentId: b.agentId,
      }),
    ).toBe(true);

    agentA2.releaseHold();
    agentB.releaseHold();
    await a2.catch(() => undefined);
    await bRun.catch(() => undefined);
  });

  test("explicit Stop tears down the fixture agent and terminates the run", async () => {
    const owner = await seedOwnerAgent();
    const threadId = await readyThread(owner.userId, owner.agentId);
    const engine = createConversationEngine({
      store,
      leaseMs: 30_000,
      pollMs: 20,
      replicaId: `${prefix}-e3`,
    });
    const runId = `${threadId}-run`;
    const runner = actorBoundRunner(engine, {
      actor: { id: owner.userId },
      agentId: owner.agentId,
      threadId,
      allow: new Set(["run", "isRunning", "stop"]),
      stopRunId: runId,
    });
    const agent = new ScriptedAgent(
      owner.agentId,
      validTurn(threadId, runId, "late", "should-not-finish"),
      true,
    );
    const input: RunAgentInput = {
      threadId,
      runId,
      messages: [{ id: "u", role: "user", content: "hold" }],
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
    };
    const running = collectUntil(
      runner.run({ threadId, agent, input }),
      (seen) => seen.some((event) => event.type === "RUN_FINISHED"),
      8_000,
    );
    await Bun.sleep(80);
    expect(await runner.isRunning({ threadId })).toBe(true);
    expect(await runner.stop({ threadId })).toBe(true);
    await running.catch(() => undefined);
    expect(agent.teardowns).toBeGreaterThan(0);
    expect(await runner.isRunning({ threadId })).toBe(false);
  });

  test("abortRun cancels a start blocked before acquisition", async () => {
    const owner = await seedOwnerAgent();
    const threadId = await readyThread(owner.userId, owner.agentId);
    const runId = `${threadId}-startup`;
    const entered = deferred();
    const release = deferred();
    const gatedStore = {
      ...store,
      acquireRun: async (...args: Parameters<typeof store.acquireRun>) => {
        entered.resolve();
        await release.promise;
        return store.acquireRun(...args);
      },
    };
    const engine = createConversationEngine({
      store: gatedStore,
      leaseMs: 30_000,
      pollMs: 20,
      replicaId: `${prefix}-startup-before-acquire`,
    });
    const agent = new ScriptedAgent(
      owner.agentId,
      validTurn(threadId, runId, "late", "must not execute"),
    );
    const input: RunAgentInput = {
      threadId,
      runId,
      messages: [{ id: "question", role: "user", content: "cancel me" }],
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
    };
    let resolveComplete!: () => void;
    let rejectComplete!: (error: unknown) => void;
    const complete = new Promise<void>((resolve, reject) => {
      resolveComplete = resolve;
      rejectComplete = reject;
    });
    engine
      .run({
        actor: { id: owner.userId },
        threadId,
        agentId: owner.agentId,
        agent,
        input,
      })
      .subscribe({
        complete: resolveComplete,
        error: rejectComplete,
      });
    await entered.promise;
    engine.abortRun(threadId, runId);
    expect(
      await engine.stop({
        actor: { id: owner.userId },
        threadId,
        agentId: owner.agentId,
        runId,
      }),
    ).toBe(false);
    release.resolve();
    await complete;
    expect(agent.runs).toBe(0);
    expect(
      await engine.isRunning({
        actor: { id: owner.userId },
        threadId,
        agentId: owner.agentId,
      }),
    ).toBe(false);
  });

  test("abortRun cancels a start after acquisition but before initial publish", async () => {
    const owner = await seedOwnerAgent();
    const threadId = await readyThread(owner.userId, owner.agentId);
    const runId = `${threadId}-startup-publish`;
    const entered = deferred();
    const release = deferred();
    let firstAppend = true;
    const gatedStore = {
      ...store,
      appendEvents: async (...args: Parameters<typeof store.appendEvents>) => {
        if (firstAppend) {
          firstAppend = false;
          entered.resolve();
          await release.promise;
        }
        return store.appendEvents(...args);
      },
    };
    const engine = createConversationEngine({
      store: gatedStore,
      leaseMs: 30_000,
      pollMs: 20,
      replicaId: `${prefix}-startup-before-publish`,
    });
    const agent = new ScriptedAgent(
      owner.agentId,
      validTurn(threadId, runId, "late", "must not execute"),
    );
    const input: RunAgentInput = {
      threadId,
      runId,
      messages: [{ id: "question", role: "user", content: "cancel me" }],
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
    };
    const events: BaseEvent[] = [];
    let resolveComplete!: () => void;
    let rejectComplete!: (error: unknown) => void;
    const complete = new Promise<void>((resolve, reject) => {
      resolveComplete = resolve;
      rejectComplete = reject;
    });
    engine
      .run({
        actor: { id: owner.userId },
        threadId,
        agentId: owner.agentId,
        agent,
        input,
      })
      .subscribe({
        next: (event) => events.push(event),
        complete: resolveComplete,
        error: rejectComplete,
      });
    await entered.promise;
    engine.abortRun(threadId, runId);
    release.resolve();
    await complete;
    expect(agent.runs).toBe(0);
    expect(events.at(-1)?.type).toBe("RUN_ERROR");
    expect(
      await engine.isRunning({
        actor: { id: owner.userId },
        threadId,
        agentId: owner.agentId,
      }),
    ).toBe(false);
    const persisted = await database
      .select()
      .from(conversationEvents)
      .where(eq(conversationEvents.threadId, threadId));
    expect(
      persisted.filter(
        (event) => event.runId === runId && event.type === "RUN_ERROR",
      ).length,
    ).toBe(1);
  });

  test("cancel after acquisition survives a revoked gated snapshot with a durable terminal error", async () => {
    const owner = await seedOwnerAgent();
    const threadId = await readyThread(owner.userId, owner.agentId);
    const runId = `${threadId}-startup-revoked`;
    const enteredSnapshot = deferred();
    const releaseSnapshot = deferred();
    let snapshotReads = 0;
    const gatedStore = {
      ...store,
      readSnapshot: async (...args: Parameters<typeof store.readSnapshot>) => {
        snapshotReads += 1;
        if (snapshotReads === 2) {
          enteredSnapshot.resolve();
          await releaseSnapshot.promise;
        }
        return store.readSnapshot(...args);
      },
    };
    const engine = createConversationEngine({
      store: gatedStore,
      leaseMs: 30_000,
      pollMs: 5,
      replicaId: `${prefix}-startup-revoked`,
    });
    const settled = new Promise<void>((resolve) => {
      engine
        .run({
          actor: { id: owner.userId },
          threadId,
          agentId: owner.agentId,
          agent: new ScriptedAgent(
            owner.agentId,
            validTurn(threadId, runId, "late", "must not execute"),
          ),
          input: {
            threadId,
            runId,
            messages: [{ id: "question", role: "user", content: "cancel me" }],
            state: {},
            tools: [],
            context: [],
            forwardedProps: {},
          },
        })
        .subscribe({ complete: resolve, error: () => resolve() });
    });
    await enteredSnapshot.promise;
    engine.abortRun(threadId, runId);
    await database.insert(revokedAccess).values({
      email: `${owner.userId}@example.test`,
      revokedBy: owner.userId,
    });
    releaseSnapshot.resolve();
    await settled;

    const [run] = await database
      .select()
      .from(conversationRuns)
      .where(eq(conversationRuns.id, runId));
    expect(run.status).toBe("failed");
    expect(run.leaseOwner).toBeNull();
    expect(run.leaseUntil).toBeNull();
    const persisted = await database
      .select()
      .from(conversationEvents)
      .where(eq(conversationEvents.threadId, threadId));
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      runId,
      type: "RUN_ERROR",
      payload: {
        type: "RUN_ERROR",
        threadId,
        runId,
        message: "Conversation run failed",
        code: "conversation_run_failed",
      },
    });
  });

  test("canceling one pending run does not cancel a later run on the same thread", async () => {
    const owner = await seedOwnerAgent();
    const threadId = await readyThread(owner.userId, owner.agentId);
    const runA = `${threadId}-startup-a`;
    const runB = `${threadId}-startup-b`;
    const enteredA = deferred();
    const releaseA = deferred();
    const gatedStore = {
      ...store,
      acquireRun: async (...args: Parameters<typeof store.acquireRun>) => {
        if (args[1].runId === runA) {
          enteredA.resolve();
          await releaseA.promise;
        }
        return store.acquireRun(...args);
      },
    };
    const engine = createConversationEngine({
      store: gatedStore,
      leaseMs: 30_000,
      pollMs: 20,
      replicaId: `${prefix}-startup-isolation`,
    });
    const input = (runId: string): RunAgentInput => ({
      threadId,
      runId,
      messages: [{ id: `question-${runId}`, role: "user", content: runId }],
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
    });
    const agentA = new ScriptedAgent(
      owner.agentId,
      validTurn(threadId, runA, "answer-a", "must not execute"),
    );
    const failedA = new Promise<void>((resolve) => {
      engine
        .run({
          actor: { id: owner.userId },
          threadId,
          agentId: owner.agentId,
          agent: agentA,
          input: input(runA),
        })
        .subscribe({
          complete: resolve,
          error: () => resolve(),
        });
    });
    await enteredA.promise;
    engine.abortRun(threadId, runA);
    const agentB = new ScriptedAgent(
      owner.agentId,
      validTurn(threadId, runB, "answer-b", "executes"),
    );
    await collectUntil(
      engine.run({
        actor: { id: owner.userId },
        threadId,
        agentId: owner.agentId,
        agent: agentB,
        input: input(runB),
      }),
      (events) => events.some((event) => event.type === "RUN_FINISHED"),
    );
    expect(agentB.runs).toBe(1);
    releaseA.resolve();
    await failedA;
    expect(agentA.runs).toBe(0);
    expect(
      await engine.isRunning({
        actor: { id: owner.userId },
        threadId,
        agentId: owner.agentId,
      }),
    ).toBe(false);
  });

  test("disconnect does not cancel the accepted run; a new engine.connect restores messages", async () => {
    const owner = await seedOwnerAgent();
    const threadId = await readyThread(owner.userId, owner.agentId);
    const engine = createConversationEngine({
      store,
      leaseMs: 30_000,
      pollMs: 20,
      replicaId: `${prefix}-e4`,
    });
    const runId = `${threadId}-run`;
    const runner = actorBoundRunner(engine, {
      actor: { id: owner.userId },
      agentId: owner.agentId,
      threadId,
      allow: new Set(["run", "connect", "isRunning"]),
      stopRunId: runId,
    });
    const agent = new ScriptedAgent(
      owner.agentId,
      validTurn(threadId, runId, "restored", "still here"),
      true,
    );
    const input: RunAgentInput = {
      threadId,
      runId,
      messages: [{ id: "keep", role: "user", content: "stay running" }],
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
    };
    const live = runner.run({ threadId, agent, input }).subscribe();
    await Bun.sleep(80);
    expect(await runner.isRunning({ threadId })).toBe(true);
    live.unsubscribe();
    expect(await runner.isRunning({ threadId })).toBe(true);
    agent.releaseHold();
    await Bun.sleep(400);
    const reconnect = engine.connect({
      actor: { id: owner.userId },
      threadId,
      agentId: owner.agentId,
      afterSequence: 0n,
    });
    const replayed = await collectUntil(reconnect, (seen) =>
      seen.some((event) => event.type === "RUN_FINISHED"),
    );
    expect(replayed[0]?.type).toBe("RUN_STARTED");
    const snapshot = await engine.readSnapshot({ id: owner.userId }, threadId);
    expect(
      snapshot.snapshot.messages.some((message) => message.id === "keep"),
    ).toBe(true);
    expect(
      snapshot.snapshot.messages.some((message) => message.id === "restored"),
    ).toBe(true);
  });

  test("a fresh engine reconnect reports a durably reaped partial run as interrupted", async () => {
    const owner = await seedOwnerAgent();
    const threadId = await readyThread(owner.userId, owner.agentId);
    const runId = `${threadId}-expired`;
    const acquired = await store.acquireRun(
      { id: owner.userId },
      { threadId, runId, leaseOwner: "expired-replica", leaseMs: 30_000 },
    );
    if (acquired.outcome !== "acquired") throw new Error("expected acquire");
    await store.appendEvents({
      threadId,
      runId,
      leaseOwner: "expired-replica",
      generation: acquired.run.generation,
      events: [
        { type: "TEXT_MESSAGE_START", messageId: "partial", role: "assistant" },
        {
          type: "TEXT_MESSAGE_CONTENT",
          messageId: "partial",
          delta: "partial",
        },
      ],
    });
    await database
      .update(conversationRuns)
      .set({ leaseUntil: new Date(Date.now() - 1_000) })
      .where(eq(conversationRuns.id, runId));

    const fresh = createConversationEngine({ store, pollMs: 5 });
    const events = await collectUntil(
      fresh.connect({
        actor: { id: owner.userId },
        threadId,
        agentId: owner.agentId,
        afterSequence: 0n,
      }),
      (seen) => seen.some((event) => event.type === "RUN_ERROR"),
    );
    expect(events.at(-1)?.type).toBe("RUN_ERROR");
    expect(events.at(-1)).toMatchObject({
      threadId,
      runId,
      code: "conversation_interrupted",
    });
    expect(events.some((event) => event.type === "RUN_FINISHED")).toBe(false);
    const snapshot = events.find(
      (event) => event.type === "MESSAGES_SNAPSHOT",
    ) as (BaseEvent & { messages: { id: string }[] }) | undefined;
    expect(snapshot?.messages.some((message) => message.id === "partial")).toBe(
      true,
    );
  });

  test("fresh reconnect replays persisted failed and stopped terminal errors", async () => {
    const owner = await seedOwnerAgent();
    for (const status of ["failed", "stopped"] as const) {
      const threadId = await readyThread(owner.userId, owner.agentId);
      const runId = `${threadId}-${status}`;
      const acquired = await store.acquireRun(
        { id: owner.userId },
        { threadId, runId, leaseOwner: `${status}-replica`, leaseMs: 30_000 },
      );
      if (acquired.outcome !== "acquired") throw new Error("expected acquire");
      const message = `persisted-${status}`;
      await store.finishRun({
        runId,
        leaseOwner: `${status}-replica`,
        generation: acquired.run.generation,
        status,
        events: [
          {
            type: "RUN_ERROR",
            threadId,
            runId,
            message,
            code: `conversation_${status}`,
          } as BaseEvent,
        ],
      });
      const fresh = createConversationEngine({ store, pollMs: 5 });
      const replayed = await collectUntil(
        fresh.connect({
          actor: { id: owner.userId },
          threadId,
          agentId: owner.agentId,
          afterSequence: 0n,
        }),
        (seen) => seen.some((event) => event.type === "RUN_ERROR"),
      );
      expect(replayed.at(-1)).toMatchObject({
        type: "RUN_ERROR",
        threadId,
        runId,
        message,
        code: `conversation_${status}`,
      });
      expect(replayed.some((event) => event.type === "RUN_FINISHED")).toBe(
        false,
      );
    }
  });

  test("revocation durably fails an active run and releases its lease", async () => {
    const owner = await seedOwnerAgent();
    const threadId = await readyThread(owner.userId, owner.agentId);
    const runId = `${threadId}-revoked`;
    const engine = createConversationEngine({
      store,
      leaseMs: 30_000,
      pollMs: 5,
      replicaId: `${prefix}-revocation`,
    });
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const request = {
      actor: { id: owner.userId },
      threadId,
      agentId: owner.agentId,
      agent: new ScriptedAgent(
        owner.agentId,
        validTurn(threadId, runId, "late", "must not finish"),
        true,
      ),
      input: {
        threadId,
        runId,
        messages: [{ id: "question", role: "user", content: "revoke me" }],
        state: {},
        tools: [],
        context: [],
        forwardedProps: {},
      },
    };
    const live = engine.run(request).subscribe({
      next(event) {
        if (event.type === "RUN_STARTED") resolveStarted();
      },
      // Revocation may invalidate the history tail before the durable finish is observed.
      error: () => undefined,
    });
    await started;
    await database.insert(revokedAccess).values({
      email: `${owner.userId}@example.test`,
      revokedBy: owner.userId,
    });
    let run: typeof conversationRuns.$inferSelect | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      [run] = await database
        .select()
        .from(conversationRuns)
        .where(eq(conversationRuns.id, runId));
      if (run?.status === "failed" && !run.leaseOwner && !run.leaseUntil) break;
      await Bun.sleep(10);
    }
    live.unsubscribe();
    expect(run?.status).toBe("failed");
    expect(run?.leaseOwner).toBeNull();
    expect(run?.leaseUntil).toBeNull();
    const persisted = await database
      .select()
      .from(conversationEvents)
      .where(eq(conversationEvents.threadId, threadId));
    expect(
      persisted.some(
        (event) =>
          event.runId === runId &&
          event.type === "RUN_ERROR" &&
          event.payload.code === "conversation_run_failed",
      ),
    ).toBe(true);
  });

  test("rejects an orphan tool result embedded in a messages snapshot", async () => {
    const owner = await seedOwnerAgent();
    const threadId = await readyThread(owner.userId, owner.agentId);
    const runId = `${threadId}-snapshot-orphan`;
    const engine = createConversationEngine({ store, pollMs: 5 });
    const events = await collectUntil(
      engine.run({
        actor: { id: owner.userId },
        threadId,
        agentId: owner.agentId,
        agent: new ScriptedAgent(owner.agentId, [
          { type: "RUN_STARTED", threadId, runId },
          {
            type: "MESSAGES_SNAPSHOT",
            messages: [
              {
                id: "orphan-result",
                role: "tool",
                toolCallId: "never-issued",
                content: "spoofed",
              },
            ],
          } as BaseEvent,
          { type: "RUN_FINISHED", threadId, runId },
        ]),
        input: {
          threadId,
          runId,
          messages: [{ id: "question", role: "user", content: "snapshot" }],
          state: {},
          tools: [],
          context: [],
          forwardedProps: {},
        },
      }),
      (seen) => seen.some((event) => event.type === "RUN_ERROR"),
    );
    expect(events.at(-1)?.type).toBe("RUN_ERROR");
    const persisted = await database
      .select()
      .from(conversationEvents)
      .where(eq(conversationEvents.threadId, threadId));
    expect(
      persisted.some((event) =>
        JSON.stringify(event.payload).includes("orphan-result"),
      ),
    ).toBe(false);
  });

  test("rejects provider terminal events with foreign execution identifiers", async () => {
    const owner = await seedOwnerAgent();
    const threadId = await readyThread(owner.userId, owner.agentId);
    const runId = `${threadId}-foreign-terminal`;
    const engine = createConversationEngine({ store, pollMs: 5 });
    const events = await collectUntil(
      engine.run({
        actor: { id: owner.userId },
        threadId,
        agentId: owner.agentId,
        agent: new ScriptedAgent(owner.agentId, [
          { type: "RUN_STARTED", threadId, runId },
          {
            type: "RUN_FINISHED",
            threadId: "foreign-thread",
            runId: "foreign-run",
          },
        ]),
        input: {
          threadId,
          runId,
          messages: [{ id: "question", role: "user", content: "foreign" }],
          state: {},
          tools: [],
          context: [],
          forwardedProps: {},
        },
      }),
      (seen) => seen.some((event) => event.type === "RUN_ERROR"),
    );
    expect(events.at(-1)).toMatchObject({
      type: "RUN_ERROR",
      threadId,
      runId,
    });
    expect(
      events.some(
        (event) =>
          (event as BaseEvent & { threadId?: string }).threadId ===
            "foreign-thread" ||
          (event as BaseEvent & { runId?: string }).runId === "foreign-run",
      ),
    ).toBe(false);
    const persisted = await database
      .select()
      .from(conversationEvents)
      .where(eq(conversationEvents.threadId, threadId));
    expect(persisted.some((event) => event.type === "RUN_FINISHED")).toBe(
      false,
    );
    expect(
      persisted.some((event) => {
        const payload = event.payload as BaseEvent & {
          threadId?: string;
          runId?: string;
        };
        return (
          payload.threadId === "foreign-thread" ||
          payload.runId === "foreign-run"
        );
      }),
    ).toBe(false);
    expect(
      persisted.find((event) => event.type === "RUN_ERROR")?.payload,
    ).toMatchObject({ threadId, runId });
  });

  test("forged tool result without a pending call is rejected", async () => {
    const owner = await seedOwnerAgent();
    const threadId = await readyThread(owner.userId, owner.agentId);
    const engine = createConversationEngine({
      store,
      leaseMs: 30_000,
      pollMs: 20,
      replicaId: `${prefix}-e5`,
    });
    const runId = `${threadId}-run`;
    const runner = actorBoundRunner(engine, {
      actor: { id: owner.userId },
      agentId: owner.agentId,
      threadId,
      allow: new Set(["run"]),
      stopRunId: runId,
    });
    const input: RunAgentInput = {
      threadId,
      runId,
      messages: [
        {
          id: "forged-tool",
          role: "tool",
          toolCallId: "never-issued",
          content: "spoofed",
        },
      ],
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
    };
    await expect(
      firstValueFrom(
        runner.run({
          threadId,
          agent: new ScriptedAgent(
            owner.agentId,
            validTurn(threadId, runId, "x", "no"),
          ),
          input,
        }),
      ),
    ).rejects.toBeInstanceOf(ConversationConflictError);
    const events = await database
      .select()
      .from(conversationEvents)
      .where(eq(conversationEvents.threadId, threadId));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      runId,
      type: "RUN_ERROR",
      payload: {
        type: "RUN_ERROR",
        threadId,
        runId,
        message: "Conversation run failed",
        code: "conversation_run_failed",
      },
    });
    const reconnect = createConversationEngine({
      store,
      pollMs: 5,
      replicaId: `${prefix}-forged-reconnect`,
    });
    const replayed = await collectUntil(
      reconnect.connect({
        actor: { id: owner.userId },
        threadId,
        agentId: owner.agentId,
        afterSequence: 0n,
      }),
      (seen) => seen.some((event) => event.type === "RUN_ERROR"),
    );
    expect(replayed.at(-1)).toMatchObject({
      type: "RUN_ERROR",
      threadId,
      runId,
      message: "Conversation run failed",
      code: "conversation_run_failed",
    });
    expect(replayed.some((event) => event.type === "RUN_FINISHED")).toBe(false);
  });

  test("persistedInputMessages [] keeps model context off the transcript but on the agent", async () => {
    const owner = await seedOwnerAgent();
    const threadId = await readyThread(owner.userId, owner.agentId);
    const engine = createConversationEngine({
      store,
      leaseMs: 30_000,
      pollMs: 20,
      replicaId: `${prefix}-e6`,
    });
    const runId = `${threadId}-run`;
    const runner = actorBoundRunner(engine, {
      actor: { id: owner.userId },
      agentId: owner.agentId,
      threadId,
      allow: new Set(["run"]),
      stopRunId: runId,
    });
    const agent = new ScriptedAgent(
      owner.agentId,
      validTurn(threadId, runId, "priv", "done"),
    );
    const input: RunAgentInput = {
      threadId,
      runId,
      messages: [{ id: "hidden", role: "user", content: "model-only-secret" }],
      state: {},
      tools: [],
      context: [{ description: "secret-context", value: "do-not-store" }],
      forwardedProps: { assertion: "private" },
    };
    const events = await collectUntil(
      runner.run({
        threadId,
        agent,
        input,
        persistedInputMessages: [],
      }),
      (seen) => seen.some((event) => event.type === "RUN_FINISHED"),
    );
    expect(events[0]?.type).toBe("RUN_STARTED");
    expect(JSON.stringify(agent.lastPrepared?.context)).toContain(
      "do-not-store",
    );
    const stored = await database
      .select()
      .from(conversationEvents)
      .where(eq(conversationEvents.threadId, threadId));
    const blob = JSON.stringify(stored.map((record) => record.payload));
    expect(blob).not.toContain("model-only-secret");
    expect(blob).not.toContain("do-not-store");
    expect(blob).not.toContain("private");
  });

  test("emits redacted runtime observations for durable commit, replay, and active runs", async () => {
    const owner = await seedOwnerAgent();
    const threadId = await readyThread(owner.userId, owner.agentId);
    const runId = randomUUID();
    const observations: ConversationObservation[] = [];
    const engine = createConversationEngine({
      store,
      pollMs: 5,
      observe: (observation) => {
        observations.push(observation);
      },
    });
    const actor = { id: owner.userId };
    await collectUntil(
      engine.run({
        actor,
        threadId,
        agentId: owner.agentId,
        agent: new ScriptedAgent(
          owner.agentId,
          validTurn(threadId, runId, "answer", "Durable answer"),
        ),
        input: {
          threadId,
          runId,
          messages: [
            {
              id: "question",
              role: "user",
              content: "Question",
            },
          ],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        },
      }),
      (events) => events.some((event) => event.type === "RUN_FINISHED"),
    );
    await collectUntil(
      engine.connect({ actor, threadId, agentId: owner.agentId }),
      (events) => events.some((event) => event.type === "RUN_FINISHED"),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(
      observations.some(
        (observation) =>
          observation.operation === "append" &&
          observation.outcome === "completed" &&
          typeof observation.latencyMs === "number",
      ),
    ).toBe(true);
    expect(
      observations.some(
        (observation) =>
          observation.operation === "finish" &&
          observation.outcome === "completed",
      ),
    ).toBe(true);
    expect(
      observations.some(
        (observation) =>
          observation.operation === "run" &&
          observation.outcome === "completed",
      ),
    ).toBe(true);
    expect(
      observations.some(
        (observation) =>
          observation.operation === "activeRuns" &&
          observation.outcome === "started" &&
          observation.count === 1,
      ),
    ).toBe(true);
    expect(
      observations.some(
        (observation) =>
          observation.operation === "activeRuns" &&
          observation.outcome === "completed" &&
          observation.count === 0,
      ),
    ).toBe(true);
    expect(
      observations.some(
        (observation) =>
          observation.operation === "connect" &&
          observation.outcome === "completed" &&
          typeof observation.lag === "number",
      ),
    ).toBe(true);

    const failedRunId = randomUUID();
    await collectUntil(
      engine.run({
        actor,
        threadId,
        agentId: owner.agentId,
        agent: new ScriptedAgent(owner.agentId, [
          { type: "RUN_STARTED", threadId, runId: failedRunId },
          {
            type: "TEXT_MESSAGE_START",
            messageId: "question",
            role: "assistant",
          },
          {
            type: "TEXT_MESSAGE_CONTENT",
            messageId: "question",
            delta: "provider-secret",
          },
          { type: "TEXT_MESSAGE_END", messageId: "question" },
          { type: "RUN_FINISHED", threadId, runId: failedRunId },
        ]),
        input: {
          threadId,
          runId: failedRunId,
          messages: [
            {
              id: "question-two",
              role: "user",
              content: "Second question",
            },
          ],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        },
      }),
      (events) => events.some((event) => event.type === "RUN_ERROR"),
    );
    expect(
      observations.some(
        (observation) =>
          observation.operation === "run" &&
          observation.outcome === "failed" &&
          observation.error === "conflict",
      ),
    ).toBe(true);
    expect(JSON.stringify(observations)).not.toContain("provider-secret");
  });

  test("labels stop request and terminal settlement without exposing provider text", async () => {
    const owner = await seedOwnerAgent();
    const threadId = await readyThread(owner.userId, owner.agentId);
    const runId = randomUUID();
    const observations: ConversationObservation[] = [];
    const engine = createConversationEngine({
      store,
      pollMs: 5,
      observe: (observation) => {
        observations.push(observation);
      },
    });
    const actor = { id: owner.userId };
    const eventsPromise = collectUntil(
      engine.run({
        actor,
        threadId,
        agentId: owner.agentId,
        agent: new ScriptedAgent(
          owner.agentId,
          validTurn(threadId, runId, "answer", "provider-secret"),
          true,
        ),
        input: {
          threadId,
          runId,
          messages: [
            {
              id: "question",
              role: "user",
              content: "https://private.example/secret",
            },
          ],
          tools: [],
          context: [],
          state: {},
          forwardedProps: { assertion: "private" },
        },
      }),
      (events) => events.some((event) => event.type === "RUN_ERROR"),
    );
    let running = false;
    for (let attempt = 0; attempt < 1_600; attempt += 1) {
      if (await engine.isRunning({ actor, threadId, agentId: owner.agentId }))
        running = true;
      if (running) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(running).toBe(true);
    expect(
      await engine.stop({
        actor,
        threadId,
        agentId: owner.agentId,
        runId,
      }),
    ).toBe(true);
    await eventsPromise;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(
      observations.some(
        (observation) =>
          observation.operation === "stop" &&
          observation.outcome === "requested",
      ),
    ).toBe(true);
    expect(
      observations.some(
        (observation) =>
          observation.operation === "stop" && observation.outcome === "settled",
      ),
    ).toBe(true);
    expect(
      observations.some(
        (observation) =>
          observation.operation === "run" &&
          observation.outcome === "cancelled",
      ),
    ).toBe(true);
    const serialized = JSON.stringify(observations);
    expect(serialized).not.toContain("provider-secret");
    expect(serialized).not.toContain("private.example");
    expect(serialized).not.toContain("assertion");
  });

  test("classifies generic producer failures as unknown rather than persistence", async () => {
    const owner = await seedOwnerAgent();
    const threadId = await readyThread(owner.userId, owner.agentId);
    const runId = randomUUID();
    const observations: ConversationObservation[] = [];
    const engine = createConversationEngine({
      store,
      pollMs: 5,
      observe: (observation) => observations.push(observation),
    });
    const originalConsoleError = console.error;
    const consoleErrors: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args);
    };
    let replayed: BaseEvent[] = [];
    try {
      await collectUntil(
        engine.run({
          actor: { id: owner.userId },
          threadId,
          agentId: owner.agentId,
          agent: new FailingAgent(
            owner.agentId,
            new Error("model provider failure must not become telemetry text"),
          ),
          input: {
            threadId,
            runId,
            messages: [{ id: "question", role: "user", content: "Question" }],
            tools: [],
            context: [],
            state: {},
            forwardedProps: {},
          },
        }),
        (events) => events.some((event) => event.type === "RUN_ERROR"),
      );
      replayed = await collectUntil(
        engine.connect({
          actor: { id: owner.userId },
          threadId,
          agentId: owner.agentId,
        }),
        (events) => events.some((event) => event.type === "RUN_ERROR"),
      );
    } finally {
      console.error = originalConsoleError;
    }
    const failed = observations.find(
      (observation) =>
        observation.operation === "run" && observation.outcome === "failed",
    );
    expect(failed?.error).toBe("unknown");
    expect(
      observations.some(
        (observation) =>
          observation.operation === "run" &&
          observation.outcome === "failed" &&
          observation.error === "persistence",
      ),
    ).toBe(false);
    expect(JSON.stringify(observations)).not.toContain(
      "model provider failure",
    );
    expect(JSON.stringify(consoleErrors)).not.toContain(
      "model provider failure",
    );
    expect(JSON.stringify(replayed)).not.toContain("model provider failure");
  });
});
