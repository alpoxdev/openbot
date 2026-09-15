import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { BaseEvent } from "@ag-ui/client";
import { eq, sql } from "drizzle-orm";
import type { Observable } from "rxjs";
import { createConversationEngine } from "../src/conversations/engine";
import {
  ImportJobConflictError,
  createConversationImportStore,
} from "../src/conversations/import-store";
import type { ConversationImportSource } from "../src/conversations/import-source";
import { capturedContentHash } from "../src/conversations/import-validation";
import { createConversationStore } from "../src/conversations/store";
import { ConversationLeaseError } from "../src/conversations/types";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelAgents,
  channelMemberships,
  channels,
  conversationImportItems,
  conversationImportJobs,
  conversationImportMappings,
  conversationThreads,
  intelligenceChannelMappings,
  userRoles,
  users,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

type Fixture = {
  namespace: string;
  ownerUserId: string;
  agentId: string;
  threadId: string;
  runId: string;
  userMessageId: string;
  assistantToolMessageId: string;
  toolCallId: string;
  toolResultMessageId: string;
  partialAssistantMessageId: string;
};

type ReadyMessage = {
  type: "ready";
  namespace: string;
  threadId: string;
  runId: string;
  replicaId: string;
  generation: number;
  watermark: string;
  leaseUntil: string;
};

type ImportFixture = {
  namespace: string;
  adminUserId: string;
  ownerUserId: string;
  agentId: string;
  channelId: string;
  sourceThreadId: string;
  jobId?: string;
  itemId?: string;
};

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createConversationStore(database);
const namespace = `conversation-process-${randomUUID()}`;
const fixture: Fixture = {
  namespace,
  ownerUserId: `${namespace}-owner`,
  agentId: `${namespace}-agent`,
  threadId: `${namespace}-thread`,
  runId: `${namespace}-run`,
  userMessageId: `${namespace}-user-message`,
  assistantToolMessageId: `${namespace}-assistant-tool`,
  toolCallId: `${namespace}-tool-call`,
  toolResultMessageId: `${namespace}-tool-result`,
  partialAssistantMessageId: `${namespace}-assistant-partial`,
};
const importNamespace = `conversation-import-process-${randomUUID()}`;
const importFixture: ImportFixture = {
  namespace: importNamespace,
  adminUserId: `${importNamespace}-admin`,
  ownerUserId: `${importNamespace}-owner`,
  agentId: `${importNamespace}-agent`,
  channelId: `${importNamespace}-channel`,
  sourceThreadId: `${importNamespace}-source-thread`,
};

async function cleanupFixture() {
  await database
    .delete(conversationImportMappings)
    .where(
      eq(conversationImportMappings.sourceNamespace, importFixture.namespace),
    );
  if (importFixture.jobId) {
    await database
      .delete(conversationImportItems)
      .where(eq(conversationImportItems.jobId, importFixture.jobId));
    await database
      .delete(conversationImportJobs)
      .where(eq(conversationImportJobs.id, importFixture.jobId));
  }
  await database
    .delete(conversationThreads)
    .where(eq(conversationThreads.id, fixture.threadId));
  await database
    .delete(conversationThreads)
    .where(eq(conversationThreads.id, importFixture.sourceThreadId));
  await database
    .delete(intelligenceChannelMappings)
    .where(eq(intelligenceChannelMappings.channelId, importFixture.channelId));
  await database
    .delete(channelAgents)
    .where(eq(channelAgents.channelId, importFixture.channelId));
  await database
    .delete(channelMemberships)
    .where(eq(channelMemberships.channelId, importFixture.channelId));
  await database
    .delete(channels)
    .where(eq(channels.id, importFixture.channelId));
  await database.delete(agents).where(eq(agents.id, fixture.agentId));
  await database.delete(agents).where(eq(agents.id, importFixture.agentId));
  await database.delete(users).where(eq(users.id, fixture.ownerUserId));
  await database.delete(users).where(eq(users.id, importFixture.adminUserId));
  await database.delete(users).where(eq(users.id, importFixture.ownerUserId));
}

afterEach(cleanupFixture);
afterAll(async () => {
  await database.$client.close();
});

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await wait(Math.min(20, Math.max(1, deadline - Date.now())));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function readReady(child: Bun.Subprocess, timeoutMs: number) {
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      reader.read(),
      new Promise<{ timedOut: true }>((resolve) => {
        timeoutHandle = setTimeout(
          () => resolve({ timedOut: true }),
          remaining,
        );
      }),
    ]);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if ("timedOut" in result)
      throw new Error("Timed out waiting for worker readiness.");
    buffered += decoder.decode(result.value ?? new Uint8Array(), {
      stream: !result.done,
    });
    for (const line of buffered.split("\n").slice(0, -1)) {
      if (!line.trim()) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        message &&
        typeof message === "object" &&
        (message as { type?: unknown }).type === "ready"
      ) {
        return message as ReadyMessage;
      }
      if (
        message &&
        typeof message === "object" &&
        (message as { type?: unknown }).type === "error"
      ) {
        throw new Error("Conversation process worker failed before readiness.");
      }
    }
    buffered = buffered.split("\n").at(-1) ?? "";
    if (result.done)
      throw new Error("Conversation process worker exited before readiness.");
  }
  throw new Error("Timed out waiting for worker readiness.");
}

async function readChildMessage<T extends { type: string }>(
  child: Bun.Subprocess,
  type: T["type"],
  timeoutMs: number,
): Promise<T> {
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      reader.read(),
      new Promise<{ timedOut: true }>((resolve) => {
        timeoutHandle = setTimeout(
          () => resolve({ timedOut: true }),
          remaining,
        );
      }),
    ]);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if ("timedOut" in result)
      throw new Error(`Timed out waiting for ${type} worker evidence.`);
    buffered += decoder.decode(result.value ?? new Uint8Array(), {
      stream: !result.done,
    });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        message &&
        typeof message === "object" &&
        (message as { type?: unknown }).type === type
      )
        return message as T;
      if (
        message &&
        typeof message === "object" &&
        (message as { type?: unknown }).type === "error"
      )
        throw new Error(`Conversation import worker failed before ${type}.`);
    }
    if (result.done) throw new Error(`Worker exited before ${type} evidence.`);
  }
  throw new Error(`Timed out waiting for ${type} worker evidence.`);
}

async function reapChild(child: Bun.Subprocess) {
  child.kill("SIGKILL");
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      child.exited,
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () =>
            reject(
              new Error("Timed out waiting for killed conversation worker."),
            ),
          2_000,
        );
      }),
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

async function waitForChildExit(child: Bun.Subprocess, timeoutMs: number) {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      child.exited,
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () =>
            reject(new Error("Timed out waiting for importer worker exit.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

function collect(observable: Observable<BaseEvent>, timeoutMs: number) {
  return new Promise<BaseEvent[]>((resolve, reject) => {
    const events: BaseEvent[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      subscription.unsubscribe();
      reject(new Error("Timed out collecting conversation reconnect events."));
    }, timeoutMs);
    const subscription = observable.subscribe({
      next(event) {
        events.push(event);
      },
      error(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
      complete() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(events);
      },
    });
  });
}

async function seedFixture() {
  await database.insert(users).values({
    id: fixture.ownerUserId,
    email: `${fixture.ownerUserId}@example.test`,
    name: "Conversation process fixture owner",
  });
  await database.insert(userRoles).values({
    userId: fixture.ownerUserId,
    role: "user",
  });
  await database.insert(agents).values({
    id: fixture.agentId,
    name: "Conversation process fixture agent",
    type: "built_in",
    configuration: {},
  });
  await database.insert(agentProfiles).values({
    agentId: fixture.agentId,
    ownerUserId: fixture.ownerUserId,
    title: "Conversation process fixture profile",
    roleDescription: "A deterministic process death fixture.",
    avatarSeed: fixture.namespace,
    visibility: "private",
  });
  await store.createThread({
    id: fixture.threadId,
    ownerUserId: fixture.ownerUserId,
    agentId: fixture.agentId,
    provenance: "local",
    localReadiness: "ready",
  });
}

function expectedMessages() {
  return [
    {
      id: fixture.userMessageId,
      role: "user" as const,
      content: "Process-death input.",
    },
    {
      id: fixture.assistantToolMessageId,
      role: "assistant" as const,
      content: "Committed tool request.",
      toolCalls: [
        {
          id: fixture.toolCallId,
          type: "function" as const,
          function: {
            name: "deterministic_lookup",
            arguments: '{"key":"process-death-fixture"}',
          },
        },
      ],
    },
    {
      id: fixture.toolResultMessageId,
      role: "tool" as const,
      toolCallId: fixture.toolCallId,
      content: "Deterministic tool result.",
    },
    {
      id: fixture.partialAssistantMessageId,
      role: "assistant" as const,
      content: "Partial output survives process death.",
    },
  ];
}

function importSourceMessages() {
  return [
    {
      id: `${importFixture.namespace}-user`,
      role: "user",
      content: "Imported process fixture.",
    },
    {
      id: `${importFixture.namespace}-assistant-tool`,
      role: "assistant",
      content: null,
      toolCalls: [
        {
          id: `${importFixture.namespace}-tool-call`,
          name: "deterministic_lookup",
          args: '{"key":"import-process-fixture"}',
        },
      ],
    },
    {
      id: `${importFixture.namespace}-tool-result`,
      role: "tool",
      toolCallId: `${importFixture.namespace}-tool-call`,
      content: "Imported deterministic result.",
    },
    {
      id: `${importFixture.namespace}-assistant-final`,
      role: "assistant",
      content: "Imported process fixture persisted.",
    },
  ];
}

function importSource(): ConversationImportSource {
  return {
    async listThreads({ userId, agentId }) {
      if (
        userId !== importFixture.ownerUserId ||
        agentId !== importFixture.agentId
      ) {
        return { ok: true, value: { threads: [], nextCursor: null } };
      }
      return {
        ok: true,
        value: {
          threads: [
            {
              id: importFixture.sourceThreadId,
              name: "Imported process fixture",
              agentId: importFixture.agentId,
              createdById: importFixture.ownerUserId,
            },
          ],
          nextCursor: null,
        },
      };
    },
    async getThread({ threadId }) {
      if (threadId !== importFixture.sourceThreadId)
        return {
          ok: false,
          gap: "not-found",
          message: "fixture thread missing",
        };
      return {
        ok: true,
        value: {
          id: importFixture.sourceThreadId,
          name: "Imported process fixture",
          agentId: importFixture.agentId,
          createdById: importFixture.ownerUserId,
        },
      };
    },
    async getThreadMessages({ threadId }) {
      if (threadId !== importFixture.sourceThreadId)
        return {
          ok: false,
          gap: "not-found",
          message: "fixture thread missing",
        };
      return { ok: true, value: { messages: importSourceMessages() as never } };
    },
    async getThreadEvents() {
      return {
        ok: true,
        value: {
          events: [{ type: "TEXT_MESSAGE_START" }],
          decodeErrorRowIds: [],
          truncated: false,
        },
      };
    },
    async getThreadState() {
      return {
        ok: true,
        value: { kind: "snapshot", state: {}, skippedDeltas: 0 },
      };
    },
  };
}

async function seedImportFixture() {
  await database.insert(users).values([
    {
      id: importFixture.adminUserId,
      email: `${importFixture.adminUserId}@example.test`,
    },
    {
      id: importFixture.ownerUserId,
      email: `${importFixture.ownerUserId}@example.test`,
    },
  ]);
  await database.insert(userRoles).values([
    { userId: importFixture.adminUserId, role: "admin" },
    { userId: importFixture.ownerUserId, role: "user" },
  ]);
  await database.insert(agents).values({
    id: importFixture.agentId,
    name: "Import process fixture agent",
    type: "built_in",
    configuration: {},
  });
  await database.insert(agentProfiles).values({
    agentId: importFixture.agentId,
    ownerUserId: importFixture.ownerUserId,
    title: "Import process fixture profile",
    roleDescription: "Synthetic importer process fixture.",
    avatarSeed: importFixture.namespace,
    visibility: "private",
  });
  await database.insert(channels).values({
    id: importFixture.channelId,
    name: "Import process fixture channel",
    description: "Synthetic importer process fixture.",
  });
  await database.insert(channelMemberships).values({
    channelId: importFixture.channelId,
    userId: importFixture.ownerUserId,
  });
  await database.insert(channelAgents).values({
    channelId: importFixture.channelId,
    agentId: importFixture.agentId,
  });
  await database.insert(intelligenceChannelMappings).values({
    userId: importFixture.ownerUserId,
    channelId: importFixture.channelId,
    threadId: importFixture.sourceThreadId,
  });

  const importStore = createConversationImportStore(database, {
    encryptionKey: `${"A".repeat(43)}=`,
  });
  const job = await importStore.createJob({
    actor: { id: importFixture.adminUserId, role: "admin" },
    sourceNamespace: importFixture.namespace,
    sourceOrigin: "https://synthetic-import.example.test",
    sourceReference: "synthetic-project",
    explicitPairs: [
      {
        userId: importFixture.ownerUserId,
        agentId: importFixture.agentId,
      },
    ],
  });
  importFixture.jobId = job.id;
  const source = importSource();
  await importStore.runInventory({
    actor: { id: importFixture.adminUserId, role: "admin" },
    jobId: job.id,
    source,
  });
  const inventoried = await importStore.getJob(
    { id: importFixture.adminUserId, role: "admin" },
    job.id,
  );
  const manifestHash = capturedContentHash(inventoried.manifest);
  await importStore.approveManifest(
    { id: importFixture.adminUserId, role: "admin" },
    job.id,
    manifestHash,
  );
  const items = await importStore.listItems(
    { id: importFixture.adminUserId, role: "admin" },
    job.id,
  );
  const item = items.find(
    (candidate) => candidate.sourceThreadId === importFixture.sourceThreadId,
  );
  expect(item).toBeDefined();
  importFixture.itemId = item!.id;
  return { importStore, manifestHash, item: item! };
}

describe("conversation process death durability", () => {
  test("reconnects a killed owner without replaying committed model or tool work", async () => {
    await seedFixture();
    let child: Bun.Subprocess | undefined;
    let reconnectDatabase: ReturnType<typeof createDatabase> | undefined;
    try {
      child = Bun.spawn({
        cmd: [
          process.execPath,
          "--no-env-file",
          join(import.meta.dir, "support/conversation-process-worker.ts"),
        ],
        cwd: join(import.meta.dir, ".."),
        env: {
          // Deliberately pass a minimal environment: no .env loader and no model/source secrets.
          TEST_DATABASE_URL: testDatabaseUrl(),
          CONVERSATION_PROCESS_FIXTURE: JSON.stringify(fixture),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      void new Response(child.stderr).arrayBuffer();

      const ready = await readReady(child, 10_000);
      expect(ready.namespace).toBe(fixture.namespace);
      expect(ready.threadId).toBe(fixture.threadId);
      expect(ready.runId).toBe(fixture.runId);
      expect(ready.generation).toBeGreaterThan(0);
      expect(ready.watermark).toMatch(/^[1-9]\d*$/);
      expect(Number.isFinite(Date.parse(ready.leaseUntil))).toBe(true);

      const committed = await waitFor(
        async () => {
          const events = await store.readEventPage(
            { id: fixture.ownerUserId },
            fixture.threadId,
            0n,
            100,
          );
          return events.at(-1)?.sequence.toString() === ready.watermark
            ? events
            : undefined;
        },
        5_000,
        "the worker's committed event watermark",
      );
      expect(committed.map((event) => event.type)).toEqual([
        "RUN_STARTED",
        "MESSAGES_SNAPSHOT",
        "STATE_SNAPSHOT",
        "TEXT_MESSAGE_START",
        "TEXT_MESSAGE_CONTENT",
        "TOOL_CALL_START",
        "TOOL_CALL_ARGS",
        "TOOL_CALL_END",
        "TEXT_MESSAGE_END",
        "TOOL_CALL_RESULT",
        "TEXT_MESSAGE_START",
        "TEXT_MESSAGE_CONTENT",
      ]);
      expect(
        committed
          .filter((event) => event.type === "TOOL_CALL_START")
          .map((event) => (event.payload as { toolCallId: string }).toolCallId),
      ).toEqual([fixture.toolCallId]);
      expect(
        committed.find((event) => event.type === "TOOL_CALL_START")?.payload,
      ).toMatchObject({
        toolCallId: fixture.toolCallId,
        toolCallName: "deterministic_lookup",
        parentMessageId: fixture.assistantToolMessageId,
      });
      expect(
        committed.find((event) => event.type === "TOOL_CALL_RESULT")?.payload,
      ).toMatchObject({
        messageId: fixture.toolResultMessageId,
        toolCallId: fixture.toolCallId,
        role: "tool",
      });

      await reapChild(child);
      child = undefined;

      await waitFor(
        async () => {
          const active = await store.getActiveRun(
            { id: fixture.ownerUserId },
            fixture.threadId,
          );
          return active?.leaseUntil && active.leaseUntil.getTime() <= Date.now()
            ? active
            : undefined;
        },
        5_000,
        "the killed worker lease to expire",
      );

      reconnectDatabase = createDatabase(testDatabaseUrl(), TEST_POOL);
      const reconnectEngine = createConversationEngine({
        store: createConversationStore(reconnectDatabase),
        pollMs: 10,
        replicaId: `${fixture.namespace}-reconnect`,
      });
      const reconnectEvents = await collect(
        reconnectEngine.connect({
          actor: { id: fixture.ownerUserId },
          threadId: fixture.threadId,
          agentId: fixture.agentId,
          afterSequence: 0n,
        }),
        5_000,
      );
      expect(reconnectEvents.map((event) => event.type)).toEqual([
        "RUN_STARTED",
        "MESSAGES_SNAPSHOT",
        "STATE_SNAPSHOT",
        "RUN_ERROR",
      ]);
      expect(reconnectEvents.at(-1)).toMatchObject({
        type: "RUN_ERROR",
        threadId: fixture.threadId,
        runId: fixture.runId,
        code: "conversation_interrupted",
      });

      const finalStore = reconnectEngine.store;
      const snapshot = await finalStore.readSnapshot(
        { id: fixture.ownerUserId },
        fixture.threadId,
      );
      expect(snapshot.snapshot.messages).toEqual(expectedMessages());

      const run = await finalStore.getLatestRun(
        { id: fixture.ownerUserId },
        fixture.threadId,
      );
      expect(
        await finalStore.getActiveRun(
          { id: fixture.ownerUserId },
          fixture.threadId,
        ),
      ).toBeNull();
      expect(run).toMatchObject({
        id: fixture.runId,
        threadId: fixture.threadId,
        status: "interrupted",
        leaseOwner: null,
        leaseUntil: null,
        stopTargetRunId: null,
      });
      expect(run?.finishedAt).toBeInstanceOf(Date);

      const durableEvents = await finalStore.readEventPage(
        { id: fixture.ownerUserId },
        fixture.threadId,
        0n,
        100,
      );
      expect(durableEvents.at(-1)?.type).toBe("RUN_ERROR");
      expect(durableEvents.at(-1)?.sequence).toBe(
        committed.at(-1)!.sequence + 1n,
      );
      expect(
        durableEvents
          .filter((event) => event.type === "RUN_ERROR")
          .map((event) => event.payload),
      ).toEqual([
        {
          type: "RUN_ERROR",
          threadId: fixture.threadId,
          runId: fixture.runId,
          message: "Conversation run was interrupted",
          code: "conversation_interrupted",
        },
      ]);
      expect(
        durableEvents.filter(
          (event) =>
            event.type === "TOOL_CALL_START" &&
            (event.payload as { toolCallId?: string }).toolCallId ===
              fixture.toolCallId,
        ),
      ).toHaveLength(1);

      await expect(
        finalStore.appendEvents({
          threadId: fixture.threadId,
          runId: fixture.runId,
          leaseOwner: ready.replicaId,
          generation: ready.generation,
          events: [
            {
              type: "TEXT_MESSAGE_CONTENT",
              messageId: fixture.partialAssistantMessageId,
              delta: " stale fenced write",
            },
          ],
        }),
      ).rejects.toBeInstanceOf(ConversationLeaseError);

      const unchanged = await finalStore.readSnapshot(
        { id: fixture.ownerUserId },
        fixture.threadId,
      );
      expect(unchanged.snapshot.messages).toEqual(expectedMessages());
    } finally {
      try {
        if (child) await reapChild(child);
      } finally {
        await reconnectDatabase?.$client.close();
      }
    }
  });

  test("reclaims a killed importer after encrypted staging and publishes exactly once", async () => {
    await seedImportFixture();
    const actor = { id: importFixture.adminUserId, role: "admin" as const };
    const importStore = createConversationImportStore(database, {
      encryptionKey: `${"A".repeat(43)}=`,
    });
    const jobId = importFixture.jobId!;
    const itemId = importFixture.itemId!;
    const childEnv = {
      TEST_DATABASE_URL: testDatabaseUrl(),
      CONVERSATION_IMPORT_PROCESS_FIXTURE: JSON.stringify({
        ...importFixture,
        jobId,
        itemId,
      }),
    };
    let stagingChild: Bun.Subprocess | undefined;
    let resumeChild: Bun.Subprocess | undefined;
    let retryChild: Bun.Subprocess | undefined;
    try {
      stagingChild = Bun.spawn({
        cmd: [
          process.execPath,
          "--no-env-file",
          join(
            import.meta.dir,
            "support/conversation-import-process-worker.ts",
          ),
        ],
        cwd: join(import.meta.dir, ".."),
        env: { ...childEnv, CONVERSATION_IMPORT_PROCESS_MODE: "stage" },
        stdout: "pipe",
        stderr: "pipe",
      });
      void new Response(stagingChild.stderr).arrayBuffer();
      const stagedEvidence = await readChildMessage<{
        type: "staged";
        namespace: string;
        jobId: string;
        itemId: string;
        phase: string;
        status: string;
        hasEncryptedResources: boolean;
      }>(stagingChild, "staged", 10_000);
      expect(stagedEvidence.namespace).toBe(importFixture.namespace);
      expect(stagedEvidence.jobId).toBe(jobId);
      expect(stagedEvidence.itemId).toBe(itemId);
      expect(stagedEvidence.phase).toBe("importing");
      expect(stagedEvidence.status).toBe("staged");
      expect(stagedEvidence.hasEncryptedResources).toBe(true);

      const stagedItem = await importStore.getItem(actor, jobId, itemId);
      expect(stagedItem.status).toBe("staged");
      expect(stagedItem.hasEncryptedResources).toBe(true);
      expect(
        await importStore.decryptItemResources({
          actor,
          jobId,
          itemId,
        }),
      ).toMatchObject({ marker: "process-import-resource" });
      const activeBeforeKill = await importStore.getJob(actor, jobId);
      expect(activeBeforeKill.attemptStatus).toBe("active");
      expect(activeBeforeKill.attemptKind).toBe("run");
      expect(activeBeforeKill.attemptToken).toBeTruthy();
      const staleAttempt = {
        token: activeBeforeKill.attemptToken!,
        kind: "run" as const,
      };

      await reapChild(stagingChild);
      stagingChild = undefined;

      // The production lease is intentionally 30 seconds and not configurable. This direct,
      // fixture-owned expiry keeps the crash/reclaim proof bounded without changing production code.
      await database
        .update(conversationImportJobs)
        .set({
          attemptLeaseExpiresAt: sql`clock_timestamp() - interval '1 second'`,
        })
        .where(eq(conversationImportJobs.id, jobId));
      const expired = await waitFor(
        async () => {
          const current = await importStore.getJob(actor, jobId);
          return current.attemptStatus === "expired" ? current : undefined;
        },
        5_000,
        "the staged importer lease to expire",
      );
      expect(expired.attemptToken).toBe(staleAttempt.token);

      await expect(
        importStore.encryptItemResources({
          actor,
          jobId,
          itemId,
          resources: { stale: true },
          attempt: staleAttempt,
          expectedPhase: "importing",
        }),
      ).rejects.toBeInstanceOf(ImportJobConflictError);
      await expect(
        importStore.markItem({
          actor,
          jobId,
          itemId,
          status: "validated",
          attempt: staleAttempt,
          expectedPhase: "importing",
        }),
      ).rejects.toBeInstanceOf(ImportJobConflictError);
      await expect(
        importStore.publishImportedThread({
          actor,
          job: expired,
          item: stagedItem,
          destinationThreadId: importFixture.sourceThreadId,
          ownerUserId: importFixture.ownerUserId,
          channelId: importFixture.channelId,
          agentId: importFixture.agentId,
          localReadiness: "ready",
          messages: importSourceMessages(),
          state: {},
          contentHash: "stale-content-hash",
          converterVersion: 1,
          approvedManifestHash: expired.approvedManifestHash!,
          attempt: staleAttempt,
          expectedPhase: "importing",
        }),
      ).rejects.toBeInstanceOf(ImportJobConflictError);

      resumeChild = Bun.spawn({
        cmd: [
          process.execPath,
          "--no-env-file",
          join(
            import.meta.dir,
            "support/conversation-import-process-worker.ts",
          ),
        ],
        cwd: join(import.meta.dir, ".."),
        env: { ...childEnv, CONVERSATION_IMPORT_PROCESS_MODE: "resume" },
        stdout: "pipe",
        stderr: "pipe",
      });
      void new Response(resumeChild.stderr).arrayBuffer();
      const resumed = await readChildMessage<{
        type: "resumed";
        namespace: string;
        jobId: string;
        phase: string;
        published: number;
        unchanged: number;
      }>(resumeChild, "resumed", 10_000);
      expect(resumed.namespace).toBe(importFixture.namespace);
      expect(resumed.jobId).toBe(jobId);
      expect(resumed.phase).toBe("completed");
      expect(resumed.published).toBe(1);
      expect(resumed.unchanged).toBe(0);
      await waitForChildExit(resumeChild, 5_000);
      resumeChild = undefined;

      const completed = await importStore.getJob(actor, jobId);
      expect(completed.phase).toBe("completed");
      expect(completed.attemptStatus).toBe("none");
      const published = await importStore.getItem(actor, jobId, itemId);
      expect(published.status).toBe("published");
      expect(
        await importStore.decryptItemResources({
          actor,
          jobId,
          itemId,
        }),
      ).toMatchObject({ messages: importSourceMessages() });
      const mapping = await database
        .select()
        .from(conversationImportMappings)
        .where(
          eq(
            conversationImportMappings.sourceNamespace,
            importFixture.namespace,
          ),
        );
      expect(mapping).toHaveLength(1);
      expect(mapping[0]?.destinationThreadId).toBe(
        importFixture.sourceThreadId,
      );
      const importedSnapshot = await store.readSnapshot(
        { id: importFixture.ownerUserId },
        importFixture.sourceThreadId,
      );
      expect(importedSnapshot.snapshot.messages).toEqual([
        {
          id: `${importFixture.namespace}-user`,
          role: "user",
          content: "Imported process fixture.",
        },
        {
          id: `${importFixture.namespace}-assistant-tool`,
          role: "assistant",
          toolCalls: [
            {
              id: `${importFixture.namespace}-tool-call`,
              type: "function",
              function: {
                name: "deterministic_lookup",
                arguments: '{"key":"import-process-fixture"}',
              },
            },
          ],
        },
        {
          id: `${importFixture.namespace}-tool-result`,
          role: "tool",
          toolCallId: `${importFixture.namespace}-tool-call`,
          content: "Imported deterministic result.",
        },
        {
          id: `${importFixture.namespace}-assistant-final`,
          role: "assistant",
          content: "Imported process fixture persisted.",
        },
      ]);

      await expect(
        importStore.encryptItemResources({
          actor,
          jobId,
          itemId,
          resources: { stale: true },
          attempt: staleAttempt,
          expectedPhase: "importing",
        }),
      ).rejects.toBeInstanceOf(ImportJobConflictError);
      await expect(
        importStore.markItem({
          actor,
          jobId,
          itemId,
          status: "validated",
          attempt: staleAttempt,
          expectedPhase: "importing",
        }),
      ).rejects.toBeInstanceOf(ImportJobConflictError);
      await expect(
        importStore.publishImportedThread({
          actor,
          job: completed,
          item: published,
          destinationThreadId: importFixture.sourceThreadId,
          ownerUserId: importFixture.ownerUserId,
          channelId: importFixture.channelId,
          agentId: importFixture.agentId,
          localReadiness: "ready",
          messages: importSourceMessages(),
          state: {},
          contentHash: published.contentHash!,
          converterVersion: 1,
          approvedManifestHash: completed.approvedManifestHash!,
          attempt: staleAttempt,
          expectedPhase: "importing",
        }),
      ).rejects.toBeInstanceOf(ImportJobConflictError);

      retryChild = Bun.spawn({
        cmd: [
          process.execPath,
          "--no-env-file",
          join(
            import.meta.dir,
            "support/conversation-import-process-worker.ts",
          ),
        ],
        cwd: join(import.meta.dir, ".."),
        env: { ...childEnv, CONVERSATION_IMPORT_PROCESS_MODE: "resume" },
        stdout: "pipe",
        stderr: "pipe",
      });
      void new Response(retryChild.stderr).arrayBuffer();
      const retry = await readChildMessage<{
        type: "resumed";
        namespace: string;
        jobId: string;
        phase: string;
        published: number;
        unchanged: number;
      }>(retryChild, "resumed", 10_000);
      expect(retry.phase).toBe("completed");
      expect(retry.published).toBe(0);
      expect(retry.unchanged).toBe(1);
      await waitForChildExit(retryChild, 5_000);
      retryChild = undefined;
      const retriedItem = await importStore.getItem(actor, jobId, itemId);
      expect(retriedItem.status).toBe("unchanged");
      expect(retriedItem.publishedAt).toEqual(published.publishedAt);
      expect(retriedItem.contentHash).toBe(published.contentHash);
      expect(
        await database
          .select()
          .from(conversationImportMappings)
          .where(
            eq(
              conversationImportMappings.sourceNamespace,
              importFixture.namespace,
            ),
          ),
      ).toHaveLength(1);
      expect(
        (
          await store.readSnapshot(
            { id: importFixture.ownerUserId },
            importFixture.sourceThreadId,
          )
        ).snapshot.messages,
      ).toEqual(importedSnapshot.snapshot.messages);
    } finally {
      try {
        if (stagingChild) await reapChild(stagingChild);
        if (resumeChild) await reapChild(resumeChild);
        if (retryChild) await reapChild(retryChild);
      } finally {
        // The importer fixture owns all rows through cleanupFixture.
      }
    }
  });
});
