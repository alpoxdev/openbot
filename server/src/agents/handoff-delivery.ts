import type { AbstractAgent, BaseEvent, Message } from "@ag-ui/client";
import type { Observable } from "rxjs";
import type { ConversationEngine } from "../conversations/engine";
import type { ConversationStore } from "../conversations/store";
import type { HandoffDelivery } from "./handoff-runner";
import { textOf } from "./message-text";

type DeliveryEngine = Pick<ConversationEngine, "run" | "stop" | "abortRun"> & {
  store: Pick<ConversationStore, "readSnapshot" | "createThread">;
};

const DEFAULT_ABORT_GRACE_MS = 5_000;

export function createHandoffDelivery(options: {
  agentFor: (input: {
    actorId: string;
    botId: string;
    fromBotId: string;
  }) => Promise<AbstractAgent | null>;
  engine: DeliveryEngine;
  mintThreadId: () => string;
  newRunId: () => string;
  announce?: (input: {
    actorId: string;
    threadId: string;
    agentId: string;
    text: string;
  }) => Promise<void>;
  setBusy?: (input: { threadId: string; busy: boolean }) => Promise<void>;
  deadlineMs?: number;
  abortGraceMs?: number;
}): HandoffDelivery {
  const { engine, agentFor, mintThreadId, newRunId, announce, setBusy } =
    options;
  const deadlineMs = options.deadlineMs ?? 5 * 60_000;
  const abortGraceMs = options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS;
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0)
    throw new RangeError("Invalid handoff deadline");
  if (!Number.isFinite(abortGraceMs) || abortGraceMs <= 0)
    throw new RangeError("Invalid handoff abort grace");

  return {
    async deliver({ work, message, shown, assertion }) {
      const actor = { id: work.actorId };
      const agent = await agentFor({
        actorId: work.actorId,
        botId: work.toBotId,
        fromBotId: work.fromBotId,
      });
      if (!agent)
        throw new Error(`${work.toBotId} could not be built for this run`);

      // A missing or forbidden asking conversation is not permission to create an empty substitute.
      const asking = await engine.store.readSnapshot(actor, work.threadId);
      const prior = conversationOnly(asking.snapshot.messages);
      const threadId = work.answerIn ?? mintThreadId();
      if (!work.answerIn) {
        await engine.store.createThread({
          id: threadId,
          ownerUserId: work.actorId,
          agentId: work.toBotId,
          provenance: "local",
          localReadiness: "ready",
        });
      }
      const before = await engine.store.readSnapshot(actor, threadId);
      const existingIds = new Set(
        before.snapshot.messages.map((entry) => entry.id),
      );
      const runId = newRunId();
      const asked: Message[] = [
        ...(work.answerIn ? prior.slice(-6) : prior),
        { id: `handoff-${runId}`, role: "user", content: message },
      ];
      const persisted: Message[] = shown
        ? [{ id: `handoff-${runId}`, role: "user", content: shown }]
        : [];
      const forward = !work.answerIn;
      if (forward)
        await setBusy?.({ threadId: work.threadId, busy: true }).catch(
          () => undefined,
        );
      const seen = { count: 0, last: "" };
      try {
        await consume(
          engine.run({
            actor,
            threadId,
            agentId: work.toBotId,
            agent,
            input: {
              threadId,
              runId,
              messages: asked,
              tools: [],
              context: [],
              state: {},
              forwardedProps: { openbotRun: assertion },
            },
            persistedInputMessages: persisted,
          }),
          (event) => {
            seen.count += 1;
            seen.last = event.type;
          },
          deadlineMs,
          async ({ waitForTerminal }) => {
            // Stop the actual execution, not merely the observer. The engine owns the only lease.
            const timedOut = `${work.toBotId} did not finish within ${Math.round(deadlineMs / 1000)}s after ${seen.count} recorded events${seen.last ? `, the last ${seen.last}` : ""}`;
            let abortFailure: unknown;
            try {
              // This is deliberately synchronous: a timed-out local execution must stop producing
              // events before the durable stop request is awaited below.
              engine.abortRun(threadId, runId);
            } catch (error) {
              abortFailure = error;
            }

            try {
              await withGrace(
                (async () => {
                  await Promise.resolve().then(() =>
                    engine.stop({
                      actor,
                      threadId,
                      agentId: work.toBotId,
                      runId,
                    }),
                  );
                  // engine.stop records a durable stop request. The run owns the terminal commit,
                  // which is what prevents a retry from starting before this exact run is settled.
                  await waitForTerminal();
                })(),
                abortGraceMs,
              );
            } catch (stopFailure) {
              const reason = errorText(stopFailure);
              throw new Error(
                `${timedOut}; durable stop failed${reason ? `: ${reason}` : ""}`,
                { cause: stopFailure },
              );
            }
            if (abortFailure) {
              const reason = errorText(abortFailure);
              throw new Error(
                `${timedOut}; local abort failed${reason ? `: ${reason}` : ""}`,
                { cause: abortFailure },
              );
            }
            return timedOut;
          },
        );
        const completed = await engine.store.readSnapshot(actor, threadId);
        const said = completed.snapshot.messages
          .filter(
            (entry) => entry.role === "assistant" && !existingIds.has(entry.id),
          )
          .map((entry) => textOf(entry.content).trim())
          .filter(Boolean);
        const answer = said.length ? said.join("\n\n") : null;
        if (answer) {
          // A roster notification failure must not turn a durable success into duplicate model work.
          await announce?.({
            actorId: work.actorId,
            threadId,
            agentId: work.toBotId,
            text: answer,
          }).catch(() => undefined);
        }
        return { answer };
      } finally {
        if (forward)
          await setBusy?.({ threadId: work.threadId, busy: false }).catch(
            () => undefined,
          );
      }
    },
  };
}

/** Only the asking conversation's words, not its tools or stale approvals, are model context. */
function conversationOnly(messages: readonly Message[]): Message[] {
  return messages.flatMap((message): Message[] => {
    if (
      (message.role !== "user" && message.role !== "assistant") ||
      !textOf(message.content).trim()
    )
      return [];
    if (message.role === "assistant") {
      const { toolCalls: _calls, ...words } = message;
      return [words];
    }
    return [message];
  });
}

function consume(
  events: Observable<BaseEvent>,
  observe: (event: BaseEvent) => void,
  timeoutMs: number,
  onTimeout: (context: {
    waitForTerminal: () => Promise<void>;
  }) => Promise<string> | string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // A timeout is not terminal by itself: its caller must stop the exact run and wait for this
    // stream's durable terminal event before this promise is allowed to reject.
    let done = false;
    let timeoutStarted = false;
    let terminal = false;
    let failure: Error | undefined;
    let streamFailure: unknown;
    let resolveTerminal!: () => void;
    const terminalWait = new Promise<void>((resolveTerminalWait) => {
      resolveTerminal = resolveTerminalWait;
    });
    const waitForTerminal = async () => {
      await terminalWait;
      if (streamFailure) throw streamFailure;
    };
    let subscription: { unsubscribe(): void } | undefined;
    const finish = (error?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      subscription?.unsubscribe();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      if (done || timeoutStarted) return;
      timeoutStarted = true;
      clearTimeout(timer);
      // Keep the observer attached while durable cancellation completes. The terminal event is the
      // engine's durable finish acknowledgement and must not be skipped by a timeout.
      void Promise.resolve()
        .then(() => onTimeout({ waitForTerminal }))
        .then(
          (message) => finish(new Error(message)),
          (error) => finish(error),
        );
    }, timeoutMs);
    subscription = events.subscribe({
      next: (event) => {
        observe(event);
        if (event.type === "RUN_ERROR") {
          terminal = true;
          failure = new Error(
            String(
              (event as BaseEvent & { message?: string }).message ??
                "Handoff run failed",
            ),
          );
        } else if (event.type === "RUN_FINISHED") terminal = true;
        if (terminal) resolveTerminal();
      },
      error: (error) => {
        streamFailure = error;
        resolveTerminal();
        if (!timeoutStarted) finish(error);
      },
      complete: () => {
        if (!terminal) {
          streamFailure =
            failure ?? new Error("Handoff ended without a durable result");
          resolveTerminal();
        }
        if (!timeoutStarted)
          finish(failure ?? (terminal ? undefined : streamFailure));
      },
    });
    if (done) subscription.unsubscribe();
  });
}

function withGrace<T>(promise: Promise<T>, graceMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(
      () =>
        settle(() =>
          reject(
            new Error(`durable stop did not complete within ${graceMs}ms`),
          ),
        ),
      graceMs,
    );
    promise.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error)),
    );
  });
}

function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "";
}
