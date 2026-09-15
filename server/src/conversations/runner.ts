import { AgentRunner } from "@copilotkit/runtime/v2";
import type {
  AgentRunnerConnectRequest,
  AgentRunnerIsRunningRequest,
  AgentRunnerRunRequest,
  AgentRunnerStopRequest,
} from "@copilotkit/runtime/v2";
import type { Observable } from "rxjs";
import { throwError } from "rxjs";
import type { BaseEvent } from "@ag-ui/client";
import type { ConversationEngine } from "./engine";
import type { ConversationActor } from "./types";
import { ConversationAccessError } from "./types";

export type RunnerOperation = "run" | "connect" | "isRunning" | "stop";

export type ActorBoundRunnerScope = {
  actor: ConversationActor;
  agentId: string;
  threadId: string;
  allow: ReadonlySet<RunnerOperation>;
  stopRunId: string | null;
};

export function actorBoundRunner(
  engine: ConversationEngine,
  scope: ActorBoundRunnerScope,
): AgentRunner {
  if (
    scope.allow.size > 0 &&
    (!scope.actor.id.trim() || !scope.threadId || !scope.agentId)
  ) {
    throw new ConversationAccessError();
  }
  const frozenActor = Object.freeze({ id: scope.actor.id });
  const frozenAllow = new Set(scope.allow);
  const frozen = Object.freeze({
    actor: frozenActor,
    agentId: scope.agentId,
    threadId: scope.threadId,
    allow: frozenAllow,
    stopRunId: scope.stopRunId,
  });

  return new (class ActorBoundRunner extends AgentRunner {
    run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
      if (!frozen.allow.has("run")) {
        return throwError(() => new ConversationAccessError());
      }
      if (
        request.threadId !== frozen.threadId ||
        request.input.threadId !== frozen.threadId ||
        request.agent.agentId !== frozen.agentId
      ) {
        return throwError(() => new ConversationAccessError());
      }
      return engine.run({
        actor: frozen.actor,
        threadId: frozen.threadId,
        agentId: frozen.agentId,
        agent: request.agent,
        input: request.input,
        persistedInputMessages: request.persistedInputMessages,
      });
    }

    connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
      if (!frozen.allow.has("connect")) {
        return throwError(() => new ConversationAccessError());
      }
      if (request.threadId !== frozen.threadId) {
        return throwError(() => new ConversationAccessError());
      }
      if (request.agentId && request.agentId !== frozen.agentId) {
        return throwError(() => new ConversationAccessError());
      }
      return engine.connect({
        actor: frozen.actor,
        threadId: frozen.threadId,
        agentId: frozen.agentId,
      });
    }

    isRunning(request: AgentRunnerIsRunningRequest): Promise<boolean> {
      if (!frozen.allow.has("isRunning")) {
        return Promise.reject(new ConversationAccessError());
      }
      if (request.threadId !== frozen.threadId) {
        return Promise.reject(new ConversationAccessError());
      }
      return engine.isRunning({
        actor: frozen.actor,
        threadId: frozen.threadId,
        agentId: frozen.agentId,
      });
    }

    stop(request: AgentRunnerStopRequest): Promise<boolean | undefined> {
      if (!frozen.allow.has("stop")) {
        return Promise.reject(new ConversationAccessError());
      }
      if (request.threadId !== frozen.threadId) {
        return Promise.reject(new ConversationAccessError());
      }
      if (request.runId && request.runId !== frozen.stopRunId) {
        return Promise.reject(new ConversationAccessError());
      }
      return engine.stop({
        actor: frozen.actor,
        threadId: frozen.threadId,
        agentId: frozen.agentId,
        runId: frozen.stopRunId,
      });
    }
  })();
}

export function denyAllRunner(engine: ConversationEngine): AgentRunner {
  return actorBoundRunner(engine, {
    actor: { id: "" },
    agentId: "",
    threadId: "",
    allow: new Set(),
    stopRunId: null,
  });
}
