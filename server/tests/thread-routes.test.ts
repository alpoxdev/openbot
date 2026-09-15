import { describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import type { ConversationStore } from "../src/conversations/store";
import {
  ConversationAccessError,
  ConversationNotFoundError,
} from "../src/conversations/types";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createThreadRoutes } from "../src/channels/thread-routes";

const identity = createThreadIdentity("openbot-test");
const actor = {
  id: "u1",
  email: "someone@openbot.test",
  role: "user" as const,
};
const signedIn: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", actor);
  await next();
};
const profiles = { getWithin: async () => null };
function fixture(overrides: Partial<ConversationStore> = {}, guard = signedIn) {
  const calls: unknown[][] = [];
  const rows = new Map<string, unknown>();
  const store = {
    createOwnedThread: async (...args: unknown[]) => {
      calls.push(args);
      const id = args[1] as string;
      rows.set(id, { thread: { localReadiness: "ready" } });
      return { id };
    },
    readSnapshot: async (_actor: unknown, id: string) => {
      if (!rows.has(id)) throw new ConversationNotFoundError();
      return rows.get(id);
    },
    ...overrides,
  } as unknown as ConversationStore;
  const app = new Hono().route(
    "/threads",
    createThreadRoutes(identity, guard, store, profiles),
  );
  return { app, calls, rows };
}
const mintInput = {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ agentId: "bot" }),
};

describe("persisted direct thread identities", () => {
  test("registers owner and bot before returning an immediately readable local ID", async () => {
    const { app, calls } = fixture();
    const response = await app.request("http://openbot.test/threads/mint", {
      ...mintInput,
      body: JSON.stringify({
        agentId: "bot",
        ownerUserId: "other",
        role: "admin",
      }),
    });
    expect(response.status).toBe(200);
    const { threadId } = await response.json();
    expect(identity.owns(threadId)).toBe(true);
    expect(calls).toEqual([[actor, threadId, "bot", profiles]]);
    const status = await app.request(`http://openbot.test/threads/${threadId}`);
    expect(await status.json()).toEqual({
      status: "local",
      localReadiness: "ready",
    });
    const next = await app.request(
      "http://openbot.test/threads/mint",
      mintInput,
    );
    expect((await next.json()).threadId).not.toBe(threadId);
  });

  test.each(["", "{}", '{"agentId":""}', "null", "[]"])(
    "rejects missing bot selection: %s",
    async (body) => {
      const { app, calls } = fixture();
      expect(
        (
          await app.request("http://openbot.test/threads/mint", {
            ...mintInput,
            body,
          })
        ).status,
      ).toBe(400);
      expect(calls).toEqual([]);
    },
  );

  test("denies a bot that the authenticated actor cannot use", async () => {
    const { app } = fixture({
      createOwnedThread: async () => {
        throw new ConversationAccessError();
      },
    });
    expect(
      (await app.request("http://openbot.test/threads/mint", mintInput)).status,
    ).toBe(404);
  });

  test("a failed commit returns no minted ID", async () => {
    const { app } = fixture({
      createOwnedThread: async () => {
        throw new Error("private database diagnostics");
      },
    });
    const response = await app.request(
      "http://openbot.test/threads/mint",
      mintInput,
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "Could not create conversation.",
    });
  });

  test("anonymous requests reach neither mint nor status storage", async () => {
    const guard: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
    ) => context.json({ error: "Unauthorized" }, 401);
    const { app, calls } = fixture({}, guard);
    expect(
      (await app.request("http://openbot.test/threads/mint", mintInput)).status,
    ).toBe(401);
    expect(
      (await app.request(`http://openbot.test/threads/${identity.mint()}`))
        .status,
    ).toBe(401);
    expect(calls).toEqual([]);
  });

  test("does not claim old missing history is deleted or mint a replacement", async () => {
    const { app, calls } = fixture();
    const response = await app.request(
      `http://openbot.test/threads/${identity.mint()}`,
    );
    expect(await response.json()).toEqual({ status: "external_unavailable" });
    expect(calls).toEqual([]);
  });

  test("looks up an owned opaque persisted ID without a UUID gate", async () => {
    const storedId = "g002-live-431595-threadId";
    const lookedUp: unknown[][] = [];
    const { app, rows } = fixture({
      readSnapshot: async (...args: unknown[]) => {
        lookedUp.push(args);
        return { thread: { localReadiness: "history_only" } };
      },
    });
    rows.set(storedId, { thread: { localReadiness: "history_only" } });
    const response = await app.request(
      `http://openbot.test/threads/${encodeURIComponent(storedId)}`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "local",
      localReadiness: "history_only",
    });
    expect(lookedUp).toEqual([[{ id: actor.id }, storedId]]);
  });

  test("denies a foreign opaque ID through the authenticated store lookup", async () => {
    const storedId = "g002-live-431595-threadId";
    const { app } = fixture({
      readSnapshot: async () => {
        throw new ConversationAccessError();
      },
    });
    const response = await app.request(
      `http://openbot.test/threads/${encodeURIComponent(storedId)}`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "external_unavailable",
    });
  });

  test("unknown opaque IDs remain unavailable without adoption", async () => {
    const storedId = "g002-live-unknown-thread";
    const { app, calls } = fixture();
    const response = await app.request(
      `http://openbot.test/threads/${encodeURIComponent(storedId)}`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "external_unavailable",
    });
    expect(calls).toEqual([]);
  });

  test("status outage stays a redacted failure rather than a missing-history response", async () => {
    const { app } = fixture({
      readSnapshot: async () => {
        throw new Error("private database diagnostics");
      },
    });
    const response = await app.request(
      `http://openbot.test/threads/${identity.mint()}`,
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "Could not check thread status.",
    });
  });
});
