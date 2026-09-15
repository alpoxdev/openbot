import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/client";
import { AbstractAgent, EventType } from "@ag-ui/client";
import { Observable } from "rxjs";
import {
  ConversationAccessError,
  ConversationNotFoundError,
} from "../src/conversations/types";
import {
  createTurnRunner,
  frameFiring,
  sanitizeSeededHistory,
} from "../src/routines/run-turn";

const OWNER = "user_owner";
const ROUTINE_ID = "routine_standup";
const AGENT_ID = "bot_helper";
const THREAD_ID = "thread_owner_channel_1";
const INSTRUCTION = "Post the standup summary.";
const FRAME_MARK = "firing right now";

type HistoryRow = Message;

class FakeAgent extends AbstractAgent {
  aborts = 0;
  onAbort?: () => void;

  run() {
    return new Observable<never>((subscriber) => {
      subscriber.complete();
    });
  }

  override abortRun(): void {
    this.aborts += 1;
    this.onAbort?.();
    super.abortRun();
  }
}

type Observer = {
  next: (event: { type: string; message?: string }) => void;
  error: (error: unknown) => void;
  complete: () => void;
};

type Driver = (context: {
  agent: FakeAgent;
  observer: Observer;
  request: {
    actor: { id: string };
    threadId: string;
    agentId: string;
    input: { runId: string; threadId: string; messages: { id: string }[] };
    persistedInputMessages?: { id: string; content?: unknown }[];
  };
}) => void;

const answers: Driver = ({ agent, observer }) => {
  agent.messages = [
    ...agent.messages,
    { id: "assistant_1", role: "assistant", content: "Three things happened." },
  ] as typeof agent.messages;
  observer.complete();
};

function harness(options: {
  history?: HistoryRow[];
  snapshotFails?: () => Error;
  drive?: Driver;
  turnTimeoutMs?: number;
  abortGraceMs?: number;
  agentIdOnThread?: string | null;
}) {
  const order: string[] = [];
  const calls = {
    snapshots: [] as { actorId: string; threadId: string }[],
    runs: [] as {
      actorId: string;
      threadId: string;
      agentId: string;
      input: { runId: string; messages: { id: string }[] };
      persistedInputMessages?: { id: string; content?: unknown }[];
    }[],
    stops: [] as {
      actorId: string;
      threadId: string;
      agentId: string;
      runId: string | null;
    }[],
    aborts: [] as { threadId: string; runId: string }[],
  };

  const agent = new FakeAgent({ agentId: AGENT_ID });
  const drive = options.drive ?? answers;

  const engine = {
    store: {
      readSnapshot: async (actor: { id: string }, threadId: string) => {
        order.push("readSnapshot");
        calls.snapshots.push({ actorId: actor.id, threadId });
        if (options.snapshotFails) throw options.snapshotFails();
        return {
          thread: {
            id: threadId,
            ownerUserId: OWNER,
            channelId: "channel_1",
            agentId: options.agentIdOnThread ?? AGENT_ID,
            provenance: "local" as const,
            localReadiness: "ready" as const,
            nextSequence: 0n,
            latestSequence: 0n,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          snapshot: {
            messages: options.history ?? [],
            state: {},
          },
          baselineSequence: 0n,
          latestSequence: 0n,
        };
      },
    },
    run: (request: {
      actor: { id: string };
      threadId: string;
      agentId: string;
      agent: FakeAgent;
      input: { runId: string; threadId: string; messages: { id: string }[] };
      persistedInputMessages?: { id: string; content?: unknown }[];
    }) => {
      order.push("run");
      calls.runs.push({
        actorId: request.actor.id,
        threadId: request.threadId,
        agentId: request.agentId,
        input: request.input,
        persistedInputMessages: request.persistedInputMessages,
      });
      return new Observable((subscriber) => {
        drive({
          agent: request.agent,
          observer: {
            next: (event) => subscriber.next(event as never),
            error: (error) => subscriber.error(error),
            complete: () => subscriber.complete(),
          },
          request,
        });
        return () => undefined;
      });
    },
    stop: async (request: {
      actor: { id: string };
      threadId: string;
      agentId: string;
      runId: string | null;
    }) => {
      order.push("stop");
      calls.stops.push({
        actorId: request.actor.id,
        threadId: request.threadId,
        agentId: request.agentId,
        runId: request.runId,
      });
      return true;
    },
    abortRun: (threadId: string, runId: string) => {
      order.push("abortRun");
      calls.aborts.push({ threadId, runId });
    },
  };

  const builtFor: { initiator: { kind: string; id?: string } }[] = [];
  const runTurn = createTurnRunner({
    engine,
    buildAgentFor: async (input) => {
      builtFor.push(input);
      return agent;
    },
    ...(options.turnTimeoutMs === undefined
      ? {}
      : { turnTimeoutMs: options.turnTimeoutMs }),
    ...(options.abortGraceMs === undefined
      ? {}
      : { abortGraceMs: options.abortGraceMs }),
  });

  const run = () =>
    runTurn({
      ownerUserId: OWNER,
      routineId: ROUTINE_ID,
      agentId: AGENT_ID,
      threadId: THREAD_ID,
      instruction: INSTRUCTION,
    });

  return { run, agent, calls, order, builtFor };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const THREE_ROWS: HistoryRow[] = [
  { id: "m1", role: "user", content: "Hello." },
  { id: "m2", role: "assistant", content: "Hello back." },
  { id: "m3", role: "user", content: "Again." },
];

describe("a routine's headless turn", () => {
  test("reads the canonical snapshot then runs the engine — in that order", async () => {
    const { run, order, calls } = harness({});

    await run();

    expect(order.indexOf("readSnapshot")).toBeLessThan(order.indexOf("run"));
    expect(calls.snapshots).toEqual([{ actorId: OWNER, threadId: THREAD_ID }]);
    expect(calls.runs[0]?.actorId).toBe(OWNER);
    expect(calls.runs[0]?.agentId).toBe(AGENT_ID);
  });

  test("returns what the Bot said, taken from the agent the runner was handed", async () => {
    const { run } = harness({});

    expect(await run()).toEqual({ replyText: "Three things happened." });
  });

  test("does not leak history into the reply: the before-set must be taken after seeding, not before", async () => {
    const { run } = harness({ history: THREE_ROWS });

    expect(await run()).toEqual({ replyText: "Three things happened." });
  });

  test("seeds the thread's history and the turn onto the agent", async () => {
    const { run, agent } = harness({
      history: [
        ...THREE_ROWS,
        {
          id: "m4",
          role: "assistant",
          toolCalls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "search", arguments: '{"q":"x"}' },
            },
          ],
        } as Message,
        { id: "m5", role: "tool", content: "found x", toolCallId: "call_1" },
      ],
    });

    await run();

    expect(agent.threadId).toBe(THREAD_ID);
    expect(agent.messages.map((message) => message.id).slice(0, 5)).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
      "m5",
    ]);
    expect(agent.messages[5]).toMatchObject({ role: "user" });
    expect(agent.messages[5]?.content).toContain(INSTRUCTION);
    expect(agent.messages[5]?.content).toContain(FRAME_MARK);
  });

  test("an unavailable local thread fails explicitly, without creating one", async () => {
    const { run, calls } = harness({
      snapshotFails: () => new ConversationNotFoundError(),
    });

    await expect(run()).rejects.toThrow("not available locally");
    expect(calls.runs).toEqual([]);
  });

  test("access denied is the same explicit failure, never a cloud fallback", async () => {
    const { run, calls } = harness({
      snapshotFails: () => new ConversationAccessError(),
    });

    await expect(run()).rejects.toThrow("not available locally");
    expect(calls.runs).toEqual([]);
  });
});

describe("the turn's message is framed as a firing happening now", () => {
  test("carries the instruction and the frame around it", async () => {
    const { run, calls } = harness({ history: THREE_ROWS });

    await run();

    const seeded = calls.runs[0]?.input.messages ?? [];
    const turn = seeded[seeded.length - 1] as { content?: unknown };
    expect(typeof turn.content).toBe("string");
    const content = String(turn.content);
    expect(content).toContain(INSTRUCTION);
    expect(content).toContain(FRAME_MARK);
    expect(content.toLowerCase()).toContain("schedule");
    expect(content.toLowerCase()).toContain("this turn");
    expect(content).toContain("routine");
  });

  test("persistedInputMessages is the new firing only", async () => {
    const { run, calls } = harness({ history: THREE_ROWS });

    await run();

    const [request] = calls.runs;
    expect(request?.input.messages).toHaveLength(4);
    expect(request?.persistedInputMessages).toHaveLength(1);
    expect(request?.persistedInputMessages?.[0]?.content).toContain(
      INSTRUCTION,
    );
    const historic = new Set(THREE_ROWS.map((row) => row.id));
    for (const message of request?.persistedInputMessages ?? []) {
      expect(historic.has(message.id)).toBe(false);
    }
  });

  test("a prior firing's framed message, arriving back as history, is not framed again", async () => {
    const alreadyFramed = frameFiring(
      "Append the current UTC time to the log page.",
    );
    const { run, calls } = harness({
      history: [
        { id: "m1", role: "user", content: alreadyFramed },
        { id: "m2", role: "assistant", content: "Appended." },
      ],
    });

    await run();

    const seeded = calls.runs[0]?.input.messages ?? [];
    expect(seeded).toHaveLength(3);
    expect((seeded[0] as { content?: unknown }).content).toBe(alreadyFramed);
    const occurrences =
      String((seeded[0] as { content?: unknown }).content).split(FRAME_MARK)
        .length - 1;
    expect(occurrences).toBe(1);
    expect(String((seeded[2] as { content?: unknown }).content)).toBe(
      frameFiring(INSTRUCTION),
    );
  });
});

describe("the seeded history is sanitized of dangling tool calls", () => {
  test("a dangling assistant tool call is stripped before the model sees it", async () => {
    const dirty: Message[] = [
      { id: "m1", role: "user", content: "Look this up." },
      {
        id: "m2",
        role: "assistant",
        toolCalls: [
          {
            id: "call_dangling",
            type: "function",
            function: { name: "search", arguments: "{}" },
          },
        ],
      } as Message,
    ];
    const { run, calls } = harness({ history: dirty });

    await run();

    const seeded = calls.runs[0]?.input.messages ?? [];
    expect(seeded.some((message) => message.id === "m2")).toBe(false);
    expect(
      sanitizeSeededHistory(dirty).some((message) => message.id === "m2"),
    ).toBe(false);
  });
});

describe("timeout stops the exact run, not only the observer", () => {
  test("when the deadline fires, abortRun and engine.stop receive the minted run id", async () => {
    const { run, calls, agent } = harness({
      drive: () => undefined,
      turnTimeoutMs: 5,
      abortGraceMs: 5,
    });

    await expect(run()).rejects.toThrow("could not be stopped");

    expect(agent.aborts).toBe(1);
    expect(calls.aborts).toHaveLength(1);
    expect(calls.stops).toHaveLength(1);
    expect(calls.stops[0]?.runId).toBe(calls.runs[0]?.input.runId);
    expect(calls.stops[0]?.actorId).toBe(OWNER);
    expect(calls.stops[0]?.threadId).toBe(THREAD_ID);
    expect(calls.stops[0]?.agentId).toBe(AGENT_ID);
  });

  test("when the deadline fires and the run then finishes inside the grace, it is still a stopped turn", async () => {
    const { run, calls } = harness({
      drive: (context) => {
        context.agent.onAbort = () => answers(context);
      },
      turnTimeoutMs: 5,
      abortGraceMs: 50,
    });

    await expect(run()).rejects.toThrow("was stopped after");
    expect(calls.stops[0]?.runId).toBe(calls.runs[0]?.input.runId);
  });
});

describe("recovering what was said", () => {
  test("falls back to the streamed chunks when no message was added", async () => {
    const { run } = harness({
      drive: ({ agent, observer }) => {
        for (const subscriber of agent.subscribers) {
          void subscriber.onTextMessageEndEvent?.({
            event: {
              type: EventType.TEXT_MESSAGE_END,
              messageId: "streamed_1",
            },
            textMessageBuffer: "Said out loud but never persisted.",
            messages: agent.messages,
            state: agent.state,
            agent,
          } as never);
        }
        observer.complete();
      },
    });

    expect(await run()).toEqual({
      replyText: "Said out loud but never persisted.",
    });
  });

  test("throws when the turn finished without saying anything", async () => {
    const { run } = harness({
      drive: ({ observer }) => observer.complete(),
    });

    await expect(run()).rejects.toThrow(
      "The turn finished without saying anything.",
    );
  });

  test("throws when the turn stopped to ask a question", async () => {
    const { run } = harness({
      drive: (context) => {
        context.agent.pendingInterrupts = [{ id: "interrupt_1" } as never];
        answers(context);
      },
    });

    await expect(run()).rejects.toThrow("nobody to ask");
  });
});

describe("a RUN_ERROR through next", () => {
  test("rejects rather than hanging, and does not read as an empty answer", async () => {
    const { run } = harness({
      drive: ({ observer }) => {
        observer.next({
          type: EventType.RUN_ERROR,
          message: "the model refused",
        });
        observer.complete();
      },
    });

    await expect(run()).rejects.toThrow("the model refused");
  });
});

describe("what the trail is told started the turn", () => {
  test("the Bot is built for the routine, not for the owner acting by hand", async () => {
    const { run, builtFor } = harness({});

    await run();

    expect(builtFor).toHaveLength(1);
    expect(builtFor[0]?.initiator).toEqual({
      kind: "routine",
      id: ROUTINE_ID,
    });
  });
});

void wait;
