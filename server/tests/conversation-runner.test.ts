import { describe, expect, test } from "bun:test";
import { AbstractAgent } from "@ag-ui/client";
import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import { Observable, firstValueFrom } from "rxjs";
import { createConversationEngine } from "../src/conversations/engine";
import { actorBoundRunner, denyAllRunner } from "../src/conversations/runner";
import { ConversationAccessError } from "../src/conversations/types";
import type { ConversationStore } from "../src/conversations/store";

function validTurn(threadId: string, runId: string, text = "ok"): BaseEvent[] {
  return [
    { type: "RUN_STARTED", threadId, runId },
    { type: "TEXT_MESSAGE_START", messageId: `${runId}-m`, role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: `${runId}-m`, delta: text },
    { type: "TEXT_MESSAGE_END", messageId: `${runId}-m` },
    { type: "RUN_FINISHED", threadId, runId },
  ];
}

class ScriptedAgent extends AbstractAgent {
  lastInput: RunAgentInput | undefined;
  constructor(
    agentId: string,
    private readonly script: BaseEvent[],
  ) {
    super({ agentId, threadId: "pending" });
  }
  run(input: RunAgentInput) {
    this.lastInput = input;
    return new Observable<BaseEvent>((subscriber) => {
      for (const event of this.script) subscriber.next(event);
      subscriber.complete();
    });
  }
}

function fakeEngine() {
  return createConversationEngine({
    store: {
      authorize: async () => "none",
      readSnapshot: async () => {
        throw new ConversationAccessError();
      },
      acquireRun: async () => {
        throw new ConversationAccessError();
      },
      getActiveRun: async () => null,
      requestStop: async () => false,
      readEventPage: async () => [],
    } as unknown as ConversationStore,
  });
}

describe("actorBoundRunner scope", () => {
  test("deny-all rejects all four methods", async () => {
    const engine = fakeEngine();
    const runner = denyAllRunner(engine);
    const agent = new ScriptedAgent("agent-a", validTurn("t", "r"));
    const input: RunAgentInput = {
      threadId: "t",
      runId: "r",
      messages: [{ id: "u", role: "user", content: "hi" }],
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
    };
    await expect(
      firstValueFrom(runner.run({ threadId: "t", agent, input })),
    ).rejects.toBeInstanceOf(ConversationAccessError);
    await expect(
      firstValueFrom(runner.connect({ threadId: "t" })),
    ).rejects.toBeInstanceOf(ConversationAccessError);
    await expect(runner.isRunning({ threadId: "t" })).rejects.toBeInstanceOf(
      ConversationAccessError,
    );
    await expect(runner.stop({ threadId: "t" })).rejects.toBeInstanceOf(
      ConversationAccessError,
    );
  });

  test("mismatched thread or agent never reaches the engine", async () => {
    const engine = fakeEngine();
    const runner = actorBoundRunner(engine, {
      actor: { id: "user-a" },
      agentId: "agent-a",
      threadId: "thread-a",
      allow: new Set(["run", "connect", "isRunning", "stop"]),
      stopRunId: "run-a",
    });
    const agent = new ScriptedAgent("agent-b", validTurn("thread-b", "run-b"));
    const input: RunAgentInput = {
      threadId: "thread-b",
      runId: "run-b",
      messages: [{ id: "u", role: "user", content: "hi" }],
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
    };
    await expect(
      firstValueFrom(runner.run({ threadId: "thread-b", agent, input })),
    ).rejects.toBeInstanceOf(ConversationAccessError);
    await expect(
      firstValueFrom(
        runner.connect({ threadId: "thread-b", agentId: "agent-a" }),
      ),
    ).rejects.toBeInstanceOf(ConversationAccessError);
    await expect(
      runner.isRunning({ threadId: "thread-b" }),
    ).rejects.toBeInstanceOf(ConversationAccessError);
    await expect(
      runner.stop({ threadId: "thread-a", runId: "run-other" }),
    ).rejects.toBeInstanceOf(ConversationAccessError);
  });

  test("a no-active-run pin still rechecks current access", async () => {
    const engine = fakeEngine();
    const none = actorBoundRunner(engine, {
      actor: { id: "user-a" },
      agentId: "agent-a",
      threadId: "thread-a",
      allow: new Set(["stop"]),
      stopRunId: null,
    });
    await expect(none.stop({ threadId: "thread-a" })).rejects.toBeInstanceOf(
      ConversationAccessError,
    );
  });

  test("an executable scope cannot be constructed without an authenticated actor", () => {
    expect(() =>
      actorBoundRunner(fakeEngine(), {
        actor: { id: "" },
        agentId: "agent-a",
        threadId: "thread-a",
        allow: new Set(["run"]),
        stopRunId: null,
      }),
    ).toThrow(ConversationAccessError);
  });
});
