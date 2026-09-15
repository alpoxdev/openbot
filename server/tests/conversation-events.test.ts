import { describe, expect, test } from "bun:test";
import type { BaseEvent } from "@ag-ui/client";
import { historyEvent, projectConversation } from "../src/conversations/events";

const event = (value: BaseEvent & Record<string, unknown>): BaseEvent => value;

describe("committed conversation event projection", () => {
  test("restores partial assistant output after a committed user baseline without mutating it", async () => {
    const baseline = {
      messages: [{ id: "user-1", role: "user" as const, content: "Question" }],
      state: { step: 1 },
    };
    const result = await projectConversation(baseline, [
      event({
        type: "TEXT_MESSAGE_START",
        messageId: "answer-1",
        role: "assistant",
      }),
      event({
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "answer-1",
        delta: "Partial ",
      }),
      event({
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "answer-1",
        delta: "answer",
      }),
    ]);
    expect(result.messages).toEqual([
      baseline.messages[0],
      { id: "answer-1", role: "assistant", content: "Partial answer" },
    ]);
    expect(baseline.messages).toHaveLength(1);
    expect(result.state).toEqual({ step: 1 });
  });

  test("preserves tool call identity, arguments and result without invoking tools", async () => {
    const result = await projectConversation({ messages: [], state: {} }, [
      event({
        type: "TOOL_CALL_START",
        toolCallId: "call-1",
        toolCallName: "search",
        parentMessageId: "answer-1",
      }),
      event({
        type: "TOOL_CALL_ARGS",
        toolCallId: "call-1",
        delta: '{"query":',
      }),
      event({
        type: "TOOL_CALL_ARGS",
        toolCallId: "call-1",
        delta: '"history"}',
      }),
      event({ type: "TOOL_CALL_END", toolCallId: "call-1" }),
      event({
        type: "TOOL_CALL_RESULT",
        toolCallId: "call-1",
        messageId: "result-1",
        role: "tool",
        content: "Found",
      }),
    ]);
    expect(result.messages).toEqual([
      {
        id: "answer-1",
        role: "assistant",
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "search", arguments: '{"query":"history"}' },
          },
        ],
      },
      { id: "result-1", role: "tool", toolCallId: "call-1", content: "Found" },
    ]);
  });

  test("applies state and activity snapshots and deltas in committed order", async () => {
    const result = await projectConversation({ messages: [], state: {} }, [
      event({ type: "STATE_SNAPSHOT", snapshot: { count: 1 } }),
      event({
        type: "STATE_DELTA",
        delta: [{ op: "replace", path: "/count", value: 2 }],
      }),
      event({
        type: "ACTIVITY_SNAPSHOT",
        messageId: "activity-1",
        activityType: "progress",
        content: { done: false },
      }),
      event({
        type: "ACTIVITY_DELTA",
        messageId: "activity-1",
        activityType: "progress",
        patch: [{ op: "replace", path: "/done", value: true }],
      }),
    ]);
    expect(result.state).toEqual({ count: 2 });
    expect(result.messages).toEqual([
      {
        id: "activity-1",
        role: "activity",
        activityType: "progress",
        content: { done: true },
      },
    ]);
  });

  test("a baseline with no tail is copied, never shared mutable history", async () => {
    const baseline = {
      messages: [{ id: "u", role: "user" as const, content: "Saved" }],
      state: { nested: { saved: true } },
    };
    const result = await projectConversation(baseline, []);
    result.messages[0]!.content = "Changed";
    (result.state as { nested: { saved: boolean } }).nested.saved = false;
    expect(baseline.messages[0]!.content).toBe("Saved");
    expect(baseline.state.nested.saved).toBe(true);
  });

  test("run-start history never contains model-only input or assertion credentials", () => {
    const raw = event({
      type: "RUN_STARTED",
      threadId: "t",
      runId: "r",
      input: {
        forwardedProps: { assertion: "private" },
        messages: [{ role: "system", content: "private context" }],
      },
    });
    expect(historyEvent(raw)).toEqual({
      type: "RUN_STARTED",
      threadId: "t",
      runId: "r",
    });
    expect(raw).toHaveProperty("input");
  });
});
