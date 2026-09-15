import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { botThreadKey } from "@/lib/copilot/bot-thread";

export const CONVERSATION_IMPORTS_PATH = "/api/admin/conversation-imports";

export const BOT_THREAD_HINT_PREFIX = "openbot.bot-thread.";

export type ConversationImportPhase =
  | "inventory"
  | "awaiting_confirmation"
  | "importing"
  | "paused"
  | "cancelled"
  | "completed"
  | "completed_with_gaps"
  | "failed";

export type ConversationImportAttemptStatus = "none" | "active" | "expired";

export type ConversationImportAttemptKind = "inventory" | "run";

export type ConversationImportManifest = {
  inventoryCompleteForDeclaredScope: boolean;
  pairCount: number;
  threadCount: number;
  notes: string[];
  /**
   * The server increments this when inventory evidence changes. Older servers do not include it,
   * and the value is intentionally not interpreted by this client.
   */
  inventoryRevision?: unknown;
};

export type ConversationImportJob = {
  id: string;
  sourceOrigin: string;
  sourceReference: string;
  phase: ConversationImportPhase;
  manifest: ConversationImportManifest;
  approvedManifestHash: string | null;
  attemptStatus: ConversationImportAttemptStatus;
  attemptKind: ConversationImportAttemptKind | null;
};

export type ConversationImportItem = {
  id: string;
  sourceThreadId: string;
  sourceUserId: string;
  sourceAgentId: string | null;
  destinationUserId: string | null;
  status: string;
  coverage: unknown;
  failureCode: string | null;
};

export type ConversationImportJobDetail = {
  job: ConversationImportJob;
  items: ConversationImportItem[];
  manifestHash: string | null;
};

export type CreateConversationImportInput = {
  sourceOrigin: string;
  sourceReference: string;
  sourceNamespace?: string;
  explicitPairs?: { userId: string; agentId: string }[];
  explicitIds?: { threadId: string; userId: string }[];
};

export const conversationImportKeys = {
  all: ["conversation-imports"] as const,
  list: () => [...conversationImportKeys.all, "list"] as const,
  detail: (id: string) =>
    [...conversationImportKeys.all, "detail", id] as const,
};

export function isActiveImportPhase(phase: ConversationImportPhase): boolean {
  return phase === "inventory" || phase === "importing";
}

export function defaultSourceOrigin(): string {
  // An import must name the old source explicitly. Falling back to this server's origin would
  // silently send a source credential to the wrong host.
  return "";
}

type BrowserStorage = Pick<Storage, "length" | "key" | "getItem">;

function localStorageIfAvailable(): BrowserStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    // Storage can be disabled by browser policy or an opaque origin.
    return null;
  }
}

/** Read remembered Bot thread ids without writing or deleting them. */
export function readBrowserThreadHints(
  userId: string,
  storage: BrowserStorage | null | undefined = localStorageIfAvailable(),
): { threadId: string; userId: string }[] {
  if (typeof userId !== "string" || !userId.trim() || !storage) return [];
  const hints: { threadId: string; userId: string }[] = [];
  let length: number;
  try {
    length = storage.length;
  } catch {
    return hints;
  }
  for (let index = 0; index < length; index += 1) {
    let key: string | null;
    try {
      key = storage.key(index);
    } catch {
      continue;
    }
    if (typeof key !== "string" || !key.startsWith(BOT_THREAD_HINT_PREFIX))
      continue;
    let threadId: string | null;
    try {
      threadId = storage.getItem(key);
    } catch {
      continue;
    }
    if (typeof threadId !== "string" || !threadId) continue;
    hints.push({ threadId, userId });
  }
  return hints;
}

export function botThreadStorageKey(agentId: string): string {
  return botThreadKey(agentId);
}

export function listConversationImportsQueryOptions() {
  return queryOptions({
    queryKey: conversationImportKeys.list(),
    queryFn: () =>
      client(CONVERSATION_IMPORTS_PATH, {
        fallback: "Could not load conversation imports",
      }).then(
        (response) =>
          response.json() as Promise<{ jobs: ConversationImportJob[] }>,
      ),
  });
}

export function conversationImportDetailQueryOptions(jobId: string) {
  return queryOptions({
    queryKey: conversationImportKeys.detail(jobId),
    queryFn: () =>
      client(`${CONVERSATION_IMPORTS_PATH}/${encodeURIComponent(jobId)}`, {
        fallback: "Could not load this import",
      }).then(
        (response) => response.json() as Promise<ConversationImportJobDetail>,
      ),
    refetchInterval: (query) => {
      const phase = query.state.data?.job.phase;
      return phase && isActiveImportPhase(phase) ? 2000 : false;
    },
  });
}

export async function createConversationImport(
  input: CreateConversationImportInput,
): Promise<ConversationImportJob> {
  return client<ConversationImportJob>(CONVERSATION_IMPORTS_PATH, "job", {
    method: "POST",
    body: input,
    fallback: "Could not start a conversation import",
  });
}

export async function inventoryConversationImport(
  jobId: string,
  apiKey: string,
): Promise<ConversationImportJob> {
  return client<ConversationImportJob>(
    `${CONVERSATION_IMPORTS_PATH}/${encodeURIComponent(jobId)}/inventory`,
    "job",
    {
      method: "POST",
      body: { apiKey },
      fallback: "Could not inventory this source",
    },
  );
}

export async function confirmConversationImport(
  jobId: string,
  manifestHash: string,
): Promise<ConversationImportJob> {
  return client<ConversationImportJob>(
    `${CONVERSATION_IMPORTS_PATH}/${encodeURIComponent(jobId)}/confirm`,
    "job",
    {
      method: "POST",
      body: { manifestHash },
      fallback: "Could not confirm this inventory",
    },
  );
}

export async function runConversationImport(
  jobId: string,
  apiKey: string,
): Promise<ConversationImportJob> {
  return client<ConversationImportJob>(
    `${CONVERSATION_IMPORTS_PATH}/${encodeURIComponent(jobId)}/run`,
    "job",
    {
      method: "POST",
      body: { apiKey },
      fallback: "Could not import these records",
    },
  );
}

export async function cancelConversationImport(
  jobId: string,
): Promise<ConversationImportJob> {
  return client<ConversationImportJob>(
    `${CONVERSATION_IMPORTS_PATH}/${encodeURIComponent(jobId)}/cancel`,
    "job",
    {
      method: "POST",
      fallback: "Could not cancel this import",
    },
  );
}
