import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  observeConversation,
  type ConversationObservation,
} from "../src/conversations/observability";

function digest(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

describe("conversation observations", () => {
  test("whitelists measurements, drops unknown fields, and hashes correlation", () => {
    const emitted: ConversationObservation[] = [];
    observeConversation((observation) => emitted.push(observation), {
      subsystem: "runtime",
      operation: "append",
      outcome: "completed",
      timestampMs: 0,
      correlation: {
        threadId: "thread-secret\nmessage",
        runId: "run-secret",
        jobId: "job-secret",
        injection: "ignore",
      },
      latencyMs: 12.5,
      lag: 3,
      count: 1,
      httpStatus: 201,
      retry: 0,
      gap: "sequence",
      error: "persistence",
      message: "raw transcript secret",
      errorText: "raw provider error",
      url: "https://private.example/token",
      body: "tool payload",
      state: "assertion",
      tool: "do-not-log",
      assertion: "do-not-log",
      unknown: { secret: "do-not-log" },
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      subsystem: "runtime",
      operation: "append",
      outcome: "completed",
      correlation: {
        threadId: digest("thread-secret\nmessage"),
        runId: digest("run-secret"),
        jobId: digest("job-secret"),
      },
      latencyMs: 12.5,
      lag: 3,
      count: 1,
      httpStatus: 201,
      retry: 0,
      gap: "sequence",
      error: "persistence",
    });
    expect(emitted[0]?.timestampMs).toEqual(expect.any(Number));
    expect(emitted[0]?.timestampMs).toBeGreaterThan(0);
    expect(emitted[0]?.timestampMs).not.toBe(0);
    const serialized = JSON.stringify(emitted);
    expect(serialized).not.toContain("raw transcript");
    expect(serialized).not.toContain("provider error");
    expect(serialized).not.toContain("private.example");
    expect(serialized).not.toContain("tool payload");
    expect(serialized).not.toContain("assertion");
  });

  test("drops invalid enum and numeric values", () => {
    const emitted: ConversationObservation[] = [];
    observeConversation((observation) => emitted.push(observation), {
      subsystem: "runtime",
      operation: "not-an-operation",
      outcome: "completed",
      latencyMs: Number.NaN,
      lag: -1,
      count: 1.2,
      httpStatus: 700,
      retry: Number.POSITIVE_INFINITY,
      gap: "not-a-gap",
      error: "not-an-error",
    });
    expect(emitted).toHaveLength(0);

    observeConversation((observation) => emitted.push(observation), {
      subsystem: "runtime",
      operation: "append",
      outcome: "completed",
      latencyMs: Number.NaN,
      lag: -1,
      count: 1.2,
      httpStatus: 700,
      retry: Number.POSITIVE_INFINITY,
      gap: "not-a-gap",
      error: "not-an-error",
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      subsystem: "runtime",
      operation: "append",
      outcome: "completed",
    });
    expect(emitted[0]).not.toHaveProperty("latencyMs");
    expect(emitted[0]).not.toHaveProperty("lag");
    expect(emitted[0]).not.toHaveProperty("count");
    expect(emitted[0]).not.toHaveProperty("httpStatus");
    expect(emitted[0]).not.toHaveProperty("retry");
    expect(emitted[0]).not.toHaveProperty("gap");
    expect(emitted[0]).not.toHaveProperty("error");
  });

  test("accepts the fixed import phases and source categories", () => {
    const emitted: ConversationObservation[] = [];
    observeConversation((observation) => emitted.push(observation), {
      subsystem: "import",
      operation: "source",
      outcome: "progress",
      phase: "awaiting_confirmation",
      correlation: { jobId: "job-1" },
      gap: "source-changed",
      error: "source-auth",
      latencyMs: 4,
      httpStatus: 206,
      retry: 1,
    });
    expect(emitted[0]).toMatchObject({
      subsystem: "import",
      operation: "source",
      outcome: "progress",
      phase: "awaiting_confirmation",
      gap: "source-changed",
      error: "source-auth",
      latencyMs: 4,
      httpStatus: 206,
      retry: 1,
      correlation: { jobId: digest("job-1") },
    });
  });

  test("swallows synchronous and asynchronous observer failures", async () => {
    expect(() =>
      observeConversation(
        () => {
          throw new Error("observer must not break a run");
        },
        {
          subsystem: "runtime",
          operation: "run",
          outcome: "started",
        },
      ),
    ).not.toThrow();
    expect(() =>
      observeConversation(
        () => Promise.reject(new Error("observer rejection")),
        {
          subsystem: "import",
          operation: "inventory",
          outcome: "discovered",
          count: 2,
        },
      ),
    ).not.toThrow();
    await Promise.resolve();
  });
});
