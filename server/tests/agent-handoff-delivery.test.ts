import { describe, expect, test } from "bun:test";
import type { AbstractAgent, BaseEvent, Message } from "@ag-ui/client";
import { Observable } from "rxjs";
import { createHandoffDelivery } from "../src/agents/handoff-delivery";
import type { EngineRunRequest } from "../src/conversations/engine";
import type { HandoffWork } from "../src/agents/handoff-runner";

const ACTOR = { id: "person-1" };
const WORK: HandoffWork = {
  fromBotId: "assistant",
  toBotId: "researcher",
  actorId: ACTOR.id,
  threadId: "asking-thread",
  runId: "asking-run",
  depth: 1,
  initiator: { kind: "routine", id: "routine-1" },
  task: "find the outage window",
  constraints: "yesterday only",
  expecting: "a date range",
  fromName: "Assistant",
  toName: "Researcher",
};

const PRIOR: Message[] = [
  { id: "prior-user", role: "user", content: "we had an outage yesterday" },
  { id: "prior-assistant", role: "assistant", content: "I will find out when" },
];

const FINISHED = [
  { type: "RUN_FINISHED", threadId: "scratch-thread", runId: "delivery-run" },
] as unknown as BaseEvent[];

type Snapshot = {
  messages: Message[];
  state: Record<string, unknown>;
};

type HarnessOptions = {
  events?: BaseEvent[];
  asking?: Message[];
  final?: Message[];
  agent?: AbstractAgent | null;
  deadlineMs?: number;
  onRun?: (request: EngineRunRequest) => void;
};

/**
 * Delivery's contract is deliberately tested with only the engine surface it consumes. In
 * particular, there is no runner, lock, or history callback here: the engine owns the lease and the
 * store is authoritative for both context and the final answer.
 */
function harness(options: HarnessOptions = {}) {
  const events = options.events ?? FINISHED;
  const calls: EngineRunRequest[] = [];
  const created: unknown[] = [];
  const stopped: Array<Record<string, unknown>> = [];
  const aborted: Array<{ threadId: string; runId: string }> = [];
  const busy: Array<{ threadId: string; busy: boolean }> = [];
  const announced: Array<{
    actorId: string;
    threadId: string;
    agentId: string;
    text: string;
  }> = [];
  const snapshots = new Map<string, Snapshot>([
    [WORK.threadId, { messages: options.asking ?? PRIOR, state: {} }],
  ]);
  const defaultAgent = {} as unknown as AbstractAgent;
  const agent = options.agent === undefined ? defaultAgent : options.agent;
  const store = {
    async readSnapshot(_actor: { id: string }, threadId: string) {
      const snapshot = snapshots.get(threadId) ?? { messages: [], state: {} };
      return {
        thread: {},
        snapshot: structuredClone(snapshot),
        baselineSequence: 0n,
        latestSequence: 0n,
      };
    },
    async createThread(input: unknown) {
      created.push(input);
      snapshots.set(String((input as { id: string }).id), {
        messages: [],
        state: {},
      });
      return {} as never;
    },
  };
  const engine = {
    store,
    run(request: EngineRunRequest) {
      calls.push(request);
      options.onRun?.(request);
      if (options.final !== undefined) {
        snapshots.set(request.threadId, {
          messages: options.final,
          state: {},
        });
      }
      return new Observable<BaseEvent>((subscriber) => {
        for (const event of events) subscriber.next(event);
        subscriber.complete();
      });
    },
    async stop(input: Record<string, unknown>) {
      stopped.push(input);
      return true;
    },
    abortRun(threadId: string, runId: string) {
      aborted.push({ threadId, runId });
    },
  };
  const delivery = createHandoffDelivery({
    agentFor: async () => agent,
    engine,
    mintThreadId: () => "scratch-thread",
    newRunId: () => "delivery-run",
    deadlineMs: options.deadlineMs,
    announce: async (input) => announced.push(input),
    setBusy: async (input) => busy.push(input),
  });
  return {
    delivery,
    calls,
    created,
    stopped,
    aborted,
    busy,
    announced,
    snapshots,
  };
}

describe("handoff delivery and the conversation engine contract", () => {
  test("forwards model context while persisting only the shown line", async () => {
    const h = harness({
      final: [
        {
          id: "answer",
          role: "assistant",
          content: "Tuesday morning",
        },
      ],
    });

    const result = await h.delivery.deliver({
      work: WORK,
      message:
        "Assistant has asked you to help.\n\nTask: find the outage window\nConstraints: yesterday only",
      shown:
        "Assistant asked Researcher for this on your behalf: find the outage window",
      assertion: "signed-assertion",
    });

    expect(result).toEqual({ answer: "Tuesday morning" });
    expect(h.created).toEqual([
      {
        id: "scratch-thread",
        ownerUserId: ACTOR.id,
        agentId: WORK.toBotId,
        provenance: "local",
        localReadiness: "ready",
      },
    ]);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.threadId).toBe("scratch-thread");
    expect(h.calls[0]?.input.messages).toEqual([
      ...PRIOR,
      {
        id: "handoff-delivery-run",
        role: "user",
        content:
          "Assistant has asked you to help.\n\nTask: find the outage window\nConstraints: yesterday only",
      },
    ]);
    expect(h.calls[0]?.persistedInputMessages).toEqual([
      {
        id: "handoff-delivery-run",
        role: "user",
        content:
          "Assistant asked Researcher for this on your behalf: find the outage window",
      },
    ]);
    expect(h.calls[0]?.input.forwardedProps).toEqual({
      openbotRun: "signed-assertion",
    });
  });

  test("relays in the existing asking thread without registering a substitute", async () => {
    const h = harness({
      final: [
        ...PRIOR,
        { id: "relay-answer", role: "assistant", content: "It was Tuesday" },
      ],
    });

    const result = await h.delivery.deliver({
      work: { ...WORK, answerIn: WORK.threadId },
      message: "You asked Researcher to help. It answered Tuesday.",
      assertion: "relay-assertion",
    });

    expect(result).toEqual({ answer: "It was Tuesday" });
    expect(h.created).toEqual([]);
    expect(h.calls[0]?.threadId).toBe(WORK.threadId);
    expect(h.calls[0]?.input.messages).toEqual([
      ...PRIOR,
      {
        id: "handoff-delivery-run",
        role: "user",
        content: "You asked Researcher to help. It answered Tuesday.",
      },
    ]);
    expect(h.calls[0]?.persistedInputMessages).toEqual([]);
  });

  test("does not adopt a missing or forbidden asking conversation", async () => {
    // A missing or forbidden read must prevent registration and execution rather than silently
    // giving the addressed Bot an empty substitute.
    const reads: string[] = [];
    const created: unknown[] = [];
    const ran: unknown[] = [];
    const engine = {
      store: {
        async readSnapshot(
          _actor: { id: string },
          threadId: string,
        ): Promise<never> {
          reads.push(threadId);
          throw new Error(
            threadId === WORK.threadId
              ? "conversation not found"
              : "unexpected read",
          );
        },
        async createThread(input: unknown) {
          created.push(input);
        },
      },
      run(request: unknown) {
        ran.push(request);
        throw new Error("must not run");
      },
      async stop() {
        return false;
      },
      abortRun() {},
    };
    const delivery = createHandoffDelivery({
      agentFor: async () => ({}) as AbstractAgent,
      engine,
      mintThreadId: () => "substitute",
      newRunId: () => "run",
    });
    await expect(
      delivery.deliver({
        work: WORK,
        message: "m",
        shown: "s",
        assertion: "signed",
      }),
    ).rejects.toThrow("conversation not found");
    // A concrete missing/not-found implementation from the store is terminal.
    expect(reads).toEqual([WORK.threadId]);
    expect(created).toEqual([]);
    expect(ran).toEqual([]);
  });

  test("propagates a forbidden history read without creating a substitute", async () => {
    const reads: string[] = [];
    const engine = {
      store: {
        async readSnapshot(_actor: { id: string }, threadId: string) {
          reads.push(threadId);
          throw new Error("conversation access denied");
        },
        async createThread() {
          throw new Error("must not create");
        },
      },
      run() {
        throw new Error("must not run");
      },
      async stop() {
        return false;
      },
      abortRun() {},
    };
    const delivery = createHandoffDelivery({
      agentFor: async () => ({}) as AbstractAgent,
      engine,
      mintThreadId: () => "substitute",
      newRunId: () => "run",
    });
    await expect(
      delivery.deliver({
        work: WORK,
        message: "m",
        shown: "s",
        assertion: "signed",
      }),
    ).rejects.toThrow("conversation access denied");
    expect(reads).toEqual([WORK.threadId]);
  });

  test("lets the engine own the lease and forwards the deployment assertion", async () => {
    const h = harness();
    await h.delivery.deliver({
      work: WORK,
      message: "m",
      shown: "s",
      assertion: "signed",
    });

    expect(h.calls).toHaveLength(1);
    expect(h.stopped).toEqual([]);
    expect(h.aborted).toEqual([]);
    expect(h.calls[0]?.input.forwardedProps).toEqual({
      openbotRun: "signed",
    });
  });

  test("preserves busy and announcement hooks for forward and relay hops", async () => {
    const h = harness({
      final: [{ id: "answer", role: "assistant", content: "Tuesday" }],
    });
    await h.delivery.deliver({
      work: WORK,
      message: "m",
      shown: "s",
      assertion: "signed",
    });
    await h.delivery.deliver({
      work: { ...WORK, answerIn: WORK.threadId },
      message: "m",
      assertion: "signed",
    });

    expect(h.busy).toEqual([
      { threadId: WORK.threadId, busy: true },
      { threadId: WORK.threadId, busy: false },
    ]);
    expect(h.announced).toEqual([
      {
        actorId: ACTOR.id,
        threadId: "scratch-thread",
        agentId: WORK.toBotId,
        text: "Tuesday",
      },
      {
        actorId: ACTOR.id,
        threadId: WORK.threadId,
        agentId: WORK.toBotId,
        text: "Tuesday",
      },
    ]);
  });

  test("reads the final durable snapshot rather than streamed text", async () => {
    const h = harness({
      events: FINISHED,
      final: [
        { id: "durable-answer", role: "assistant", content: "from the store" },
      ],
    });
    const result = await h.delivery.deliver({
      work: WORK,
      message: "m",
      shown: "s",
      assertion: "signed",
    });

    expect(result).toEqual({ answer: "from the store" });
    expect(h.announced[0]?.text).toBe("from the store");
  });

  test("rejects a stream that completes without a terminal event", async () => {
    const h = harness({
      events: [
        {
          type: "TEXT_MESSAGE_CONTENT",
          messageId: "partial",
          delta: "partial",
        } as unknown as BaseEvent,
      ],
      final: [{ id: "should-not-read", role: "assistant", content: "no" }],
    });

    await expect(
      h.delivery.deliver({
        work: WORK,
        message: "m",
        shown: "s",
        assertion: "signed",
      }),
    ).rejects.toThrow("without a durable result");
  });

  test("rejects a terminal RUN_ERROR instead of reading it as an answer", async () => {
    const h = harness({
      events: [
        {
          type: "RUN_ERROR",
          message: "the deterministic agent failed",
        } as unknown as BaseEvent,
      ],
      final: [{ id: "should-not-read", role: "assistant", content: "no" }],
    });

    await expect(
      h.delivery.deliver({
        work: WORK,
        message: "m",
        shown: "s",
        assertion: "signed",
      }),
    ).rejects.toThrow("the deterministic agent failed");
  });

  test("times out by stopping the actual engine run", async () => {
    const h = harness({
      deadlineMs: 10,
      events: [],
    });
    let emitStopped: (() => void) | undefined;
    const stalled = createHandoffDelivery({
      engine: {
        store: {
          async readSnapshot() {
            return {
              thread: {},
              snapshot: { messages: PRIOR, state: {} },
              baselineSequence: 0n,
              latestSequence: 0n,
            };
          },
          async createThread() {},
        },
        run: () =>
          new Observable<BaseEvent>((subscriber) => {
            emitStopped = () => {
              subscriber.next({
                type: "RUN_ERROR",
                message: "Conversation stopped",
              } as unknown as BaseEvent);
              subscriber.complete();
            };
          }),
        stop: async (input: Record<string, unknown>) => {
          h.stopped.push(input);
          emitStopped?.();
          return true;
        },
        abortRun: (threadId: string, runId: string) => {
          h.aborted.push({ threadId, runId });
        },
      },
      agentFor: async () => ({}) as AbstractAgent,
      mintThreadId: () => "scratch-thread",
      newRunId: () => "delivery-run",
      deadlineMs: 10,
    });

    await expect(
      stalled.deliver({
        work: WORK,
        message: "m",
        shown: "s",
        assertion: "signed",
      }),
    ).rejects.toThrow("did not finish within");
    expect(h.aborted).toEqual([
      { threadId: "scratch-thread", runId: "delivery-run" },
    ]);
    expect(h.stopped).toEqual([
      {
        actor: ACTOR,
        threadId: "scratch-thread",
        agentId: WORK.toBotId,
        runId: "delivery-run",
      },
    ]);
  });

  test("does not settle a timeout until the durable stop completes", async () => {
    let stopStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      stopStarted = resolve;
    });
    let finishStop!: (value: boolean) => void;
    const stopResult = new Promise<boolean>((resolve) => {
      finishStop = resolve;
    });
    let settled = false;
    let emitStopped: (() => void) | undefined;
    const stalled = createHandoffDelivery({
      engine: {
        store: {
          async readSnapshot() {
            return {
              thread: {},
              snapshot: { messages: PRIOR, state: {} },
              baselineSequence: 0n,
              latestSequence: 0n,
            };
          },
          async createThread() {},
        },
        run: () =>
          new Observable<BaseEvent>((subscriber) => {
            emitStopped = () => {
              subscriber.next({
                type: "RUN_ERROR",
                message: "Conversation stopped",
              } as unknown as BaseEvent);
              subscriber.complete();
            };
          }),
        stop: async () => {
          stopStarted();
          const result = await stopResult;
          emitStopped?.();
          return result;
        },
        abortRun() {},
      },
      agentFor: async () => ({}) as AbstractAgent,
      mintThreadId: () => "scratch-thread",
      newRunId: () => "delivery-run",
      deadlineMs: 10,
      abortGraceMs: 100,
    });

    const delivery = stalled
      .deliver({
        work: WORK,
        message: "m",
        shown: "s",
        assertion: "signed",
      })
      .finally(() => {
        settled = true;
      });
    await started;
    await Bun.sleep(10);
    expect(settled).toBe(false);
    finishStop(true);
    await expect(delivery).rejects.toThrow("did not finish within");
  });

  test("surfaces a durable stop failure instead of swallowing it", async () => {
    let emitStopped: (() => void) | undefined;
    const stalled = createHandoffDelivery({
      engine: {
        store: {
          async readSnapshot() {
            return {
              thread: {},
              snapshot: { messages: PRIOR, state: {} },
              baselineSequence: 0n,
              latestSequence: 0n,
            };
          },
          async createThread() {},
        },
        run: () =>
          new Observable<BaseEvent>((subscriber) => {
            emitStopped = () => {
              subscriber.next({
                type: "RUN_ERROR",
                message: "Conversation stopped",
              } as unknown as BaseEvent);
              subscriber.complete();
            };
          }),
        stop: async () => {
          emitStopped?.();
          throw new Error("stop request failed");
        },
        abortRun() {},
      },
      agentFor: async () => ({}) as AbstractAgent,
      mintThreadId: () => "scratch-thread",
      newRunId: () => "delivery-run",
      deadlineMs: 10,
      abortGraceMs: 100,
    });

    await expect(
      stalled.deliver({
        work: WORK,
        message: "m",
        shown: "s",
        assertion: "signed",
      }),
    ).rejects.toThrow("durable stop failed: stop request failed");
  });
});
