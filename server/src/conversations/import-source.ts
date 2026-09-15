import { lookup as dnsLookup } from "node:dns/promises";
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
} from "node:http";
import { isIP, type LookupFunction } from "node:net";
import { request as httpsRequest } from "node:https";
import { z } from "zod";
import { checkNavigationTarget } from "../computer/target";
import {
  observeConversation,
  type ConversationObservationError,
  type ConversationObservationGap,
} from "./observability";
import type {
  ImportDebugAccess,
  ImportListPage,
  ImportResourceGap,
  ImportSourceAuth,
  ImportSourceFailure,
  ImportSourceLookup,
  ImportSourceLookupAddress,
  ImportSourceResult,
  ImportSourceTransportOptions,
  ImportThreadEvents,
  ImportThreadMessage,
  ImportThreadState,
  ImportThreadSummary,
} from "./import-types";

export type {
  ImportDebugAccess,
  ImportListPage,
  ImportResourceGap,
  ImportSourceAuth,
  ImportSourceFailure,
  ImportSourceLookup,
  ImportSourceLookupAddress,
  ImportSourceOriginOptions,
  ImportSourceResult,
  ImportSourceTransportOptions,
  ImportThreadEvents,
  ImportThreadInspectEvent,
  ImportThreadMessage,
  ImportThreadState,
  ImportThreadSummary,
} from "./import-types";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 200;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const threadSummarySchema: z.ZodType<ImportThreadSummary> = z.object({
  id: z.string().min(1),
  name: z.string().nullable(),
  lastRunAt: z.string().optional(),
  lastUpdatedAt: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  archived: z.boolean().optional(),
  agentId: z.string().optional(),
  createdById: z.string().optional(),
  organizationId: z.string().optional(),
});

const listThreadsSchema = z.object({
  threads: z.array(threadSummarySchema),
  nextCursor: z.string().nullable().optional(),
});

const getThreadSchema = z.object({
  thread: threadSummarySchema,
});

const threadMessageSchema = z
  .object({
    id: z.string().min(1),
    role: z.string().min(1),
    content: z.unknown().optional(),
    activityType: z.string().optional(),
    toolCalls: z.array(z.unknown()).optional(),
    toolCallId: z.string().optional(),
  })
  .passthrough();

const messagesSchema = z.object({
  messages: z.array(threadMessageSchema),
});

const eventsSchema = z.object({
  events: z.array(z.object({ type: z.string() }).passthrough()),
  decodeErrorRowIds: z.array(z.string()),
  truncated: z.boolean(),
});

const stateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("no-snapshot") }),
  z.object({ kind: z.literal("snapshot-decode-error") }),
  z.object({
    kind: z.literal("snapshot"),
    state: z.unknown(),
    skippedDeltas: z.number(),
  }),
]);

function fail(
  code: ImportSourceFailure["code"],
  message: string,
  status?: number,
): ImportSourceFailure {
  return status === undefined
    ? { ok: false, code, message }
    : { ok: false, code, status, message };
}

function originHasCredentials(url: URL): boolean {
  return url.username !== "" || url.password !== "";
}

export function resolveImportSourceOrigin(
  raw: string,
  options: { allowHttp?: boolean; allowPrivateHosts?: boolean } = {},
): ImportSourceResult<string> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return fail("origin-rejected", "Source origin is not a URL.");
  }
  if (originHasCredentials(parsed)) {
    return fail(
      "origin-rejected",
      "Source origin must not include credentials.",
    );
  }
  const allowHttp = options.allowHttp === true;
  if (
    parsed.protocol !== "https:" &&
    !(allowHttp && parsed.protocol === "http:")
  ) {
    return fail("origin-rejected", "Source origin must be HTTPS.");
  }
  const verdict = checkNavigationTarget(parsed.toString(), {
    allowPrivateHosts: options.allowPrivateHosts === true,
  });
  if (!verdict.allowed) {
    return fail("origin-rejected", verdict.reason);
  }
  return { ok: true, value: new URL(verdict.url).origin };
}

function sameHostPort(from: URL, to: URL): boolean {
  return from.hostname === to.hostname && from.port === to.port;
}

function sameCredentialScope(from: URL, to: URL): boolean {
  if (!sameHostPort(from, to)) return false;
  return (
    from.protocol === to.protocol ||
    (from.protocol === "http:" && to.protocol === "https:")
  );
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function retryAfterMs(
  header: string | null,
  attempt: number,
  base: number,
): number {
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(Math.floor(seconds * 1000), 10_000);
    }
    const dateMs = Date.parse(header);
    if (Number.isFinite(dateMs)) {
      const wait = dateMs - Date.now();
      if (wait > 0) return Math.min(wait, 10_000);
    }
  }
  return Math.min(base * 2 ** attempt, 2_000);
}

function isFiniteNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && Number.isFinite(value);
}

function isFinitePositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0 && Number.isFinite(value);
}

type InternalFetchResult =
  | { ok: true; value: unknown }
  | ImportSourceFailure
  | (ImportSourceFailure & { retryAfterHeader: string | null });

function publicFailure(
  result:
    | ImportSourceFailure
    | (ImportSourceFailure & { retryAfterHeader?: string | null }),
): ImportSourceFailure {
  const { retryAfterHeader: _dropped, ...rest } =
    result as ImportSourceFailure & {
      retryAfterHeader?: string | null;
    };
  return rest;
}

function retryHeaderFrom(hop: InternalFetchResult): string | null {
  if (hop.ok) return null;
  if ("retryAfterHeader" in hop && typeof hop.retryAfterHeader === "string") {
    return hop.retryAfterHeader;
  }
  return null;
}

function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function sourceObservationError(
  code: ImportSourceFailure["code"],
  status?: number,
): ConversationObservationError {
  switch (code) {
    case "unauthorized":
    case "forbidden":
      return "source-auth";
    case "cancelled":
    case "timeout":
    case "transient":
      return "source-transport";
    case "http-error":
      return status !== undefined && isTransientStatus(status)
        ? "source-transport"
        : "source-protocol";
    default:
      return "source-protocol";
  }
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<ImportSourceResult<string>> {
  const declared = response.headers.get("content-length");
  if (declared) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) {
      return fail(
        "oversized",
        "Source response exceeded the body size limit.",
        response.status,
      );
    }
  }
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).length > maxBytes) {
      return fail(
        "oversized",
        "Source response exceeded the body size limit.",
        response.status,
      );
    }
    return { ok: true, value: text };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return fail(
        "oversized",
        "Source response exceeded the body size limit.",
        response.status,
      );
    }
    chunks.push(value);
  }
  return { ok: true, value: new TextDecoder().decode(concat(chunks, total)) };
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function normalizedHostname(hostname: string): string {
  return hostname.replace(/^\[/, "").replace(/\]$/, "");
}

function addressUrl(target: URL, address: ImportSourceLookupAddress): string {
  const host =
    address.family === 6 || address.address.includes(":")
      ? `[${normalizedHostname(address.address)}]`
      : address.address;
  return `${target.protocol}//${host}${target.port ? `:${target.port}` : ""}`;
}

function pinnedLookup(
  addresses: readonly ImportSourceLookupAddress[],
): LookupFunction {
  return (_hostname, options, callback) => {
    const requestedFamily =
      options.family === "IPv4"
        ? 4
        : options.family === "IPv6"
          ? 6
          : options.family;
    const matching = addresses.filter(
      (address) =>
        requestedFamily === undefined ||
        requestedFamily === 0 ||
        requestedFamily === address.family,
    );
    const [first] = matching;
    if (first === undefined) {
      const error = Object.assign(
        new Error("Pinned source address unavailable."),
        {
          code: "EADDRNOTAVAIL",
        },
      );
      callback(error, "", 0);
      return;
    }
    if (options.all) {
      callback(
        null,
        matching.map(({ address, family }) => ({ address, family })),
      );
      return;
    }
    callback(null, first.address, first.family);
  };
}

function incomingResponse(
  incoming: IncomingMessage,
  signal: AbortSignal | undefined,
): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const onAbort = () => {
        incoming.destroy(
          Object.assign(new Error("Source response was aborted."), {
            name: "AbortError",
          }),
        );
      };
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
      };
      incoming.on("data", (chunk: Uint8Array | string) => {
        try {
          if (typeof chunk === "string") {
            controller.enqueue(new TextEncoder().encode(chunk));
          } else {
            controller.enqueue(
              new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
            );
          }
        } catch {
          incoming.destroy();
        }
      });
      incoming.once("end", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // The body may already have been cancelled after exceeding its bound.
        }
      });
      incoming.once("error", (error) => {
        cleanup();
        try {
          controller.error(error);
        } catch {
          // The body may already have been cancelled after exceeding its bound.
        }
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    },
    cancel() {
      incoming.destroy();
    },
  });
  const status = incoming.statusCode;
  return new Response(body, {
    status:
      status !== undefined && status >= 200 && status <= 599 ? status : 502,
    ...(incoming.statusMessage === undefined
      ? {}
      : { statusText: incoming.statusMessage }),
    headers,
  });
}

function fetchPinned(
  target: URL,
  init: RequestInit,
  addresses: readonly ImportSourceLookupAddress[],
): Promise<Response> {
  const signal = init.signal ?? undefined;
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, name) => {
    headers[name] = value;
  });
  const options = {
    method: init.method ?? "GET",
    headers,
    signal,
    // A fresh socket makes this request use exactly the lookup result below; it cannot reuse a
    // connection established for an earlier DNS answer.
    agent: false,
    lookup: pinnedLookup(addresses),
  };
  return new Promise<Response>((resolve, reject) => {
    const onResponse = (incoming: IncomingMessage) => {
      try {
        resolve(incomingResponse(incoming, signal));
      } catch (error) {
        reject(error);
      }
    };
    let request: ClientRequest;
    try {
      request =
        target.protocol === "https:"
          ? httpsRequest(target, options, onResponse)
          : httpRequest(target, options, onResponse);
    } catch (error) {
      reject(error);
      return;
    }
    request.once("error", reject);
    request.end();
  });
}

export type ConversationImportSource = {
  listThreads(params: {
    userId: string;
    agentId: string;
    includeArchived?: boolean;
    limit?: number;
    cursor?: string;
    signal?: AbortSignal;
  }): Promise<ImportSourceResult<ImportListPage>>;
  getThread(params: {
    threadId: string;
    userId: string;
    signal?: AbortSignal;
  }): Promise<ImportSourceResult<ImportThreadSummary> | ImportResourceGap>;
  getThreadMessages(params: {
    threadId: string;
    userId: string;
    signal?: AbortSignal;
  }): Promise<
    ImportSourceResult<{ messages: ImportThreadMessage[] }> | ImportResourceGap
  >;
  /**
   * Optional debug acquisition. Requires {@link ImportDebugAccess}.
   * Does not prove ownership; callers must already have scoped metadata/messages.
   */
  getThreadEvents(params: {
    threadId: string;
    access: ImportDebugAccess;
    signal?: AbortSignal;
  }): Promise<ImportSourceResult<ImportThreadEvents> | ImportResourceGap>;
  /**
   * Optional debug acquisition. Requires {@link ImportDebugAccess}.
   * Does not prove ownership; callers must already have scoped metadata/messages.
   */
  getThreadState(params: {
    threadId: string;
    access: ImportDebugAccess;
    signal?: AbortSignal;
  }): Promise<ImportSourceResult<ImportThreadState> | ImportResourceGap>;
};

export function createConversationImportSource(
  auth: ImportSourceAuth,
  transport: ImportSourceTransportOptions = {},
): ImportSourceResult<ConversationImportSource> {
  const origin = resolveImportSourceOrigin(auth.origin, {
    allowHttp: transport.allowHttp,
    allowPrivateHosts: transport.allowPrivateHosts,
  });
  if (!origin.ok) return origin;
  if (
    !auth.apiKey ||
    auth.apiKey.includes("\n") ||
    auth.apiKey.includes("\r")
  ) {
    return fail("unauthorized", "Source credential is unavailable.");
  }

  const timeoutMs = transport.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBodyBytes = transport.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxRedirects = transport.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxRetries = transport.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryBase = transport.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_MS;
  if (
    !isFinitePositiveInteger(timeoutMs) ||
    !isFinitePositiveInteger(maxBodyBytes) ||
    !isFiniteNonNegativeInteger(maxRedirects) ||
    !isFiniteNonNegativeInteger(maxRetries) ||
    !Number.isFinite(retryBase) ||
    retryBase < 0
  ) {
    return fail("protocol", "Import source transport bounds are invalid.");
  }

  const fetchImpl = transport.fetchImpl;
  const lookupImpl: ImportSourceLookup =
    transport.lookupImpl ??
    (async (hostname) => dnsLookup(hostname, { all: true, verbatim: true }));
  const sleep = transport.sleep ?? defaultSleep;
  const pinned = new URL(origin.value);
  const sourceCorrelation =
    transport.jobId === undefined ? undefined : { jobId: transport.jobId };
  const sourceClock = transport.now ?? Date.now;
  type SourceObservationDetails = {
    latencyMs?: number;
    httpStatus?: number;
    retry?: number;
    gap?: ConversationObservationGap;
    error?: ConversationObservationError;
  };
  const emitSource = (
    outcome: "started" | "received" | "failed" | "retrying" | "blocked",
    details: SourceObservationDetails = {},
  ): void => {
    observeConversation(transport.observe, {
      subsystem: "import",
      operation: "source",
      outcome,
      ...(sourceCorrelation === undefined
        ? {}
        : { correlation: sourceCorrelation }),
      ...details,
    });
  };
  const readClock = (): number => {
    try {
      const value = sourceClock();
      if (Number.isFinite(value)) return value;
    } catch {
      // A test clock must not change source transport behavior.
    }
    return Date.now();
  };
  const elapsed = (startedAt: number): number | undefined => {
    const value = readClock() - startedAt;
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  };
  const observeFailure = (
    result: InternalFetchResult,
    startedAt: number,
    retry: number,
  ): InternalFetchResult => {
    if (result.ok) return result;
    const details: SourceObservationDetails = {
      retry,
      error: sourceObservationError(result.code, result.status),
    };
    const latencyMs = elapsed(startedAt);
    if (latencyMs !== undefined) details.latencyMs = latencyMs;
    if (result.status !== undefined) details.httpStatus = result.status;
    emitSource("failed", details);
    return result;
  };
  const emitGap = (gap: ConversationObservationGap): void => {
    emitSource("failed", { gap });
  };
  const emitProtocolFailure = (): void => {
    emitSource("failed", {
      error: "source-protocol",
    });
  };

  async function resolveTargetAddresses(
    target: URL,
    signal: AbortSignal | undefined,
    timeout: AbortSignal,
  ): Promise<ImportSourceResult<readonly ImportSourceLookupAddress[]>> {
    const host = normalizedHostname(target.hostname);
    const family = isIP(host);
    let addresses: readonly ImportSourceLookupAddress[];
    if (family === 4 || family === 6) {
      addresses = [{ address: host, family }];
    } else {
      if (signal?.aborted)
        return fail("cancelled", "Import source read was cancelled.");
      if (timeout.aborted)
        return fail("timeout", "Import source read timed out.");
      type LookupRace =
        | { ok: true; value: readonly ImportSourceLookupAddress[] }
        | { ok: false; value: ImportSourceFailure };
      const lookupResult: Promise<LookupRace> = Promise.resolve()
        .then(() => lookupImpl(host, signal))
        .then(
          (value) => ({ ok: true, value }),
          () => ({
            ok: false,
            value: fail("transient", "Source hostname could not be resolved."),
          }),
        );
      let removeAbortListeners = () => {};
      const abortResult = new Promise<LookupRace>((resolve) => {
        const onAbort = () => {
          resolve({
            ok: false,
            value: signal?.aborted
              ? fail("cancelled", "Import source read was cancelled.")
              : fail("timeout", "Import source read timed out."),
          });
        };
        const cleanup = () => {
          signal?.removeEventListener("abort", onAbort);
          timeout.removeEventListener("abort", onAbort);
        };
        removeAbortListeners = cleanup;
        signal?.addEventListener("abort", onAbort, { once: true });
        timeout.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted || timeout.aborted) onAbort();
      });
      const result = await Promise.race([lookupResult, abortResult]);
      removeAbortListeners();
      if (!result.ok) return result.value;
      addresses = result.value;
    }

    if (!Array.isArray(addresses) || addresses.length === 0) {
      return fail("transient", "Source hostname could not be resolved.");
    }
    for (const address of addresses) {
      if (
        address === null ||
        typeof address !== "object" ||
        typeof address.address !== "string" ||
        !Number.isInteger(address.family) ||
        (address.family !== 4 && address.family !== 6) ||
        isIP(normalizedHostname(address.address)) !== address.family
      ) {
        return fail(
          "transient",
          "Source hostname returned an invalid address.",
        );
      }
      const verdict = checkNavigationTarget(addressUrl(target, address), {
        allowPrivateHosts: transport.allowPrivateHosts === true,
      });
      if (!verdict.allowed) {
        return fail(
          "origin-rejected",
          "Source hostname resolved to a blocked address.",
        );
      }
    }
    return { ok: true, value: addresses };
  }

  async function requestJson(
    pathAndQuery: string,
    signal?: AbortSignal,
  ): Promise<ImportSourceResult<unknown>> {
    let attempt = 0;
    for (;;) {
      const hop = await getOnce(pathAndQuery, signal, attempt);
      const retryable =
        !hop.ok &&
        (hop.code === "transient" ||
          (hop.code === "http-error" &&
            hop.status !== undefined &&
            isTransientStatus(hop.status)));
      if (retryable && attempt < maxRetries && !signal?.aborted) {
        const wait = retryAfterMs(retryHeaderFrom(hop), attempt, retryBase);
        attempt += 1;
        emitSource("retrying", {
          retry: attempt,
          ...(hop.status === undefined ? {} : { httpStatus: hop.status }),
          error: sourceObservationError(hop.code, hop.status),
        });
        try {
          await sleep(wait, signal);
        } catch {
          return fail("cancelled", "Import source read was cancelled.");
        }
        continue;
      }
      if (!hop.ok) return publicFailure(hop);
      return hop;
    }
  }

  async function getOnce(
    pathAndQuery: string,
    signal?: AbortSignal,
    retry = 0,
  ): Promise<InternalFetchResult> {
    if (signal?.aborted)
      return fail("cancelled", "Import source read was cancelled.");
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined =
      signal !== undefined ? AbortSignal.any([signal, timeout]) : timeout;

    let target = new URL(pathAndQuery, `${pinned.origin}/`);
    if (target.origin !== pinned.origin) {
      return fail(
        "origin-rejected",
        "Source request left the selected origin.",
      );
    }

    let includeAuth = true;
    let lastStartedAt = 0;
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const lookupStartedAt = readClock();
      const addresses = await resolveTargetAddresses(target, signal, timeout);
      if (!addresses.ok) {
        return observeFailure(addresses, lookupStartedAt, retry);
      }
      const headers = new Headers({ Accept: "application/json" });
      if (includeAuth) headers.set("Authorization", `Bearer ${auth.apiKey}`);
      const startedAt = readClock();
      lastStartedAt = startedAt;
      emitSource("started", { retry });
      let response: Response;
      try {
        response =
          fetchImpl === undefined
            ? await fetchPinned(
                target,
                {
                  method: "GET",
                  headers,
                  redirect: "manual",
                  signal: combined,
                },
                addresses.value,
              )
            : await fetchImpl(target.toString(), {
                method: "GET",
                headers,
                redirect: "manual",
                signal: combined,
              });
      } catch (error) {
        const failure =
          combined.aborted && signal?.aborted
            ? fail("cancelled", "Import source read was cancelled.")
            : combined.aborted
              ? fail("timeout", "Import source read timed out.")
              : /abort/i.test(
                    error instanceof Error ? error.message : "network",
                  )
                ? fail("cancelled", "Import source read was cancelled.")
                : fail("transient", "Source network request failed.");
        observeFailure(failure, startedAt, retry);
        return failure;
      }
      emitSource("received", {
        retry,
        httpStatus: response.status,
        latencyMs: elapsed(startedAt),
      });

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get("location");
        if (!location) {
          return observeFailure(
            fail(
              "redirect-refused",
              "Source redirect had no Location.",
              response.status,
            ),
            startedAt,
            retry,
          );
        }
        let next: URL;
        try {
          next = new URL(location, target);
        } catch {
          return observeFailure(
            fail("redirect-refused", "Source redirect was not a URL."),
            startedAt,
            retry,
          );
        }
        if (originHasCredentials(next)) {
          return observeFailure(
            fail("redirect-refused", "Source redirect included credentials."),
            startedAt,
            retry,
          );
        }
        const hopVerdict = checkNavigationTarget(next.toString(), {
          allowPrivateHosts: transport.allowPrivateHosts === true,
        });
        if (!hopVerdict.allowed) {
          return observeFailure(
            fail("redirect-refused", hopVerdict.reason),
            startedAt,
            retry,
          );
        }
        const nextUrl = new URL(hopVerdict.url);
        if (
          nextUrl.origin !== pinned.origin ||
          !sameCredentialScope(pinned, nextUrl)
        ) {
          return observeFailure(
            fail(
              "redirect-refused",
              "Source redirected to a different origin; credentials were not forwarded.",
            ),
            startedAt,
            retry,
          );
        }
        if (
          nextUrl.protocol !== "https:" &&
          !(transport.allowHttp && nextUrl.protocol === "http:")
        ) {
          return observeFailure(
            fail("redirect-refused", "Source redirect was not HTTPS."),
            startedAt,
            retry,
          );
        }
        includeAuth = sameCredentialScope(pinned, nextUrl);
        if (!includeAuth) {
          return observeFailure(
            fail(
              "redirect-refused",
              "Source redirected outside credential scope; credentials were not forwarded.",
            ),
            startedAt,
            retry,
          );
        }
        target = nextUrl;
        continue;
      }

      let body: ImportSourceResult<string>;
      try {
        body = await readBoundedBody(response, maxBodyBytes);
      } catch {
        let failure: ImportSourceFailure;
        if (signal?.aborted) {
          failure = fail("cancelled", "Import source read was cancelled.");
        } else if (timeout.aborted) {
          failure = fail("timeout", "Import source read timed out.");
        } else {
          failure = fail(
            "transient",
            "Source response body could not be read.",
          );
        }
        return observeFailure(failure, startedAt, retry);
      }
      if (!body.ok) return observeFailure(body, startedAt, retry);
      if (response.status === 401) {
        return observeFailure(
          fail("unauthorized", "Source authentication was rejected.", 401),
          startedAt,
          retry,
        );
      }
      if (response.status === 403) {
        return observeFailure(
          fail(
            "forbidden",
            "Source refused this credential for the requested resource.",
            403,
          ),
          startedAt,
          retry,
        );
      }
      if (response.status === 404) {
        return observeFailure(
          fail("not-found", "Source resource was not found.", 404),
          startedAt,
          retry,
        );
      }
      if (isTransientStatus(response.status)) {
        const failure = {
          ...fail(
            "http-error",
            `Source returned ${response.status}.`,
            response.status,
          ),
          retryAfterHeader: response.headers.get("retry-after"),
        };
        return observeFailure(failure, startedAt, retry);
      }
      if (!response.ok) {
        return observeFailure(
          fail(
            "http-error",
            `Source returned ${response.status}.`,
            response.status,
          ),
          startedAt,
          retry,
        );
      }
      if (body.value.length === 0) {
        return observeFailure(
          fail("malformed", "Source response was empty."),
          startedAt,
          retry,
        );
      }
      try {
        return { ok: true, value: JSON.parse(body.value) as unknown };
      } catch {
        return observeFailure(
          fail("malformed", "Source response was not JSON."),
          startedAt,
          retry,
        );
      }
    }
    return observeFailure(
      fail("redirect-refused", "Source redirected too many times."),
      lastStartedAt,
      retry,
    );
  }

  const source: ConversationImportSource = {
    async listThreads(params) {
      const query = new URLSearchParams({
        userId: params.userId,
        agentId: params.agentId,
      });
      if (params.includeArchived) query.set("includeArchived", "true");
      if (params.limit != null) query.set("limit", String(params.limit));
      if (params.cursor) query.set("cursor", params.cursor);
      const raw = await requestJson(
        `/api/threads?${query.toString()}`,
        params.signal,
      );
      if (!raw.ok) return raw;
      const parsed = listThreadsSchema.safeParse(raw.value);
      if (!parsed.success) {
        emitProtocolFailure();
        return fail(
          "malformed",
          "Thread list response did not match the installed API.",
        );
      }
      return {
        ok: true,
        value: {
          threads: parsed.data.threads,
          nextCursor: parsed.data.nextCursor ?? null,
        },
      };
    },

    async getThread(params) {
      const qs = new URLSearchParams({ userId: params.userId }).toString();
      const path = `/api/threads/${encodeURIComponent(params.threadId)}?${qs}`;
      const raw = await requestJson(path, params.signal);
      if (!raw.ok) {
        if (raw.code === "not-found") {
          emitGap("not-found");
          return {
            ok: false,
            gap: "not-found",
            message: "Thread is unavailable on the source for this user.",
          };
        }
        return raw;
      }
      const wrapped = getThreadSchema.safeParse(raw.value);
      if (!wrapped.success) {
        emitProtocolFailure();
        return fail(
          "malformed",
          "Thread response did not match the installed API.",
        );
      }
      if (wrapped.data.thread.id !== params.threadId) {
        emitProtocolFailure();
        return fail(
          "malformed",
          "Thread response did not match the requested thread.",
        );
      }
      return { ok: true, value: wrapped.data.thread };
    },

    async getThreadMessages(params) {
      const qs = new URLSearchParams({ userId: params.userId }).toString();
      const path = `/api/threads/${encodeURIComponent(params.threadId)}/messages?${qs}`;
      const raw = await requestJson(path, params.signal);
      if (!raw.ok) {
        if (raw.code === "not-found") {
          emitGap("not-found");
          return {
            ok: false,
            gap: "not-found",
            message:
              "Thread messages are unavailable on the source for this user.",
          };
        }
        return raw;
      }
      const parsed = messagesSchema.safeParse(raw.value);
      if (!parsed.success) {
        emitProtocolFailure();
        return fail(
          "malformed",
          "Messages response did not match the installed API.",
        );
      }
      return { ok: true, value: { messages: parsed.data.messages } };
    },

    async getThreadEvents(params) {
      if (params.access.ownershipEstablished !== true) {
        emitSource("blocked", { gap: "debug-not-applicable" });
        return {
          ok: false,
          gap: "debug-not-applicable",
          message: "Debug events require prior scoped ownership proof.",
        };
      }
      const path = `/api/_inspect/threads/${encodeURIComponent(params.threadId)}/events`;
      const raw = await requestJson(path, params.signal);
      if (!raw.ok) {
        if (
          raw.code === "not-found" ||
          raw.code === "forbidden" ||
          raw.code === "http-error"
        ) {
          emitGap("unavailable");
          return {
            ok: false,
            gap: "unavailable",
            message: "Debug events were not available on this source.",
            details: { code: raw.code, status: raw.status },
          };
        }
        return raw;
      }
      const parsed = eventsSchema.safeParse(raw.value);
      if (!parsed.success) {
        emitProtocolFailure();
        return fail(
          "malformed",
          "Events response did not match the installed API.",
        );
      }
      const value: ImportThreadEvents = {
        events: parsed.data.events as ImportThreadEvents["events"],
        decodeErrorRowIds: parsed.data.decodeErrorRowIds,
        truncated: parsed.data.truncated,
      };
      if (value.truncated || value.decodeErrorRowIds.length > 0) {
        emitGap(value.truncated ? "truncated" : "decode-error");
        return {
          ok: false,
          gap: value.truncated ? "truncated" : "decode-error",
          message: value.truncated
            ? "Source event history is truncated; cursor looping cannot recover the tail."
            : "Source event rows failed to decode.",
          details: {
            decodeErrorRowIds: value.decodeErrorRowIds,
            truncated: value.truncated,
            eventCount: value.events.length,
          },
        };
      }
      return { ok: true, value };
    },

    async getThreadState(params) {
      if (params.access.ownershipEstablished !== true) {
        emitSource("blocked", { gap: "debug-not-applicable" });
        return {
          ok: false,
          gap: "debug-not-applicable",
          message: "Debug state requires prior scoped ownership proof.",
        };
      }
      const path = `/api/_inspect/threads/${encodeURIComponent(params.threadId)}/state`;
      const raw = await requestJson(path, params.signal);
      if (!raw.ok) {
        if (
          raw.code === "not-found" ||
          raw.code === "forbidden" ||
          raw.code === "http-error"
        ) {
          emitGap("unavailable");
          return {
            ok: false,
            gap: "unavailable",
            message: "Debug state was not available on this source.",
            details: { code: raw.code, status: raw.status },
          };
        }
        return raw;
      }
      const parsed = stateSchema.safeParse(raw.value);
      if (!parsed.success) {
        emitProtocolFailure();
        return fail(
          "malformed",
          "State response did not match the installed API.",
        );
      }
      if (parsed.data.kind === "no-snapshot") {
        emitGap("no-snapshot");
        return {
          ok: false,
          gap: "no-snapshot",
          message: "Source has no persisted snapshot; this is a valid absence.",
        };
      }
      if (parsed.data.kind === "snapshot-decode-error") {
        emitGap("decode-error");
        return {
          ok: false,
          gap: "decode-error",
          message: "Source snapshot could not be decoded.",
        };
      }
      if (parsed.data.skippedDeltas > 0) {
        emitGap("skipped-deltas");
        return {
          ok: false,
          gap: "skipped-deltas",
          message: "Source snapshot skipped deltas; evidence is degraded.",
          details: {
            skippedDeltas: parsed.data.skippedDeltas,
            state: parsed.data.state,
          },
        };
      }
      return { ok: true, value: parsed.data };
    },
  };

  return { ok: true, value: source };
}
