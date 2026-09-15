import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  agentProfiles,
  attachments,
  channelMemberships,
  channels,
  conversationThreads,
} from "../db/schema";
import type { ConversationStore } from "./store";
import type {
  ConversationImportStore,
  ImportAttempt,
  ImportItemRecord,
  ImportJobActor,
  ImportJobRecord,
} from "./import-store";
import {
  ImportDestinationConflictError,
  ImportJobConflictError,
} from "./import-store";
import type { ConversationImportSource } from "./import-source";
import type { ImportThreadSummary } from "./import-types";
import {
  IMPORT_CONVERTER_VERSION,
  capturedContentHash,
  validateImportedMessages,
} from "./import-validation";

const ATTACHMENT_REF = /\/api\/attachments\/([0-9a-f-]{36})/gi;

export type ImportJobSummary = {
  jobId: string;
  phase: ImportJobRecord["phase"];
  counts: {
    selected: number;
    published: number;
    unchanged: number;
    blocked: number;
    failed: number;
    excluded: number;
    sourceChanged: number;
  };
  coverage: Record<string, unknown>;
};

export type RunApprovedImportInput = {
  actor: ImportJobActor;
  jobId: string;
  approvedManifestHash: string;
  source: ConversationImportSource;
  itemIds?: string[];
  signal?: AbortSignal;
  attempt?: ImportAttempt;
};

export function assertImportRunnable(
  job: ImportJobRecord,
  approvedManifestHash: string,
) {
  if (job.phase === "cancelled") {
    throw new ImportJobConflictError("Cancelled jobs cannot import");
  }
  if (job.phase === "paused") {
    throw new ImportJobConflictError(
      "Paused jobs cannot import until inventory is complete",
    );
  }
  if (
    job.phase !== "awaiting_confirmation" &&
    job.phase !== "importing" &&
    job.phase !== "completed" &&
    job.phase !== "completed_with_gaps"
  ) {
    throw new ImportJobConflictError(`Job phase ${job.phase} cannot import`);
  }
  if (
    !job.approvedManifestHash ||
    job.approvedManifestHash !== approvedManifestHash
  ) {
    throw new ImportJobConflictError(
      "Approved manifest hash does not match the job",
    );
  }
  if (capturedContentHash(job.manifest) !== approvedManifestHash) {
    throw new ImportJobConflictError(
      "Approved manifest hash does not match the current inventory",
    );
  }
}

function isInertEmptyState(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  return (
    Object.getPrototypeOf(value) === Object.prototype &&
    Reflect.ownKeys(value).length === 0
  );
}

function previousResourceGaps(coverage: Record<string, unknown>): boolean {
  if (coverage.resourceGaps === true) return true;
  const attachments = coverage.attachments;
  if (
    attachments &&
    typeof attachments === "object" &&
    !Array.isArray(attachments) &&
    (((attachments as Record<string, unknown>).missing as unknown[])?.length >
      0 ||
      ((attachments as Record<string, unknown>).staged as unknown[])?.length >
        0)
  ) {
    return true;
  }
  const events = coverage.events;
  if (events && typeof events === "object" && !Array.isArray(events)) {
    const record = events as Record<string, unknown>;
    if (
      record.available !== true ||
      record.truncated === true ||
      (Array.isArray(record.decodeErrorRowIds) &&
        record.decodeErrorRowIds.length > 0)
    ) {
      return true;
    }
  }
  const state = coverage.state;
  if (state && typeof state === "object" && !Array.isArray(state)) {
    const record = state as Record<string, unknown>;
    if (
      record.available !== true ||
      record.kind !== "snapshot" ||
      (typeof record.skippedDeltas === "number" && record.skippedDeltas > 0)
    ) {
      return true;
    }
  }
  return false;
}

function collectAttachmentIds(value: unknown, into: Set<string>) {
  if (typeof value === "string") {
    for (const match of value.matchAll(ATTACHMENT_REF)) {
      if (match[1]) into.add(match[1]);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectAttachmentIds(entry, into);
    return;
  }
  if (value && typeof value === "object") {
    for (const nested of Object.values(value))
      collectAttachmentIds(nested, into);
  }
}

function nonEmptyIdentity(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function metadataFingerprint(summary: ImportThreadSummary) {
  return {
    id: summary.id,
    createdById: nonEmptyIdentity(summary.createdById) ?? null,
    agentId: nonEmptyIdentity(summary.agentId) ?? null,
    organizationId: nonEmptyIdentity(summary.organizationId) ?? null,
    lastRunAt: nonEmptyIdentity(summary.lastRunAt) ?? null,
    lastUpdatedAt: nonEmptyIdentity(summary.lastUpdatedAt) ?? null,
    updatedAt: nonEmptyIdentity(summary.updatedAt) ?? null,
  };
}

function sourceIdentity(summary: ImportThreadSummary) {
  const agentId = nonEmptyIdentity(summary.agentId);
  const organizationId = nonEmptyIdentity(summary.organizationId);
  const createdById = nonEmptyIdentity(summary.createdById);
  return {
    ...(agentId === undefined ? {} : { agentId }),
    ...(organizationId === undefined ? {} : { organizationId }),
    ...(createdById === undefined ? {} : { createdById }),
  };
}

function identityFieldsDisagree(
  first: ReturnType<typeof sourceIdentity>,
  later: ReturnType<typeof sourceIdentity>,
): boolean {
  return (
    (first.agentId !== undefined &&
      later.agentId !== undefined &&
      first.agentId !== later.agentId) ||
    (first.organizationId !== undefined &&
      later.organizationId !== undefined &&
      first.organizationId !== later.organizationId) ||
    (first.createdById !== undefined &&
      later.createdById !== undefined &&
      first.createdById !== later.createdById)
  );
}

function priorSourceIdentity(coverage: Record<string, unknown>) {
  const identity = coverage.sourceIdentity;
  if (!isRecord(identity)) return {};
  const agentId = nonEmptyIdentity(identity.agentId);
  const organizationId = nonEmptyIdentity(identity.organizationId);
  const createdById = nonEmptyIdentity(identity.createdById);
  return {
    ...(agentId === undefined ? {} : { agentId }),
    ...(organizationId === undefined ? {} : { organizationId }),
    ...(createdById === undefined ? {} : { createdById }),
  };
}

function identityDisagreement(input: {
  item: ImportItemRecord;
  summary: ImportThreadSummary;
}): boolean {
  const expectedAgentId = nonEmptyIdentity(input.item.sourceAgentId);
  const actualAgentId = nonEmptyIdentity(input.summary.agentId);
  if (expectedAgentId && actualAgentId && expectedAgentId !== actualAgentId) {
    return true;
  }

  const mappedUserId = nonEmptyIdentity(
    input.item.ownershipEvidence.mappingUserId,
  );
  if (
    input.item.ownershipEvidence.classification === "mapped" &&
    mappedUserId === undefined
  ) {
    return true;
  }
  if (
    input.item.destinationUserId !== null &&
    mappedUserId !== undefined &&
    input.item.destinationUserId !== mappedUserId
  ) {
    return true;
  }
  const queriedUserId = nonEmptyIdentity(input.item.sourceUserId);
  if (mappedUserId && queriedUserId !== mappedUserId) {
    return true;
  }
  const createdById = nonEmptyIdentity(input.summary.createdById);
  if (mappedUserId && createdById && mappedUserId !== createdById) {
    return true;
  }
  return false;
}

function metadataDisagrees(
  first: ReturnType<typeof metadataFingerprint>,
  later: ReturnType<typeof metadataFingerprint>,
): boolean {
  if (first.id !== later.id) return true;
  const fields = [
    "createdById",
    "agentId",
    "organizationId",
    "lastRunAt",
    "lastUpdatedAt",
    "updatedAt",
  ] as const;
  return fields.some((field) => {
    const before = first[field];
    const after = later[field];
    // Optional source metadata may be absent on either read. Absence is not evidence
    // of an identity change; only two explicit, different values are.
    return before !== null && after !== null && before !== after;
  });
}

const SAFE_SOURCE_FAILURE_CODES = new Set([
  "origin-rejected",
  "cancelled",
  "timeout",
  "oversized",
  "malformed",
  "unauthorized",
  "forbidden",
  "not-found",
  "transient",
  "http-error",
  "redirect-refused",
  "protocol",
]);

const SAFE_RESOURCE_GAPS = new Set([
  "not-found",
  "unavailable",
  "truncated",
  "decode-error",
  "no-snapshot",
  "skipped-deltas",
  "debug-not-applicable",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function safeDiagnosticFields(value: unknown): {
  code?: string;
  status?: number;
  truncated?: boolean;
  decodeErrorRowIds?: string[];
  count?: number;
  skippedDeltas?: number;
} {
  const root = isRecord(value) ? value : {};
  const details = isRecord(root.details) ? root.details : {};
  const code = [root.code, details.code].find(
    (candidate): candidate is string =>
      typeof candidate === "string" && SAFE_SOURCE_FAILURE_CODES.has(candidate),
  );
  const status = [root.status, details.status]
    .map(safeNonNegativeInteger)
    .find(
      (candidate): candidate is number =>
        candidate !== undefined && candidate >= 100 && candidate <= 599,
    );
  const truncated =
    typeof details.truncated === "boolean" ? details.truncated : undefined;
  const decodeErrorRowIds = Array.isArray(details.decodeErrorRowIds)
    ? details.decodeErrorRowIds.filter(
        (rowId): rowId is string => typeof rowId === "string",
      )
    : undefined;
  const count = safeNonNegativeInteger(details.eventCount ?? details.count);
  const skippedDeltas = safeNonNegativeInteger(details.skippedDeltas);
  return {
    ...(code !== undefined ? { code } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(truncated !== undefined ? { truncated } : {}),
    ...(decodeErrorRowIds !== undefined ? { decodeErrorRowIds } : {}),
    ...(count !== undefined ? { count } : {}),
    ...(skippedDeltas !== undefined ? { skippedDeltas } : {}),
  };
}

function safeResourceGap(value: unknown): string {
  return typeof value === "string" && SAFE_RESOURCE_GAPS.has(value)
    ? value
    : "unavailable";
}

function eventsEvidence(
  events: Awaited<ReturnType<ConversationImportSource["getThreadEvents"]>>,
) {
  if (events.ok) {
    return {
      available: true,
      truncated: events.value.truncated,
      decodeErrorRowIds: events.value.decodeErrorRowIds,
      count: events.value.events.length,
    };
  }
  if ("gap" in events) {
    return {
      available: false,
      gap: safeResourceGap(events.gap),
      ...safeDiagnosticFields(events),
    };
  }
  return {
    available: false,
    gap: "unavailable",
    ...safeDiagnosticFields(events),
  };
}

function stateEvidence(
  state: Awaited<ReturnType<ConversationImportSource["getThreadState"]>>,
) {
  if (state.ok) {
    return {
      available: true,
      kind: state.value.kind,
      skippedDeltas:
        state.value.kind === "snapshot" ? state.value.skippedDeltas : 0,
    };
  }
  if ("gap" in state) {
    return {
      available: false,
      gap: safeResourceGap(state.gap),
      ...safeDiagnosticFields(state),
    };
  }
  return {
    available: false,
    gap: "unavailable",
    ...safeDiagnosticFields(state),
  };
}

export function createConversationImporter(deps: {
  database: Database;
  importStore: ConversationImportStore;
  conversations: ConversationStore;
}) {
  async function agentDeleted(agentId: string | null): Promise<boolean> {
    if (!agentId) return false;
    const [row] = await deps.database
      .select({ deletedAt: agentProfiles.deletedAt })
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, agentId))
      .limit(1);
    return Boolean(row?.deletedAt);
  }

  async function localAttachmentCoverage(input: {
    channelId: string | null;
    ownerUserId: string;
    messages: unknown;
  }) {
    const ids = new Set<string>();
    collectAttachmentIds(input.messages, ids);
    const missing: string[] = [];
    const verified: string[] = [];
    const staged: string[] = [];
    for (const id of ids) {
      if (!input.channelId) {
        missing.push(id);
        continue;
      }
      const [row] = await deps.database
        .select({
          id: attachments.id,
          channelId: attachments.channelId,
          attachedAt: attachments.attachedAt,
        })
        .from(attachments)
        .innerJoin(
          channels,
          and(
            eq(channels.id, attachments.channelId),
            isNull(channels.deletedAt),
          ),
        )
        .innerJoin(
          channelMemberships,
          and(
            eq(channelMemberships.channelId, attachments.channelId),
            eq(channelMemberships.userId, input.ownerUserId),
          ),
        )
        .where(
          and(
            eq(attachments.id, id),
            eq(attachments.channelId, input.channelId),
          ),
        )
        .limit(1);
      if (!row) missing.push(id);
      else if (row.attachedAt == null) staged.push(id);
      else verified.push(id);
    }
    return { referenced: [...ids], verified, missing, staged };
  }

  async function destination(threadId: string): Promise<{
    ownerUserId: string;
    localReadiness: "not_ready" | "history_only" | "ready";
  } | null> {
    const [row] = await deps.database
      .select({
        ownerUserId: conversationThreads.ownerUserId,
        localReadiness: conversationThreads.localReadiness,
      })
      .from(conversationThreads)
      .where(eq(conversationThreads.id, threadId))
      .limit(1);
    return row ?? null;
  }

  async function importOne(input: {
    actor: ImportJobActor;
    job: ImportJobRecord;
    item: ImportItemRecord;
    source: ConversationImportSource;
    approvedManifestHash: string;
    attempt: ImportAttempt;
    signal?: AbortSignal;
  }): Promise<{
    status: ImportItemRecord["status"];
    resourceGaps: boolean;
    historyOnly: boolean;
  }> {
    if (input.signal?.aborted) {
      throw new ImportJobConflictError("Import cancelled");
    }
    const job = await deps.importStore.getJob(input.actor, input.job.id);
    assertImportRunnable(job, input.approvedManifestHash);
    if (
      input.item.status === "blocked" ||
      input.item.ownershipEvidence.classification === "identity-conflict" ||
      input.item.ownershipEvidence.classification === "explicit-unowned" ||
      input.item.ownershipEvidence.classification === "unmapped"
    ) {
      await deps.importStore.markItem({
        actor: input.actor,
        jobId: job.id,
        itemId: input.item.id,
        status: "blocked",
        failureCode: input.item.ownershipEvidence.classification,
        attempt: input.attempt,
        expectedPhase: "importing",
      });
      return { status: "blocked", resourceGaps: false, historyOnly: false };
    }

    const ownerUserId = input.item.destinationUserId;
    if (!ownerUserId) {
      await deps.importStore.markItem({
        actor: input.actor,
        jobId: job.id,
        itemId: input.item.id,
        status: "blocked",
        failureCode: "unowned",
        attempt: input.attempt,
        expectedPhase: "importing",
      });
      return { status: "blocked", resourceGaps: false, historyOnly: false };
    }

    const meta = await input.source.getThread({
      threadId: input.item.sourceThreadId,
      userId: input.item.sourceUserId,
      signal: input.signal,
    });
    if (!meta.ok) {
      await deps.importStore.markItem({
        actor: input.actor,
        jobId: job.id,
        itemId: input.item.id,
        status: "failed",
        failureCode: "gap" in meta ? meta.gap : meta.code,
        attempt: input.attempt,
        expectedPhase: "importing",
      });
      return { status: "failed", resourceGaps: true, historyOnly: false };
    }
    if (identityDisagreement({ item: input.item, summary: meta.value })) {
      await deps.importStore.markItem({
        actor: input.actor,
        jobId: job.id,
        itemId: input.item.id,
        status: "blocked",
        failureCode: "identity-conflict",
        attempt: input.attempt,
        expectedPhase: "importing",
      });
      return { status: "blocked", resourceGaps: false, historyOnly: false };
    }
    const inventoryIdentity = priorSourceIdentity(input.item.coverage);
    const firstIdentity = sourceIdentity(meta.value);
    if (identityFieldsDisagree(inventoryIdentity, firstIdentity)) {
      await deps.importStore.markItem({
        actor: input.actor,
        jobId: job.id,
        itemId: input.item.id,
        status: "failed",
        failureCode: "source-changed",
        attempt: input.attempt,
        expectedPhase: "importing",
      });
      return { status: "failed", resourceGaps: true, historyOnly: false };
    }

    const first = await input.source.getThreadMessages({
      threadId: input.item.sourceThreadId,
      userId: input.item.sourceUserId,
      signal: input.signal,
    });
    if (!first.ok) {
      await deps.importStore.markItem({
        actor: input.actor,
        jobId: job.id,
        itemId: input.item.id,
        status: "failed",
        failureCode: "gap" in first ? first.gap : first.code,
        attempt: input.attempt,
        expectedPhase: "importing",
      });
      return { status: "failed", resourceGaps: true, historyOnly: false };
    }

    const validated = validateImportedMessages(first.value.messages);
    if (!validated.ok) {
      await deps.importStore.encryptItemResources({
        actor: input.actor,
        jobId: job.id,
        itemId: input.item.id,
        resources: { messages: first.value.messages, issues: validated.issues },
        attempt: input.attempt,
        expectedPhase: "importing",
      });
      await deps.importStore.markItem({
        actor: input.actor,
        jobId: job.id,
        itemId: input.item.id,
        status: "failed",
        failureCode: "validation",
        converterVersion: IMPORT_CONVERTER_VERSION,
        attempt: input.attempt,
        expectedPhase: "importing",
      });
      return { status: "failed", resourceGaps: false, historyOnly: false };
    }

    const access: { ownershipEstablished: true } = {
      ownershipEstablished: true,
    };
    const events = await input.source.getThreadEvents({
      threadId: input.item.sourceThreadId,
      access,
      signal: input.signal,
    });
    const state = await input.source.getThreadState({
      threadId: input.item.sourceThreadId,
      access,
      signal: input.signal,
    });
    const eventsCover = eventsEvidence(events);
    const stateCover = stateEvidence(state);

    let canonicalState: unknown = {};
    let skippedDeltas = 0;
    if (state.ok && state.value.kind === "snapshot") {
      skippedDeltas = state.value.skippedDeltas;
      // Raw source state is retained in the encrypted resource envelope, but arbitrary state may
      // contain old run assertions, pending approvals, or provider-specific executable context.
      // Only an explicitly inert empty plain object is safe to seed into a local continuation.
      if (isInertEmptyState(state.value.state)) canonicalState = {};
    }

    const confirmMeta = await input.source.getThread({
      threadId: input.item.sourceThreadId,
      userId: input.item.sourceUserId,
      signal: input.signal,
    });
    const confirmMessages = await input.source.getThreadMessages({
      threadId: input.item.sourceThreadId,
      userId: input.item.sourceUserId,
      signal: input.signal,
    });
    if (!confirmMeta.ok || !confirmMessages.ok) {
      await deps.importStore.markItem({
        actor: input.actor,
        jobId: job.id,
        itemId: input.item.id,
        status: "failed",
        failureCode: "source-changed",
        attempt: input.attempt,
        expectedPhase: "importing",
      });
      return { status: "failed", resourceGaps: true, historyOnly: false };
    }
    const firstMeta = metadataFingerprint(meta.value);
    const laterMeta = metadataFingerprint(confirmMeta.value);
    const hash1 = capturedContentHash(first.value.messages);
    const hash2 = capturedContentHash(confirmMessages.value.messages);
    if (
      hash1 !== hash2 ||
      metadataDisagrees(firstMeta, laterMeta) ||
      identityDisagreement({ item: input.item, summary: confirmMeta.value }) ||
      identityFieldsDisagree(firstIdentity, sourceIdentity(confirmMeta.value))
    ) {
      await deps.importStore.markItem({
        actor: input.actor,
        jobId: job.id,
        itemId: input.item.id,
        status: "failed",
        failureCode: "source-changed",
        contentHash: hash2,
        coverage: {
          sourceChanged: true,
          firstHash: hash1,
          secondHash: hash2,
          firstMeta,
          laterMeta,
        },
        attempt: input.attempt,
        expectedPhase: "importing",
      });
      return { status: "failed", resourceGaps: false, historyOnly: false };
    }
    const currentAgentComplete =
      input.item.sourceAgentId.length > 0 &&
      meta.value.agentId === input.item.sourceAgentId;

    const attachments = await localAttachmentCoverage({
      channelId: input.item.destinationChannelId,
      ownerUserId,
      messages: validated.messages,
    });

    await deps.importStore.encryptItemResources({
      actor: input.actor,
      jobId: job.id,
      itemId: input.item.id,
      resources: {
        messages: first.value.messages,
        events: events.ok
          ? events.value
          : {
              gap: "gap" in events ? events.gap : "unavailable",
              details: "details" in events ? events.details : undefined,
            },
        state: state.ok
          ? state.value
          : {
              gap: "gap" in state ? state.gap : "unavailable",
              details: "details" in state ? state.details : undefined,
            },
      },
      attempt: input.attempt,
      expectedPhase: "importing",
    });

    const existing = await deps.importStore.existingMapping(
      job.sourceNamespace,
      input.item.sourceThreadId,
    );
    if (existing) {
      const destinationThread = await destination(existing.destinationThreadId);
      const identityMatches =
        existing.contentHash === validated.contentHash &&
        existing.sourceOrigin === job.sourceOrigin &&
        existing.sourceUserId === input.item.sourceUserId &&
        destinationThread?.ownerUserId === ownerUserId;
      if (identityMatches) {
        const priorCoverage = input.item.coverage;
        const destinationReadiness =
          destinationThread?.localReadiness ?? "not_ready";
        const stateInert =
          state.ok &&
          state.value.kind === "snapshot" &&
          state.value.skippedDeltas === 0 &&
          isInertEmptyState(state.value.state);
        const resourceGaps =
          previousResourceGaps(priorCoverage) ||
          !eventsCover.available ||
          eventsCover.truncated === true ||
          (Array.isArray(eventsCover.decodeErrorRowIds) &&
            eventsCover.decodeErrorRowIds.length > 0) ||
          stateCover.kind !== "snapshot" ||
          (typeof stateCover.skippedDeltas === "number" &&
            stateCover.skippedDeltas > 0) ||
          !stateInert ||
          destinationReadiness !== "ready" ||
          attachments.missing.length > 0 ||
          attachments.staged.length > 0;
        const historyOnly =
          destinationReadiness !== "ready" ||
          input.item.coverage.localReadiness === "history_only" ||
          !currentAgentComplete ||
          !validated.continuationSafe ||
          !stateInert;
        await deps.importStore.markItem({
          actor: input.actor,
          jobId: job.id,
          itemId: input.item.id,
          status: "unchanged",
          contentHash: validated.contentHash,
          converterVersion: IMPORT_CONVERTER_VERSION,
          coverage: {
            ...priorCoverage,
            attachments,
            state: stateCover,
            events: eventsCover,
            sourceIdentity: firstIdentity,
            localReadiness: destinationReadiness,
            resourceGaps,
          },
          attempt: input.attempt,
          expectedPhase: "importing",
        });
        return { status: "unchanged", resourceGaps, historyOnly };
      }
      await deps.importStore.markItem({
        actor: input.actor,
        jobId: job.id,
        itemId: input.item.id,
        status: "blocked",
        failureCode: "destination-conflict",
        contentHash: validated.contentHash,
        attempt: input.attempt,
        expectedPhase: "importing",
      });
      return { status: "blocked", resourceGaps: false, historyOnly: false };
    }

    const deleted = await agentDeleted(input.item.sourceAgentId);
    const stateComplete =
      state.ok &&
      state.value.kind === "snapshot" &&
      skippedDeltas === 0 &&
      isInertEmptyState(state.value.state);
    const continuationReasons: string[] = [];
    if (!stateComplete) {
      continuationReasons.push(
        "Source state is not an explicitly validated inert empty snapshot.",
      );
    }
    if (!currentAgentComplete) {
      continuationReasons.push(
        "Current source coworker identity was not completely corroborated.",
      );
    }
    if (!validated.continuationSafe) {
      continuationReasons.push(
        "Messages contain an unresolved tool call or interruption.",
      );
    }
    const eventsComplete =
      events.ok &&
      !events.value.truncated &&
      events.value.decodeErrorRowIds.length === 0;
    const assetsComplete =
      attachments.missing.length === 0 && attachments.staged.length === 0;
    const localReadiness =
      deleted ||
      !stateComplete ||
      !currentAgentComplete ||
      !validated.continuationSafe
        ? "history_only"
        : "ready";
    const resourceGaps = !stateComplete || !eventsComplete || !assetsComplete;

    const destinationThreadId = input.item.sourceThreadId;
    await deps.importStore.markItem({
      actor: input.actor,
      jobId: job.id,
      itemId: input.item.id,
      status: "validated",
      contentHash: validated.contentHash,
      converterVersion: IMPORT_CONVERTER_VERSION,
      coverage: {
        attachments,
        state: stateCover,
        events: eventsCover,
        sourceIdentity: firstIdentity,
        skippedDeltas,
        continuationSafe: validated.continuationSafe,
        localReadiness,
        resourceGaps,
        ...(continuationReasons.length > 0
          ? { continuationReason: continuationReasons }
          : {}),
      },
      attempt: input.attempt,
      expectedPhase: "importing",
    });

    const liveJob = await deps.importStore.getJob(input.actor, job.id);
    assertImportRunnable(liveJob, input.approvedManifestHash);

    let published: ImportItemRecord;
    try {
      published = await deps.importStore.publishImportedThread({
        actor: input.actor,
        job,
        item: input.item,
        destinationThreadId,
        ownerUserId,
        channelId: input.item.destinationChannelId,
        agentId: input.item.sourceAgentId || null,
        localReadiness,
        messages: validated.messages,
        state: canonicalState,
        contentHash: validated.contentHash,
        converterVersion: IMPORT_CONVERTER_VERSION,
        approvedManifestHash: input.approvedManifestHash,
        attempt: input.attempt,
        expectedPhase: "importing",
      });
    } catch (error) {
      if (error instanceof ImportDestinationConflictError) {
        await deps.importStore.markItem({
          actor: input.actor,
          jobId: job.id,
          itemId: input.item.id,
          status: "blocked",
          failureCode: "destination-conflict",
          contentHash: validated.contentHash,
          attempt: input.attempt,
          expectedPhase: "importing",
        });
        return { status: "blocked", resourceGaps: false, historyOnly: false };
      }
      throw error;
    }
    return {
      status: published.status === "unchanged" ? "unchanged" : "published",
      resourceGaps,
      historyOnly: localReadiness === "history_only",
    };
  }

  return {
    async runApprovedImport(
      input: RunApprovedImportInput,
    ): Promise<ImportJobSummary> {
      const admission = await deps.importStore.acquireAttempt({
        actor: input.actor,
        jobId: input.jobId,
        kind: "run",
        approvedManifestHash: input.approvedManifestHash,
        attempt: input.attempt,
      });
      const { job, attempt } = admission;
      assertImportRunnable(job, input.approvedManifestHash);
      const operationController = new AbortController();
      const abortFromCaller = () => operationController.abort();
      if (input.signal?.aborted) operationController.abort();
      else
        input.signal?.addEventListener("abort", abortFromCaller, {
          once: true,
        });
      let leaseLost = false;
      const renewal = setInterval(() => {
        void deps.importStore
          .renewAttempt({
            actor: input.actor,
            jobId: job.id,
            attempt,
            expectedPhase: "importing",
          })
          .catch(() => {
            leaseLost = true;
            operationController.abort();
          });
      }, 10_000);

      try {
        const items = await deps.importStore.listItems(input.actor, job.id);
        const requestedItemIds = input.itemIds;
        if (requestedItemIds) {
          const known = new Set(items.map((item) => item.id));
          const unknown = requestedItemIds.filter((id) => !known.has(id));
          if (unknown.length > 0) {
            throw new ImportJobConflictError(
              "Unknown import item ids were requested",
            );
          }
        }
        const selected = requestedItemIds
          ? items.filter(
              (item) =>
                requestedItemIds.includes(item.id) &&
                item.status !== "excluded",
            )
          : items.filter((item) => item.status !== "excluded");
        const excludedCount = requestedItemIds
          ? items.filter((item) => !requestedItemIds.includes(item.id)).length
          : items.filter((item) => item.status === "excluded").length;

        const counts = {
          selected: selected.length,
          published: 0,
          unchanged: 0,
          blocked: 0,
          failed: 0,
          excluded: excludedCount,
          sourceChanged: 0,
        };
        let resourceGaps = false;
        let historyOnly = false;

        try {
          for (const item of selected) {
            if (operationController.signal.aborted) break;
            const result = await importOne({
              actor: input.actor,
              job,
              item,
              source: input.source,
              approvedManifestHash: input.approvedManifestHash,
              attempt,
              signal: operationController.signal,
            });
            if (result.status === "published") counts.published += 1;
            else if (result.status === "unchanged") counts.unchanged += 1;
            else if (result.status === "blocked") counts.blocked += 1;
            else if (result.status === "failed") {
              counts.failed += 1;
              const latest = await deps.importStore.getItem(
                input.actor,
                job.id,
                item.id,
              );
              if (latest.failureCode === "source-changed")
                counts.sourceChanged += 1;
            }
            if (result.resourceGaps) resourceGaps = true;
            if (result.historyOnly) historyOnly = true;
          }
        } catch (error) {
          const live = await deps.importStore.getJob(input.actor, job.id);
          if (
            live.phase === "cancelled" ||
            (error instanceof ImportJobConflictError &&
              /cancel/i.test(error.message))
          ) {
            return {
              jobId: job.id,
              phase: "cancelled",
              counts,
              coverage: { cancelled: true },
            };
          }
          if (leaseLost) {
            throw new ImportJobConflictError(
              "The import attempt lease was lost",
            );
          }
          throw error;
        }

        const live = await deps.importStore.getJob(input.actor, job.id);
        if (live.phase === "cancelled") {
          return {
            jobId: job.id,
            phase: "cancelled",
            counts,
            coverage: { cancelled: true },
          };
        }

        const inventoryIncomplete =
          !job.manifest.inventoryCompleteForDeclaredScope;
        const itemIssues =
          counts.failed + counts.blocked > 0 ||
          operationController.signal.aborted;
        const phase =
          inventoryIncomplete || itemIssues || resourceGaps || historyOnly
            ? "completed_with_gaps"
            : "completed";
        const updated = await deps.importStore.updatePhase(
          input.actor,
          job.id,
          phase,
          {
            attempt,
            expectedPhase: "importing",
            approvedManifestHash: input.approvedManifestHash,
            expectedInventoryRevision: job.manifest.inventoryRevision,
          },
        );
        return {
          jobId: job.id,
          phase: updated.phase,
          counts,
          coverage: {
            declaredPairs: job.scope.explicitPairs.length,
            selected: counts.selected,
            excluded: counts.excluded,
            inventoryCompleteForDeclaredScope:
              job.manifest.inventoryCompleteForDeclaredScope,
            resourceGaps,
            historyOnly,
          },
        };
      } finally {
        clearInterval(renewal);
        input.signal?.removeEventListener("abort", abortFromCaller);
      }
    },
  };
}

export type ConversationImporter = ReturnType<
  typeof createConversationImporter
>;
