import { AbstractAgent } from "@ag-ui/client";
import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import { Observable } from "rxjs";
import { eq } from "drizzle-orm";
import { createConversationEngine } from "../../src/conversations/engine";
import { createConversationStore } from "../../src/conversations/store";
import { createDatabase } from "../../src/db/client";
import { conversationThreads } from "../../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./database";

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

const rawFixture = process.env.CONVERSATION_PROCESS_FIXTURE;
if (!rawFixture) throw new Error("Conversation process fixture is required.");

let fixture: Fixture;
try {
  const parsed: unknown = JSON.parse(rawFixture);
  if (!parsed || typeof parsed !== "object") throw new Error();
  fixture = parsed as Fixture;
} catch {
  throw new Error("Conversation process fixture is invalid.");
}

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createConversationStore(database);
const actor = { id: fixture.ownerUserId };

const inputMessage = {
  id: fixture.userMessageId,
  role: "user" as const,
  content: "Process-death input.",
};

class DeterministicProcessAgent extends AbstractAgent {
  constructor(agentId: string, threadId: string) {
    super({ agentId, threadId });
  }

  run(input: RunAgentInput) {
    const events: BaseEvent[] = [
      { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
      {
        type: "TEXT_MESSAGE_START",
        messageId: fixture.assistantToolMessageId,
        role: "assistant",
      },
      {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: fixture.assistantToolMessageId,
        delta: "Committed tool request.",
      },
      {
        type: "TOOL_CALL_START",
        toolCallId: fixture.toolCallId,
        toolCallName: "deterministic_lookup",
        parentMessageId: fixture.assistantToolMessageId,
      },
      {
        type: "TOOL_CALL_ARGS",
        toolCallId: fixture.toolCallId,
        delta: '{"key":"process-death-fixture"}',
      },
      { type: "TOOL_CALL_END", toolCallId: fixture.toolCallId },
      {
        type: "TEXT_MESSAGE_END",
        messageId: fixture.assistantToolMessageId,
      },
      {
        type: "TOOL_CALL_RESULT",
        messageId: fixture.toolResultMessageId,
        toolCallId: fixture.toolCallId,
        content: "Deterministic tool result.",
        role: "tool",
      },
      {
        type: "TEXT_MESSAGE_START",
        messageId: fixture.partialAssistantMessageId,
        role: "assistant",
      },
      {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: fixture.partialAssistantMessageId,
        delta: "Partial output survives process death.",
      },
    ];

    return new Observable<BaseEvent>((subscriber) => {
      let stopped = false;
      const emit = async () => {
        for (const event of events) {
          if (stopped) return;
          subscriber.next(event);
        }
        await new Promise<void>(() => undefined);
      };
      void emit();
      return () => {
        stopped = true;
      };
    });
  }
}

const expectedPersistedTypes = [
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
];

async function waitForCommittedEvents(timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = await store.readEventPage(actor, fixture.threadId, 0n, 100);
    const runEvents = page.filter((event) => event.runId === fixture.runId);
    if (
      runEvents.length === expectedPersistedTypes.length &&
      runEvents.every(
        (event, index) => event.type === expectedPersistedTypes[index],
      )
    ) {
      return page.at(-1)!.sequence;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Conversation process fixture did not reach its watermark.");
}

async function main() {
  const thread = await database
    .select({ id: conversationThreads.id })
    .from(conversationThreads)
    .where(eq(conversationThreads.id, fixture.threadId))
    .limit(1);
  if (thread.length === 0)
    throw new Error("Conversation process fixture is missing.");

  const engine = createConversationEngine({
    store,
    leaseMs: 2_000,
    heartbeatMs: 250,
    pollMs: 20,
    replicaId: `${fixture.namespace}-child`,
  });
  const run = engine.run({
    actor,
    threadId: fixture.threadId,
    agentId: fixture.agentId,
    agent: new DeterministicProcessAgent(fixture.agentId, fixture.threadId),
    input: {
      threadId: fixture.threadId,
      runId: fixture.runId,
      messages: [inputMessage],
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
    },
  });
  const runSubscription = run.subscribe({
    error: () => undefined,
  });
  void runSubscription;

  const watermark = await waitForCommittedEvents(8_000);
  const active = await store.getActiveRun(actor, fixture.threadId);
  if (
    !active ||
    active.id !== fixture.runId ||
    active.status !== "running" ||
    !active.leaseUntil
  ) {
    throw new Error("Conversation process fixture did not hold its lease.");
  }

  // Readiness contains only identifiers and a commit watermark, never transcript or credentials.
  console.log(
    JSON.stringify({
      type: "ready",
      namespace: fixture.namespace,
      threadId: fixture.threadId,
      runId: fixture.runId,
      replicaId: engine.replicaId,
      generation: active.generation,
      watermark: watermark.toString(),
      leaseUntil: active.leaseUntil.toISOString(),
    }),
  );

  // Keep the active Observable and lease maintenance alive until the parent sends SIGKILL.
  await new Promise<void>(() => undefined);
}

void main().catch(async () => {
  console.log(
    JSON.stringify({
      type: "error",
      namespace: fixture.namespace,
      message: "Conversation process fixture failed before readiness.",
    }),
  );
  await database.$client.close();
  process.exitCode = 1;
});
