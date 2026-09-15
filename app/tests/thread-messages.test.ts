import { describe, expect, test } from "bun:test";
import {
  readableTurns,
  readThreadMessages,
} from "@/lib/copilot/thread-messages";

/**
 * Reading back local Postgres history that used a tool.
 *
 * Local history is already canonical AG-UI. The old `{id, name, args}` spelling belongs to an
 * inspected source provider and is converted once by the server importer, never by this reader.
 */
const userTurn = {
  id: "6953d56c",
  role: "user" as const,
  content: "open hackernews.com and tell me the top 3 stories",
};

/** As local Postgres history returns it. */
const storedToolCall = {
  id: "0fe7b049",
  role: "assistant" as const,
  toolCalls: [
    {
      id: "call_maB4q3",
      type: "function" as const,
      function: {
        name: "computer_navigate",
        arguments: '{"url":"https://news.ycombinator.com"}',
      },
    },
  ],
};

const toolResult = {
  id: "aa5e9452",
  role: "tool" as const,
  toolCallId: "call_maB4q3",
  content: '{"ok":true,"title":"Hacker News"}',
};

const answer = {
  id: "5c1f",
  role: "assistant" as const,
  content: "Top 3 stories…",
  historyMetadata: { persistedBy: "postgres" },
};

describe("restoring a conversation that used a tool", () => {
  test("a browsing turn survives the read", () => {
    const { messages, unreadable } = readableTurns([
      userTurn,
      storedToolCall,
      toolResult,
      answer,
    ]);

    expect(messages).toEqual([userTurn, storedToolCall, toolResult, answer]);
    expect(unreadable).toBe(0);
  });

  test("the tool call comes back in the shape every renderer reads", () => {
    const { messages } = readableTurns([storedToolCall]);
    expect(messages).toEqual([storedToolCall]);
  });

  test("a call already in AG-UI's shape is left alone", () => {
    const already = {
      id: "x",
      role: "assistant",
      toolCalls: [
        {
          id: "c1",
          type: "function",
          function: { name: "computer_click", arguments: "{}" },
        },
      ],
    };
    const { messages, unreadable } = readableTurns([already]);
    expect(unreadable).toBe(0);
    expect(messages[0]).toEqual(already as never);
  });

  test("a turn that is genuinely malformed is still refused", () => {
    /*
     * The guard is not being removed, only taught a second spelling. A tool call with neither shape
     * is something no renderer can draw, and letting it through is how one bad turn used to take a
     * whole conversation down.
     */
    const nonsense = { id: "y", role: "assistant", toolCalls: [{ id: "c2" }] };
    const { messages, unreadable } = readableTurns([nonsense]);
    expect(messages).toHaveLength(0);
    expect(unreadable).toBe(1);
  });

  test("a mixed legacy and canonical array is refused rather than half-translated", () => {
    // Legacy source rows are an importer concern; the local reader does not guess at either shape.
    const mixed = {
      id: "z",
      role: "assistant",
      toolCalls: [
        { id: "a", name: "one", args: "{}" },
        {
          id: "b",
          type: "function",
          function: { name: "two", arguments: "{}" },
        },
      ],
    };
    expect(readableTurns([mixed]).unreadable).toBe(1);
  });

  test("everything else passes through untouched", () => {
    const { messages, unreadable } = readableTurns([userTurn, answer]);
    expect(unreadable).toBe(0);
    expect(messages[0]).toEqual(userTurn as never);
  });
});

/**
 * Local history must be canonical before it reaches this reader. Legacy source-provider spellings
 * and corrupted canonical rows are counted as unreadable instead of being guessed at in the browser.
 */
describe("canonical history validation", () => {
  test.each([
    {
      name: "legacy flat tool call",
      turn: {
        id: "legacy-flat",
        role: "assistant",
        toolCalls: [{ id: "c1", name: "computer_navigate", args: "{}" }],
      },
    },
    {
      name: "canonical tool call with object arguments",
      turn: {
        id: "object-arguments",
        role: "assistant",
        toolCalls: [
          {
            id: "c1",
            type: "function",
            function: { name: "computer_navigate", arguments: {} },
          },
        ],
      },
    },
    {
      name: "assistant with null content",
      turn: {
        id: "null-assistant",
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "c1",
            type: "function",
            function: { name: "computer_navigate", arguments: "{}" },
          },
        ],
      },
    },
  ])("$name is unreadable rather than guessed", ({ turn }) => {
    expect(readableTurns([turn])).toEqual({
      messages: [],
      unreadable: 1,
      availability: "ready",
    });
  });

  test("a person's turn with no content is still refused and counted", () => {
    expect(readableTurns([{ id: "m1", role: "user", content: null }])).toEqual({
      messages: [],
      unreadable: 1,
      availability: "ready",
    });
  });

  test("content that is a list of parts survives", () => {
    const content = [{ type: "text", text: "What is in this?" }];

    const { messages, unreadable } = readableTurns([
      { id: "m1", role: "user", content },
    ]);

    expect(messages).toHaveLength(1);
    expect(unreadable).toBe(0);
  });

  test("canonical message order, structured parts, and argument bytes are preserved", () => {
    const argumentBytes = '{ "url": "https://x", "fragment": "  exact  " }';
    const read = readableTurns([
      {
        id: "m1",
        role: "user",
        content: [{ type: "text", text: "one" }],
      },
      {
        id: "m2",
        role: "assistant",
        toolCalls: [
          {
            id: "c1",
            type: "function",
            function: { name: "computer_navigate", arguments: argumentBytes },
          },
        ],
      },
      { id: "m3", role: "assistant", content: "three" },
    ]).messages as Array<Record<string, unknown>>;

    expect(read.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(read[0]?.content).toEqual([{ type: "text", text: "one" }]);
    const toolCallMessage = read[1];
    expect(toolCallMessage).toBeDefined();
    if (!toolCallMessage || !("toolCalls" in toolCallMessage)) {
      throw new Error("Expected the second message to contain tool calls");
    }
    const toolCalls = toolCallMessage.toolCalls;
    expect(Array.isArray(toolCalls)).toBe(true);
    if (!Array.isArray(toolCalls)) {
      throw new Error("Expected tool calls to be an array");
    }
    const toolCall = toolCalls[0];
    expect(toolCall).toBeDefined();
    if (
      !toolCall ||
      typeof toolCall !== "object" ||
      !("function" in toolCall)
    ) {
      throw new Error("Expected the first tool call to contain a function");
    }
    const toolFunction = toolCall.function;
    expect(toolFunction).toBeDefined();
    if (
      !toolFunction ||
      typeof toolFunction !== "object" ||
      !("arguments" in toolFunction)
    ) {
      throw new Error("Expected the tool function to contain arguments");
    }
    expect(toolFunction.arguments).toBe(argumentBytes);
    expect(read[2]?.content).toBe("three");
  });
});

describe("thread history retrieval outcomes", () => {
  type FetchHandler = (
    ...args: Parameters<typeof globalThis.fetch>
  ) => ReturnType<typeof globalThis.fetch>;

  const withFetch = async (handler: FetchHandler, run: () => Promise<void>) => {
    const original = globalThis.fetch;
    globalThis.fetch = Object.assign(handler, {
      preconnect: original.preconnect,
    });
    try {
      await run();
    } finally {
      globalThis.fetch = original;
    }
  };

  test("HTTP failures are unavailable history, not valid empty history", async () => {
    await withFetch(
      async () => new Response("broken", { status: 500 }),
      async () => {
        const read = await readThreadMessages("thread-1", "agent-1");

        expect(read).toEqual({
          messages: [],
          unreadable: 0,
          availability: "unavailable",
        });
      },
    );
  });

  test("network failures are unavailable history, not valid empty history", async () => {
    await withFetch(
      async () => {
        throw new TypeError("network down");
      },
      async () => {
        const read = await readThreadMessages("thread-1", "agent-1");

        expect(read).toEqual({
          messages: [],
          unreadable: 0,
          availability: "unavailable",
        });
      },
    );
  });

  test.each([
    { name: "missing messages field", body: {} },
    { name: "non-array messages field", body: { messages: { id: "m1" } } },
  ])("a 200 response with $name is unavailable history", async ({ body }) => {
    await withFetch(
      async () => Response.json(body),
      async () => {
        const read = await readThreadMessages("thread-1", "agent-1");

        expect(read).toEqual({
          messages: [],
          unreadable: 0,
          availability: "unavailable",
        });
      },
    );
  });

  test.each([
    {
      name: "headers",
      handler: ({ signal }: { signal?: AbortSignal }) =>
        new Promise<Response>((resolve) => {
          signal?.addEventListener("abort", () =>
            resolve(new Response("aborted", { status: 499 })),
          );
        }),
    },
    {
      name: "body",
      handler: ({ signal }: { signal?: AbortSignal }) =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                signal?.addEventListener("abort", () => controller.close());
              },
            }),
            { headers: { "content-type": "application/json" } },
          ),
        ),
    },
  ])(
    "a stalled $name read aborts and returns unavailable history",
    async ({ handler }) => {
      let capturedSignal: AbortSignal | undefined;
      await withFetch(
        (_input, init) => {
          capturedSignal = init?.signal ?? undefined;
          return handler({ signal: capturedSignal });
        },
        async () => {
          const read = await readThreadMessages("thread-1", "agent-1", {
            deadlineMs: 20,
          });

          expect(capturedSignal?.aborted).toBe(true);
          expect(read).toEqual({
            messages: [],
            unreadable: 0,
            availability: "unavailable",
          });
        },
      );
    },
  );

  test("a readable empty response remains a valid empty history", async () => {
    await withFetch(
      async () =>
        Response.json({
          messages: [],
        }),
      async () => {
        const read = await readThreadMessages("thread-1", "agent-1");

        expect(read).toEqual({
          messages: [],
          unreadable: 0,
          availability: "ready",
        });
      },
    );
  });

  test("unreadable stored turns are still a ready retrieval with holes", () => {
    expect(readableTurns([{ id: "m1", role: "user", content: null }])).toEqual({
      messages: [],
      unreadable: 1,
      availability: "ready",
    });
  });
});
