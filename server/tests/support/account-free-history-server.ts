import { createHash } from "node:crypto";
import { AbstractAgent } from "@ag-ui/client";
import type { BaseEvent, Message, RunAgentInput } from "@ag-ui/client";
import { eq } from "drizzle-orm";
import { Observable } from "rxjs";
import { createAgentProfileStore } from "../../src/agents/profile-store";
import type { AuthService } from "../../src/auth/guards";
import { createRoleRepository } from "../../src/auth/guards";
import { createStallGuard } from "../../src/channels/stall-guard";
import { createThreadIdentity } from "../../src/channels/thread-identity";
import { createApp } from "../../src/app";
import { mountCopilotRuntime } from "../../src/copilot";
import { createConversationEngine } from "../../src/conversations/engine";
import { createConversationStore } from "../../src/conversations/store";
import { conversationThreads } from "../../src/db/schema";
import {
  agentProfiles,
  agents,
  conversationBaselines,
  conversationEvents,
  conversationRuns,
  userRoles,
  users,
} from "../../src/db/schema";
import { createDatabase } from "../../src/db/client";
import { loadConfig } from "../../src/config";
import { testDatabaseUrl } from "./database";
import { testEnvironment } from "./environment";

/**
 * This process is intentionally a very small host for the real conversation routes. It does not
 * import the production entrypoint: that entrypoint starts every deployment worker and scheduler,
 * while this fixture only needs one Hono app and one PostgreSQL-backed conversation engine.
 */

type Fixture = {
  namespace: string;
  ownerUserId: string;
  foreignUserId: string;
  agentId: string;
  threadId: string;
  runId: string;
  userMessageId: string;
  assistantToolMessageId: string;
  toolResultMessageId: string;
  assistantFinalMessageId: string;
  continuationUserMessageId: string;
  continuationAssistantMessageId: string;
  ownerSessionToken: string;
  foreignSessionToken: string;
};

const fixtureInput = process.env.ACCOUNT_FREE_FIXTURE;
if (!fixtureInput) {
  throw new Error("ACCOUNT_FREE_FIXTURE is required.");
}

let fixture: Fixture;
try {
  const value: unknown = JSON.parse(fixtureInput);
  if (!value || typeof value !== "object") throw new Error();
  fixture = value as Fixture;
} catch {
  throw new Error("ACCOUNT_FREE_FIXTURE must be valid JSON.");
}

const mode = process.env.ACCOUNT_FREE_MODE ?? "serve";
const databaseUrl = testDatabaseUrl();
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}
const digest = (messages: readonly Message[]) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(messages)))
    .digest("hex");

const baseMessages = (): Message[] => [
  {
    id: fixture.userMessageId,
    role: "user",
    content: "Account-free user fixture request.",
  },
  {
    id: fixture.assistantToolMessageId,
    role: "assistant",
    content: "Assistant fixture is checking the account-free ledger.",
    toolCalls: [
      {
        id: `${fixture.namespace}-tool-call`,
        type: "function",
        function: {
          name: "account_free_lookup",
          arguments: '{"record":"fixture-42"}',
        },
      },
    ],
  },
  {
    id: fixture.toolResultMessageId,
    role: "tool",
    toolCallId: `${fixture.namespace}-tool-call`,
    content: "Detailed fixture tool result: record fixture-42 is settled.",
  },
  {
    id: fixture.assistantFinalMessageId,
    role: "assistant",
    content: "Assistant fixture final answer: the record is settled.",
  },
];

function continuationMessages(): Message[] {
  return [
    {
      id: fixture.continuationUserMessageId,
      role: "user",
      content: "Continue the account-free fixture conversation.",
    },
  ];
}

function allExpectedMessages(): Message[] {
  return [
    ...baseMessages(),
    ...continuationMessages(),
    {
      id: fixture.continuationAssistantMessageId,
      role: "assistant",
      content: "Deterministic engine continuation completed.",
    },
  ];
}

class DeterministicAgent extends AbstractAgent {
  constructor(agentId: string, threadId: string) {
    super({ agentId, threadId });
  }

  run(input: RunAgentInput) {
    const textId = fixture.continuationAssistantMessageId;
    const events: BaseEvent[] = [
      { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
      { type: "TEXT_MESSAGE_START", messageId: textId, role: "assistant" },
      {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: textId,
        delta: "Deterministic engine continuation completed.",
      },
      { type: "TEXT_MESSAGE_END", messageId: textId },
      { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
    ];
    return new Observable<BaseEvent>((subscriber) => {
      for (const event of events) subscriber.next(event);
      subscriber.complete();
    });
  }
}

async function seed(database: ReturnType<typeof createDatabase>) {
  const existing = await database
    .select({ id: conversationThreads.id })
    .from(conversationThreads)
    .where(eq(conversationThreads.id, fixture.threadId))
    .limit(1);
  if (existing.length > 0) return;

  await database.insert(users).values([
    {
      id: fixture.ownerUserId,
      email: `${fixture.ownerUserId}@example.test`,
      name: "Account-free fixture owner",
    },
    {
      id: fixture.foreignUserId,
      email: `${fixture.foreignUserId}@example.test`,
      name: "Account-free foreign user",
    },
  ]);
  await database.insert(userRoles).values([
    { userId: fixture.ownerUserId, role: "user" },
    { userId: fixture.foreignUserId, role: "user" },
  ]);
  await database.insert(agents).values({
    id: fixture.agentId,
    name: "Account-free fixture agent",
    type: "remote_ag_ui",
    configuration: { endpoint: "http://127.0.0.1:9/account-free-never-called" },
  });
  await database.insert(agentProfiles).values({
    agentId: fixture.agentId,
    ownerUserId: fixture.ownerUserId,
    title: "Account-free fixture agent",
    roleDescription: "A deterministic history-only acceptance fixture.",
    avatarSeed: fixture.agentId,
    visibility: "private",
  });

  const store = createConversationStore(database);
  const actor = { id: fixture.ownerUserId };
  await store.createThread({
    id: fixture.threadId,
    ownerUserId: fixture.ownerUserId,
    agentId: fixture.agentId,
    provenance: "local",
  });
  await store.publishBaseline(actor, fixture.threadId, {
    messages: baseMessages(),
    state: { fixture: "account-free" },
    baselineSequence: 0n,
    contentHash: digest(baseMessages()),
  });

  // The baseline is the complete user/tool transcript. The engine continuation adds a durable
  // event-derived assistant turn, proving this fixture exercises both store projection and engine
  // persistence without contacting a provider or a remote agent.
  await database
    .update(conversationThreads)
    .set({ localReadiness: "ready" })
    .where(eq(conversationThreads.id, fixture.threadId));
  const engine = createConversationEngine({
    store,
    pollMs: 5,
    replicaId: `${fixture.namespace}-engine`,
  });
  const continuation = continuationMessages();
  await new Promise<void>((resolve, reject) => {
    engine
      .run({
        actor,
        threadId: fixture.threadId,
        agentId: fixture.agentId,
        agent: new DeterministicAgent(fixture.agentId, fixture.threadId),
        input: {
          threadId: fixture.threadId,
          runId: fixture.runId,
          messages: continuation,
          state: {},
          tools: [],
          context: [],
          forwardedProps: {},
        },
      })
      .subscribe({ complete: resolve, error: reject });
  });
  await database
    .update(conversationThreads)
    .set({ localReadiness: "history_only" })
    .where(eq(conversationThreads.id, fixture.threadId));
}

async function clean(database: ReturnType<typeof createDatabase>) {
  // The exact fixture ids are supplied by the parent. Each deletion is independently safe so a
  // process killed during seeding still leaves no partial namespace behind.
  await database
    .delete(conversationThreads)
    .where(eq(conversationThreads.id, fixture.threadId));
  await database
    .delete(conversationEvents)
    .where(eq(conversationEvents.threadId, fixture.threadId));
  await database
    .delete(conversationBaselines)
    .where(eq(conversationBaselines.threadId, fixture.threadId));
  await database
    .delete(conversationRuns)
    .where(eq(conversationRuns.threadId, fixture.threadId));
  await database
    .delete(agentProfiles)
    .where(eq(agentProfiles.agentId, fixture.agentId));
  await database.delete(agents).where(eq(agents.id, fixture.agentId));
  await database
    .delete(userRoles)
    .where(eq(userRoles.userId, fixture.ownerUserId));
  await database
    .delete(userRoles)
    .where(eq(userRoles.userId, fixture.foreignUserId));
  await database.delete(users).where(eq(users.id, fixture.ownerUserId));
  await database.delete(users).where(eq(users.id, fixture.foreignUserId));
}

function actorFor(request: Request) {
  const cookie = request.headers.get("cookie") ?? "";
  const token = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("account-free-session="))
    ?.slice("account-free-session=".length);
  if (token === fixture.ownerSessionToken) {
    return { id: fixture.ownerUserId, role: "user" as const };
  }
  if (token === fixture.foreignSessionToken) {
    return { id: fixture.foreignUserId, role: "user" as const };
  }
  return null;
}

function fixtureAuth(): AuthService {
  return {
    handler: () => new Response(null, { status: 204 }),
    api: {
      getSession: async ({ headers }) => {
        const actor = actorFor(new Request("http://fixture.test", { headers }));
        if (!actor) return null;
        return {
          user: {
            id: actor.id,
            email: `${actor.id}@example.test`,
          },
        };
      },
    },
  };
}

async function runServer() {
  const database = createDatabase(databaseUrl, { max: 2 });
  const conversations = createConversationStore(database);
  const config = loadConfig(
    testEnvironment({
      DATABASE_URL: databaseUrl,
      PORT: process.env.ACCOUNT_FREE_PORT ?? "0",
    }),
  );
  const roleRepository = createRoleRepository(database);
  const profiles = createAgentProfileStore(database, undefined);
  const identity = createThreadIdentity(`${fixture.namespace}-deployment`);
  const stallGuard = createStallGuard({ stallMs: 0 });
  const identifyActor = async (request: Request) => {
    const actor = actorFor(request);
    if (!actor) throw new Error("unauthenticated");
    return actor;
  };
  const runtime = mountCopilotRuntime(
    config,
    { provider: "openai", defaultModel: "account-free-fixture-model" },
    async (actor) =>
      actor.id === fixture.ownerUserId
        ? [
            {
              id: fixture.agentId,
              name: "Account-free fixture agent",
              type: "unavailable" as const,
              reason: "History-only acceptance fixture.",
            },
          ]
        : [],
    async () => null,
    identifyActor,
    stallGuard,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      store: conversations,
      engine: createConversationEngine({ store: conversations, pollMs: 5 }),
    },
  );
  const args: Parameters<typeof createApp> = [
    config,
    fixtureAuth(),
    roleRepository,
  ];
  args[6] = runtime.handler;
  args[9] = profiles;
  args[16] = identity;
  args[29] = conversations;
  const app = createApp(...args);
  const port = Number(process.env.ACCOUNT_FREE_PORT ?? "0");
  let listener: ReturnType<typeof Bun.serve> | undefined;
  const shutdown = async () => {
    listener?.stop(true);
    stallGuard.stop();
    await database.$client.close();
    process.exit(0);
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void shutdown();
    });
  }
  listener = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/__fixture/ready") {
        if (actorFor(request)?.id !== fixture.ownerUserId) {
          return new Response("Not found", { status: 404 });
        }
        return Response.json({
          ownerUserId: fixture.ownerUserId,
          foreignUserId: fixture.foreignUserId,
          agentId: fixture.agentId,
          threadId: fixture.threadId,
          messages: allExpectedMessages(),
          digest: digest(allExpectedMessages()),
        });
      }
      if (url.pathname === "/__fixture/state") {
        if (actorFor(request)?.id !== fixture.ownerUserId) {
          return new Response("Not found", { status: 404 });
        }
        const snapshot = await conversations.readSnapshot(
          { id: fixture.ownerUserId },
          fixture.threadId,
        );
        return Response.json({
          messages: snapshot.snapshot.messages,
          digest: digest(snapshot.snapshot.messages),
          thread: {
            id: snapshot.thread.id,
            ownerUserId: snapshot.thread.ownerUserId,
            agentId: snapshot.thread.agentId,
            provenance: snapshot.thread.provenance,
            localReadiness: snapshot.thread.localReadiness,
          },
        });
      }
      return app.fetch(request);
    },
  });
  console.info("account-free-history fixture ready");
  await new Promise<void>(() => undefined);
}

const database = createDatabase(databaseUrl, { max: 2 });
if (mode === "cleanup") {
  try {
    await clean(database);
  } finally {
    await database.$client.close();
  }
} else {
  try {
    if (mode === "seed") await seed(database);
  } finally {
    await database.$client.close();
  }
  await runServer();
}
