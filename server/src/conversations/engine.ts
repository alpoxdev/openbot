import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  type AbstractAgent,
  type AgentSubscriber,
  type BaseEvent,
  EventType,
  type Message,
  MessageSchema,
  type RunAgentInput,
} from "@ag-ui/client";
import { Observable } from "rxjs";
import { historyEvent } from "./events";
import {
  observeConversation,
  type ConversationObservationError,
  type ConversationObserver,
} from "./observability";
import type { ConversationStore } from "./store";
import {
  ConversationAccessError,
  ConversationConflictError,
  ConversationLeaseError,
  type ConversationActor,
  type ConversationRunRecord,
} from "./types";

export type ConversationEngineOptions = {
  store: ConversationStore;
  leaseMs?: number;
  heartbeatMs?: number;
  pollMs?: number;
  replicaId?: string;
  observe?: ConversationObserver;
  onRunBusy?: (input: {
    threadId: string;
    busy: boolean;
  }) => void | Promise<void>;
};
export type EngineRunRequest = {
  actor: ConversationActor;
  threadId: string;
  agentId: string;
  agent: AbstractAgent;
  input: RunAgentInput;
  /** Server-only distinction between model context and the displayed transcript. */
  persistedInputMessages?: Message[];
};
export type EngineConnectRequest = {
  actor: ConversationActor;
  threadId: string;
  agentId: string;
  afterSequence?: bigint;
};
export type EngineStopRequest = Omit<EngineConnectRequest, "afterSequence"> & {
  runId: string | null;
};

type Execution = {
  run: ConversationRunRecord;
  cursor: bigint;
  startedAt: number;
  abort: () => void;
  abortRequested: boolean;
  done: boolean;
  failure?: unknown;
};

type PendingStart = {
  threadId: string;
  runId: string;
  canceled: boolean;
};

type StartResult =
  | { canceled: true; execution?: Execution }
  | { duplicate: ConversationRunRecord }
  | { execution: Execution };

function acceptedMessages(
  stored: readonly Message[],
  request: EngineRunRequest,
): Message[] {
  const result = structuredClone([...stored]);
  const known = new Set(result.map((message) => message.id));
  const pending = new Set<string>();
  for (const message of stored) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) pending.add(call.id);
    } else if (message.role === "tool") pending.delete(message.toolCallId);
  }
  const trusted = request.persistedInputMessages !== undefined;
  for (const message of request.persistedInputMessages ??
    request.input.messages) {
    if (!MessageSchema.safeParse(message).success)
      throw new ConversationConflictError("Invalid conversation message");
    if (known.has(message.id)) continue;
    if (!trusted) {
      if (message.role === "tool") {
        if (!pending.delete(message.toolCallId))
          throw new ConversationConflictError(
            "No pending tool call matches this result",
          );
      } else if (message.role !== "user") {
        throw new ConversationConflictError(
          "Only new user messages and pending tool results are accepted",
        );
      }
    }
    known.add(message.id);
    result.push(structuredClone(message));
  }
  return result;
}

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const terminal = (event: BaseEvent) =>
  event.type === "RUN_FINISHED" || event.type === "RUN_ERROR";
const lifecycleEvent = (
  type: "RUN_STARTED" | "RUN_FINISHED" | "RUN_ERROR",
  threadId: string,
  runId: string,
  extra: Record<string, unknown> = {},
): BaseEvent => ({ type: EventType[type], threadId, runId, ...extra });

export function createConversationEngine(options: ConversationEngineOptions) {
  const { store } = options;
  const leaseMs = options.leaseMs ?? 60_000;
  const heartbeatMs = options.heartbeatMs ?? Math.min(15_000, leaseMs / 3);
  const pollMs = options.pollMs ?? 100;
  const replicaId =
    options.replicaId ?? `${hostname()}:${process.pid}:${randomUUID()}`;
  if (
    !Number.isFinite(leaseMs) ||
    leaseMs < 1000 ||
    leaseMs > 900_000 ||
    !Number.isFinite(heartbeatMs) ||
    heartbeatMs <= 0 ||
    heartbeatMs >= leaseMs ||
    !Number.isFinite(pollMs) ||
    pollMs <= 0
  )
    throw new RangeError("Invalid conversation engine timing");
  const live = new Map<string, Execution>();
  const pendingStarts = new Map<string, Map<string, Set<PendingStart>>>();
  const stopRequests = new Map<string, number>();
  const stopKey = (threadId: string, runId: string) =>
    `${threadId}\u0000${runId}`;
  const storeBoundaryFailures = new WeakSet<object>();

  const observationError = (
    error: unknown,
    storeBoundary = false,
  ): ConversationObservationError => {
    if (storeBoundary && typeof error === "object" && error !== null) {
      storeBoundaryFailures.add(error);
    }
    return error instanceof ConversationLeaseError
      ? "lease"
      : error instanceof ConversationConflictError
        ? "conflict"
        : error instanceof ConversationAccessError
          ? "authorization"
          : storeBoundary ||
              (typeof error === "object" &&
                error !== null &&
                storeBoundaryFailures.has(error))
            ? "persistence"
            : "unknown";
  };
  const correlation = (threadId: string, runId?: string) => ({
    threadId,
    ...(runId === undefined ? {} : { runId }),
  });
  const elapsed = (startedAt: number) => Math.max(0, Date.now() - startedAt);
  const safeNumber = (value: bigint) => {
    if (value <= 0n) return 0;
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : Number.MAX_SAFE_INTEGER;
  };
  const appendEventsObserved = async (
    input: Parameters<ConversationStore["appendEvents"]>[0],
  ) => {
    const startedAt = Date.now();
    try {
      const result = await store.appendEvents(input);
      observeConversation(options.observe, {
        subsystem: "runtime",
        operation: "append",
        outcome: "completed",
        correlation: correlation(input.threadId, input.runId),
        latencyMs: elapsed(startedAt),
        count: input.events.length,
      });
      return result;
    } catch (error) {
      const category = observationError(error, true);
      observeConversation(options.observe, {
        subsystem: "runtime",
        operation: "append",
        outcome: "failed",
        correlation: correlation(input.threadId, input.runId),
        latencyMs: elapsed(startedAt),
        error: category,
      });
      observeConversation(options.observe, {
        subsystem: "runtime",
        operation: "persistence",
        outcome: "failed",
        correlation: correlation(input.threadId, input.runId),
        latencyMs: elapsed(startedAt),
        error: category,
        gap: "persistence",
      });
      if (category === "lease")
        observeConversation(options.observe, {
          subsystem: "runtime",
          operation: "lease",
          outcome: "lost",
          correlation: correlation(input.threadId, input.runId),
          error: category,
          gap: "lease",
        });
      throw error;
    }
  };
  const finishRunObserved = async (
    input: Parameters<ConversationStore["finishRun"]>[0],
  ) => {
    const startedAt = Date.now();
    try {
      const result = await store.finishRun(input);
      observeConversation(options.observe, {
        subsystem: "runtime",
        operation: "finish",
        outcome: "completed",
        correlation: correlation(result.threadId, input.runId),
        latencyMs: elapsed(startedAt),
        count: input.events?.length ?? 0,
      });
      return result;
    } catch (error) {
      const category = observationError(error, true);
      observeConversation(options.observe, {
        subsystem: "runtime",
        operation: "finish",
        outcome: "failed",
        correlation: { runId: input.runId },
        latencyMs: elapsed(startedAt),
        error: category,
      });
      observeConversation(options.observe, {
        subsystem: "runtime",
        operation: "persistence",
        outcome: "failed",
        correlation: { runId: input.runId },
        latencyMs: elapsed(startedAt),
        error: category,
        gap: "persistence",
      });
      if (category === "lease")
        observeConversation(options.observe, {
          subsystem: "runtime",
          operation: "lease",
          outcome: "lost",
          correlation: { runId: input.runId },
          error: category,
          gap: "lease",
        });
      throw error;
    }
  };
  const readEventPageObserved = async (
    actor: ConversationActor,
    threadId: string,
    afterSequence: bigint,
    limit: number,
  ) => {
    const startedAt = Date.now();
    try {
      const result = await store.readEventPage(
        actor,
        threadId,
        afterSequence,
        limit,
      );
      const latest = result.at(-1)?.sequence;
      observeConversation(options.observe, {
        subsystem: "runtime",
        operation: "replay",
        outcome: "progress",
        correlation: correlation(threadId),
        latencyMs: elapsed(startedAt),
        count: result.length,
        lag: latest === undefined ? 0 : safeNumber(latest - afterSequence),
      });
      return result;
    } catch (error) {
      const category = observationError(error, true);
      observeConversation(options.observe, {
        subsystem: "runtime",
        operation: "replay",
        outcome: "failed",
        correlation: correlation(threadId),
        latencyMs: elapsed(startedAt),
        error: category,
      });
      observeConversation(options.observe, {
        subsystem: "runtime",
        operation: "persistence",
        outcome: "failed",
        correlation: correlation(threadId),
        latencyMs: elapsed(startedAt),
        error: category,
        gap: "persistence",
      });
      throw error;
    }
  };

  function registerPendingStart(threadId: string, runId: string): PendingStart {
    let byRun = pendingStarts.get(threadId);
    if (!byRun) {
      byRun = new Map();
      pendingStarts.set(threadId, byRun);
    }
    let attempts = byRun.get(runId);
    if (!attempts) {
      attempts = new Set();
      byRun.set(runId, attempts);
    }
    const pending: PendingStart = { threadId, runId, canceled: false };
    attempts.add(pending);
    return pending;
  }

  function unregisterPendingStart(pending: PendingStart) {
    const byRun = pendingStarts.get(pending.threadId);
    const attempts = byRun?.get(pending.runId);
    if (!attempts) return;
    attempts.delete(pending);
    if (attempts.size === 0) byRun?.delete(pending.runId);
    if (byRun?.size === 0) pendingStarts.delete(pending.threadId);
  }

  function cancelPendingStarts(threadId: string, runId: string) {
    for (const pending of pendingStarts.get(threadId)?.get(runId) ?? [])
      pending.canceled = true;
  }

  function notifyBusy(threadId: string, busy: boolean) {
    // Presence is best-effort; a failed notification cannot invalidate a durable turn.
    try {
      void Promise.resolve(options.onRunBusy?.({ threadId, busy })).catch(
        () => undefined,
      );
    } catch {
      // A synchronous observer failure must not affect conversation persistence either.
    }
  }

  async function authorize(
    request: EngineConnectRequest,
    mode: "history" | "run",
  ) {
    const access = await store.authorize(
      request.actor,
      request.threadId,
      mode,
      request.agentId,
    );
    if (access === "none" || (mode === "run" && access !== "run"))
      throw new ConversationAccessError();
    const snapshot = await store.readSnapshot(request.actor, request.threadId);
    /*
     * Direct threads are pinned to their one Bot. Channel runs are different:
     * the channel roster is the grant, so a trusted server-side delivery may
     * select any executable member Bot. The public SSE dispatcher applies the
     * channel's canonical `thread.agentId` route binding before it constructs
     * this request; keeping that boundary here would break internal
     * multi-Bot work.
     */
    if (
      !snapshot.thread.channelId &&
      snapshot.thread.agentId !== request.agentId
    )
      throw new ConversationAccessError();
    return snapshot;
  }

  async function produce(
    request: EngineRunRequest,
    execution: Execution,
    canonical: Message[],
  ) {
    const { actor, agent, threadId, input } = request;
    const runId = execution.run.id;
    const runCorrelation = correlation(threadId, runId);
    const fence = {
      runId,
      leaseOwner: replicaId,
      generation: execution.run.generation,
    };
    let stopped = execution.abortRequested;
    let finished = false;
    let maintenanceFailure: unknown;
    let pendingWrites = Promise.resolve();
    let ending: BaseEvent | undefined;
    let callbackFailure: unknown;
    let agentFailure: unknown;
    let agentFailed = false;
    let failureSubscription: { unsubscribe(): void } | undefined;
    let terminalObserved = false;
    const observeTerminal = (
      outcome: "completed" | "failed" | "cancelled",
      error?: ConversationObservationError,
    ) => {
      if (terminalObserved) return;
      terminalObserved = true;
      observeConversation(options.observe, {
        subsystem: "runtime",
        operation: "run",
        outcome,
        correlation: runCorrelation,
        latencyMs: elapsed(execution.startedAt),
        ...(error === undefined ? {} : { error }),
      });
      if (outcome === "cancelled") {
        const requestedAt = stopRequests.get(stopKey(threadId, runId));
        if (requestedAt !== undefined) {
          observeConversation(options.observe, {
            subsystem: "runtime",
            operation: "stop",
            outcome: "settled",
            correlation: runCorrelation,
            latencyMs: elapsed(requestedAt),
            gap: "stop",
          });
          stopRequests.delete(stopKey(threadId, runId));
        }
      }
    };
    execution.abort = () => {
      execution.abortRequested = true;
      stopped = true;
      agent.abortRun();
      void agent.detachActiveRun().catch((error) => {
        maintenanceFailure = error;
      });
    };
    const immutableHistory = new Map(
      canonical.map((message) => [message.id, message]),
    );
    const historicalCalls = new Set<string>();
    const pendingHistoricalCalls = new Set<string>();
    const outputCalls = new Set<string>();
    const pendingOutputCalls = new Set<string>();
    for (const message of canonical) {
      if (message.role === "assistant") {
        for (const call of message.toolCalls ?? []) {
          historicalCalls.add(call.id);
          pendingHistoricalCalls.add(call.id);
        }
      } else if (message.role === "tool") {
        pendingHistoricalCalls.delete(message.toolCallId);
      }
    }
    const modelOnlyIds = new Set(
      request.persistedInputMessages === undefined
        ? []
        : input.messages
            .filter((message) => !immutableHistory.has(message.id))
            .map((message) => message.id),
    );

    function persistable(event: BaseEvent): BaseEvent {
      const references = event as BaseEvent & {
        messageId?: string;
        parentMessageId?: string;
        toolCallId?: string;
      };
      if (
        (references.messageId && immutableHistory.has(references.messageId)) ||
        (references.parentMessageId &&
          immutableHistory.has(references.parentMessageId))
      ) {
        throw new ConversationConflictError(
          "Output cannot modify an accepted history message",
        );
      }
      if (references.toolCallId && historicalCalls.has(references.toolCallId)) {
        if (event.type !== "TOOL_CALL_RESULT") {
          throw new ConversationConflictError(
            "Output cannot modify a historical tool call",
          );
        }
      }
      if (event.type === "TOOL_CALL_START") {
        const toolCallId = references.toolCallId;
        if (!toolCallId || historicalCalls.has(toolCallId)) {
          throw new ConversationConflictError(
            "Output cannot modify a historical tool call",
          );
        }
        if (!outputCalls.has(toolCallId)) {
          outputCalls.add(toolCallId);
          pendingOutputCalls.add(toolCallId);
        }
      } else if (event.type === "TOOL_CALL_RESULT") {
        const toolCallId = references.toolCallId;
        if (
          !toolCallId ||
          (historicalCalls.has(toolCallId)
            ? pendingHistoricalCalls.has(toolCallId)
            : pendingOutputCalls.has(toolCallId)) === false
        ) {
          throw new ConversationConflictError(
            "No pending tool call matches this result",
          );
        }
        if (historicalCalls.has(toolCallId)) {
          pendingHistoricalCalls.delete(toolCallId);
        } else {
          pendingOutputCalls.delete(toolCallId);
        }
      }
      if (event.type !== "MESSAGES_SNAPSHOT") return historyEvent(event);
      const source = (event as BaseEvent & { messages: Message[] }).messages;
      if (!Array.isArray(source))
        throw new ConversationConflictError("Invalid messages snapshot");
      const messages = structuredClone(canonical);
      const canonicalIds = new Set(messages.map((message) => message.id));
      const included = new Set(canonicalIds);
      for (const message of source) {
        if (modelOnlyIds.has(message.id)) continue;
        if (included.has(message.id)) {
          const existing = immutableHistory.get(message.id);
          if (existing && existing.role !== "tool" && message.role !== "tool")
            continue;
          if (existing?.role === "tool" && message.role === "tool") continue;
          if (!existing && message.role !== "tool") continue;
          throw new ConversationConflictError(
            "No pending tool call matches this result",
          );
        }
        if (message.role === "user" || message.role === "system") continue;
        if (!MessageSchema.safeParse(message).success)
          throw new ConversationConflictError("Invalid output message");
        if (message.role === "assistant") {
          for (const call of message.toolCalls ?? []) {
            if (historicalCalls.has(call.id)) {
              throw new ConversationConflictError(
                "Output cannot modify a historical tool call",
              );
            }
            if (!outputCalls.has(call.id)) {
              outputCalls.add(call.id);
              pendingOutputCalls.add(call.id);
            }
          }
        } else if (message.role === "tool") {
          if (
            historicalCalls.has(message.toolCallId)
              ? !pendingHistoricalCalls.delete(message.toolCallId)
              : !pendingOutputCalls.delete(message.toolCallId)
          ) {
            throw new ConversationConflictError(
              "No pending tool call matches this result",
            );
          }
        }
        included.add(message.id);
        messages.push(structuredClone(message));
      }
      return { ...event, messages } as BaseEvent;
    }

    const maintenance = (async () => {
      let renewedAt = Date.now();
      while (!finished) {
        await wait(Math.min(pollMs, heartbeatMs));
        if (finished) break;
        try {
          if (
            (await store.authorize(actor, threadId, "run", request.agentId)) !==
            "run"
          )
            throw new ConversationAccessError();
          const active = await store.getActiveRun(actor, threadId);
          if (!active || active.id !== runId)
            throw new ConversationLeaseError();
          if (active.status === "stopping") execution.abort();
          if (Date.now() - renewedAt >= heartbeatMs) {
            await store.renewLease({ ...fence, leaseMs });
            renewedAt = Date.now();
          }
        } catch (error) {
          maintenanceFailure = error;
          observeConversation(options.observe, {
            subsystem: "runtime",
            operation: "lease",
            outcome: "lost",
            correlation: runCorrelation,
            error: observationError(error, true),
            gap: "lease",
          });
          execution.abort();
          break;
        }
      }
    })();

    try {
      agent.threadId = threadId;
      agent.setMessages(
        structuredClone(
          request.persistedInputMessages === undefined
            ? canonical
            : input.messages,
        ),
      );
      const initial = await store.readSnapshot(actor, threadId);
      agent.setState(structuredClone(initial.snapshot.state));
      if (stopped) throw new DOMException("Conversation stopped", "AbortError");
      // Keep SDK diagnostics from exposing provider payloads/errors. The agent is
      // request-local, so this does not affect any other execution.
      agent.debug = false;
      const failureSubscriber: AgentSubscriber = {
        onRunFailed: ({ error }) => {
          agentFailed = true;
          agentFailure = error;
          // The SDK's public hook contract omits stopPropagation from its
          // TypeScript return type, but runAgent honors this documented runtime
          // mutation to prevent its raw console.error/rethrow path.
          return { stopPropagation: true } as unknown as never;
        },
      };
      failureSubscription = agent.subscribe(failureSubscriber);
      await agent.runAgent(
        {
          runId,
          tools: input.tools,
          context: input.context,
          forwardedProps: input.forwardedProps,
          ...(input.resume === undefined ? {} : { resume: input.resume }),
        },
        {
          onEvent: ({ event }) => {
            if (event.type === "RUN_STARTED") return;
            if (terminal(event)) {
              const terminalIds = event as BaseEvent & {
                threadId?: unknown;
                runId?: unknown;
              };
              if (
                (terminalIds.threadId !== undefined &&
                  terminalIds.threadId !== threadId) ||
                (terminalIds.runId !== undefined && terminalIds.runId !== runId)
              ) {
                // AG-UI treats subscriber errors as observer failures and continues the stream;
                // latch this failure so a foreign terminal cannot become synthetic success.
                callbackFailure = new ConversationConflictError(
                  "Terminal event does not match the fenced execution",
                );
                return;
              }
              ending = historyEvent({
                ...event,
                threadId,
                runId,
              } as BaseEvent);
              return;
            }
            pendingWrites = pendingWrites.then(async () => {
              if (maintenanceFailure) throw maintenanceFailure;
              await appendEventsObserved({
                ...fence,
                threadId,
                events: [persistable(event)],
              });
            });
            return pendingWrites;
          },
        },
      );
      failureSubscription.unsubscribe();
      if (agentFailed) throw agentFailure;
      if (callbackFailure) throw callbackFailure;
      await pendingWrites;
      if (maintenanceFailure) throw maintenanceFailure;
      const latest = await store.readSnapshot(actor, threadId);
      const failed = ending?.type === "RUN_ERROR";
      const end = stopped
        ? lifecycleEvent("RUN_ERROR", threadId, runId, {
            message: "Conversation stopped",
            code: "conversation_stopped",
          })
        : (ending ?? lifecycleEvent("RUN_FINISHED", threadId, runId));
      await finishRunObserved({
        ...fence,
        status: stopped ? "stopped" : failed ? "failed" : "completed",
        events: [end],
        snapshot: {
          ...latest.snapshot,
          baselineSequence: latest.latestSequence + 1n,
        },
      });
      observeTerminal(stopped ? "cancelled" : failed ? "failed" : "completed");
    } catch (error) {
      failureSubscription?.unsubscribe();
      failureSubscription = undefined;
      agent.abortRun();
      // A rejected callback may leave an already-started append pending; settle before terminal state.
      await pendingWrites.catch(() => undefined);
      try {
        // Do not reauthorize a revoked actor here: the fenced tail is the durable state.
        await finishRunObserved({
          ...fence,
          status: stopped && !maintenanceFailure ? "stopped" : "failed",
          events: [
            lifecycleEvent("RUN_ERROR", threadId, runId, {
              message:
                stopped && !maintenanceFailure
                  ? "Conversation stopped"
                  : "Conversation run failed",
              code:
                stopped && !maintenanceFailure
                  ? "conversation_stopped"
                  : "conversation_run_failed",
            }),
          ],
        });
      } catch (persistenceError) {
        execution.failure = persistenceError;
      }
      const cancelled = stopped && !maintenanceFailure;
      observeTerminal(
        cancelled ? "cancelled" : "failed",
        cancelled ? undefined : observationError(error),
      );
    } finally {
      finished = true;
      await maintenance;
      execution.done = true;
      // A stop request only settles when cancellation wins. Regardless of the
      // terminal outcome, release the local request bookkeeping.
      stopRequests.delete(stopKey(threadId, runId));
      if (live.get(threadId) === execution) {
        live.delete(threadId);
        observeConversation(options.observe, {
          subsystem: "runtime",
          operation: "activeRuns",
          outcome: "completed",
          correlation: correlation(threadId, runId),
          // This is intentionally a process-local count, not a cluster-wide gauge.
          count: live.size,
        });
      }
      notifyBusy(threadId, false);
    }
  }

  async function finishCanceledStart(
    request: EngineRunRequest,
    execution: Execution,
    initialInputAccepted: boolean,
  ) {
    const fence = {
      runId: execution.run.id,
      leaseOwner: replicaId,
      generation: execution.run.generation,
    };
    const observeCanceledStop = () => {
      const requestedAt = stopRequests.get(
        stopKey(request.threadId, execution.run.id),
      );
      if (requestedAt === undefined) return;
      observeConversation(options.observe, {
        subsystem: "runtime",
        operation: "stop",
        outcome: "settled",
        correlation: correlation(request.threadId, execution.run.id),
        latencyMs: elapsed(requestedAt),
        gap: "stop",
      });
      stopRequests.delete(stopKey(request.threadId, execution.run.id));
    };
    if (!initialInputAccepted) {
      const result = await finishRunObserved({
        ...fence,
        status: "stopped",
        events: [
          lifecycleEvent("RUN_ERROR", request.threadId, execution.run.id, {
            message: "Conversation stopped",
            code: "conversation_stopped",
          }),
        ],
      });
      observeConversation(options.observe, {
        subsystem: "runtime",
        operation: "run",
        outcome: "cancelled",
        correlation: correlation(request.threadId, execution.run.id),
        latencyMs: elapsed(execution.startedAt),
      });
      observeCanceledStop();
      return result;
    }
    const latest = await store.readSnapshot(request.actor, request.threadId);
    const result = await finishRunObserved({
      ...fence,
      status: "stopped",
      events: [
        lifecycleEvent("RUN_ERROR", request.threadId, execution.run.id, {
          message: "Conversation stopped",
          code: "conversation_stopped",
        }),
      ],
      snapshot: {
        ...latest.snapshot,
        baselineSequence: latest.latestSequence + 1n,
      },
    });
    observeConversation(options.observe, {
      subsystem: "runtime",
      operation: "run",
      outcome: "cancelled",
      correlation: correlation(request.threadId, execution.run.id),
      latencyMs: elapsed(execution.startedAt),
    });
    observeCanceledStop();
    return result;
  }

  async function start(
    request: EngineRunRequest,
    pending: PendingStart,
  ): Promise<StartResult> {
    try {
      if (
        request.input.threadId !== request.threadId ||
        request.agent.agentId !== request.agentId
      )
        throw new ConversationAccessError();
      await authorize(request, "run");
      if (pending.canceled) return { canceled: true as const };
      const acquired = await store.acquireRun(request.actor, {
        threadId: request.threadId,
        runId: request.input.runId,
        leaseOwner: replicaId,
        leaseMs,
        agentId: request.agentId,
      });
      if (acquired.outcome === "collision") {
        observeConversation(options.observe, {
          subsystem: "runtime",
          operation: "lease",
          outcome: "blocked",
          correlation: correlation(request.threadId, request.input.runId),
          error: "lease",
          gap: "lease",
        });
        throw new ConversationConflictError("Thread already has an active run");
      }
      if (acquired.outcome === "duplicate") return { duplicate: acquired.run };
      const execution: Execution = {
        run: acquired.run,
        cursor: 0n,
        startedAt: Date.now(),
        abort: () => request.agent.abortRun(),
        abortRequested: false,
        done: false,
      };
      execution.abort = () => {
        execution.abortRequested = true;
        request.agent.abortRun();
      };
      try {
        if (pending.canceled) {
          execution.done = true;
          await finishCanceledStart(request, execution, false);
          return { canceled: true as const };
        }
        const before = await store.readSnapshot(
          request.actor,
          request.threadId,
        );
        execution.cursor = before.latestSequence;
        if (pending.canceled) {
          execution.done = true;
          await finishCanceledStart(request, execution, false);
          return { canceled: true as const };
        }
        const messages = acceptedMessages(before.snapshot.messages, request);
        await appendEventsObserved({
          threadId: request.threadId,
          runId: acquired.run.id,
          leaseOwner: replicaId,
          generation: acquired.run.generation,
          events: [
            lifecycleEvent("RUN_STARTED", request.threadId, acquired.run.id),
            { type: "MESSAGES_SNAPSHOT", messages } as BaseEvent,
            {
              type: "STATE_SNAPSHOT",
              snapshot: before.snapshot.state,
            } as BaseEvent,
          ],
        });
        if (pending.canceled) {
          execution.done = true;
          await finishCanceledStart(request, execution, true);
          return { canceled: true as const, execution };
        }
        live.set(request.threadId, execution);
        observeConversation(options.observe, {
          subsystem: "runtime",
          operation: "run",
          outcome: "started",
          correlation: correlation(request.threadId, acquired.run.id),
          count: live.size,
        });
        observeConversation(options.observe, {
          subsystem: "runtime",
          operation: "activeRuns",
          outcome: "started",
          correlation: correlation(request.threadId, acquired.run.id),
          // This is intentionally a process-local count, not a cluster-wide gauge.
          count: live.size,
        });
        unregisterPendingStart(pending);
        notifyBusy(request.threadId, true);
        void produce(request, execution, messages).catch((error) => {
          execution.failure = error;
          execution.done = true;
        });
        return { execution };
      } catch (error) {
        // No model has run. Release a newly acquired lease, but never mask a failed durable write.
        await finishRunObserved({
          runId: acquired.run.id,
          leaseOwner: replicaId,
          generation: acquired.run.generation,
          status: "failed",
          events: [
            lifecycleEvent("RUN_ERROR", request.threadId, acquired.run.id, {
              message: "Conversation run failed",
              code: "conversation_run_failed",
            }),
          ],
        }).catch(() => undefined);
        observeConversation(options.observe, {
          subsystem: "runtime",
          operation: "run",
          outcome: "failed",
          correlation: correlation(request.threadId, acquired.run.id),
          latencyMs: elapsed(execution.startedAt),
          error: observationError(error, true),
        });
        throw error;
      }
    } finally {
      unregisterPendingStart(pending);
      if (!live.has(request.threadId))
        stopRequests.delete(stopKey(request.threadId, request.input.runId));
    }
  }

  function tail(
    request: EngineConnectRequest,
    cursor: bigint,
    runId: string,
    execution?: Execution,
  ): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      let detached = false;
      void (async () => {
        while (!detached) {
          if (execution?.failure) throw execution.failure;
          const page = await readEventPageObserved(
            request.actor,
            request.threadId,
            cursor,
            200,
          );
          for (const row of page) {
            cursor = row.sequence;
            if (row.runId !== runId) continue;
            subscriber.next(row.payload);
            if (terminal(row.payload)) {
              subscriber.complete();
              return;
            }
          }
          if (page.length === 200) continue;
          await store.reapExpiredRuns();
          const active = await store.getActiveRun(
            request.actor,
            request.threadId,
          );
          if (!active || active.id !== runId) {
            // Terminal commit can race the preceding page read. Drain its committed tail first.
            const last = await readEventPageObserved(
              request.actor,
              request.threadId,
              cursor,
              200,
            );
            if (last.length > 0) continue;
            if (execution?.failure) throw execution.failure;
            observeConversation(options.observe, {
              subsystem: "runtime",
              operation: "run",
              outcome: "interrupted",
              correlation: correlation(request.threadId, runId),
              gap: "sequence",
              error: "lease",
            });
            subscriber.next(
              lifecycleEvent("RUN_ERROR", request.threadId, runId, {
                message: "Conversation run was interrupted",
                code: "conversation_interrupted",
              }),
            );
            subscriber.complete();
            return;
          }
          await wait(pollMs);
        }
      })().catch((error) => {
        const category = observationError(error, true);
        observeConversation(options.observe, {
          subsystem: "runtime",
          operation: "replay",
          outcome: "failed",
          correlation: correlation(request.threadId, runId),
          error: category,
          gap: "sequence",
        });
        if (category === "persistence")
          observeConversation(options.observe, {
            subsystem: "runtime",
            operation: "persistence",
            outcome: "failed",
            correlation: correlation(request.threadId),
            error: category,
            gap: "persistence",
          });
        subscriber.error(error);
      });
      return () => {
        detached = true;
      };
    });
  }

  function restore(
    request: EngineConnectRequest,
    duplicate?: ConversationRunRecord,
    operation: "connect" | "resync" = "connect",
  ): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      let detached = false;
      let following: { unsubscribe(): void } | undefined;
      const startedAt = Date.now();
      void (async () => {
        await store.reapExpiredRuns();
        const active = await store.getActiveRun(
          request.actor,
          request.threadId,
        );
        const latest = await store.getLatestRun(
          request.actor,
          request.threadId,
        );
        const snapshot = await authorize(request, "history");
        if (detached) return;
        let replayRun: ConversationRunRecord | undefined;
        if (duplicate && (!active || active.id !== duplicate.id)) {
          replayRun = duplicate;
        } else if (!active && latest) {
          replayRun = latest;
        }
        const replayFailure = Boolean(
          replayRun &&
            ["failed", "interrupted", "stopped"].includes(replayRun.status),
        );
        const persistedTerminal =
          replayFailure && replayRun
            ? await store.getRunTerminalEvent(
                request.actor,
                request.threadId,
                replayRun.id,
              )
            : null;
        const runId =
          duplicate?.id ??
          active?.id ??
          (replayFailure && replayRun
            ? replayRun.id
            : `history:${randomUUID()}`);
        subscriber.next(lifecycleEvent("RUN_STARTED", request.threadId, runId));
        subscriber.next({
          type: "MESSAGES_SNAPSHOT",
          messages: snapshot.snapshot.messages,
        } as BaseEvent);
        subscriber.next({
          type: "STATE_SNAPSHOT",
          snapshot: snapshot.snapshot.state,
        } as BaseEvent);
        const requestedSequence =
          request.afterSequence ?? snapshot.latestSequence;
        observeConversation(options.observe, {
          subsystem: "runtime",
          operation,
          outcome: "completed",
          correlation: correlation(request.threadId, runId),
          latencyMs: elapsed(startedAt),
          lag: safeNumber(snapshot.latestSequence - requestedSequence),
          gap: operation,
        });
        if (!active || (duplicate && active.id !== duplicate.id)) {
          if (replayRun)
            observeConversation(options.observe, {
              subsystem: "runtime",
              operation: "replay",
              outcome: "completed",
              correlation: correlation(request.threadId, replayRun.id),
              count: 1,
              lag: safeNumber(snapshot.latestSequence),
            });
          if (replayFailure && persistedTerminal) {
            subscriber.next({
              ...persistedTerminal,
              threadId: request.threadId,
              runId,
            } as BaseEvent);
          } else if (!replayFailure) {
            subscriber.next(
              lifecycleEvent("RUN_FINISHED", request.threadId, runId),
            );
          }
          subscriber.complete();
          return;
        }
        following = tail(request, snapshot.latestSequence, runId).subscribe(
          subscriber,
        );
      })().catch((error) => {
        const category = observationError(error, true);
        observeConversation(options.observe, {
          subsystem: "runtime",
          operation,
          outcome: "failed",
          correlation: correlation(request.threadId),
          latencyMs: elapsed(startedAt),
          error: category,
          gap: operation,
        });
        if (category === "persistence")
          observeConversation(options.observe, {
            subsystem: "runtime",
            operation: "persistence",
            outcome: "failed",
            correlation: correlation(request.threadId),
            error: category,
            gap: "persistence",
          });
        subscriber.error(error);
      });
      return () => {
        detached = true;
        following?.unsubscribe();
      };
    });
  }

  return {
    store,
    replicaId,
    readSnapshot: (actor: ConversationActor, threadId: string) =>
      store.readSnapshot(actor, threadId),
    run(request: EngineRunRequest): Observable<BaseEvent> {
      return new Observable((subscriber) => {
        let detached = false;
        let following: { unsubscribe(): void } | undefined;
        const pending = registerPendingStart(
          request.threadId,
          request.input.runId,
        );
        void start(request, pending)
          .then((started) => {
            // Accepted execution persists independently of this observer's lifetime.
            if (detached) return;
            if ("canceled" in started) {
              if (!started.execution) {
                subscriber.complete();
                return;
              }
              following = tail(
                request,
                started.execution.cursor,
                started.execution.run.id,
              ).subscribe(subscriber);
              return;
            }
            following = (
              "duplicate" in started
                ? restore(request, started.duplicate, "resync")
                : tail(
                    request,
                    started.execution.cursor,
                    started.execution.run.id,
                    started.execution,
                  )
            ).subscribe(subscriber);
          })
          .catch((error) => subscriber.error(error));
        return () => {
          detached = true;
          following?.unsubscribe();
        };
      });
    },
    connect: (request: EngineConnectRequest) => restore(request),
    async isRunning(request: EngineConnectRequest) {
      await authorize(request, "history");
      await store.reapExpiredRuns();
      return Boolean(await store.getActiveRun(request.actor, request.threadId));
    },
    async stop(request: EngineStopRequest) {
      await authorize(request, "run");
      if (request.runId === null) return false;
      cancelPendingStarts(request.threadId, request.runId);
      const requestedAt = Date.now();
      let changed: boolean;
      try {
        changed = await store.requestStop({
          actor: request.actor,
          threadId: request.threadId,
          runId: request.runId,
          agentId: request.agentId,
        });
      } catch (error) {
        const category = observationError(error, true);
        observeConversation(options.observe, {
          subsystem: "runtime",
          operation: "stop",
          outcome: "failed",
          correlation: correlation(request.threadId, request.runId),
          latencyMs: elapsed(requestedAt),
          error: category,
        });
        observeConversation(options.observe, {
          subsystem: "runtime",
          operation: "persistence",
          outcome: "failed",
          correlation: correlation(request.threadId, request.runId),
          latencyMs: elapsed(requestedAt),
          error: category,
          gap: "persistence",
        });
        throw error;
      }
      const localExecution =
        live.get(request.threadId)?.run.id === request.runId ||
        Boolean(pendingStarts.get(request.threadId)?.get(request.runId)?.size);
      if (changed && localExecution)
        stopRequests.set(stopKey(request.threadId, request.runId), requestedAt);
      observeConversation(options.observe, {
        subsystem: "runtime",
        operation: "stop",
        outcome: changed ? "requested" : "unchanged",
        correlation: correlation(request.threadId, request.runId),
        latencyMs: elapsed(requestedAt),
        gap: "stop",
      });
      const execution = live.get(request.threadId);
      if (execution?.run.id === request.runId) execution.abort();
      return changed;
    },
    abortRun(threadId: string, runId: string) {
      cancelPendingStarts(threadId, runId);
      const execution = live.get(threadId);
      if (execution?.run.id === runId) execution.abort();
    },
  };
}

export type ConversationEngine = ReturnType<typeof createConversationEngine>;
