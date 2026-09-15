import { describe, expect, test } from "bun:test";
import { localThreadStatus } from "../src/channels/thread-status";
import type { ConversationStore } from "../src/conversations/store";
import {
  ConversationAccessError,
  ConversationNotFoundError,
} from "../src/conversations/types";

function reader(readSnapshot: (...args: unknown[]) => Promise<unknown>) {
  return { readSnapshot } as unknown as ConversationStore;
}

describe("server conversation availability", () => {
  test.each([
    ["ready", "local"],
    ["history_only", "local"],
    ["not_ready", "import_pending"],
  ])(
    "preserves %s readiness instead of treating it as empty",
    async (localReadiness, status) => {
      const store = reader(async () => ({ thread: { localReadiness } }));
      expect(await localThreadStatus(store, "thread", "owner")).toEqual({
        status,
        localReadiness,
      });
    },
  );

  test.each([new ConversationNotFoundError(), new ConversationAccessError()])(
    "missing and foreign records have indistinguishable unavailable responses",
    async (error) => {
      const store = reader(async () => {
        throw error;
      });
      expect(await localThreadStatus(store, "thread", "owner")).toEqual({
        status: "external_unavailable",
      });
    },
  );

  test("database failures remain failures, never evidence that a remembered ID is gone", async () => {
    const error = new Error("database offline");
    const store = reader(async () => {
      throw error;
    });
    await expect(localThreadStatus(store, "thread", "owner")).rejects.toBe(
      error,
    );
  });

  test("uses the authenticated owner and exact historical identifier", async () => {
    const calls: unknown[][] = [];
    const store = reader(async (...args) => {
      calls.push(args);
      return { thread: { localReadiness: "ready" } };
    });
    await localThreadStatus(store, "historical-id", "original-owner");
    expect(calls).toEqual([[{ id: "original-owner" }, "historical-id"]]);
  });
});
