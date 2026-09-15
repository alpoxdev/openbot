import { tryClient } from "@/lib/client";
import {
  readableTurns,
  type StoredThread,
} from "@/lib/copilot/thread-messages";

export const COPILOTKIT_THREADS_PATH = "/api/copilotkit/threads";
export const THREADS_MINT_PATH = "/api/threads/mint";

export type ConversationLocalReadiness = "ready" | "history_only" | "not_ready";

export type ConversationThreadStatus =
  | "local"
  | "import_pending"
  | "external_unavailable"
  | "notfound";

export type ConversationThreadSummary = {
  id: string;
  agentId: string | null;
  channelId: string | null;
  provenance: string | null;
  localReadiness: ConversationLocalReadiness | null;
  updatedAt: string;
  title: string | null;
  preview: string | null;
};

export type ConversationThreadRecord = {
  status: ConversationThreadStatus;
  localReadiness?: ConversationLocalReadiness;
};

export type ConversationHistoryList = {
  threads: ConversationThreadSummary[];
  nextCursor: string | null;
  availability: "ready" | "unavailable";
};

const EMPTY_UNAVAILABLE: ConversationHistoryList = {
  threads: [],
  nextCursor: null,
  availability: "unavailable",
};

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asReadiness(value: unknown): ConversationLocalReadiness | null {
  return value === "ready" || value === "history_only" || value === "not_ready"
    ? value
    : null;
}

function asStatus(value: unknown): ConversationThreadStatus | null {
  if (
    value === "local" ||
    value === "import_pending" ||
    value === "external_unavailable" ||
    value === "notfound"
  ) {
    return value;
  }
  return null;
}

function asSummary(value: unknown): ConversationThreadSummary | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  const id = asString(row.id);
  const updatedAt = asString(row.updatedAt);
  if (!id || !updatedAt) return null;
  // A missing channel identity is not equivalent to a direct thread. Keep restoration fail-closed
  // rather than turning an incomplete server row into a browser-owned conversation.
  if (!("channelId" in row)) return null;
  const channelId = row.channelId === null ? null : asString(row.channelId);
  if (row.channelId !== null && channelId === null) return null;
  if ("localReadiness" in row && !asReadiness(row.localReadiness)) {
    return null;
  }
  return {
    id,
    agentId: asString(row.agentId),
    channelId,
    provenance: asString(row.provenance),
    localReadiness: asReadiness(row.localReadiness),
    updatedAt,
    title: asString(row.title),
    preview: asString(row.preview),
  };
}

function parseConversationHistoryPage(
  body: unknown,
  options?: {
    agentId?: string;
    directOnly?: boolean;
    limit?: number;
  },
): ConversationHistoryList | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.threads) || !("nextCursor" in record)) {
    return null;
  }
  const nextCursor =
    record.nextCursor === null ? null : asString(record.nextCursor);
  if (
    record.nextCursor !== null &&
    (nextCursor === null || nextCursor === "")
  ) {
    return null;
  }

  const threads: ConversationThreadSummary[] = [];
  for (const row of record.threads) {
    const summary = asSummary(row);
    // A malformed row means the server did not provide a trustworthy complete list. Treating it
    // as an empty result could mint a new thread and strand the history that row represented.
    if (!summary) return null;
    if (options?.agentId !== undefined && summary.agentId !== options.agentId) {
      return null;
    }
    if (options?.directOnly === true && summary.channelId !== null) {
      return null;
    }
    threads.push(summary);
  }
  if (options?.limit !== undefined && threads.length > options.limit) {
    return null;
  }
  // An empty page is the server's end-of-history sentinel. A cursor after no rows would make the
  // next request unverifiable and could cause callers to treat contradictory data as a clear list.
  if (threads.length === 0 && nextCursor !== null) return null;
  return { threads, nextCursor, availability: "ready" };
}

export function parseConversationThreadRecord(
  body: unknown,
): ConversationThreadRecord | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const status = asStatus(record.status);
  if (!status) return null;
  if (!("localReadiness" in record)) return { status };
  const localReadiness = asReadiness(record.localReadiness);
  return localReadiness ? { status, localReadiness } : null;
}

export function liveHandoverAllowed(
  record: ConversationThreadRecord | null,
): boolean {
  return record?.status === "local" && record.localReadiness === "ready";
}

export async function mintConversationThread(
  agentId: string,
): Promise<string | null> {
  try {
    const response = await tryClient(THREADS_MINT_PATH, {
      method: "POST",
      body: { agentId },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { threadId?: unknown };
    return typeof body.threadId === "string" ? body.threadId : null;
  } catch {
    return null;
  }
}

export async function readConversationThread(
  threadId: string,
): Promise<ConversationThreadRecord | null> {
  try {
    const response = await tryClient(
      `/api/threads/${encodeURIComponent(threadId)}`,
    );
    if (response.status === 404) {
      return { status: "notfound" };
    }
    if (!response.ok) return null;
    return parseConversationThreadRecord(await response.json());
  } catch {
    return null;
  }
}

export async function listConversationHistory(options?: {
  agentId?: string;
  directOnly?: boolean;
  limit?: number;
  cursor?: string;
}): Promise<ConversationHistoryList> {
  try {
    const query = new URLSearchParams();
    if (options?.agentId) query.set("agentId", options.agentId);
    if (options?.directOnly) query.set("directOnly", "true");
    if (options?.limit !== undefined) {
      query.set("limit", String(options.limit));
    }
    if (options?.cursor) query.set("cursor", options.cursor);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    const response = await tryClient(`${COPILOTKIT_THREADS_PATH}${suffix}`);
    if (!response.ok) return EMPTY_UNAVAILABLE;
    return (
      parseConversationHistoryPage(await response.json(), options) ??
      EMPTY_UNAVAILABLE
    );
  } catch {
    return EMPTY_UNAVAILABLE;
  }
}

export async function mostRecentEligibleThread(
  agentId: string,
): Promise<ConversationThreadSummary | null | "unavailable"> {
  const listed = await listConversationHistory({
    agentId,
    directOnly: true,
    limit: 1,
  });
  if (listed.availability === "unavailable") return "unavailable";
  return listed.threads[0] ?? null;
}

export async function readConversationMessages(
  threadId: string,
  agentId?: string,
): Promise<StoredThread> {
  try {
    const query = agentId ? `?agentId=${encodeURIComponent(agentId)}` : "";
    const response = await tryClient(
      `${COPILOTKIT_THREADS_PATH}/${encodeURIComponent(threadId)}/messages${query}`,
    );
    if (!response.ok) {
      return { messages: [], unreadable: 0, availability: "unavailable" };
    }
    const body: unknown = await response.json();
    const stored =
      typeof body === "object" && body !== null && "messages" in body
        ? (body as { messages: unknown }).messages
        : null;
    return Array.isArray(stored)
      ? readableTurns(stored)
      : { messages: [], unreadable: 0, availability: "unavailable" };
  } catch {
    return { messages: [], unreadable: 0, availability: "unavailable" };
  }
}
