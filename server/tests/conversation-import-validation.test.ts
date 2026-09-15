import { describe, expect, test } from "bun:test";
import {
  capturedContentHash,
  validateImportedMessages,
} from "../src/conversations/import-validation";

describe("imported message validation", () => {
  test("manifest approval survives JSONB key reordering but remains bound to values and array order", () => {
    const before = {
      origin: "fixture",
      pairs: [{ user: "a", agent: "b" }],
      complete: true,
    };
    const after = {
      complete: true,
      pairs: [{ agent: "b", user: "a" }],
      origin: "fixture",
    };
    expect(capturedContentHash(before)).toBe(capturedContentHash(after));
    expect(capturedContentHash(before)).not.toBe(
      capturedContentHash({ ...after, complete: false }),
    );
    expect(capturedContentHash(["first", "second"])).not.toBe(
      capturedContentHash(["second", "first"]),
    );
  });

  test("converts source calls once while preserving canonical calls, rows, extensions, and order", () => {
    const exactArgumentBytes = '{ "query": "it", "fragment": "  exact  " }';
    const raw = [
      {
        id: "u",
        role: "user",
        content: [{ type: "text", text: "Find it" }],
        sourceExtension: { original: true, order: 1 },
      },
      {
        id: "a",
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "legacy",
            name: "search",
            args: { query: "it" },
            sourceDetail: { spelling: "source", order: 2 },
          },
          {
            id: "canonical",
            type: "function",
            function: { name: "open", arguments: exactArgumentBytes },
            sourceDetail: { spelling: "canonical", order: 3 },
          },
        ],
      },
      {
        id: "t1",
        role: "tool",
        toolCallId: "legacy",
        content: "Found",
        sourceExtension: { order: 4 },
      },
      {
        id: "t2",
        role: "tool",
        toolCallId: "canonical",
        content: "Opened",
        sourceExtension: { order: 5 },
      },
    ];
    const result = validateImportedMessages(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected faithful import");
    expect(result.messages).toEqual([
      raw[0],
      {
        id: "a",
        role: "assistant",
        toolCalls: [
          {
            id: "legacy",
            sourceDetail: { spelling: "source", order: 2 },
            type: "function",
            function: { name: "search", arguments: '{"query":"it"}' },
          },
          {
            id: "canonical",
            type: "function",
            function: { name: "open", arguments: exactArgumentBytes },
            sourceDetail: { spelling: "canonical", order: 3 },
          },
        ],
      },
      raw[2],
      raw[3],
    ]);
    expect(result.messages.map((message) => message.id)).toEqual([
      "u",
      "a",
      "t1",
      "t2",
    ]);
    expect(result.continuationSafe).toBe(true);
    expect(result.issues).toEqual([]);
    expect(raw[1]).toHaveProperty("content", null);
  });

  test("serializes null source args as the JSON bytes null", () => {
    const result = validateImportedMessages([
      {
        id: "a",
        role: "assistant",
        toolCalls: [{ id: "c", name: "approve", args: null }],
      },
      { id: "t", role: "tool", toolCallId: "c", content: "Approved" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected null arguments to be imported");
    expect(result.messages[0]?.toolCalls?.[0]).toEqual({
      id: "c",
      type: "function",
      function: { name: "approve", arguments: "null" },
    });
    expect(result.continuationSafe).toBe(true);
  });

  test("rejects the import rather than silently dropping malformed or duplicate records", () => {
    const result = validateImportedMessages([
      { id: "u", role: "user", content: "Original" },
      { id: "u", role: "user", content: "Conflicting" },
      {
        id: "broken",
        role: "not-a-role",
        content: "Do not silently lose this",
      },
    ]);
    expect(result).toEqual({
      ok: false,
      issues: [
        { code: "duplicate-message", messageId: "u" },
        { code: "invalid-message", messageId: "broken" },
      ],
    });
  });

  test("unknown malformed tool calls remain rejected", () => {
    expect(
      validateImportedMessages([
        {
          id: "broken-call",
          role: "assistant",
          toolCalls: [{ id: "c", type: "function", function: { name: "x" } }],
        },
      ]),
    ).toEqual({
      ok: false,
      issues: [{ code: "invalid-message", messageId: "broken-call" }],
    });
  });

  test("an interrupted tool call remains viewable but cannot automatically continue", () => {
    const result = validateImportedMessages([
      {
        id: "a",
        role: "assistant",
        toolCalls: [{ id: "pending", name: "approve", args: '{"partial":' }],
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok)
      throw new Error("Interrupted history should remain readable");
    expect(result.continuationSafe).toBe(false);
    expect(result.issues).toEqual([{ code: "pending-tool-call" }]);
    expect(result.messages).toHaveLength(1);
  });

  test("orphan results are retained without making them safe executable context", () => {
    const result = validateImportedMessages([
      { id: "t", role: "tool", toolCallId: "missing", content: "Result" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected history-only result");
    expect(result.messages).toHaveLength(1);
    expect(result.continuationSafe).toBe(false);
    expect(result.issues).toEqual([
      { code: "orphan-tool-result", messageId: "t" },
    ]);
  });

  test("empty captured responses validate and changed contents change their digest", () => {
    const empty = validateImportedMessages([]);
    const before = validateImportedMessages([
      { id: "u", role: "user", content: "Before" },
    ]);
    const after = validateImportedMessages([
      { id: "u", role: "user", content: "After" },
    ]);
    expect(empty.ok && empty.messages).toEqual([]);
    expect(
      before.ok && after.ok && before.contentHash !== after.contentHash,
    ).toBe(true);
  });
});
