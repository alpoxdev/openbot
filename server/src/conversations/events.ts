import {
  AbstractAgent,
  type BaseEvent,
  type Message,
  type RunAgentInput,
  type State,
  defaultApplyEvents,
} from "@ag-ui/client";
import { EMPTY, defaultIfEmpty, from, lastValueFrom, tap } from "rxjs";

export type ConversationSnapshot = {
  messages: Message[];
  state: State;
};

/** Uses the public AG-UI reducer without running a model or any tool subscribers. */
class HistoryProjection extends AbstractAgent {
  run() {
    return EMPTY;
  }
}

/** Rebuild only the committed tail after the baseline's sequence. */
export async function projectConversation(
  baseline: ConversationSnapshot,
  events: readonly BaseEvent[],
): Promise<ConversationSnapshot> {
  const messages = structuredClone(baseline.messages);
  const state = structuredClone(baseline.state);
  if (events.length === 0) return { messages, state };

  const agent = new HistoryProjection({
    agentId: "history-projection",
    threadId: "history-projection",
    initialMessages: messages,
    initialState: state,
  });
  const input: RunAgentInput = {
    threadId: agent.threadId,
    runId: "history-projection",
    messages,
    state,
    tools: [],
    context: [],
    forwardedProps: {},
  };
  await lastValueFrom(
    defaultApplyEvents(input, from(structuredClone(events)), agent, []).pipe(
      tap((mutation) => {
        if (mutation.messages !== undefined)
          agent.setMessages(mutation.messages);
        if (mutation.state !== undefined) agent.setState(mutation.state);
      }),
      defaultIfEmpty(undefined),
    ),
  );
  return { messages: agent.messages, state: agent.state };
}

/** Runtime input can contain model-only context and signed assertions, never history. */
export function historyEvent(event: BaseEvent): BaseEvent {
  if (event.type !== "RUN_STARTED") return structuredClone(event);
  const { input: _input, ...safe } = event as BaseEvent & { input?: unknown };
  return structuredClone(safe);
}
