import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import {
  ConversationAccessError,
  ConversationConflictError,
  ConversationNotFoundError,
} from "../src/conversations/types";
import type { ConversationStore } from "../src/conversations/store";
import { testEnvironment } from "./support/environment";

function authAs(id: string) {
  return {
    handler: () => new Response(null, { status: 204 }),
    api: {
      getSession: async () => ({
        user: { id, email: `${id}@example.test`, name: id },
      }),
    },
  };
}

function storeStub(
  overrides: Partial<ConversationStore> = {},
): ConversationStore {
  return {
    list: async () => ({ threads: [], nextCursor: null }),
    authorize: async () => "none",
    readSnapshot: async () => {
      throw new ConversationNotFoundError();
    },
    readEventPage: async () => [],
    ...overrides,
  } as ConversationStore;
}

describe("owned conversation HTTP", () => {
  test("unauthenticated list and reads are 401", async () => {
    const app = createApp(
      loadConfig(testEnvironment()),
      {
        handler: () => new Response(null, { status: 204 }),
        api: { getSession: async () => null },
      } as never,
      { rolesForUser: async () => ["user"] },
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
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      storeStub(),
    );
    const list = await app.request(
      "http://openbot.test/api/copilotkit/threads",
    );
    expect(list.status).toBe(401);
    const messages = await app.request(
      "http://openbot.test/api/copilotkit/threads/guess/messages",
    );
    expect(messages.status).toBe(401);
  });

  test("foreign or guessed ids are 404, not empty history", async () => {
    const app = createApp(
      loadConfig(testEnvironment()),
      authAs("member") as never,
      { rolesForUser: async () => ["user"] },
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
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      storeStub({
        authorize: async () => {
          throw new ConversationAccessError();
        },
      }),
    );
    const response = await app.request(
      "http://openbot.test/api/copilotkit/threads/foreign/messages",
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found." });
  });

  test("store failure is 502, empty local list is 200", async () => {
    const failing = createApp(
      loadConfig(testEnvironment()),
      authAs("member") as never,
      { rolesForUser: async () => ["user"] },
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
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      storeStub({
        list: async () => {
          throw new Error("db down");
        },
      }),
    );
    const failed = await failing.request(
      "http://openbot.test/api/copilotkit/threads",
    );
    expect(failed.status).toBe(502);

    const empty = createApp(
      loadConfig(testEnvironment()),
      authAs("member") as never,
      { rolesForUser: async () => ["user"] },
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
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      storeStub({ list: async () => ({ threads: [], nextCursor: null }) }),
    );
    const listed = await empty.request(
      "http://openbot.test/api/copilotkit/threads",
    );
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ threads: [], nextCursor: null });
  });

  test("lists one bounded metadata page without reading snapshots", async () => {
    let receivedQuery: unknown;
    const listedAt = new Date("2026-01-02T03:04:05.006Z");
    const app = createApp(
      loadConfig(testEnvironment()),
      authAs("member") as never,
      { rolesForUser: async () => ["user"] },
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
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      storeStub({
        list: async (_actor, query) => {
          receivedQuery = query;
          return {
            threads: [
              {
                id: "thread-1",
                agentId: "agent-1",
                channelId: null,
                provenance: "local",
                localReadiness: "ready",
                updatedAt: listedAt,
                title: "Opening question",
                preview: "Opening question",
              },
            ],
            nextCursor: "opaque-next",
          };
        },
        readSnapshot: async () => {
          throw new Error("list must not read snapshots");
        },
      }),
    );
    const response = await app.request(
      "http://openbot.test/api/copilotkit/threads?agentId=agent-1&directOnly=true&limit=7&cursor=opaque",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      threads: [
        {
          id: "thread-1",
          agentId: "agent-1",
          channelId: null,
          provenance: "local",
          localReadiness: "ready",
          updatedAt: listedAt.toISOString(),
          title: "Opening question",
          preview: "Opening question",
        },
      ],
      nextCursor: "opaque-next",
    });
    expect(receivedQuery).toEqual({
      agentId: "agent-1",
      directOnly: true,
      limit: 7,
      cursor: "opaque",
    });
  });

  test("rejects malformed thread list query parameters", async () => {
    const app = createApp(
      loadConfig(testEnvironment()),
      authAs("member") as never,
      { rolesForUser: async () => ["user"] },
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
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      storeStub(),
    );
    const response = await app.request(
      "http://openbot.test/api/copilotkit/threads?directOnly=maybe",
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Query parameter "directOnly" must be true or false.',
    });
  });

  test("returns a client error for a malformed opaque cursor", async () => {
    const app = createApp(
      loadConfig(testEnvironment()),
      authAs("member") as never,
      { rolesForUser: async () => ["user"] },
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
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      storeStub({
        list: async () => {
          throw new ConversationConflictError("Invalid conversation cursor");
        },
      }),
    );
    const response = await app.request(
      "http://openbot.test/api/copilotkit/threads?cursor=not-valid",
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Invalid conversation cursor",
    });
  });

  test("unknown suffixes including clear are 404 after auth", async () => {
    const app = createApp(
      loadConfig(testEnvironment()),
      authAs("member") as never,
      { rolesForUser: async () => ["user"] },
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
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      storeStub(),
    );
    const clear = await app.request(
      "http://openbot.test/api/copilotkit/threads/clear",
      { method: "POST" },
    );
    expect(clear.status).toBe(404);
  });

  test("owned thread routes do not swallow the runtime dispatcher", async () => {
    const runtime = new Hono();
    runtime.get("/api/copilotkit/info", (context) =>
      context.json({ mode: "sse" }),
    );
    const args: Parameters<typeof createApp> = [
      loadConfig(testEnvironment()),
      authAs("member") as never,
      { rolesForUser: async () => ["user"] },
    ];
    args[6] = runtime;
    args[29] = storeStub();
    const mounted = createApp(...args);
    const response = await mounted.request(
      "http://openbot.test/api/copilotkit/info",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ mode: "sse" });
  });

  test("durable capabilities require a successful full-store readiness probe", async () => {
    let ready = true;
    let probes = 0;
    const args: Parameters<typeof createApp> = [loadConfig(testEnvironment())];
    args[29] = storeStub({
      assertReady: async () => {
        probes += 1;
        if (!ready) throw new Error("partial schema");
      },
    });
    const mounted = createApp(...args);
    const first = await mounted.request("http://openbot.test/api/capabilities");
    expect((await first.json()).durableHistory).toBe(true);
    ready = false;
    const second = await mounted.request(
      "http://openbot.test/api/capabilities",
    );
    expect((await second.json()).durableHistory).toBe(false);
    expect(probes).toBe(2);
  });
});
