import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { createRoleRepository } from "../src/auth/guards";
import {
  mountCopilotRuntime,
  type RegisteredAgent,
  type RuntimeModel,
} from "../src/copilot";
import { createConversationEngine } from "../src/conversations/engine";
import { createConversationImportSource } from "../src/conversations/import-source";
import { createConversationImportStore } from "../src/conversations/import-store";
import { createConversationImporter } from "../src/conversations/importer";
import { capturedContentHash } from "../src/conversations/import-validation";
import { createConversationStore } from "../src/conversations/store";
import { loadConfig } from "../src/config";
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
import { testEnvironment } from "./support/environment";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const conversations = createConversationStore(database);
const importStore = createConversationImportStore(database, {
  encryptionKey: `${"A".repeat(43)}=`,
});
const importer = createConversationImporter({
  database,
  importStore,
  conversations,
});
const prefix = `conversation-import-e2e-${randomUUID().slice(0, 8)}`;

const created = {
  users: [] as string[],
  agents: [] as string[],
  channels: [] as string[],
  threads: [] as string[],
  jobs: [] as string[],
};

afterEach(async () => {
  // Import mappings restrict deleting their destination thread; remove them before any conversation
  // or channel rows, then remove jobs/items before their requester rows.
  for (const threadId of created.threads) {
    await database
      .delete(conversationImportMappings)
      .where(eq(conversationImportMappings.destinationThreadId, threadId));
  }
  for (const jobId of created.jobs) {
    const items = await database
      .select({ id: conversationImportItems.id })
      .from(conversationImportItems)
      .where(eq(conversationImportItems.jobId, jobId));
    for (const item of items) {
      await database
        .delete(conversationImportMappings)
        .where(eq(conversationImportMappings.itemId, item.id));
    }
    await database
      .delete(conversationImportItems)
      .where(eq(conversationImportItems.jobId, jobId));
    await database
      .delete(conversationImportJobs)
      .where(eq(conversationImportJobs.id, jobId));
  }
  for (const threadId of created.threads) {
    await database
      .delete(conversationThreads)
      .where(eq(conversationThreads.id, threadId));
  }
  for (const channelId of created.channels) {
    await database
      .delete(intelligenceChannelMappings)
      .where(eq(intelligenceChannelMappings.channelId, channelId));
    await database.delete(channels).where(eq(channels.id, channelId));
  }
  for (const agentId of created.agents) {
    await database
      .delete(agentProfiles)
      .where(eq(agentProfiles.agentId, agentId));
    await database.delete(agents).where(eq(agents.id, agentId));
  }
  for (const userId of created.users) {
    await database.delete(userRoles).where(eq(userRoles.userId, userId));
    await database.delete(users).where(eq(users.id, userId));
  }
  created.users.length = 0;
  created.agents.length = 0;
  created.channels.length = 0;
  created.threads.length = 0;
  created.jobs.length = 0;
});

afterAll(async () => {
  await database.$client.close();
});

async function seedUser(label: string, role: "admin" | "user") {
  const id = `${prefix}-${label}-${randomUUID()}`;
  await database.insert(users).values({
    id,
    email: `${id}@example.test`,
  });
  await database.insert(userRoles).values({ userId: id, role });
  created.users.push(id);
  return id;
}

async function seedAgent(input: {
  label: string;
  endpoint: string;
  visibility: "public" | "private";
  ownerUserId?: string | null;
  deletedAt?: Date | null;
}) {
  const id = `${prefix}-agent-${input.label}-${randomUUID()}`;
  await database.insert(agents).values({
    id,
    name: input.label,
    type: "remote_ag_ui",
    configuration: { endpoint: input.endpoint },
  });
  await database.insert(agentProfiles).values({
    agentId: id,
    ownerUserId: input.ownerUserId ?? null,
    title: input.label,
    roleDescription: "Deterministic integration fixture.",
    avatarSeed: id,
    visibility: input.visibility,
    deletedAt: input.deletedAt ?? null,
  });
  created.agents.push(id);
  return id;
}

async function seedMappedChannel(
  ownerUserId: string,
  agentId: string,
  threadId: string,
  alternateAgentIds: string[] = [],
) {
  const channelId = `${prefix}-channel-${randomUUID()}`;
  await database.insert(channels).values({
    id: channelId,
    name: "Imported fixture",
    description: "Conversation import fixture",
  });
  await database.insert(channelMemberships).values({
    channelId,
    userId: ownerUserId,
  });
  await database.insert(channelAgents).values([
    { channelId, agentId },
    ...alternateAgentIds.map((alternateAgentId) => ({
      channelId,
      agentId: alternateAgentId,
    })),
  ]);
  await database.insert(intelligenceChannelMappings).values({
    userId: ownerUserId,
    channelId,
    threadId,
  });
  created.channels.push(channelId);
  return channelId;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 8_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(message);
    await Bun.sleep(10);
  }
}

async function sseEvents(
  response: Response,
): Promise<Record<string, unknown>[]> {
  const text = await response.text();
  return [...text.matchAll(/^data:\s*(\{.*\})\s*$/gm)].flatMap((match) => {
    try {
      return [JSON.parse(match[1]!) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
}

type RemoteRequest = {
  threadId: string;
  runId: string;
  messages?: unknown[];
  tools?: unknown[];
  [key: string]: unknown;
};

function scriptedRemoteEndpoint() {
  const requests: RemoteRequest[] = [];
  const heldThreads = new Set<string>();
  const releaseByThread = new Map<string, () => void>();
  const encoder = new TextEncoder();
  const frame = (event: Record<string, unknown>) =>
    `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      const body = (await request.json()) as RemoteRequest;
      requests.push(body);
      const threadId = body.threadId;
      const runId = body.runId;
      const messageId = `${runId}-fixture-reply`;
      const events = [
        { type: "RUN_STARTED", threadId, runId },
        { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
        {
          type: "TEXT_MESSAGE_CONTENT",
          messageId,
          delta: `Fixture reply for ${threadId}`,
        },
        { type: "TEXT_MESSAGE_END", messageId },
        { type: "RUN_FINISHED", threadId, runId },
      ];
      if (!heldThreads.has(threadId)) {
        return new Response(events.map(frame).join(""), {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(
              encoder.encode(frame(events[0]!) + frame(events[1]!)),
            );
            await new Promise<void>((resolve) => {
              releaseByThread.set(threadId, resolve);
            });
            try {
              controller.enqueue(
                encoder.encode(events.slice(2).map(frame).join("")),
              );
              controller.close();
            } catch {
              // The client may have cancelled this stream after an authorized Stop.
            } finally {
              releaseByThread.delete(threadId);
            }
          },
          cancel() {
            releaseByThread.get(threadId)?.();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });

  return {
    requests,
    heldThreads,
    releaseThread(threadId: string) {
      releaseByThread.get(threadId)?.();
    },
    url: `http://127.0.0.1:${server.port}/ag-ui`,
    stop() {
      server.stop(true);
    },
  };
}

function sourceFixture(input: {
  ownerUserId: string;
  agentId: string;
  threadId: string;
  messages: unknown[];
}) {
  const requests: Array<{ method: string; path: string }> = [];
  const summary = {
    id: input.threadId,
    name: "Scoped imported thread",
    agentId: input.agentId,
    createdById: input.ownerUserId,
    lastUpdatedAt: "2026-01-01T00:00:00.000Z",
  };
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      requests.push({ method: request.method, path: url.pathname });
      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
      }
      if (
        request.headers.get("authorization") !== "Bearer fixture-source-secret"
      ) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (url.pathname === "/api/threads") {
        const userId = url.searchParams.get("userId");
        const agentId = url.searchParams.get("agentId");
        return Response.json({
          threads:
            userId === input.ownerUserId && agentId === input.agentId
              ? [summary]
              : [],
          nextCursor: null,
        });
      }
      if (
        url.pathname === `/api/threads/${encodeURIComponent(input.threadId)}`
      ) {
        return Response.json({ thread: summary });
      }
      if (
        url.pathname ===
        `/api/threads/${encodeURIComponent(input.threadId)}/messages`
      ) {
        return Response.json({ messages: input.messages });
      }
      if (
        url.pathname ===
        `/api/_inspect/threads/${encodeURIComponent(input.threadId)}/events`
      ) {
        return Response.json({
          events: [
            {
              type: "RUN_STARTED",
              threadId: input.threadId,
              runId: "source-run",
            },
            {
              type: "RUN_FINISHED",
              threadId: input.threadId,
              runId: "source-run",
            },
          ],
          decodeErrorRowIds: [],
          truncated: false,
        });
      }
      if (
        url.pathname ===
        `/api/_inspect/threads/${encodeURIComponent(input.threadId)}/state`
      ) {
        return Response.json({
          kind: "snapshot",
          state: {},
          skippedDeltas: 0,
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  return {
    requests,
    origin: `http://127.0.0.1:${server.port}`,
    stop() {
      server.stop(true);
    },
  };
}

function appWithRuntime(input: {
  engine: ReturnType<typeof createConversationEngine>;
  config: ReturnType<typeof loadConfig>;
  publicAgent: RegisteredAgent;
  privateAgent: RegisteredAgent;
  deletedAgent: RegisteredAgent;
  sessions: Record<string, { id: string; role: "admin" | "user" }>;
  conversationStore?: typeof conversations;
}) {
  const identifyActor = async (request: Request) => {
    const session = input.sessions[request.headers.get("x-session") ?? ""];
    if (!session) throw new Error("unauthenticated");
    return { id: session.id, role: session.role };
  };
  const agentsFor = async (actor: { id: string }) =>
    actor.id === input.sessions.a.id
      ? [input.publicAgent, input.privateAgent, input.deletedAgent]
      : [input.publicAgent];
  const runtimeArgs = [
    input.config,
    {
      provider: "openai",
      defaultModel: "fixture-model",
    } satisfies RuntimeModel,
    agentsFor,
    async () => null,
    identifyActor,
    {
      watch: (
        _bot: unknown,
        implementation?: (url: string, init: RequestInit) => Promise<Response>,
      ) => implementation ?? fetch,
      stop() {},
    },
  ] as unknown as Parameters<typeof mountCopilotRuntime>;
  runtimeArgs[16] = {
    store: input.conversationStore ?? conversations,
    engine: input.engine,
  };
  const { handler } = mountCopilotRuntime(...runtimeArgs);

  const auth = {
    handler: () => new Response(null, { status: 204 }),
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const session = input.sessions[headers.get("x-session") ?? ""];
        return session
          ? {
              user: {
                id: session.id,
                email: `${session.id}@example.test`,
              },
            }
          : null;
      },
    },
  };
  const args = [
    input.config,
    auth,
    createRoleRepository(database),
  ] as unknown as Parameters<typeof createApp>;
  args[6] = handler;
  args[29] = conversations;
  return createApp(...args);
}

describe("conversation import through the real store, engine, and SSE runtime", () => {
  test("imports scoped structured history, reloads it, and isolates concurrent public-agent runs", async () => {
    const remote = scriptedRemoteEndpoint();
    let sourceServer: ReturnType<typeof sourceFixture> | undefined;
    try {
      const admin = await seedUser("admin", "admin");
      const ownerA = await seedUser("owner-a", "user");
      const ownerB = await seedUser("owner-b", "user");
      const publicAgentId = await seedAgent({
        label: "Public fixture",
        endpoint: remote.url,
        visibility: "public",
      });
      const privateAgentId = await seedAgent({
        label: "Private fixture",
        endpoint: remote.url,
        visibility: "private",
        ownerUserId: ownerA,
      });
      const deletedAgentId = await seedAgent({
        label: "Deleted fixture",
        endpoint: remote.url,
        visibility: "public",
        deletedAt: new Date(),
      });
      const privateAgent: RegisteredAgent = {
        id: privateAgentId,
        name: "Private fixture",
        type: "remote_ag_ui",
        endpoint: remote.url,
        standingMessage: {
          id: `standing-role:${privateAgentId}`,
          role: "system",
          content: "Private fixture role",
        },
      };
      const deletedAgent: RegisteredAgent = {
        id: deletedAgentId,
        name: "Deleted fixture",
        type: "unavailable",
        reason:
          "Deleted fixture has been deleted and can no longer run. Its conversations remain readable.",
      };
      const publicAgent: RegisteredAgent = {
        id: publicAgentId,
        name: "Public fixture",
        type: "remote_ag_ui",
        endpoint: remote.url,
        standingMessage: {
          id: `standing-role:${publicAgentId}`,
          role: "system",
          content: "Public fixture role",
        },
      };

      const importedThreadId = `${prefix}-imported-thread-${randomUUID()}`;
      created.threads.push(importedThreadId);
      const importedChannelId = await seedMappedChannel(
        ownerA,
        publicAgentId,
        importedThreadId,
      );
      const sourceMessages = [
        {
          id: "import-user-structured",
          role: "user",
          content: [{ type: "text", text: "Remember this structured prompt." }],
          sourceExtension: { kind: "structured-content", order: 1 },
        },
        {
          id: "import-assistant-tool-call",
          role: "assistant",
          content: "I will query the fixture.",
          toolCalls: [
            {
              id: "import-call-1",
              name: "lookup",
              args: JSON.stringify({ query: "fixture" }),
              sourceExtension: { kind: "tool-call", order: 2 },
            },
          ],
        },
        {
          id: "import-tool-result",
          role: "tool",
          toolCallId: "import-call-1",
          content: "Fixture lookup result.",
          structuredContent: { kind: "tool-result", value: 42, order: 3 },
        },
        {
          id: "import-assistant-final",
          role: "assistant",
          content: "The imported fixture is complete.",
          structuredContent: { kind: "assistant-result", order: 4 },
        },
      ];
      sourceServer = sourceFixture({
        ownerUserId: ownerA,
        agentId: publicAgentId,
        threadId: importedThreadId,
        messages: sourceMessages,
      });
      const source = createConversationImportSource(
        {
          origin: sourceServer.origin,
          apiKey: "fixture-source-secret",
        },
        { allowHttp: true, allowPrivateHosts: true },
      );
      if (!source.ok) throw new Error(source.message);

      const adminActor = { id: admin, role: "admin" as const };
      const job = await importStore.createJob({
        actor: adminActor,
        sourceNamespace: sourceServer.origin,
        sourceOrigin: sourceServer.origin,
        sourceReference: "scripted-fixture",
        explicitPairs: [{ userId: ownerA, agentId: publicAgentId }],
      });
      created.jobs.push(job.id);
      const inventory = await importStore.runInventory({
        actor: adminActor,
        jobId: job.id,
        source: source.value,
      });
      expect(inventory.job.manifest.inventoryCompleteForDeclaredScope).toBe(
        true,
      );
      const ready = await importStore.getJob(adminActor, job.id);
      const manifestHash = capturedContentHash(ready.manifest);
      await importStore.approveManifest(adminActor, job.id, manifestHash);
      const imported = await importer.runApprovedImport({
        actor: adminActor,
        jobId: job.id,
        approvedManifestHash: manifestHash,
        source: source.value,
      });
      expect(imported.phase).toBe("completed");
      expect(imported.counts).toMatchObject({
        selected: 1,
        published: 1,
        failed: 0,
        blocked: 0,
        sourceChanged: 0,
      });

      const snapshot = await conversations.readSnapshot(
        { id: ownerA },
        importedThreadId,
      );
      expect(snapshot.thread).toMatchObject({
        id: importedThreadId,
        ownerUserId: ownerA,
        channelId: importedChannelId,
        agentId: publicAgentId,
        provenance: "imported",
        localReadiness: "ready",
      });
      expect(snapshot.snapshot.messages.map((message) => message.id)).toEqual([
        "import-user-structured",
        "import-assistant-tool-call",
        "import-tool-result",
        "import-assistant-final",
      ]);
      expect(snapshot.snapshot.messages[0]?.content).toEqual([
        { type: "text", text: "Remember this structured prompt." },
      ]);
      expect(snapshot.snapshot.messages[1]?.toolCalls?.[0]).toMatchObject({
        id: "import-call-1",
        sourceExtension: { kind: "tool-call", order: 2 },
        type: "function",
        function: {
          name: "lookup",
          arguments: '{"query":"fixture"}',
        },
      });
      expect(snapshot.snapshot.messages[2]).toMatchObject({
        role: "tool",
        toolCallId: "import-call-1",
        structuredContent: { kind: "tool-result", value: 42, order: 3 },
      });

      // Disable the source before constructing the replacement engine/handler. No later local read
      // or run is allowed to depend on its endpoint.
      const sourceRequests = sourceServer.requests;
      const sourceRequestCount = sourceRequests.length;
      sourceServer.stop();
      sourceServer = undefined;

      const sessions = {
        admin: { id: admin, role: "admin" as const },
        a: { id: ownerA, role: "user" as const },
        b: { id: ownerB, role: "user" as const },
      };
      const config = loadConfig(
        testEnvironment({ DATABASE_URL: testDatabaseUrl() }),
      );
      const engine1 = createConversationEngine({
        store: conversations,
        pollMs: 5,
        replicaId: `${prefix}-engine-1`,
      });
      const app1 = appWithRuntime({
        engine: engine1,
        config,
        publicAgent,
        privateAgent,
        deletedAgent,
        sessions,
      });
      const historyResponse = await app1.request(
        `http://openbot.test/api/copilotkit/threads/${encodeURIComponent(importedThreadId)}/messages`,
        { headers: { "x-session": "a" } },
      );
      expect(historyResponse.status).toBe(200);
      const historyJson = (await historyResponse.json()) as {
        messages: unknown[];
      };
      expect(
        historyJson.messages.map((message) => (message as { id: string }).id),
      ).toEqual(snapshot.snapshot.messages.map((message) => message.id));

      const engine2 = createConversationEngine({
        store: conversations,
        pollMs: 5,
        replicaId: `${prefix}-engine-2`,
      });
      const app2 = appWithRuntime({
        engine: engine2,
        config,
        publicAgent,
        privateAgent,
        deletedAgent,
        sessions,
      });
      const connectResponse = await app2.request(
        `http://openbot.test/api/copilotkit/agent/${encodeURIComponent(publicAgentId)}/connect`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-session": "a",
          },
          body: JSON.stringify({
            threadId: importedThreadId,
            runId: `${importedThreadId}-reconnect`,
            state: {},
            messages: [],
            tools: [],
            context: [],
            forwardedProps: {},
          }),
        },
      );
      expect(connectResponse.status).toBe(200);
      const reconnectEvents = await sseEvents(connectResponse);
      const reconnectSnapshot = reconnectEvents.find(
        (event) => event.type === "MESSAGES_SNAPSHOT",
      );
      expect(reconnectSnapshot?.messages).toEqual(snapshot.snapshot.messages);

      const continuationRunId = `${importedThreadId}-continuation`;
      const continuationResponse = await app2.request(
        `http://openbot.test/api/copilotkit/agent/${encodeURIComponent(publicAgentId)}/run`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-session": "a",
          },
          body: JSON.stringify({
            threadId: importedThreadId,
            runId: continuationRunId,
            state: {},
            messages: [
              {
                id: "continuation-input",
                role: "user",
                content: "Continue this imported conversation locally.",
              },
            ],
            tools: [],
            context: [],
            forwardedProps: {},
          }),
        },
      );
      expect(continuationResponse.status).toBe(200);
      expect(continuationResponse.headers.get("content-type")).toContain(
        "text/event-stream",
      );
      const continuationEvents = await sseEvents(continuationResponse);
      expect(
        continuationEvents.some((event) => event.type === "RUN_FINISHED"),
      ).toBe(true);
      const afterContinuation = await conversations.readSnapshot(
        { id: ownerA },
        importedThreadId,
      );
      expect(
        afterContinuation.snapshot.messages.map((message) => message.id),
      ).toEqual([
        "import-user-structured",
        "import-assistant-tool-call",
        "import-tool-result",
        "import-assistant-final",
        "continuation-input",
        `${continuationRunId}-fixture-reply`,
      ]);
      const continuationRequest = remote.requests.find(
        (request) => request.runId === continuationRunId,
      );
      expect(continuationRequest).toBeDefined();
      expect(
        (continuationRequest?.messages ?? []).filter(
          (message) =>
            (message as { id?: string }).id === "import-user-structured",
        ),
      ).toHaveLength(1);
      expect(
        (continuationRequest?.messages ?? []).filter(
          (message) => (message as { id?: string }).id === "continuation-input",
        ),
      ).toHaveLength(1);
      expect(
        (continuationRequest?.messages ?? []).filter(
          (message) => (message as { id?: string }).id === "import-tool-result",
        ),
      ).toHaveLength(1);
      expect(
        (continuationRequest?.messages ?? []).filter(
          (message) =>
            (message as { id?: string }).id === "import-assistant-tool-call",
        ),
      ).toHaveLength(1);
      const continuedHistory = (continuationRequest?.messages ?? []).filter(
        (message) => {
          const id = (message as { id?: unknown }).id;
          return (
            typeof id === "string" &&
            [
              "import-user-structured",
              "import-assistant-tool-call",
              "import-tool-result",
              "import-assistant-final",
            ].includes(id)
          );
        },
      );
      expect(continuedHistory).toEqual(snapshot.snapshot.messages);
      expect(continuationRequest?.tools).toEqual([]);
      expect(sourceServer).toBeUndefined();

      // A private and a deleted Bot retain readable history but are not executable for a caller
      // who does not own the private profile, or for anybody after deletion.
      const privateThreadId = `${prefix}-private-thread-${randomUUID()}`;
      const deletedThreadId = `${prefix}-deleted-thread-${randomUUID()}`;
      created.threads.push(privateThreadId, deletedThreadId);
      await conversations.createThread({
        id: privateThreadId,
        ownerUserId: ownerA,
        agentId: privateAgentId,
        provenance: "local",
        localReadiness: "ready",
      });
      await conversations.createThread({
        id: deletedThreadId,
        ownerUserId: ownerA,
        agentId: deletedAgentId,
        provenance: "local",
        localReadiness: "ready",
      });
      const deletedHistory = await app2.request(
        `http://openbot.test/api/copilotkit/threads/${encodeURIComponent(deletedThreadId)}/messages`,
        { headers: { "x-session": "a" } },
      );
      expect(deletedHistory.status).toBe(200);
      const deletedRun = await app2.request(
        `http://openbot.test/api/copilotkit/agent/${encodeURIComponent(deletedAgentId)}/run`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-session": "a",
          },
          body: JSON.stringify({
            threadId: deletedThreadId,
            runId: `${deletedThreadId}-run`,
            state: {},
            messages: [
              { id: "deleted-input", role: "user", content: "no run" },
            ],
            tools: [],
            context: [],
            forwardedProps: {},
          }),
        },
      );
      expect(deletedRun.status).toBe(404);
      const privateHistoryForB = await app2.request(
        `http://openbot.test/api/copilotkit/threads/${encodeURIComponent(privateThreadId)}/messages`,
        { headers: { "x-session": "b" } },
      );
      expect(privateHistoryForB.status).toBe(404);
      const privateRunForB = await app2.request(
        `http://openbot.test/api/copilotkit/agent/${encodeURIComponent(privateAgentId)}/run`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-session": "b",
          },
          body: JSON.stringify({
            threadId: privateThreadId,
            runId: `${privateThreadId}-run`,
            state: {},
            messages: [
              { id: "private-input", role: "user", content: "no run" },
            ],
            tools: [],
            context: [],
            forwardedProps: {},
          }),
        },
      );
      expect(privateRunForB.status).toBe(404);

      // Both callers can run their own thread against the same public endpoint concurrently.
      const ownerBThreadId = `${prefix}-owner-b-thread-${randomUUID()}`;
      created.threads.push(ownerBThreadId);
      await conversations.createThread({
        id: ownerBThreadId,
        ownerUserId: ownerB,
        agentId: publicAgentId,
        provenance: "local",
        localReadiness: "ready",
      });
      remote.heldThreads.add(importedThreadId);
      remote.heldThreads.add(ownerBThreadId);
      const runAId = `${importedThreadId}-held`;
      const runBId = `${ownerBThreadId}-held`;
      const runAResponse = await app2.request(
        `http://openbot.test/api/copilotkit/agent/${encodeURIComponent(publicAgentId)}/run`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-session": "a" },
          body: JSON.stringify({
            threadId: importedThreadId,
            runId: runAId,
            state: {},
            messages: [{ id: "a-new-input", role: "user", content: "A" }],
            tools: [],
            context: [],
            forwardedProps: {},
          }),
        },
      );
      const runABody = sseEvents(runAResponse);
      const runBResponse = await app2.request(
        `http://openbot.test/api/copilotkit/agent/${encodeURIComponent(publicAgentId)}/run`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-session": "b" },
          body: JSON.stringify({
            threadId: ownerBThreadId,
            runId: runBId,
            state: {},
            messages: [{ id: "b-new-input", role: "user", content: "B" }],
            tools: [],
            context: [],
            forwardedProps: {},
          }),
        },
      );
      const runBBody = sseEvents(runBResponse);
      expect(runAResponse.status).toBe(200);
      expect(runBResponse.status).toBe(200);
      await waitFor(
        () =>
          remote.requests.filter(
            (request) =>
              request.threadId === importedThreadId ||
              request.threadId === ownerBThreadId,
          ).length >= 3,
        "concurrent remote streams did not start",
      );
      await waitFor(
        async () =>
          (await conversations.getActiveRun(
            { id: ownerA },
            importedThreadId,
          )) !== null &&
          (await conversations.getActiveRun({ id: ownerB }, ownerBThreadId)) !==
            null,
        "concurrent runs were not persisted as active",
      );

      const leakedHistory = await app2.request(
        `http://openbot.test/api/copilotkit/threads/${encodeURIComponent(importedThreadId)}/messages`,
        {
          headers: {
            "x-session": "b",
            "x-user-id": ownerA,
            "x-thread-id": importedThreadId,
            "x-agent-id": publicAgentId,
          },
        },
      );
      expect(leakedHistory.status).toBe(404);
      const forgedConnect = await app2.request(
        `http://openbot.test/api/copilotkit/agent/${encodeURIComponent(publicAgentId)}/connect`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-session": "b",
            "x-user-id": ownerA,
            "x-thread-id": importedThreadId,
          },
          body: JSON.stringify({
            threadId: importedThreadId,
            runId: "forged-connect",
            state: {},
            messages: [],
            tools: [],
            context: [],
            forwardedProps: {},
          }),
        },
      );
      expect(forgedConnect.status).toBe(404);
      const forgedStop = await app2.request(
        `http://openbot.test/api/copilotkit/agent/${encodeURIComponent(publicAgentId)}/stop/${encodeURIComponent(importedThreadId)}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-session": "b",
            "x-user-id": ownerA,
            "x-thread-id": importedThreadId,
            "x-agent-id": publicAgentId,
          },
          body: JSON.stringify({
            threadId: importedThreadId,
            agentId: publicAgentId,
          }),
        },
      );
      expect(forgedStop.status).toBe(404);

      for (const path of [
        "/api/copilotkit",
        "/api/copilotkit/unknown",
        "/api/copilotkit/cpk-debug-events",
        "/api/copilotkit/threads/clear",
      ]) {
        const denied = await app2.request(`http://openbot.test${path}`, {
          headers: { "x-session": "b" },
        });
        expect(denied.status).toBe(404);
      }

      const stopA = await app2.request(
        `http://openbot.test/api/copilotkit/agent/${encodeURIComponent(publicAgentId)}/stop/${encodeURIComponent(importedThreadId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-session": "a" },
          body: JSON.stringify({
            threadId: importedThreadId,
            agentId: publicAgentId,
          }),
        },
      );
      expect(stopA.status).toBe(200);
      expect((await stopA.json()).stopped).toBe(true);
      await waitFor(
        async () =>
          (await conversations.getActiveRun(
            { id: ownerA },
            importedThreadId,
          )) === null,
        "authorized Stop did not end A's run",
      );
      expect(
        await conversations.getActiveRun({ id: ownerB }, ownerBThreadId),
      ).not.toBeNull();

      // The client normally cancels A's upstream stream as part of Stop. Releasing it as well keeps
      // the fixture deterministic if an HTTP implementation defers its cancellation callback.
      remote.releaseThread(importedThreadId);
      remote.releaseThread(ownerBThreadId);
      await runBBody;
      await runABody;
      await waitFor(
        async () =>
          (await conversations.getActiveRun({ id: ownerB }, ownerBThreadId)) ===
          null,
        "B's stream did not survive and finish after A stopped",
      );
      const bSnapshot = await conversations.readSnapshot(
        { id: ownerB },
        ownerBThreadId,
      );
      expect(bSnapshot.snapshot.messages.map((message) => message.id)).toEqual([
        "b-new-input",
        `${runBId}-fixture-reply`,
      ]);

      // A third handler/engine instance reconnects after the concurrent runs have finished.
      const engine3 = createConversationEngine({
        store: conversations,
        pollMs: 5,
        replicaId: `${prefix}-engine-3`,
      });
      const app3 = appWithRuntime({
        engine: engine3,
        config,
        publicAgent,
        privateAgent,
        deletedAgent,
        sessions,
      });
      const bReconnect = await app3.request(
        `http://openbot.test/api/copilotkit/agent/${encodeURIComponent(publicAgentId)}/connect`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-session": "b" },
          body: JSON.stringify({
            threadId: ownerBThreadId,
            runId: `${ownerBThreadId}-reconnect`,
            state: {},
            messages: [],
            tools: [],
            context: [],
            forwardedProps: {},
          }),
        },
      );
      expect(bReconnect.status).toBe(200);
      const bReconnectEvents = await sseEvents(bReconnect);
      expect(
        bReconnectEvents.find((event) => event.type === "MESSAGES_SNAPSHOT")
          ?.messages,
      ).toEqual(bSnapshot.snapshot.messages);
      expect(sourceServer).toBeUndefined();
      expect(sourceRequestCount).toBeGreaterThan(0);
      expect(sourceRequests).toHaveLength(sourceRequestCount);
      expect(sourceRequests.every((request) => request.method === "GET")).toBe(
        true,
      );

      const responseBodies = [
        JSON.stringify(historyJson),
        JSON.stringify(reconnectEvents),
        JSON.stringify(continuationEvents),
        JSON.stringify(await forgedConnect.clone().text()),
        JSON.stringify(await forgedStop.clone().text()),
      ].join("\n");
      expect(responseBodies).not.toContain("fixture-source-secret");
      expect(responseBodies).not.toMatch(/Bearer\s+fixture-source-secret/i);
    } finally {
      sourceServer?.stop();
      remote.stop();
    }
  });

  test("mounted routes bind to the canonical channel agent while the engine keeps member grants", async () => {
    const remote = scriptedRemoteEndpoint();
    try {
      const ownerA = await seedUser("mounted-a", "user");
      const ownerB = await seedUser("mounted-b", "user");
      const canonicalId = await seedAgent({
        label: "Mounted canonical",
        endpoint: remote.url,
        visibility: "public",
      });
      const memberId = await seedAgent({
        label: "Mounted member",
        endpoint: remote.url,
        visibility: "private",
        ownerUserId: ownerA,
      });
      const outsideId = await seedAgent({
        label: "Mounted outside",
        endpoint: remote.url,
        visibility: "public",
      });
      const canonicalAgent: RegisteredAgent = {
        id: canonicalId,
        name: "Mounted canonical",
        type: "remote_ag_ui",
        endpoint: remote.url,
        standingMessage: {
          id: `standing-role:${canonicalId}`,
          role: "system",
          content: "Mounted canonical role",
        },
      };
      const memberAgent: RegisteredAgent = {
        id: memberId,
        name: "Mounted member",
        type: "remote_ag_ui",
        endpoint: remote.url,
        standingMessage: {
          id: `standing-role:${memberId}`,
          role: "system",
          content: "Mounted member role",
        },
      };
      const outsideAgent: RegisteredAgent = {
        id: outsideId,
        name: "Mounted outside",
        type: "remote_ag_ui",
        endpoint: remote.url,
        standingMessage: {
          id: `standing-role:${outsideId}`,
          role: "system",
          content: "Mounted outside role",
        },
      };

      const threadA = `${prefix}-mounted-channel-${randomUUID()}`;
      const channelId = await seedMappedChannel(ownerA, canonicalId, threadA, [
        memberId,
      ]);
      created.threads.push(threadA);
      await conversations.createThread({
        id: threadA,
        ownerUserId: ownerA,
        channelId,
        agentId: canonicalId,
        provenance: "local",
        localReadiness: "ready",
      });
      const storedChannelAgentIds = (
        await database
          .select({ agentId: channelAgents.agentId })
          .from(channelAgents)
          .where(eq(channelAgents.channelId, channelId))
      )
        .map((row) => row.agentId)
        .sort();
      expect(storedChannelAgentIds).toEqual([canonicalId, memberId].sort());
      const threadB = `${prefix}-mounted-foreign-${randomUUID()}`;
      created.threads.push(threadB);
      await conversations.createThread({
        id: threadB,
        ownerUserId: ownerB,
        agentId: canonicalId,
        provenance: "local",
        localReadiness: "ready",
      });

      const sessions = {
        a: { id: ownerA, role: "user" as const },
        b: { id: ownerB, role: "user" as const },
      };
      const config = loadConfig(
        testEnvironment({ DATABASE_URL: testDatabaseUrl() }),
      );
      const engine = createConversationEngine({
        store: conversations,
        pollMs: 5,
        replicaId: `${prefix}-mounted-engine`,
      });
      const app = appWithRuntime({
        engine,
        config,
        publicAgent: canonicalAgent,
        privateAgent: memberAgent,
        // This is a live, visible Bot that is deliberately absent from the
        // channel roster (not a deleted/unavailable fixture).
        deletedAgent: outsideAgent,
        sessions,
      });
      const body = (threadId: string, runId: string) =>
        JSON.stringify({
          threadId,
          runId,
          state: {},
          messages: [{ id: `${runId}-question`, role: "user", content: runId }],
          tools: [],
          context: [],
          forwardedProps: {},
        });
      const runPath = (agentId: string) =>
        `/api/copilotkit/agent/${encodeURIComponent(agentId)}/run`;
      const stopPath = (agentId: string, threadId: string) =>
        `/api/copilotkit/agent/${encodeURIComponent(agentId)}/stop/${encodeURIComponent(threadId)}`;

      // The stored first channel agent is the public route binding.
      const canonicalRunId = `${threadA}-canonical`;
      const canonicalResponse = await app.request(
        `http://openbot.test${runPath(canonicalId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-session": "a" },
          body: body(threadA, canonicalRunId),
        },
      );
      expect(canonicalResponse.status).toBe(200);
      expect(
        (await sseEvents(canonicalResponse)).some(
          (event) => event.type === "RUN_FINISHED",
        ),
      ).toBe(true);

      // The member is authorized by the real store for internal multi-Bot
      // execution, but cannot switch the public route away from thread.agentId.
      expect(
        await conversations.authorize({ id: ownerA }, threadA, "run", memberId),
      ).toBe("run");
      const deniedRequestCount = remote.requests.length;
      const memberRoute = await app.request(
        `http://openbot.test${runPath(memberId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-session": "a" },
          body: body(threadA, `${threadA}-member-route`),
        },
      );
      expect(memberRoute.status).toBe(404);

      // The local hook's virtual id is not a registered runtime agent and
      // cannot be used as another channel's public route.
      const foreignVirtualAgentId = `channel:${prefix}-foreign-channel`;
      const virtualRoute = await app.request(
        `http://openbot.test${runPath(foreignVirtualAgentId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-session": "a" },
          body: body(threadA, `${threadA}-virtual-route`),
        },
      );
      expect(virtualRoute.status).toBe(404);

      // A visible Bot outside channelAgents is denied by store authorization
      // before the runtime can construct or contact it.
      const outsideRoute = await app.request(
        `http://openbot.test${runPath(outsideId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-session": "a" },
          body: body(threadA, `${threadA}-outside-route`),
        },
      );
      expect(outsideRoute.status).toBe(404);
      expect(remote.requests).toHaveLength(deniedRequestCount);

      remote.heldThreads.add(threadA);
      const runA1Id = `${threadA}-a1`;
      const runA1Response = await app.request(
        `http://openbot.test${runPath(canonicalId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-session": "a" },
          body: body(threadA, runA1Id),
        },
      );
      const runA1Body = sseEvents(runA1Response);
      await waitFor(
        () => remote.requests.some((request) => request.runId === runA1Id),
        "mounted A1 did not reach the remote agent",
      );
      await waitFor(
        async () =>
          (await engine.isRunning({
            actor: { id: ownerA },
            threadId: threadA,
            agentId: canonicalId,
          })) === true,
        "mounted A1 did not become active",
      );
      await expect(
        engine.isRunning({
          actor: { id: ownerB },
          threadId: threadA,
          agentId: canonicalId,
        }),
      ).rejects.toThrow();

      // A foreign actor cannot use the mounted Stop route or observe A's
      // running state through the engine boundary.
      const foreignStop = await app.request(
        `http://openbot.test${stopPath(canonicalId, threadA)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-session": "b" },
        },
      );
      expect(foreignStop.status).toBe(404);
      expect(
        await engine.isRunning({
          actor: { id: ownerA },
          threadId: threadA,
          agentId: canonicalId,
        }),
      ).toBe(true);

      // Hold the mounted dispatcher's active-run lookup after it captures A1.
      let releaseDelayedStop!: () => void;
      let delayedStopEntered!: () => void;
      const delayedStop = new Promise<void>((resolve) => {
        releaseDelayedStop = resolve;
      });
      const delayedStopSeen = new Promise<void>((resolve) => {
        delayedStopEntered = resolve;
      });
      const delayedStore = {
        ...conversations,
        getActiveRun: async (actor: { id: string }, threadId: string) => {
          const active = await conversations.getActiveRun(actor, threadId);
          if (
            actor.id === ownerA &&
            threadId === threadA &&
            active?.id === runA1Id
          ) {
            delayedStopEntered();
            await delayedStop;
          }
          return active;
        },
      };
      const delayedApp = appWithRuntime({
        engine,
        config,
        publicAgent: canonicalAgent,
        privateAgent: memberAgent,
        deletedAgent: outsideAgent,
        sessions,
        conversationStore: delayedStore,
      });
      const stopA1 = delayedApp.request(
        `http://openbot.test${stopPath(canonicalId, threadA)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-session": "a" },
        },
      );
      await delayedStopSeen;

      // Finish A1 while the HTTP Stop is paused, then start A2. Releasing
      // dispatch resumes with the captured run id, so it must be a no-op.
      await engine.stop({
        actor: { id: ownerA },
        threadId: threadA,
        agentId: canonicalId,
        runId: runA1Id,
      });
      remote.releaseThread(threadA);
      await runA1Body;
      await waitFor(
        async () =>
          (await engine.isRunning({
            actor: { id: ownerA },
            threadId: threadA,
            agentId: canonicalId,
          })) === false,
        "A1 did not finish before delayed Stop release",
      );
      remote.heldThreads.add(threadA);
      const runA2Id = `${threadA}-a2`;
      const runA2Response = await delayedApp.request(
        `http://openbot.test${runPath(canonicalId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-session": "a" },
          body: body(threadA, runA2Id),
        },
      );
      const runA2Body = sseEvents(runA2Response);
      await waitFor(
        () => remote.requests.some((request) => request.runId === runA2Id),
        "mounted A2 did not reach the remote agent",
      );
      await waitFor(
        async () =>
          (await engine.isRunning({
            actor: { id: ownerA },
            threadId: threadA,
            agentId: canonicalId,
          })) === true,
        "mounted A2 did not become active",
      );

      remote.heldThreads.add(threadB);
      const runBId = `${threadB}-b`;
      const runBResponse = await delayedApp.request(
        `http://openbot.test${runPath(canonicalId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-session": "b" },
          body: body(threadB, runBId),
        },
      );
      const runBBody = sseEvents(runBResponse);
      await waitFor(
        () => remote.requests.some((request) => request.runId === runBId),
        "mounted foreign B run did not reach the remote agent",
      );
      await waitFor(
        async () =>
          (await engine.isRunning({
            actor: { id: ownerB },
            threadId: threadB,
            agentId: canonicalId,
          })) === true,
        "mounted foreign B run did not become active",
      );

      releaseDelayedStop();
      const staleStopResponse = await stopA1;
      expect(staleStopResponse.status).toBe(200);
      expect((await staleStopResponse.json()).stopped).toBe(false);
      expect(
        await engine.isRunning({
          actor: { id: ownerA },
          threadId: threadA,
          agentId: canonicalId,
        }),
      ).toBe(true);
      expect(
        await engine.isRunning({
          actor: { id: ownerB },
          threadId: threadB,
          agentId: canonicalId,
        }),
      ).toBe(true);

      remote.releaseThread(threadA);
      remote.releaseThread(threadB);
      await runA2Body;
      await runBBody;
    } finally {
      remote.stop();
    }
  });
});
