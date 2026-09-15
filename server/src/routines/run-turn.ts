/**
 * One headless turn, run into the local conversation the person will open.
 *
 * The shared conversation engine owns acquire, lease heartbeat, durable events and Stop.

 */
import type {
  AbstractAgent,
  BaseEvent,
  Message,
  RunAgentInput,
} from "@ag-ui/client";
import { EventType } from "@ag-ui/client";
import { frameFiring } from "../../../shared/routine-firing";
import { sanitizeSeededHistory } from "../agents/history-sanitize";
import type { AuditInitiator } from "../audit";
import type { ConversationEngine } from "../conversations/engine";
import {
  ConversationAccessError,
  ConversationNotFoundError,
} from "../conversations/types";
import type { TurnRunner } from "./runner";

const DEFAULT_ABORT_GRACE_MS = 5_000;
const DEFAULT_TURN_TIMEOUT_MS = 5 * 60_000;

export { sanitizeSeededHistory };
export { frameFiring };

export type ConversationEngineLike = {
  store: Pick<ConversationEngine["store"], "readSnapshot">;
  run: ConversationEngine["run"];
  stop: ConversationEngine["stop"];
  abortRun: ConversationEngine["abortRun"];
};

type ConversationSnapshot = Awaited<
  ReturnType<ConversationEngineLike["store"]["readSnapshot"]>
>;

function assistantText(message: Message): string | undefined {
  if (message.role !== "assistant") return undefined;
  const { content } = message;
  return typeof content === "string" && content.length > 0
    ? content
    : undefined;
}

export function createTurnRunner(options: {
  engine: ConversationEngineLike;
  buildAgentFor: (input: {
    ownerUserId: string;
    agentId: string;
    initiator: AuditInitiator;
  }) => Promise<AbstractAgent>;
  turnTimeoutMs?: number;
  abortGraceMs?: number;
}): TurnRunner {
  const {
    engine,
    buildAgentFor,
    turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS,
    abortGraceMs = DEFAULT_ABORT_GRACE_MS,
  } = options;

  return async ({ ownerUserId, routineId, agentId, threadId, instruction }) => {
    const runId = crypto.randomUUID();
    const actor = { id: ownerUserId };

    let snapshot: ConversationSnapshot;
    try {
      snapshot = await engine.store.readSnapshot(actor, threadId);
    } catch (error) {
      if (
        error instanceof ConversationNotFoundError ||
        error instanceof ConversationAccessError
      ) {
        throw new Error(
          "This conversation is not available locally, so the routine cannot run.",
        );
      }
      throw error;
    }

    if (snapshot.thread.agentId && snapshot.thread.agentId !== agentId) {
      throw new Error(
        "This conversation belongs to a different Bot, so the routine cannot run.",
      );
    }

    const seeded = sanitizeSeededHistory(snapshot.snapshot.messages);
    const turn = {
      id: crypto.randomUUID(),
      role: "user",
      content: frameFiring(instruction),
    } as Message;
    const messages = [...seeded, turn];
    const persistedInputMessages = [turn];

    const agent = await buildAgentFor({
      ownerUserId,
      agentId,
      initiator: { kind: "routine", id: routineId },
    });
    agent.threadId = threadId;
    agent.setMessages(messages);
    agent.setState(snapshot.snapshot.state);

    const input: RunAgentInput = {
      threadId,
      runId,
      messages,
      state: agent.state,
      tools: [],
      context: [],
      forwardedProps: undefined,
    };

    const before = new Set(agent.messages.map((message) => message.id));
    const chunks: string[] = [];
    const spoken = agent.subscribe({
      onTextMessageEndEvent: ({ textMessageBuffer }) => {
        if (textMessageBuffer.length > 0) chunks.push(textMessageBuffer);
      },
    });

    let deadline: ReturnType<typeof setTimeout> | undefined;
    let backstop: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let stopPromise: Promise<boolean | undefined> | undefined;

    const stopTurn = () => {
      try {
        agent.abortRun();
      } catch {
        // The engine Stop is the half that cancels the durable run.
      }
      engine.abortRun(threadId, runId);
      stopPromise ??= engine
        .stop({ actor, threadId, agentId, runId })
        .catch(() => undefined);
    };

    try {
      const completed = new Promise<void>((resolve, reject) => {
        let terminal: Error | undefined;
        engine
          .run({
            actor,
            threadId,
            agentId,
            agent,
            input,
            persistedInputMessages,
          })
          .subscribe({
            next: (event: BaseEvent) => {
              if (event.type !== EventType.RUN_ERROR || terminal) return;
              const message =
                "message" in event && typeof event.message === "string"
                  ? event.message
                  : "The routine's turn failed.";
              terminal = new Error(message);
              terminal.name = "RoutineTurnRunError";
            },
            error: reject,
            complete: () => {
              if (terminal) reject(terminal);
              else resolve();
            },
          });
      });

      const timeout = new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => {
          stopped = true;
          stopTurn();
        }, turnTimeoutMs);
        deadline.unref?.();
        backstop = setTimeout(() => {
          reject(
            new Error(
              `The routine's turn did not finish within ${Math.round(turnTimeoutMs / 1000)}s and could not be stopped.`,
            ),
          );
        }, turnTimeoutMs + abortGraceMs);
        backstop.unref?.();
      });

      await Promise.race([completed, timeout]);
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
      if (backstop !== undefined) clearTimeout(backstop);
      spoken.unsubscribe();
    }

    if (stopped) {
      await stopPromise;
      throw new Error(
        `The routine's turn was stopped after ${Math.round(turnTimeoutMs / 1000)}s.`,
      );
    }

    const said = agent.messages
      .filter((message) => !before.has(message.id))
      .map(assistantText)
      .filter((text): text is string => text !== undefined);
    const replyText = (said.length > 0 ? said : chunks).join("\n\n");

    if (agent.pendingInterrupts.length > 0) {
      throw new Error(
        "The turn stopped to ask a question, and a routine has nobody to ask.",
      );
    }
    if (replyText.length === 0) {
      throw new Error("The turn finished without saying anything.");
    }

    return { replyText };
  };
}
