import { describe, expect, test } from "bun:test";
import { createStallGuard } from "../src/channels/stall-guard";
import { loadConfig } from "../src/config";
import { mountCopilotRuntime } from "../src/copilot";
import { createConversationEngine } from "../src/conversations/engine";
import type { ConversationStore } from "../src/conversations/store";
import { testEnvironment } from "./support/environment";

function mounted() {
  let identities = 0;
  let storeCalls = 0;
  const roles: string[] = [];
  const store = {
    authorize: async () => {
      storeCalls += 1;
      return "none";
    },
  } as unknown as ConversationStore;
  const engine = createConversationEngine({ store });
  const args: Parameters<typeof mountCopilotRuntime> = [
    loadConfig(testEnvironment()),
    { provider: "openai", defaultModel: "test-model" },
    async (actor) => {
      roles.push(actor.role);
      return [
        {
          id: "bot",
          name: "Test Bot",
          type: "built_in",
          title: "Test",
          roleDescription: "Test fixture",
        },
      ];
    },
    async () => null,
    async () => {
      identities += 1;
      return identities === 1
        ? { id: "user-a", role: "user" }
        : { id: "admin-b", role: "admin" };
    },
    createStallGuard({ stallMs: 0 }),
  ];
  args[16] = { store, engine };
  const runtime = mountCopilotRuntime(...args);
  return {
    ...runtime,
    identities: () => identities,
    storeCalls: () => storeCalls,
    roles,
  };
}

describe("local history runtime boundary", () => {
  test("agent discovery retains the same authenticated actor instead of resolving a second identity", async () => {
    const runtime = mounted();
    const response = await runtime.handler.request(
      "http://openbot.test/api/copilotkit/info",
    );
    const info = await response.json();
    expect({ status: response.status, info }).toMatchObject({ status: 200 });
    expect(runtime.identities()).toBe(1);
    expect(runtime.roles.length).toBeGreaterThan(0);
    expect(runtime.roles.every((role) => role === "user")).toBe(true);
    expect(info.mode).toBe("sse");
    expect(info).not.toHaveProperty("licenseStatus");
  });

  test.each([
    "/api/copilotkit",
    "/api/copilotkit?unexpected=1",
    "/api/copilotkit/memories",
    "/api/copilotkit/threads/clear",
  ])("does not forward disallowed root or hosted routes: %s", async (path) => {
    const runtime = mounted();
    const response = await runtime.handler.request(
      `http://openbot.test${path}`,
      { method: "POST" },
    );
    expect(response.status).toBe(404);
    expect(runtime.storeCalls()).toBe(0);
  });

  test.each(["not-json", "[]", '{"input":{"threadId":"nested"}}'])(
    "refuses malformed or obsolete nested runtime input before history access: %s",
    async (body) => {
      const runtime = mounted();
      const response = await runtime.handler.request(
        "http://openbot.test/api/copilotkit/agent/bot/run",
        {
          method: "POST",
          body,
          headers: { "content-type": "application/json" },
        },
      );
      expect(response.status).toBe(400);
      expect(runtime.storeCalls()).toBe(0);
    },
  );

  test("caps streamed JSON bodies even without Content-Length", async () => {
    const runtime = mounted();
    const response = await runtime.handler.request(
      "http://openbot.test/api/copilotkit/agent/bot/run",
      {
        method: "POST",
        body: JSON.stringify({
          threadId: "t",
          text: "x".repeat(4 * 1024 * 1024),
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(response.status).toBe(413);
    expect(runtime.storeCalls()).toBe(0);
  });

  test("malformed encoded agent IDs are refused rather than producing an internal error", async () => {
    const runtime = mounted();
    const response = await runtime.handler.request(
      "http://openbot.test/api/copilotkit/agent/%FF/run",
      {
        method: "POST",
        body: JSON.stringify({ threadId: "t" }),
      },
    );
    expect(response.status).toBe(400);
    expect(runtime.storeCalls()).toBe(0);
  });
});
