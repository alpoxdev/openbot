import type { BaseEvent, Message, State } from "@ag-ui/client";

export type ConversationActor = {
  id: string;
};

export type ConversationProvenance = "local" | "imported";

export type ConversationLocalReadiness = "not_ready" | "history_only" | "ready";

export type ConversationRunStatus =
  | "pending"
  | "running"
  | "stopping"
  | "interrupted"
  | "completed"
  | "failed"
  | "stopped";

export type ConversationAccess = "none" | "history" | "run";

export type ConversationThreadRecord = {
  id: string;
  ownerUserId: string;
  channelId: string | null;
  agentId: string | null;
  provenance: ConversationProvenance;
  localReadiness: ConversationLocalReadiness;
  nextSequence: bigint;
  latestSequence: bigint;
  createdAt: Date;
  updatedAt: Date;
};

/** Short metadata returned by the conversation roster. */
export type ConversationThreadSummary = {
  id: string;
  agentId: string | null;
  channelId: string | null;
  provenance: ConversationProvenance;
  localReadiness: ConversationLocalReadiness;
  updatedAt: Date;
  title: string | null;
  preview: string | null;
};

/** One bounded page of conversation roster rows. */
export type ConversationThreadPage = {
  threads: ConversationThreadSummary[];
  nextCursor: string | null;
};

/** Filters and keyset position for the conversation roster. */
export type ConversationThreadQuery = {
  agentId?: string;
  directOnly?: boolean;
  limit?: number;
  cursor?: string;
};

export type ConversationRunRecord = {
  id: string;
  threadId: string;
  status: ConversationRunStatus;
  leaseOwner: string | null;
  leaseUntil: Date | null;
  generation: number;
  stopTargetRunId: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
};

export type ConversationEventRecord = {
  threadId: string;
  sequence: bigint;
  runId: string | null;
  type: string;
  payload: BaseEvent;
  createdAt: Date;
};

export type CreateThreadInput = {
  id: string;
  ownerUserId: string;
  channelId?: string | null;
  agentId?: string | null;
  provenance: ConversationProvenance;
  localReadiness?: ConversationLocalReadiness;
};

export type PublishBaselineInput = {
  messages: Message[];
  state: State;
  baselineSequence: bigint;
  contentHash?: string | null;
};

export type CheckpointBaselineInput = PublishBaselineInput & {
  runId: string;
  leaseOwner: string;
  generation: number;
};

export type AcquireRunInput = {
  agentId?: string;
  threadId: string;
  runId: string;
  leaseOwner: string;
  leaseMs: number;
};

export type AcquireRunResult =
  | { outcome: "acquired"; run: ConversationRunRecord }
  | { outcome: "duplicate"; run: ConversationRunRecord }
  | { outcome: "collision"; run: ConversationRunRecord };

export type FinishRunInput = {
  runId: string;
  leaseOwner: string;
  generation: number;
  status: Extract<ConversationRunStatus, "completed" | "failed" | "stopped">;
  events?: readonly BaseEvent[];
  snapshot?: { messages: Message[]; state: State; baselineSequence: bigint };
};

export class ConversationAccessError extends Error {
  readonly code = "conversation_access_denied" as const;
  constructor(message = "Conversation access denied") {
    super(message);
    this.name = "ConversationAccessError";
  }
}

export class ConversationNotFoundError extends Error {
  readonly code = "conversation_not_found" as const;
  constructor(message = "Conversation not found") {
    super(message);
    this.name = "ConversationNotFoundError";
  }
}

export class ConversationConflictError extends Error {
  readonly code = "conversation_conflict" as const;
  constructor(message = "Conversation conflict") {
    super(message);
    this.name = "ConversationConflictError";
  }
}

export class ConversationLeaseError extends Error {
  readonly code = "conversation_lease_lost" as const;
  constructor(message = "Conversation lease lost") {
    super(message);
    this.name = "ConversationLeaseError";
  }
}
