import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import {
  botThreadArchiveKey,
  botThreadKey,
  threadToUse,
  useBotThread,
  type BotThread,
} from "@/lib/copilot/bot-thread";
import {
  liveHandoverAllowed,
  mintConversationThread,
  mostRecentEligibleThread,
  parseConversationThreadRecord,
} from "@/lib/conversation-history";

type FetchHandler = (
  ...args: Parameters<typeof globalThis.fetch>
) => ReturnType<typeof globalThis.fetch>;

function mockFetch(handler: FetchHandler): typeof fetch {
  return Object.assign(handler, {
    preconnect: globalThis.fetch.preconnect,
  });
}

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});
afterAll(() => GlobalRegistrator.unregister());

function ThreadProbe({
  agentId,
  onValue,
}: {
  agentId: string;
  onValue: (value: BotThread) => void;
}) {
  const value = useBotThread(agentId);
  onValue(value);
  return createElement("output", { "data-thread-id": value.threadId ?? "" });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("botThreadKey", () => {
  test("is the same key for the same agent every time", () => {
    expect(botThreadKey("bot-a")).toBe(botThreadKey("bot-a"));
  });

  test("is namespaced rather than the bare agent id", () => {
    const key = botThreadKey("bot-a");
    expect(key).not.toBe("bot-a");
    expect(key).toContain("bot-a");
  });

  test("two agents never collide", () => {
    expect(botThreadKey("bot-a")).not.toBe(botThreadKey("bot-b"));
  });

  test("archive pointer is a separate key", () => {
    expect(botThreadArchiveKey("bot-a")).not.toBe(botThreadKey("bot-a"));
  });
});

describe("threadToUse", () => {
  test("a remembered local thread is kept", () => {
    expect(
      threadToUse({
        remembered: "t1",
        record: { status: "local", localReadiness: "ready" },
        lookupFailed: false,
        serverLatestId: "other",
        serverListFailed: false,
      }),
    ).toBe("remembered");
  });

  test("a remembered unavailable id is held, not reminted", () => {
    expect(
      threadToUse({
        remembered: "t1",
        record: { status: "external_unavailable" },
        lookupFailed: false,
        serverLatestId: "newer",
        serverListFailed: false,
      }),
    ).toBe("hold");
  });

  test("a remembered notfound id is held, not reminted", () => {
    expect(
      threadToUse({
        remembered: "t1",
        record: { status: "notfound" },
        lookupFailed: false,
        serverLatestId: "newer",
        serverListFailed: false,
      }),
    ).toBe("hold");
  });

  test("a failed lookup does not replace the remembered id", () => {
    expect(
      threadToUse({
        remembered: "t1",
        record: null,
        lookupFailed: true,
        serverLatestId: "newer",
        serverListFailed: false,
      }),
    ).toBe("hold");
  });

  test("with no browser pointer, the newest server conversation is restored", () => {
    expect(
      threadToUse({
        remembered: null,
        record: null,
        lookupFailed: false,
        serverLatestId: "server-1",
        serverListFailed: false,
      }),
    ).toBe("server");
  });

  test("a failed server list does not mint an empty thread", () => {
    expect(
      threadToUse({
        remembered: null,
        record: null,
        lookupFailed: false,
        serverLatestId: null,
        serverListFailed: true,
      }),
    ).toBe("hold");
  });

  test("a confirmed empty history may mint", () => {
    expect(
      threadToUse({
        remembered: null,
        record: null,
        lookupFailed: false,
        serverLatestId: null,
        serverListFailed: false,
      }),
    ).toBe("mint");
  });
});

describe("liveHandoverAllowed", () => {
  test("import pending and history-only disable live handover", () => {
    expect(liveHandoverAllowed({ status: "import_pending" })).toBe(false);
    expect(
      liveHandoverAllowed({
        status: "local",
        localReadiness: "not_ready",
      }),
    ).toBe(false);
    expect(
      liveHandoverAllowed({ status: "local", localReadiness: "history_only" }),
    ).toBe(false);
    expect(
      liveHandoverAllowed({ status: "local", localReadiness: "ready" }),
    ).toBe(true);
  });
});

describe("parseConversationThreadRecord", () => {
  test("rejects a body without status rather than inventing known", () => {
    expect(parseConversationThreadRecord({ known: false })).toBeNull();
    expect(parseConversationThreadRecord({ status: "local" })).toEqual({
      status: "local",
    });
    expect(
      parseConversationThreadRecord({
        status: "import_pending",
        localReadiness: "not_ready",
      }),
    ).toEqual({ status: "import_pending", localReadiness: "not_ready" });
    expect(
      parseConversationThreadRecord({
        status: "local",
        localReadiness: "unexpected",
      }),
    ).toBeNull();
  });
});

describe("mintConversationThread", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });
  const originalFetch = globalThis.fetch;

  test("posts agentId and returns the server thread id", async () => {
    globalThis.fetch = mockFetch(async (_input, init) => {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ agentId: "bot-a" });
      return Response.json({ threadId: "minted-1" });
    });
    expect(await mintConversationThread("bot-a")).toBe("minted-1");
  });
});

describe("mostRecentEligibleThread", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });
  const originalFetch = globalThis.fetch;

  test("picks the newest eligible server row", async () => {
    let requestPath = "";
    globalThis.fetch = mockFetch(async (input) => {
      requestPath = String(input);
      return Response.json({
        nextCursor: null,
        threads: [
          {
            id: "new",
            agentId: "bot-a",
            channelId: null,
            provenance: "import",
            localReadiness: "history_only",
            updatedAt: "2026-02-01T00:00:00.000Z",
            title: "New",
            preview: "later",
          },
        ],
      });
    });
    const latest = await mostRecentEligibleThread("bot-a");
    expect(latest === "unavailable" ? null : latest?.id).toBe("new");
    expect(requestPath).toBe(
      "/api/copilotkit/threads?agentId=bot-a&directOnly=true&limit=1",
    );
  });

  test("does not restore a row with no or another agent", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async () =>
      Response.json({
        nextCursor: null,
        threads: [
          {
            id: "deleted",
            agentId: null,
            channelId: null,
            provenance: "import",
            localReadiness: "history_only",
            updatedAt: "2026-04-01T00:00:00.000Z",
          },
          {
            id: "other",
            agentId: "bot-b",
            channelId: null,
            provenance: "local",
            localReadiness: "ready",
            updatedAt: "2026-05-01T00:00:00.000Z",
          },
          {
            id: "mine",
            agentId: "bot-a",
            channelId: null,
            provenance: "local",
            localReadiness: "ready",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    expect(await mostRecentEligibleThread("bot-a")).toBe("unavailable");
    globalThis.fetch = originalFetch;
  });

  test("a failed list is unavailable rather than empty", async () => {
    globalThis.fetch = mockFetch(
      async () => new Response("no", { status: 502 }),
    );
    expect(await mostRecentEligibleThread("bot-a")).toBe("unavailable");
  });

  test("a malformed list is unavailable rather than empty", async () => {
    globalThis.fetch = mockFetch(async () =>
      Response.json({
        nextCursor: null,
        threads: [{ id: "missing-updated-at", agentId: "bot-a" }],
      }),
    );
    expect(await mostRecentEligibleThread("bot-a")).toBe("unavailable");
  });

  test("a response without nextCursor is unavailable rather than empty", async () => {
    globalThis.fetch = mockFetch(async () => Response.json({ threads: [] }));
    expect(await mostRecentEligibleThread("bot-a")).toBe("unavailable");
  });

  test("an empty nextCursor is unavailable rather than a fetchable next page", async () => {
    globalThis.fetch = mockFetch(async () =>
      Response.json({
        nextCursor: "",
        threads: [
          {
            id: "mine",
            agentId: "bot-a",
            channelId: null,
            localReadiness: "ready",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    expect(await mostRecentEligibleThread("bot-a")).toBe("unavailable");
  });

  test("a valid empty page with a null cursor remains empty history", async () => {
    globalThis.fetch = mockFetch(async () =>
      Response.json({ nextCursor: null, threads: [] }),
    );
    expect(await mostRecentEligibleThread("bot-a")).toBeNull();
  });

  test("a wrong-channel row contradicting directOnly is unavailable", async () => {
    globalThis.fetch = mockFetch(async () =>
      Response.json({
        nextCursor: null,
        threads: [
          {
            id: "channel-thread",
            agentId: "bot-a",
            channelId: "channel-1",
            provenance: "local",
            localReadiness: "ready",
            updatedAt: "2026-03-01T00:00:00.000Z",
            title: "Channel",
            preview: "not direct",
          },
        ],
      }),
    );
    expect(await mostRecentEligibleThread("bot-a")).toBe("unavailable");
  });

  test("an oversized direct page contradicting limit one is unavailable", async () => {
    globalThis.fetch = mockFetch(async () =>
      Response.json({
        nextCursor: null,
        threads: [
          {
            id: "first",
            agentId: "bot-a",
            channelId: null,
            provenance: "local",
            localReadiness: "ready",
            updatedAt: "2026-03-01T00:00:00.000Z",
            title: "First",
            preview: null,
          },
          {
            id: "second",
            agentId: "bot-a",
            channelId: null,
            provenance: "local",
            localReadiness: "ready",
            updatedAt: "2026-02-01T00:00:00.000Z",
            title: "Second",
            preview: null,
          },
        ],
      }),
    );
    expect(await mostRecentEligibleThread("bot-a")).toBe("unavailable");
  });
});

test("stale agent mint cannot replace the current thread or clear its mint gate", async () => {
  let resolveA!: (response: Response) => void;
  let resolveB!: (response: Response) => void;
  const mintAgents: string[] = [];
  const pendingA = new Promise<Response>((resolve) => {
    resolveA = resolve;
  });
  const pendingB = new Promise<Response>((resolve) => {
    resolveB = resolve;
  });
  globalThis.fetch = mockFetch(async (input, init) => {
    const path = String(input);
    if (path.startsWith("/api/copilotkit/threads")) {
      return Response.json({ nextCursor: null, threads: [] });
    }
    expect(path).toBe("/api/threads/mint");
    const body = JSON.parse(String(init?.body)) as { agentId?: string };
    mintAgents.push(body.agentId ?? "");
    return body.agentId === "agent-a" ? pendingA : pendingB;
  });

  const values: BotThread[] = [];
  const view = render(
    createElement(ThreadProbe, {
      agentId: "agent-a",
      onValue: (value) => values.push(value),
    }),
  );
  await waitFor(() => expect(mintAgents).toEqual(["agent-a"]));

  view.rerender(
    createElement(ThreadProbe, {
      agentId: "agent-b",
      onValue: (value) => values.push(value),
    }),
  );
  expect(values.at(-1)?.threadId).toBeUndefined();
  await waitFor(() => expect(mintAgents).toEqual(["agent-a", "agent-b"]));

  resolveA(Response.json({ threadId: "thread-a" }));
  await Promise.resolve();
  expect(values.at(-1)?.threadId).toBeUndefined();
  values.at(-1)?.startNew();
  expect(mintAgents).toEqual(["agent-a", "agent-b"]);

  resolveB(Response.json({ threadId: "thread-b" }));
  await waitFor(() => expect(values.at(-1)?.threadId).toBe("thread-b"));
  view.unmount();
});

test("New shares a pending initial resolution mint instead of orphaning a second thread", async () => {
  const list = deferred<Response>();
  const mint = deferred<Response>();
  let listStarted = false;
  let mintCalls = 0;
  let current: BotThread | undefined;
  globalThis.fetch = mockFetch(async (input) => {
    const path = String(input);
    if (path.startsWith("/api/copilotkit/threads")) {
      listStarted = true;
      return list.promise;
    }
    expect(path).toBe("/api/threads/mint");
    mintCalls += 1;
    return mint.promise;
  });

  const view = render(
    createElement(ThreadProbe, {
      agentId: "agent-a",
      onValue: (value) => {
        current = value;
      },
    }),
  );
  await waitFor(() => expect(listStarted).toBe(true));
  current?.startNew();
  await waitFor(() => expect(mintCalls).toBe(1));

  list.resolve(Response.json({ nextCursor: null, threads: [] }));
  await Promise.resolve();
  expect(mintCalls).toBe(1);
  mint.resolve(Response.json({ threadId: "explicit-thread" }));
  await waitFor(() => expect(current?.threadId).toBe("explicit-thread"));
  expect(mintCalls).toBe(1);
  view.unmount();
});

test("a failed explicit New mint lets empty-history recovery retry once", async () => {
  const list = deferred<Response>();
  const failedMint = deferred<Response>();
  const recoveryMint = deferred<Response>();
  let mintCalls = 0;
  let current: BotThread | undefined;
  globalThis.fetch = mockFetch(async (input) => {
    const path = String(input);
    if (path.startsWith("/api/copilotkit/threads")) {
      return list.promise;
    }
    expect(path).toBe("/api/threads/mint");
    mintCalls += 1;
    if (mintCalls === 1) return failedMint.promise;
    return recoveryMint.promise;
  });

  const view = render(
    createElement(ThreadProbe, {
      agentId: "agent-a",
      onValue: (value) => {
        current = value;
      },
    }),
  );
  await waitFor(() => expect(current).toBeDefined());
  current?.startNew();
  await waitFor(() => expect(mintCalls).toBe(1));
  failedMint.resolve(new Response("failed", { status: 502 }));
  list.resolve(Response.json({ nextCursor: null, threads: [] }));
  await waitFor(() => expect(mintCalls).toBe(2));
  recoveryMint.resolve(Response.json({ threadId: "recovered-thread" }));
  await waitFor(() => expect(current?.threadId).toBe("recovered-thread"));
  expect(mintCalls).toBe(2);
  view.unmount();
});
