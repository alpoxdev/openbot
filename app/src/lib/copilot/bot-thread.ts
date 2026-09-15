import { useCallback, useEffect, useRef, useState } from "react";
import {
  liveHandoverAllowed,
  mintConversationThread,
  mostRecentEligibleThread,
  readConversationThread,
  type ConversationLocalReadiness,
  type ConversationThreadRecord,
  type ConversationThreadStatus,
} from "@/lib/conversation-history";

/**
 * The thread the direct Bot chat talks in.
 *
 * Server rows are the history. The browser id is a pointer, not the record: clearing localStorage
 * must not strand conversations that already live on this server, and an unavailable remembered id
 * must not be auto-replaced.
 */

const KEY = "openbot.bot-thread";
const ARCHIVE_KEY = "openbot.bot-thread-archive";

/** The one place the storage key is built, so the getter and the setter can never drift apart. */
export function botThreadKey(agentId: string): string {
  return `${KEY}.${agentId}`;
}

export function botThreadArchiveKey(agentId: string): string {
  return `${ARCHIVE_KEY}.${agentId}`;
}

function remembered(agentId: string): string | null {
  try {
    return window.localStorage.getItem(botThreadKey(agentId));
  } catch {
    return null;
  }
}

function remember(agentId: string, threadId: string): void {
  try {
    window.localStorage.setItem(botThreadKey(agentId), threadId);
  } catch {
    // The conversation still works; the pointer just will not be here next time.
  }
}

function archivePointer(agentId: string, threadId: string): void {
  try {
    window.localStorage.setItem(botThreadArchiveKey(agentId), threadId);
  } catch {
    // Archive is convenience only.
  }
}

export type ThreadResolution = "remembered" | "server" | "mint" | "hold";

/**
 * How to pick a thread given a browser pointer and what this server said about it.
 *
 * A remembered id that the server cannot confirm is held, never reminted. Missing browser storage
 * restores the newest eligible server conversation. Minting is only for a confirmed empty history
 * or an explicit new conversation.
 */
export function threadToUse(input: {
  remembered: string | null;
  record: ConversationThreadRecord | null;
  lookupFailed: boolean;
  serverLatestId: string | null;
  serverListFailed: boolean;
}): ThreadResolution {
  if (input.remembered) {
    if (input.lookupFailed) return "hold";
    if (!input.record) return "hold";
    if (input.record.status === "notfound") return "hold";
    if (input.record.status === "external_unavailable") return "hold";
    return "remembered";
  }
  if (input.serverListFailed) return "hold";
  if (input.serverLatestId) return "server";
  return "mint";
}

export type BotThread = {
  threadId: string | undefined;
  history: "ready" | "unavailable";
  status: ConversationThreadStatus | undefined;
  localReadiness: ConversationLocalReadiness | undefined;
  liveHandover: boolean;
  startNew: () => void;
};

type MintOperation = {
  generation: number;
  explicit: boolean;
  promise: Promise<string | null>;
};

export function useBotThread(agentId: string): BotThread {
  const [threadId, setThreadId] = useState<string | undefined>(undefined);
  const [history, setHistory] = useState<"ready" | "unavailable">("ready");
  const [status, setStatus] = useState<ConversationThreadStatus | undefined>(
    undefined,
  );
  const [localReadiness, setLocalReadiness] = useState<
    ConversationLocalReadiness | undefined
  >(undefined);
  const mountedRef = useRef(true);
  const mintOperationRef = useRef<MintOperation | null>(null);
  const generationRef = useRef(0);
  const startedNewRef = useRef<{ generation: number; started: boolean }>({
    generation: 0,
    started: false,
  });
  const resolvedAgentRef = useRef<string | undefined>(undefined);
  const renderedAgentRef = useRef(agentId);
  if (renderedAgentRef.current !== agentId) {
    // Effects run after paint. Clear the owner during render so a changed agent can never briefly
    // receive the prior agent's thread while its new server lookup is in flight.
    renderedAgentRef.current = agentId;
    resolvedAgentRef.current = undefined;
  }

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    let current = true;
    mountedRef.current = true;
    // A stale request may still be in flight. It is not allowed to clear this generation's
    // minting flag when it settles.
    if (mintOperationRef.current?.generation !== generation) {
      mintOperationRef.current = null;
    }
    startedNewRef.current = { generation, started: false };
    resolvedAgentRef.current = undefined;
    setThreadId(undefined);
    setHistory("ready");
    setStatus(undefined);
    setLocalReadiness(undefined);

    const isCurrent = () =>
      current && mountedRef.current && generationRef.current === generation;
    const startedNew = () =>
      startedNewRef.current.generation === generation &&
      startedNewRef.current.started;
    const applyRecord = (
      id: string,
      record: ConversationThreadRecord | null,
      unavailable: boolean,
    ) => {
      if (!isCurrent()) return;
      resolvedAgentRef.current = agentId;
      setThreadId(id);
      setStatus(record?.status);
      setLocalReadiness(record?.localReadiness);
      setHistory(unavailable ? "unavailable" : "ready");
    };
    const mintForGeneration = (explicit: boolean): MintOperation => {
      const pending = mintOperationRef.current;
      if (pending?.generation === generation) {
        if (explicit) pending.explicit = true;
        return pending;
      }

      const operation = {
        generation,
        explicit,
        promise: Promise.resolve<string | null>(null),
      };
      operation.promise = mintConversationThread(agentId).finally(() => {
        if (
          generationRef.current === generation &&
          mintOperationRef.current === operation
        ) {
          mintOperationRef.current = null;
        }
      });
      mintOperationRef.current = operation;
      return operation;
    };
    const adoptMinted = async () => {
      const operation = mintForGeneration(false);
      let minted = await operation.promise;
      // If New owned the shared operation and failed, preserve the old thread while allowing the
      // resolver's normal empty-history recovery to make one replacement attempt.
      if (
        minted === null &&
        operation.explicit &&
        isCurrent() &&
        !startedNew()
      ) {
        minted = await mintForGeneration(false).promise;
      }
      if (!isCurrent() || startedNew()) return;
      if (!minted) {
        resolvedAgentRef.current = agentId;
        setHistory("unavailable");
        return;
      }
      remember(agentId, minted);
      applyRecord(minted, { status: "local", localReadiness: "ready" }, false);
    };

    const resolve = async () => {
      const existing = remembered(agentId);
      if (existing) {
        const record = await readConversationThread(existing);
        if (!isCurrent() || startedNew()) return;
        const decision = threadToUse({
          remembered: existing,
          record,
          lookupFailed: record === null,
          serverLatestId: null,
          serverListFailed: false,
        });
        if (decision === "hold" || decision === "remembered") {
          applyRecord(
            existing,
            record,
            record === null || record.status === "external_unavailable",
          );
          return;
        }
      }

      const latest = await mostRecentEligibleThread(agentId);
      if (!isCurrent() || startedNew()) return;
      if (latest === "unavailable") {
        resolvedAgentRef.current = agentId;
        setHistory("unavailable");
        return;
      }
      if (latest) {
        remember(agentId, latest.id);
        const record = await readConversationThread(latest.id);
        if (!isCurrent() || startedNew()) return;
        applyRecord(
          latest.id,
          record ?? {
            status: "local",
            localReadiness: latest.localReadiness ?? "ready",
          },
          record === null,
        );
        return;
      }
      await adoptMinted();
    };

    void resolve();

    return () => {
      current = false;
      mountedRef.current = false;
      generationRef.current += 1;
    };
  }, [agentId]);

  const startNew = useCallback(() => {
    const generation = generationRef.current;
    if (
      !mountedRef.current ||
      startedNewRef.current.generation !== generation
    ) {
      return;
    }
    const previous = remembered(agentId);
    const operation = (() => {
      const pending = mintOperationRef.current;
      if (pending?.generation === generation) {
        pending.explicit = true;
        return pending;
      }
      const created = {
        generation,
        explicit: true,
        promise: Promise.resolve<string | null>(null),
      };
      created.promise = mintConversationThread(agentId).finally(() => {
        if (
          generationRef.current === generation &&
          mintOperationRef.current === created
        ) {
          mintOperationRef.current = null;
        }
      });
      mintOperationRef.current = created;
      return created;
    })();
    void operation.promise.then((minted) => {
      if (
        !mountedRef.current ||
        generationRef.current !== generation ||
        startedNewRef.current.generation !== generation
      ) {
        return;
      }
      if (!minted) return;
      startedNewRef.current.started = true;
      if (previous && previous !== minted) archivePointer(agentId, previous);
      remember(agentId, minted);
      resolvedAgentRef.current = agentId;
      setThreadId(minted);
      setStatus("local");
      setLocalReadiness("ready");
      setHistory("ready");
    });
  }, [agentId]);

  const resolvedForAgent = resolvedAgentRef.current === agentId;
  const record: ConversationThreadRecord | null =
    resolvedForAgent && status
      ? { status, ...(localReadiness ? { localReadiness } : {}) }
      : null;

  return {
    threadId: resolvedForAgent ? threadId : undefined,
    history: resolvedForAgent ? history : "ready",
    status: resolvedForAgent ? status : undefined,
    localReadiness: resolvedForAgent ? localReadiness : undefined,
    liveHandover:
      resolvedForAgent && liveHandoverAllowed(record) && history === "ready",
    startNew,
  };
}
