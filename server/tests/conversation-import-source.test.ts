import { createServer } from "node:http";
import { describe, expect, test } from "bun:test";
import {
  createConversationImportSource,
  resolveImportSourceOrigin,
} from "../src/conversations/import-source";
import type { ConversationObservation } from "../src/conversations/observability";

const ORIGIN = "https://intelligence.example.test";
const KEY = "project-runtime-key";

function source(
  fetchImpl: typeof fetch,
  extras: Parameters<typeof createConversationImportSource>[1] = {},
) {
  const created = createConversationImportSource(
    { origin: ORIGIN, apiKey: KEY },
    {
      fetchImpl,
      lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
      sleep: async () => undefined,
      ...extras,
    },
  );
  if (!created.ok) throw new Error(created.message);
  return created.value;
}

describe("resolveImportSourceOrigin", () => {
  test("accepts HTTPS and rejects credentialed or private URLs", () => {
    const ok = resolveImportSourceOrigin(`${ORIGIN}/v1`);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value).toBe(ORIGIN);

    expect(
      resolveImportSourceOrigin("http://intelligence.example.test").ok,
    ).toBe(false);
    expect(
      resolveImportSourceOrigin("https://user:pass@intelligence.example.test")
        .ok,
    ).toBe(false);
    expect(resolveImportSourceOrigin("https://169.254.169.254/").ok).toBe(
      false,
    );
    expect(resolveImportSourceOrigin("https://localhost/api").ok).toBe(false);
  });

  test("allowHttp does not grant private hosts", () => {
    expect(
      resolveImportSourceOrigin("http://localhost/api", { allowHttp: true }).ok,
    ).toBe(false);
    const privateHttps = resolveImportSourceOrigin("https://127.0.0.1/", {
      allowHttp: true,
    });
    expect(privateHttps.ok).toBe(false);
    const allowed = resolveImportSourceOrigin("http://127.0.0.1/", {
      allowHttp: true,
      allowPrivateHosts: true,
    });
    expect(allowed.ok).toBe(true);
  });
});

describe("listThreads paging", () => {
  test("sends user, agent, archived, limit and cursor query params and drops join tokens", async () => {
    const seen: string[] = [];
    const client = source(async (input) => {
      const url = new URL(String(input));
      seen.push(url.search);
      expect(url.pathname).toBe("/api/threads");
      expect(url.origin).toBe(ORIGIN);
      return new Response(
        JSON.stringify({
          threads: [{ id: "t1", name: "One" }],
          joinCode: "secret-join",
          joinToken: "secret-token",
          nextCursor: "page-2",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const page = await client.listThreads({
      userId: "user-a",
      agentId: "agent-b",
      includeArchived: true,
      limit: 25,
      cursor: "abc",
    });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.threads).toEqual([{ id: "t1", name: "One" }]);
    expect(page.value.nextCursor).toBe("page-2");
    expect(JSON.stringify(page.value)).not.toContain("secret");
    const params = new URLSearchParams(seen[0]);
    expect(params.get("userId")).toBe("user-a");
    expect(params.get("agentId")).toBe("agent-b");
    expect(params.get("includeArchived")).toBe("true");
    expect(params.get("limit")).toBe("25");
    expect(params.get("cursor")).toBe("abc");
  });
});

describe("getThread and messages", () => {
  test("uses GET /api/threads/:id?userId= and treats 404 as a gap", async () => {
    const client = source(async (input) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/api/threads/th%2F1");
      expect(url.searchParams.get("userId")).toBe("u1");
      return new Response("missing", { status: 404 });
    });
    const result = await client.getThread({ threadId: "th/1", userId: "u1" });
    expect(result.ok).toBe(false);
    if (!result.ok && "gap" in result) expect(result.gap).toBe("not-found");
  });

  test("messages path has no pagination and empty array is success", async () => {
    const client = source(async (input) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/api/threads/t1/messages");
      expect(url.searchParams.get("userId")).toBe("u1");
      expect(url.searchParams.has("cursor")).toBe(false);
      return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    });
    const result = await client.getThreadMessages({
      threadId: "t1",
      userId: "u1",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.messages).toEqual([]);
  });

  test("preserves unrecognized message fields and does not log raw content", async () => {
    const client = source(async () => {
      return new Response(
        JSON.stringify({
          messages: [
            {
              id: "m1",
              role: "assistant",
              content: "secret-transcript",
              activityType: "text",
              extraSourceField: { nested: true },
              undocumented: "keep-me",
            },
          ],
        }),
        { status: 200 },
      );
    });
    const result = await client.getThreadMessages({
      threadId: "t1",
      userId: "u1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const message = result.value.messages[0];
    expect(message?.extraSourceField).toEqual({ nested: true });
    expect(message?.undocumented).toBe("keep-me");
    expect(message?.content).toBe("secret-transcript");
  });

  test("preserves raw tool calls, including extensions, structured arguments, and malformed calls", async () => {
    const rawCalls = [
      {
        id: "object-args",
        name: "lookup",
        args: { query: "fixture", filters: ["active"] },
        sourceExtension: { kind: "tool-call", order: 1 },
      },
      {
        id: "null-args",
        name: "approve",
        args: null,
        sourceExtension: { kind: "tool-call", order: 2 },
      },
      {
        id: "canonical",
        type: "function",
        function: { name: "lookup", arguments: '{"query":"fixture"}' },
        sourceExtension: { kind: "tool-call", order: 3 },
      },
      {
        id: "malformed",
        sourceExtension: { kind: "malformed", order: 4 },
      },
    ];
    const client = source(async () => {
      return new Response(
        JSON.stringify({
          messages: [
            {
              id: "m1",
              role: "assistant",
              content: null,
              toolCalls: rawCalls,
            },
          ],
        }),
        { status: 200 },
      );
    });

    const result = await client.getThreadMessages({
      threadId: "t1",
      userId: "u1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.messages[0]?.toolCalls).toEqual(rawCalls);
  });

  test("getThread requires the installed { thread } envelope", async () => {
    const client = source(async () => {
      return new Response(JSON.stringify({ id: "t1", name: "bare" }), {
        status: 200,
      });
    });
    const result = await client.getThread({ threadId: "t1", userId: "u1" });
    expect(result.ok).toBe(false);
    if (!result.ok && "code" in result) expect(result.code).toBe("malformed");
  });

  test("getThread rejects a response for a different scoped thread", async () => {
    const client = source(async () => {
      return new Response(
        JSON.stringify({ thread: { id: "other-thread", name: "Other" } }),
        { status: 200 },
      );
    });
    const result = await client.getThread({
      threadId: "requested",
      userId: "u1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok && "code" in result) {
      expect(result.code).toBe("malformed");
      expect(result.message).not.toContain("other-thread");
    }
  });
});

describe("bounds and cancellation", () => {
  test("aborts when the caller signal fires", async () => {
    const controller = new AbortController();
    const client = source(async (_input, init) => {
      await new Promise<never>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    });
    const pending = client.listThreads({
      userId: "u",
      agentId: "a",
      signal: controller.signal,
    });
    controller.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("cancelled");
  });

  test("times out bounded reads", async () => {
    const client = source(
      async (_input, init) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("timeout"), { name: "AbortError" }));
          });
        }),
      { timeoutMs: 5 },
    );
    const result = await client.getThread({ threadId: "t", userId: "u" });
    expect(result.ok).toBe(false);
    if (!result.ok && "code" in result) expect(result.code).toBe("timeout");
  });

  test("classifies a mid-body stream fault as transient and retries with a sanitized error", async () => {
    let attempts = 0;
    const client = source(
      async () => {
        attempts += 1;
        let first = true;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (first) {
                first = false;
                controller.enqueue(new TextEncoder().encode('{"threads":'));
                return;
              }
              controller.error(new Error("body-secret"));
            },
          }),
          { status: 200 },
        );
      },
      { maxRetries: 1 },
    );
    const result = await client.listThreads({ userId: "u", agentId: "a" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("transient");
      expect(result.message).not.toContain("body-secret");
    }
    expect(attempts).toBe(2);
  });

  test("classifies a mid-body caller abort as cancelled", async () => {
    const caller = new AbortController();
    const client = source(async (_input, _init) => {
      let first = true;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (first) {
              first = false;
              controller.enqueue(new TextEncoder().encode('{"threads":'));
              caller.abort();
              return;
            }
            controller.error(new Error("body-secret"));
          },
        }),
        { status: 200 },
      );
    });
    const result = await client.listThreads({
      userId: "u",
      agentId: "a",
      signal: caller.signal,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("cancelled");
  });

  test("classifies a mid-body timeout as timeout", async () => {
    const client = source(
      async (_input, init) => {
        let first = true;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener("abort", () => {
              controller.error(new Error("body-timeout-secret"));
            });
          },
          pull(controller) {
            if (first) {
              first = false;
              controller.enqueue(new TextEncoder().encode('{"threads":'));
              return;
            }
            return new Promise<void>(() => undefined);
          },
        });
        return new Response(body, { status: 200 });
      },
      { timeoutMs: 5, maxRetries: 0 },
    );
    const result = await client.listThreads({ userId: "u", agentId: "a" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("timeout");
  });

  test("rejects oversized bodies without treating them as empty success", async () => {
    const client = source(
      async () =>
        new Response("x".repeat(64), {
          status: 200,
          headers: { "content-length": "64" },
        }),
      { maxBodyBytes: 8 },
    );
    const result = await client.listThreads({ userId: "u", agentId: "a" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("oversized");
  });

  test("refuses NaN and negative transport bounds", () => {
    const fetchImpl = (async () => new Response("{}")) as typeof fetch;
    expect(
      createConversationImportSource(
        { origin: ORIGIN, apiKey: KEY },
        { fetchImpl, timeoutMs: Number.NaN },
      ).ok,
    ).toBe(false);
    expect(
      createConversationImportSource(
        { origin: ORIGIN, apiKey: KEY },
        { fetchImpl, maxRetries: -1 },
      ).ok,
    ).toBe(false);
    expect(
      createConversationImportSource(
        { origin: ORIGIN, apiKey: KEY },
        { fetchImpl, maxBodyBytes: 0 },
      ).ok,
    ).toBe(false);
    expect(
      createConversationImportSource(
        { origin: ORIGIN, apiKey: KEY },
        { fetchImpl, retryBaseDelayMs: -5 },
      ).ok,
    ).toBe(false);
  });
});

describe("resolved source addresses", () => {
  test("rejects a public source hostname resolving to a private address before sending credentials", async () => {
    let fetches = 0;
    const client = source(
      async () => {
        fetches += 1;
        return new Response("{}");
      },
      {
        maxRetries: 0,
        lookupImpl: async () => [{ address: "127.0.0.1", family: 4 }],
      },
    );
    const result = await client.listThreads({ userId: "u", agentId: "a" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("origin-rejected");
    expect(fetches).toBe(0);
  });

  test("fails closed when source hostname resolution fails without exposing lookup details", async () => {
    let fetches = 0;
    const client = source(
      async () => {
        fetches += 1;
        return new Response("{}");
      },
      {
        maxRetries: 0,
        lookupImpl: async () => {
          throw new Error(`dns-secret-${KEY}`);
        },
      },
    );
    const result = await client.listThreads({ userId: "u", agentId: "a" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("transient");
      expect(result.message).not.toContain(KEY);
      expect(result.message).not.toContain("dns-secret");
    }
    expect(fetches).toBe(0);
  });

  test("pins the validated address while retaining the source Host header", async () => {
    const server = createServer((request, response) => {
      expect(request.headers.host).toMatch(/^source\.test:\d+$/);
      expect(request.headers.authorization).toBe(`Bearer ${KEY}`);
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          threads: [{ id: "t1", name: "Pinned" }],
          nextCursor: null,
        }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("Fixture did not expose a TCP port.");
      let lookups = 0;
      const created = createConversationImportSource(
        { origin: `http://source.test:${address.port}`, apiKey: KEY },
        {
          allowHttp: true,
          allowPrivateHosts: true,
          maxRetries: 0,
          lookupImpl: async () => {
            lookups += 1;
            return [{ address: "127.0.0.1", family: 4 }];
          },
        },
      );
      if (!created.ok) throw new Error(created.message);
      const result = await created.value.listThreads({
        userId: "u",
        agentId: "a",
      });
      expect(result.ok).toBe(true);
      expect(lookups).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("error redaction and retries", () => {
  test("does not surface raw bodies or bearer keys in failure messages", async () => {
    const client = source(async () => {
      return new Response(
        JSON.stringify({
          error: "secret-transcript",
          Authorization: `Bearer ${KEY}`,
        }),
        { status: 500 },
      );
    });
    const result = await client.listThreads({ userId: "u", agentId: "a" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toContain(KEY);
      expect(result.message).not.toContain("secret-transcript");
      expect(result.code).toBe("http-error");
    }
  });

  test("retries 503 using bounded Retry-After", async () => {
    let n = 0;
    const slept: number[] = [];
    const client = source(
      async () => {
        n += 1;
        if (n === 1) {
          return new Response("busy", {
            status: 503,
            headers: { "Retry-After": "2" },
          });
        }
        return new Response(
          JSON.stringify({
            threads: [{ id: "t", name: null }],
            nextCursor: null,
          }),
          { status: 200 },
        );
      },
      {
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
    );
    const result = await client.listThreads({ userId: "u", agentId: "a" });
    expect(result.ok).toBe(true);
    expect(n).toBe(2);
    expect(slept).toEqual([2000]);
  });

  test("retries 429 using bounded Retry-After", async () => {
    let n = 0;
    const slept: number[] = [];
    const client = source(
      async () => {
        n += 1;
        if (n === 1) {
          return new Response("slow", {
            status: 429,
            headers: { "retry-after": "1" },
          });
        }
        return new Response(
          JSON.stringify({
            threads: [{ id: "t", name: null }],
            nextCursor: null,
          }),
          { status: 200 },
        );
      },
      {
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
    );
    const result = await client.listThreads({ userId: "u", agentId: "a" });
    expect(result.ok).toBe(true);
    expect(n).toBe(2);
    expect(slept).toEqual([1000]);
  });

  test("caps Retry-After at ten seconds", async () => {
    const slept: number[] = [];
    let n = 0;
    const client = source(
      async () => {
        n += 1;
        if (n === 1) {
          return new Response("busy", {
            status: 503,
            headers: { "Retry-After": "999" },
          });
        }
        return new Response(
          JSON.stringify({
            threads: [{ id: "t", name: null }],
            nextCursor: null,
          }),
          { status: 200 },
        );
      },
      {
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
    );
    await client.listThreads({ userId: "u", agentId: "a" });
    expect(slept).toEqual([10_000]);
  });
});

describe("source observations", () => {
  test("reports bounded retry, status, latency, and hashed job correlation", async () => {
    const emitted: ConversationObservation[] = [];
    let attempts = 0;
    let clock = 100;
    const client = source(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          return new Response("busy", { status: 503 });
        }
        return new Response(
          JSON.stringify({
            threads: [{ id: "t", name: null }],
            nextCursor: null,
          }),
          { status: 200 },
        );
      },
      {
        maxRetries: 1,
        jobId: "private-job-id",
        observe: (observation) => emitted.push(observation),
        now: () => {
          clock += 5;
          return clock;
        },
      },
    );

    const result = await client.listThreads({ userId: "u", agentId: "a" });
    expect(result.ok).toBe(true);
    expect(emitted.map((observation) => observation.outcome)).toEqual([
      "started",
      "received",
      "failed",
      "retrying",
      "started",
      "received",
    ]);
    expect(
      emitted
        .filter((observation) => observation.retry !== undefined)
        .every(({ retry }) => retry === 0 || retry === 1),
    ).toBe(true);
    expect(
      emitted
        .filter((observation) => observation.httpStatus !== undefined)
        .map((observation) => observation.httpStatus),
    ).toEqual([503, 503, 503, 200]);
    for (const observation of emitted.filter(
      ({ outcome }) => outcome === "received" || outcome === "failed",
    )) {
      expect(observation.latencyMs).toEqual(expect.any(Number));
      expect(observation.latencyMs).toBeGreaterThanOrEqual(0);
    }
    expect(
      emitted.every(
        ({ subsystem, operation }) =>
          subsystem === "import" && operation === "source",
      ),
    ).toBe(true);
    expect(
      emitted.every(
        ({ correlation }) =>
          correlation?.jobId === undefined ||
          /^[a-f0-9]{64}$/.test(correlation.jobId),
      ),
    ).toBe(true);
  });

  test("keeps source observations free of source secrets and payload metadata", async () => {
    const emitted: ConversationObservation[] = [];
    let calls = 0;
    const client = source(
      async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(
            JSON.stringify({
              error: "raw-error-secret",
              authorization: `Bearer ${KEY}`,
              transcript: "transcript-secret",
              state: "state-secret",
            }),
            { status: 500 },
          );
        }
        return new Response(
          JSON.stringify({
            kind: "snapshot",
            state: { private: "state-secret" },
            skippedDeltas: 0,
          }),
          { status: 200 },
        );
      },
      {
        maxRetries: 0,
        jobId: "private-job-id",
        observe: (observation) => emitted.push(observation),
      },
    );

    const failed = await client.listThreads({
      userId: "actor-secret",
      agentId: "query-secret",
      cursor: "url-query-secret",
    });
    expect(failed.ok).toBe(false);
    const state = await client.getThreadState({
      threadId: "thread-secret",
      access: { ownershipEstablished: true },
    });
    expect(state.ok).toBe(true);

    const serialized = JSON.stringify(emitted);
    for (const canary of [
      KEY,
      "raw-error-secret",
      "actor-secret",
      "query-secret",
      "url-query-secret",
      "transcript-secret",
      "state-secret",
      "thread-secret",
      "https://intelligence.example.test/api/threads",
    ]) {
      expect(serialized).not.toContain(canary);
    }
  });

  test("a throwing observer cannot change the source response", async () => {
    const client = source(
      async () =>
        new Response(
          JSON.stringify({
            threads: [{ id: "t", name: null }],
            nextCursor: null,
          }),
          { status: 200 },
        ),
      {
        observe: () => {
          throw new Error("observer failure");
        },
      },
    );

    const result = await client.listThreads({ userId: "u", agentId: "a" });
    expect(result).toEqual({
      ok: true,
      value: {
        threads: [{ id: "t", name: null }],
        nextCursor: null,
      },
    });
  });
});

describe("foreign redirects", () => {
  test("refuses a different origin and never forwards the key", async () => {
    const auths: Array<string | null> = [];
    const urls: string[] = [];
    const client = source(async (input, init) => {
      urls.push(String(input));
      const headers = new Headers(init?.headers);
      auths.push(headers.get("Authorization"));
      return new Response(null, {
        status: 302,
        headers: { Location: "https://evil.example/steal" },
      });
    });
    const result = await client.getThread({ threadId: "t", userId: "u" });
    expect(result.ok).toBe(false);
    if (!result.ok && "code" in result)
      expect(result.code).toBe("redirect-refused");
    expect(urls).toHaveLength(1);
    expect(urls[0]?.startsWith(ORIGIN)).toBe(true);
    expect(auths).toEqual([`Bearer ${KEY}`]);
  });

  test.each([
    "http://intelligence.example.test/changed-scheme",
    "https://intelligence.example.test:444/changed-port",
    "https://evil.example/changed-host",
  ])(
    "refuses manual redirects across host, port, or scheme: %s",
    async (location) => {
      let requests = 0;
      const client = source(async () => {
        requests += 1;
        return new Response(null, {
          status: 302,
          headers: { Location: location },
        });
      });
      const result = await client.getThread({ threadId: "t", userId: "u" });
      expect(result.ok).toBe(false);
      if (!result.ok && "code" in result)
        expect(result.code).toBe("redirect-refused");
      expect(requests).toBe(1);
    },
  );

  test("refuses a same-origin redirect chain once a later hop changes its port", async () => {
    let requests = 0;
    const client = source(async () => {
      requests += 1;
      return new Response(null, {
        status: 302,
        headers: {
          Location:
            requests === 1
              ? `${ORIGIN}/same-origin-hop`
              : "https://intelligence.example.test:444/final",
        },
      });
    });
    const result = await client.getThread({ threadId: "t", userId: "u" });
    expect(result.ok).toBe(false);
    if (!result.ok && "code" in result)
      expect(result.code).toBe("redirect-refused");
    expect(requests).toBe(2);
  });
});

describe("optional debug resources", () => {
  test("events truncated and decode gaps stay explicit", async () => {
    const client = source(async (input) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/api/_inspect/threads/t1/events");
      return new Response(
        JSON.stringify({
          events: [{ type: "TEXT_MESSAGE_START" }],
          decodeErrorRowIds: ["row-9"],
          truncated: true,
        }),
        { status: 200 },
      );
    });
    const result = await client.getThreadEvents({
      threadId: "t1",
      access: { ownershipEstablished: true },
    });
    expect(result.ok).toBe(false);
    if (!result.ok && "gap" in result) {
      expect(result.gap).toBe("truncated");
      expect(result.details?.truncated).toBe(true);
      expect(result.details?.decodeErrorRowIds).toEqual(["row-9"]);
    }
  });

  test("state variants remain discriminated", async () => {
    const replies = [
      { kind: "no-snapshot" },
      { kind: "snapshot-decode-error" },
      { kind: "snapshot", state: { x: 1 }, skippedDeltas: 2 },
      { kind: "snapshot", state: { x: 1 }, skippedDeltas: 0 },
    ];
    let i = 0;
    const client = source(async () => {
      return new Response(JSON.stringify(replies[i++]!), { status: 200 });
    });
    const access = { ownershipEstablished: true } as const;
    const a = await client.getThreadState({ threadId: "t", access });
    const b = await client.getThreadState({ threadId: "t", access });
    const c = await client.getThreadState({ threadId: "t", access });
    const d = await client.getThreadState({ threadId: "t", access });
    expect(a.ok).toBe(false);
    if (!a.ok && "gap" in a) expect(a.gap).toBe("no-snapshot");
    expect(b.ok).toBe(false);
    if (!b.ok && "gap" in b) expect(b.gap).toBe("decode-error");
    expect(c.ok).toBe(false);
    if (!c.ok && "gap" in c) expect(c.gap).toBe("skipped-deltas");
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.value.kind).toBe("snapshot");
  });

  test("missing debug endpoint is a gap, not empty success", async () => {
    const client = source(async () => new Response("nope", { status: 404 }));
    const events = await client.getThreadEvents({
      threadId: "t",
      access: { ownershipEstablished: true },
    });
    expect(events.ok).toBe(false);
    if (!events.ok && "gap" in events) expect(events.gap).toBe("unavailable");
  });
});
