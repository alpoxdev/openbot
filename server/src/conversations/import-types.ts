/**
 * Read-only CopilotKit Intelligence source shapes for conversation import.
 *
 * Grounded in installed `@copilotkit/runtime` 1.70.1 public method contracts
 * (`listThreads`, `getThread`, `getThreadMessages`, `getThreadEvents`,
 * `getThreadState`). These types are local copies so import never reaches
 * private package paths. Realtime `joinCode`/`joinToken` are omitted on
 * purpose: import must not persist them.
 *
 * Debug `_inspect` events/state are optional diagnostics. Callers must
 * establish scoped metadata/messages ownership before requesting them.
 */

import type { ConversationObserver } from "./observability";

export type ImportThreadSummary = {
  id: string;
  name: string | null;
  lastRunAt?: string;
  lastUpdatedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  archived?: boolean;
  agentId?: string;
  createdById?: string;
  organizationId?: string;
};

export type ImportThreadMessage = {
  id: string;
  role: string;
  content?: unknown;
  activityType?: string;
  toolCalls?: unknown[];
  toolCallId?: string;
  [key: string]: unknown;
};

export type ImportThreadInspectEvent = {
  type: string;
  [key: string]: unknown;
};

export type ImportThreadEvents = {
  events: ImportThreadInspectEvent[];
  decodeErrorRowIds: string[];
  truncated: boolean;
};

export type ImportThreadState =
  | { kind: "no-snapshot" }
  | { kind: "snapshot-decode-error" }
  | { kind: "snapshot"; state: unknown; skippedDeltas: number };

export type ImportSourceAuth = {
  origin: string;
  apiKey: string;
};

export type ImportSourceOriginOptions = {
  allowHttp?: boolean;
  allowPrivateHosts?: boolean;
};

export type ImportSourceLookupAddress = {
  address: string;
  family: number;
};

/**
 * Resolve one source hostname before opening a request. The source adapter uses the returned
 * addresses both for SSRF classification and for the socket's pinned lookup, so a later DNS answer
 * cannot redirect a credential-bearing request.
 */
export type ImportSourceLookup = (
  hostname: string,
  signal?: AbortSignal,
) => Promise<readonly ImportSourceLookupAddress[]>;

export type ImportSourceTransportOptions = ImportSourceOriginOptions & {
  fetchImpl?: typeof fetch;
  lookupImpl?: ImportSourceLookup;
  timeoutMs?: number;
  maxBodyBytes?: number;
  maxRedirects?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  observe?: ConversationObserver;
  jobId?: string;
};

export type ImportSourceErrorCode =
  | "origin-rejected"
  | "cancelled"
  | "timeout"
  | "oversized"
  | "malformed"
  | "unauthorized"
  | "forbidden"
  | "not-found"
  | "transient"
  | "http-error"
  | "redirect-refused"
  | "protocol";

export type ImportSourceFailure = {
  ok: false;
  code: ImportSourceErrorCode;
  status?: number;
  message: string;
};

export type ImportSourceOk<T> = { ok: true; value: T };

export type ImportSourceResult<T> = ImportSourceOk<T> | ImportSourceFailure;

export type ImportResourceGap = {
  ok: false;
  gap:
    | "not-found"
    | "unavailable"
    | "truncated"
    | "decode-error"
    | "no-snapshot"
    | "skipped-deltas"
    | "debug-not-applicable";
  message: string;
  details?: Record<string, unknown>;
};

export type ImportListPage = {
  threads: ImportThreadSummary[];
  nextCursor: string | null;
};

/**
 * Debug `_inspect` reads accept no userId. The importer must already have
 * proven access with scoped `getThread`/`getThreadMessages` and local owner
 * mapping. Passing `{ ownershipEstablished: true }` is the public
 * precondition; this adapter does not itself prove ownership.
 */
export type ImportDebugAccess = {
  ownershipEstablished: true;
};
