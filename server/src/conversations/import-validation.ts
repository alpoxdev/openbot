import { createHash } from "node:crypto";
import { type Message, MessageSchema } from "@ag-ui/client";

export const IMPORT_CONVERTER_VERSION = 1;

export type ImportValidationIssue = {
  code:
    | "invalid-message"
    | "duplicate-message"
    | "duplicate-tool-call"
    | "orphan-tool-result"
    | "pending-tool-call";
  messageId?: string;
};

export type ImportedMessagesValidation =
  | { ok: false; issues: ImportValidationIssue[] }
  | {
      ok: true;
      messages: Message[];
      contentHash: string;
      continuationSafe: boolean;
      issues: ImportValidationIssue[];
    };

/** JSONB may reorder object keys; arrays and their message ordering remain significant. */
export function capturedContentHash(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, entry: unknown) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry))
      return entry;
    const record = entry as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, record[key]]),
    );
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Convert the inspected source dialect once; never silently drop a malformed source row. */
export function validateImportedMessages(
  raw: readonly unknown[],
): ImportedMessagesValidation {
  const messages: Message[] = [];
  const issues: ImportValidationIssue[] = [];
  const ids = new Set<string>();
  const toolCalls = new Set<string>();
  const pendingCalls = new Set<string>();

  for (const item of raw) {
    if (!isRecord(item)) {
      issues.push({ code: "invalid-message" });
      continue;
    }
    const candidate = structuredClone(item);
    const messageId =
      typeof candidate.id === "string" ? candidate.id : undefined;
    if (candidate.role === "assistant" && candidate.content === null)
      delete candidate.content;
    if (Array.isArray(candidate.toolCalls)) {
      candidate.toolCalls = candidate.toolCalls.map((call) => {
        if (
          !isRecord(call) ||
          !("name" in call) ||
          !("args" in call) ||
          "function" in call
        )
          return call;
        const { name, args, ...remaining } = call;
        return {
          ...remaining,
          type: "function",
          function: {
            name,
            arguments: typeof args === "string" ? args : JSON.stringify(args),
          },
        };
      });
    }
    if (
      !MessageSchema.safeParse(candidate).success ||
      messageId === undefined
    ) {
      issues.push({
        code: "invalid-message",
        ...(messageId === undefined ? {} : { messageId }),
      });
      continue;
    }
    if (ids.has(messageId)) {
      issues.push({ code: "duplicate-message", messageId });
      continue;
    }
    ids.add(messageId);
    // Preserve extension fields. Returning Zod's parsed value would strip source history fields.
    const message = candidate as Message;
    messages.push(message);
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        if (toolCalls.has(call.id))
          issues.push({ code: "duplicate-tool-call", messageId });
        toolCalls.add(call.id);
        pendingCalls.add(call.id);
      }
    } else if (message.role === "tool") {
      if (!pendingCalls.delete(message.toolCallId))
        issues.push({ code: "orphan-tool-result", messageId });
    }
  }

  if (
    issues.some(
      (issue) =>
        issue.code === "invalid-message" ||
        issue.code === "duplicate-message" ||
        issue.code === "duplicate-tool-call",
    )
  ) {
    return { ok: false, issues };
  }
  if (pendingCalls.size > 0) issues.push({ code: "pending-tool-call" });
  return {
    ok: true,
    messages,
    contentHash: capturedContentHash(messages),
    continuationSafe: issues.length === 0,
    issues,
  };
}
