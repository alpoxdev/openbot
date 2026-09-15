import { and, desc, eq, gt, ne, sql } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "../credentials";
import type { Database } from "../db/client";
import {
  conversationBaselines,
  conversationImportItems,
  conversationImportJobs,
  conversationImportMappings,
  conversationThreads,
} from "../db/schema";
import {
  type DatabaseExecutor,
  type ImportActorAgentPair,
  type ImportExplicitId,
  type ImportInventoryCheckpoint,
  type ImportInventoryOwnershipEvidence,
  type ImportInventoryThread,
  runImportInventory,
} from "./import-inventory";
import type { ConversationImportSource } from "./import-source";
import { capturedContentHash } from "./import-validation";
import {
  observeConversation,
  type ConversationObservationGap,
  type ConversationObserver,
} from "./observability";

export type ImportJobPhase =
  | "inventory"
  | "awaiting_confirmation"
  | "importing"
  | "paused"
  | "cancelled"
  | "completed"
  | "completed_with_gaps"
  | "failed";

export type ImportItemStatus =
  | "discovered"
  | "staged"
  | "validated"
  | "published"
  | "unchanged"
  | "blocked"
  | "failed"
  | "excluded";

export type ImportJobActor = {
  id: string;
  role: "admin" | "user";
};

export type ImportAttemptKind = "inventory" | "run";

/** The token is immutable for one admitted operation; its lease is renewed in the job row. */
export type ImportAttempt = {
  token: string;
  kind: ImportAttemptKind;
};

export type ImportAttemptStatus = "none" | "active" | "expired";

export type ImportJobScope = {
  explicitPairs: ImportActorAgentPair[];
  explicitIds: ImportExplicitId[];
  sourceReference: string;
};

export type ImportJobManifest = {
  schemaVersion: number;
  /** Monotonic evidence generation; changes on every persisted inventory progress snapshot. */
  inventoryRevision: number;
  sourceNamespace: string;
  sourceOrigin: string;
  sourceReference: string;
  inventoryCompleteForDeclaredScope: boolean;
  pairCount: number;
  threadCount: number;
  notes: string[];
};

export type ImportJobRecord = {
  id: string;
  requestedBy: string;
  sourceNamespace: string;
  sourceOrigin: string;
  sourceReference: string;
  phase: ImportJobPhase;
  scope: ImportJobScope;
  manifest: ImportJobManifest;
  approvedManifestHash: string | null;
  checkpoint: ImportInventoryCheckpoint;
  attemptToken: string | null;
  attemptKind: ImportAttemptKind | null;
  attemptLeaseExpiresAt: Date | null;
  attemptStatus: ImportAttemptStatus;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ImportItemRecord = {
  id: string;
  jobId: string;
  sourceThreadId: string;
  sourceUserId: string;
  sourceAgentId: string;
  destinationUserId: string | null;
  destinationChannelId: string | null;
  status: ImportItemStatus;
  ownershipEvidence: ImportInventoryOwnershipEvidence;
  coverage: Record<string, unknown>;
  contentHash: string | null;
  converterVersion: number;
  capturedAt: Date | null;
  publishedAt: Date | null;
  failureCode: string | null;
  hasEncryptedResources: boolean;
};

export class ImportJobAccessError extends Error {
  constructor(message = "Import job is not visible to this actor") {
    super(message);
    this.name = "ImportJobAccessError";
  }
}

export class ImportJobConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportJobConflictError";
  }
}

export class ImportDestinationConflictError extends ImportJobConflictError {
  constructor(message = "Import destination is already claimed") {
    super(message);
    this.name = "ImportDestinationConflictError";
  }
}

export class ImportJobNotFoundError extends Error {
  constructor(message = "Import job was not found") {
    super(message);
    this.name = "ImportJobNotFoundError";
  }
}

const RESOURCE_DOMAIN = "conversation-import-resource";
const IMPORT_ATTEMPT_LEASE_MS = 30_000;

function attemptFromRow(
  row: typeof conversationImportJobs.$inferSelect,
): ImportAttempt | null {
  if (
    !row.attemptToken ||
    (row.attemptKind !== "inventory" && row.attemptKind !== "run")
  ) {
    return null;
  }
  return { token: row.attemptToken, kind: row.attemptKind };
}

function attemptPredicate(
  jobId: string,
  attempt: ImportAttempt,
  expectedPhase?: ImportJobPhase,
) {
  return and(
    eq(conversationImportJobs.id, jobId),
    eq(conversationImportJobs.attemptToken, attempt.token),
    eq(conversationImportJobs.attemptKind, attempt.kind),
    gt(conversationImportJobs.attemptLeaseExpiresAt, sql`clock_timestamp()`),
    expectedPhase ? eq(conversationImportJobs.phase, expectedPhase) : undefined,
  );
}

type EncryptedResourcePayload = {
  domain: typeof RESOURCE_DOMAIN;
  jobId: string;
  itemId: string;
  resources: unknown;
};

function asScope(value: unknown): ImportJobScope {
  const record = value as ImportJobScope;
  return {
    explicitPairs: Array.isArray(record.explicitPairs)
      ? record.explicitPairs
      : [],
    explicitIds: Array.isArray(record.explicitIds) ? record.explicitIds : [],
    sourceReference:
      typeof record.sourceReference === "string" ? record.sourceReference : "",
  };
}

function asManifest(value: unknown): ImportJobManifest {
  const record = value as Partial<ImportJobManifest>;
  return {
    schemaVersion: record.schemaVersion ?? 1,
    inventoryRevision:
      typeof record.inventoryRevision === "number" &&
      Number.isSafeInteger(record.inventoryRevision) &&
      record.inventoryRevision >= 0
        ? record.inventoryRevision
        : 0,
    sourceNamespace: record.sourceNamespace ?? "",
    sourceOrigin: record.sourceOrigin ?? "",
    sourceReference: record.sourceReference ?? "",
    inventoryCompleteForDeclaredScope: Boolean(
      record.inventoryCompleteForDeclaredScope,
    ),
    pairCount: record.pairCount ?? 0,
    threadCount: record.threadCount ?? 0,
    notes: record.notes ?? [],
  };
}

function asCheckpoint(value: unknown): ImportInventoryCheckpoint {
  const record = value as ImportInventoryCheckpoint;
  return {
    pairs: Array.isArray(record.pairs) ? record.pairs : [],
    probes: Array.isArray(record.probes) ? record.probes : [],
  };
}

function asOwnership(value: unknown): ImportInventoryOwnershipEvidence {
  const record = value as ImportInventoryOwnershipEvidence;
  return {
    classification: record.classification ?? "unmapped",
    mappingUserId: record.mappingUserId,
    mappingChannelId: record.mappingChannelId,
    mappingThreadId: record.mappingThreadId,
    notes: record.notes ?? [],
  };
}

function asJob(
  row: typeof conversationImportJobs.$inferSelect,
  dbNow: Date,
): ImportJobRecord {
  return {
    id: row.id,
    requestedBy: row.requestedBy,
    sourceNamespace: row.sourceNamespace,
    sourceOrigin: row.sourceOrigin,
    sourceReference: row.sourceReference,
    phase: row.phase,
    scope: asScope(row.scope),
    manifest: asManifest(row.manifest),
    approvedManifestHash: row.approvedManifestHash,
    checkpoint: asCheckpoint(row.checkpoint),
    attemptToken: row.attemptToken,
    attemptKind:
      row.attemptKind === "inventory" || row.attemptKind === "run"
        ? row.attemptKind
        : null,
    attemptLeaseExpiresAt: row.attemptLeaseExpiresAt,
    attemptStatus:
      row.attemptToken && row.attemptLeaseExpiresAt
        ? row.attemptLeaseExpiresAt.getTime() > dbNow.getTime()
          ? "active"
          : "expired"
        : "none",
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function databaseClock(
  executor: Pick<Database, "select">,
): Promise<Date> {
  const [row] = await executor
    .select({ now: sql<string>`clock_timestamp()::text` })
    .from(sql`(select 1) as clock`);
  const now = new Date(row?.now ?? "");
  if (!Number.isFinite(now.getTime())) {
    throw new ImportJobConflictError("Database clock is unavailable");
  }
  return now;
}

function asItem(
  row: typeof conversationImportItems.$inferSelect,
): ImportItemRecord {
  return {
    id: row.id,
    jobId: row.jobId,
    sourceThreadId: row.sourceThreadId,
    sourceUserId: row.sourceUserId,
    sourceAgentId: row.sourceAgentId,
    destinationUserId: row.destinationUserId,
    destinationChannelId: row.destinationChannelId,
    status: row.status,
    ownershipEvidence: asOwnership(row.ownershipEvidence),
    coverage: (row.coverage as Record<string, unknown>) ?? {},
    contentHash: row.contentHash,
    converterVersion: row.converterVersion,
    capturedAt: row.capturedAt,
    publishedAt: row.publishedAt,
    failureCode: row.failureCode,
    hasEncryptedResources: Boolean(row.encryptedResources),
  };
}

function emptyManifest(input: {
  sourceNamespace: string;
  sourceOrigin: string;
  sourceReference: string;
}): ImportJobManifest {
  return {
    schemaVersion: 1,
    inventoryRevision: 0,
    sourceNamespace: input.sourceNamespace,
    sourceOrigin: input.sourceOrigin,
    sourceReference: input.sourceReference,
    inventoryCompleteForDeclaredScope: false,
    pairCount: 0,
    threadCount: 0,
    notes: [],
  };
}

function assertAdminRequester(actor: ImportJobActor) {
  if (actor.role !== "admin") {
    throw new ImportJobAccessError(
      "Only an administrator may run an import job",
    );
  }
}

function phaseOutcome(
  phase: ImportJobPhase,
):
  | "progress"
  | "validated"
  | "started"
  | "paused"
  | "cancelled"
  | "completed"
  | "failed" {
  switch (phase) {
    case "inventory":
      return "progress";
    case "awaiting_confirmation":
      return "validated";
    case "importing":
      return "started";
    case "paused":
      return "paused";
    case "cancelled":
      return "cancelled";
    case "completed":
    case "completed_with_gaps":
      return "completed";
    case "failed":
      return "failed";
  }
}

function inventoryGap(reason: string): ConversationObservationGap {
  if (/cancelled/i.test(reason)) return "stop";
  if (/page cap|paused/i.test(reason)) return "truncated";
  if (/cycle/i.test(reason)) return "source-changed";
  if (/ownership|unowned|identity/i.test(reason)) return "ownership";
  if (/not[- ]found/i.test(reason)) return "not-found";
  return "unavailable";
}

function resourceGap(value: unknown): ConversationObservationGap | undefined {
  switch (value) {
    case "not-found":
    case "unavailable":
    case "truncated":
    case "decode-error":
    case "no-snapshot":
    case "skipped-deltas":
    case "debug-not-applicable":
    case "missing-asset":
    case "ownership":
    case "source-changed":
    case "history-only":
      return value;
    default:
      return undefined;
  }
}

function sourceFailureGap(
  value: unknown,
): ConversationObservationGap | undefined {
  switch (value) {
    case "cancelled":
      return "stop";
    case "oversized":
      return "truncated";
    case "malformed":
    case "protocol":
      return "decode-error";
    case "origin-rejected":
    case "timeout":
    case "unauthorized":
    case "forbidden":
    case "transient":
    case "http-error":
    case "redirect-refused":
      return "unavailable";
    default:
      return undefined;
  }
}

function emitResourceGapObservations(
  observer: ConversationObserver | undefined,
  jobId: string,
  phase: ImportJobPhase,
  coverage: Record<string, unknown> | undefined,
) {
  if (!coverage) return;
  let emitted = false;
  const emit = (gap: ConversationObservationGap, count = 1) => {
    emitted = true;
    observeConversation(observer, {
      subsystem: "import",
      operation: "import",
      outcome: "progress",
      phase,
      correlation: { jobId },
      gap,
      count,
    });
  };

  const attachments = coverage.attachments;
  if (
    attachments &&
    typeof attachments === "object" &&
    !Array.isArray(attachments)
  ) {
    const record = attachments as Record<string, unknown>;
    const missing = Array.isArray(record.missing) ? record.missing.length : 0;
    const staged = Array.isArray(record.staged) ? record.staged.length : 0;
    if (missing + staged > 0) emit("missing-asset", missing + staged);
  }

  const events = coverage.events;
  if (events && typeof events === "object" && !Array.isArray(events)) {
    const record = events as Record<string, unknown>;
    if (record.available !== true) {
      emit(resourceGap(record.gap) ?? "unavailable");
    }
    if (record.truncated === true) emit("truncated");
    if (
      Array.isArray(record.decodeErrorRowIds) &&
      record.decodeErrorRowIds.length > 0
    )
      emit("decode-error", record.decodeErrorRowIds.length);
  }

  const state = coverage.state;
  if (state && typeof state === "object" && !Array.isArray(state)) {
    const record = state as Record<string, unknown>;
    if (record.available !== true) {
      emit(resourceGap(record.gap) ?? "unavailable");
    }
    if (
      record.kind === "snapshot" &&
      typeof record.skippedDeltas === "number" &&
      Number.isSafeInteger(record.skippedDeltas) &&
      record.skippedDeltas > 0
    ) {
      emit("skipped-deltas", record.skippedDeltas);
    }
  }

  if (coverage.sourceChanged === true) emit("source-changed");
  if (coverage.localReadiness === "history_only") emit("history-only");
  if (coverage.resourceGaps === true && !emitted) emit("unavailable");
}

function emitItemObservation(
  observer: ConversationObserver | undefined,
  input: {
    jobId: string;
    phase: ImportJobPhase;
    status: ImportItemStatus;
    failureCode: string | null;
    coverage?: Record<string, unknown>;
  },
) {
  let operation: "import" | "publication" = "import";
  let outcome:
    | "discovered"
    | "staged"
    | "validated"
    | "published"
    | "unchanged"
    | "blocked"
    | "failed"
    | "excluded"
    | "sourceChanged"
    | "conflict" = input.status;
  if (input.status === "published" || input.status === "unchanged") {
    operation = "publication";
  }
  if (input.status === "failed" && input.failureCode === "source-changed") {
    outcome = "sourceChanged";
  }
  if (
    input.status === "blocked" &&
    input.failureCode === "destination-conflict"
  ) {
    operation = "publication";
    outcome = "conflict";
  }
  const failureGap =
    input.failureCode === "source-changed"
      ? "source-changed"
      : input.failureCode === "identity-conflict" ||
          input.failureCode === "explicit-unowned" ||
          input.failureCode === "probe-not-found" ||
          input.failureCode === "unowned"
        ? "ownership"
        : (resourceGap(input.failureCode) ??
          sourceFailureGap(input.failureCode));
  observeConversation(observer, {
    subsystem: "import",
    operation,
    outcome,
    phase: input.phase,
    correlation: { jobId: input.jobId },
    count: 1,
    ...(failureGap === undefined ? {} : { gap: failureGap }),
  });
  emitResourceGapObservations(
    observer,
    input.jobId,
    input.phase,
    input.coverage,
  );
}

export function createConversationImportStore(
  database: Database,
  options: { encryptionKey: string; observe?: ConversationObserver },
) {
  async function requireJob(actor: ImportJobActor, jobId: string) {
    const [row] = await database
      .select()
      .from(conversationImportJobs)
      .where(eq(conversationImportJobs.id, jobId))
      .limit(1);
    if (!row) throw new ImportJobNotFoundError();
    if (row.requestedBy !== actor.id) throw new ImportJobAccessError();
    return asJob(row, await databaseClock(database));
  }

  return {
    async acquireAttempt(input: {
      actor: ImportJobActor;
      jobId: string;
      kind: ImportAttemptKind;
      approvedManifestHash?: string;
      attempt?: ImportAttempt;
    }): Promise<{ job: ImportJobRecord; attempt: ImportAttempt }> {
      assertAdminRequester(input.actor);
      const admitted = await database.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(conversationImportJobs)
          .where(eq(conversationImportJobs.id, input.jobId))
          .for("update")
          .limit(1);
        if (!row) throw new ImportJobNotFoundError();
        if (row.requestedBy !== input.actor.id)
          throw new ImportJobAccessError();
        const dbNow = await databaseClock(tx);
        const current = asJob(row, dbNow);
        const currentAttempt = attemptFromRow(row);
        const currentActive =
          currentAttempt !== null &&
          row.attemptLeaseExpiresAt !== null &&
          row.attemptLeaseExpiresAt.getTime() > dbNow.getTime();

        if (input.attempt) {
          if (
            !currentActive ||
            !currentAttempt ||
            currentAttempt.token !== input.attempt.token ||
            currentAttempt.kind !== input.attempt.kind ||
            input.attempt.kind !== input.kind
          ) {
            throw new ImportJobConflictError(
              "The import attempt is no longer the active database owner",
            );
          }
          if (
            current.phase !==
            (input.kind === "inventory" ? "inventory" : "importing")
          ) {
            throw new ImportJobConflictError(
              "The import attempt is not in its active phase",
            );
          }
          return { job: current, attempt: currentAttempt };
        }

        if (currentActive) {
          throw new ImportJobConflictError(
            "Another authorized import attempt currently owns this job",
          );
        }
        const hasCurrentApprovedManifest =
          Boolean(input.approvedManifestHash) &&
          current.approvedManifestHash === input.approvedManifestHash &&
          current.manifest.inventoryCompleteForDeclaredScope &&
          capturedContentHash(current.manifest) === input.approvedManifestHash;
        const allowed =
          input.kind === "inventory"
            ? current.phase === "inventory" ||
              current.phase === "paused" ||
              current.phase === "awaiting_confirmation" ||
              current.phase === "failed"
            : current.phase === "awaiting_confirmation" ||
              current.phase === "importing" ||
              current.phase === "completed" ||
              current.phase === "completed_with_gaps" ||
              ((current.phase === "failed" || current.phase === "paused") &&
                hasCurrentApprovedManifest);
        if (!allowed) {
          throw new ImportJobConflictError(
            `Job phase ${current.phase} cannot ${input.kind}`,
          );
        }
        if (input.kind === "run" && !hasCurrentApprovedManifest) {
          throw new ImportJobConflictError(
            "Approved manifest hash does not match the current inventory",
          );
        }
        const attempt: ImportAttempt = {
          token: crypto.randomUUID(),
          kind: input.kind,
        };
        const [started] = await tx
          .update(conversationImportJobs)
          .set({
            phase: input.kind === "inventory" ? "inventory" : "importing",
            approvedManifestHash:
              input.kind === "inventory" ? null : current.approvedManifestHash,
            attemptToken: attempt.token,
            attemptKind: attempt.kind,
            attemptLeaseExpiresAt: sql`clock_timestamp() + interval '30 seconds'`,
            updatedAt: sql`clock_timestamp()`,
            version: sql`${conversationImportJobs.version} + 1`,
          })
          .where(
            and(
              eq(conversationImportJobs.id, input.jobId),
              eq(conversationImportJobs.version, row.version),
            ),
          )
          .returning();
        if (!started) {
          throw new ImportJobConflictError(
            "Import job changed before the attempt was admitted",
          );
        }
        return { job: asJob(started, await databaseClock(tx)), attempt };
      });
      if (!input.attempt) {
        observeConversation(options.observe, {
          subsystem: "import",
          operation: input.kind === "inventory" ? "inventory" : "import",
          outcome: "started",
          phase: admitted.job.phase,
          correlation: { jobId: input.jobId },
        });
      }
      return admitted;
    },

    async renewAttempt(input: {
      actor: ImportJobActor;
      jobId: string;
      attempt: ImportAttempt;
      expectedPhase: ImportJobPhase;
    }): Promise<ImportAttempt> {
      assertAdminRequester(input.actor);
      const [updated] = await database
        .update(conversationImportJobs)
        .set({
          attemptLeaseExpiresAt: sql`clock_timestamp() + interval '30 seconds'`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            attemptPredicate(input.jobId, input.attempt, input.expectedPhase),
            eq(conversationImportJobs.requestedBy, input.actor.id),
          ),
        )
        .returning();
      if (!updated) {
        throw new ImportJobConflictError(
          "The import attempt lease is no longer valid",
        );
      }
      return input.attempt;
    },

    async createJob(input: {
      actor: ImportJobActor;
      sourceNamespace: string;
      sourceOrigin: string;
      sourceReference: string;
      explicitPairs: ImportActorAgentPair[];
      explicitIds?: ImportExplicitId[];
    }): Promise<ImportJobRecord> {
      assertAdminRequester(input.actor);
      const scope: ImportJobScope = {
        explicitPairs: input.explicitPairs,
        explicitIds: input.explicitIds ?? [],
        sourceReference: input.sourceReference,
      };
      const [row] = await database
        .insert(conversationImportJobs)
        .values({
          requestedBy: input.actor.id,
          sourceNamespace: input.sourceNamespace,
          sourceOrigin: input.sourceOrigin,
          sourceReference: input.sourceReference,
          phase: "inventory",
          scope,
          manifest: emptyManifest(input),
          checkpoint: { pairs: [], probes: [] },
        })
        .returning();
      const job = asJob(row, await databaseClock(database));
      observeConversation(options.observe, {
        subsystem: "import",
        operation: "import",
        outcome: "started",
        phase: job.phase,
        correlation: { jobId: job.id },
      });
      return job;
    },

    async getJob(
      actor: ImportJobActor,
      jobId: string,
    ): Promise<ImportJobRecord> {
      assertAdminRequester(actor);
      return requireJob(actor, jobId);
    },

    async listJobs(actor: ImportJobActor): Promise<ImportJobRecord[]> {
      assertAdminRequester(actor);
      const rows = await database
        .select()
        .from(conversationImportJobs)
        .where(eq(conversationImportJobs.requestedBy, actor.id))
        .orderBy(desc(conversationImportJobs.createdAt));
      const now = await databaseClock(database);
      return rows.map((row) => asJob(row, now));
    },

    async updatePhase(
      actor: ImportJobActor,
      jobId: string,
      phase: ImportJobPhase,
      phaseOptions:
        | {
            attempt: ImportAttempt;
            expectedPhase: ImportJobPhase;
            approvedManifestHash?: string;
            expectedInventoryRevision?: number;
          }
        | undefined = undefined,
    ): Promise<ImportJobRecord> {
      assertAdminRequester(actor);
      if (phase === "cancelled") {
        const result = await database.transaction(async (tx) => {
          const [row] = await tx
            .select()
            .from(conversationImportJobs)
            .where(
              and(
                eq(conversationImportJobs.id, jobId),
                eq(conversationImportJobs.requestedBy, actor.id),
              ),
            )
            .for("update")
            .limit(1);
          if (!row) throw new ImportJobNotFoundError();
          if (row.phase === "cancelled") {
            return {
              job: asJob(row, await databaseClock(tx)),
              changed: false,
            };
          }
          const [updated] = await tx
            .update(conversationImportJobs)
            .set({
              phase: "cancelled",
              attemptToken: null,
              attemptKind: null,
              attemptLeaseExpiresAt: null,
              updatedAt: new Date(),
              version: sql`${conversationImportJobs.version} + 1`,
            })
            .where(
              and(
                eq(conversationImportJobs.id, jobId),
                eq(conversationImportJobs.requestedBy, actor.id),
                ne(conversationImportJobs.phase, "cancelled"),
              ),
            )
            .returning();
          if (!updated)
            throw new ImportJobConflictError(
              "Import job was cancelled concurrently",
            );
          return {
            job: asJob(updated, await databaseClock(tx)),
            changed: true,
          };
        });
        if (result.changed) {
          observeConversation(options.observe, {
            subsystem: "import",
            operation: "import",
            outcome: "cancelled",
            phase: result.job.phase,
            correlation: { jobId },
          });
        }
        return result.job;
      }
      if (!phaseOptions) {
        throw new ImportJobConflictError(
          "A valid database import attempt is required",
        );
      }
      if (
        (phase === "completed" || phase === "completed_with_gaps") &&
        (!phaseOptions.approvedManifestHash ||
          phaseOptions.expectedInventoryRevision === undefined)
      ) {
        throw new ImportJobConflictError(
          "Import finalization requires the approved manifest hash and inventory revision",
        );
      }
      const [row] = await database
        .update(conversationImportJobs)
        .set({
          phase,
          attemptToken: null,
          attemptKind: null,
          attemptLeaseExpiresAt: null,
          updatedAt: sql`clock_timestamp()`,
          version: sql`${conversationImportJobs.version} + 1`,
        })
        .where(
          and(
            attemptPredicate(
              jobId,
              phaseOptions.attempt,
              phaseOptions.expectedPhase,
            ),
            eq(conversationImportJobs.requestedBy, actor.id),
            phaseOptions.approvedManifestHash
              ? eq(
                  conversationImportJobs.approvedManifestHash,
                  phaseOptions.approvedManifestHash,
                )
              : undefined,
            phaseOptions.expectedInventoryRevision !== undefined
              ? sql`${conversationImportJobs.manifest}->>'inventoryRevision' = ${String(phaseOptions.expectedInventoryRevision)}`
              : undefined,
          ),
        )
        .returning();
      if (!row) {
        throw new ImportJobConflictError(
          "The import attempt lease or expected phase is no longer valid",
        );
      }
      const job = asJob(row, await databaseClock(database));
      observeConversation(options.observe, {
        subsystem: "import",
        operation: "import",
        outcome: phaseOutcome(job.phase),
        phase: job.phase,
        correlation: { jobId },
      });
      return job;
    },

    async approveManifest(
      actor: ImportJobActor,
      jobId: string,
      manifestHash: string,
    ): Promise<ImportJobRecord> {
      assertAdminRequester(actor);
      const approved = await database.transaction(async (tx) => {
        // Approval and inventory both lock the job row. This makes the phase/hash check one
        // atomic decision: an approval cannot race a progress commit and bless its old manifest.
        const [row] = await tx
          .select()
          .from(conversationImportJobs)
          .where(eq(conversationImportJobs.id, jobId))
          .for("update")
          .limit(1);
        if (!row) throw new ImportJobNotFoundError();
        if (row.requestedBy !== actor.id) throw new ImportJobAccessError();
        const job = asJob(row, await databaseClock(tx));
        if (job.attemptStatus === "active") {
          throw new ImportJobConflictError(
            "Manifest cannot be approved while an import attempt is active",
          );
        }
        if (job.phase !== "awaiting_confirmation") {
          throw new ImportJobConflictError(
            "Manifest can only be approved while awaiting confirmation",
          );
        }
        if (!job.manifest.inventoryCompleteForDeclaredScope) {
          throw new ImportJobConflictError(
            "Manifest cannot be approved until inventory is complete",
          );
        }
        const current = capturedContentHash(job.manifest);
        if (current !== manifestHash) {
          throw new ImportJobConflictError(
            "Approved hash does not match the stored manifest",
          );
        }
        const [updated] = await tx
          .update(conversationImportJobs)
          .set({
            approvedManifestHash: manifestHash,
            attemptToken: null,
            attemptKind: null,
            attemptLeaseExpiresAt: null,
            updatedAt: new Date(),
            version: sql`${conversationImportJobs.version} + 1`,
          })
          .where(
            and(
              eq(conversationImportJobs.id, jobId),
              eq(conversationImportJobs.phase, "awaiting_confirmation"),
            ),
          )
          .returning();
        if (!updated) {
          throw new ImportJobConflictError(
            "Manifest can only be approved while awaiting confirmation",
          );
        }
        return asJob(updated, await databaseClock(tx));
      });
      observeConversation(options.observe, {
        subsystem: "import",
        operation: "import",
        outcome: "validated",
        phase: approved.phase,
        correlation: { jobId },
      });
      return approved;
    },

    async cancelJob(
      actor: ImportJobActor,
      jobId: string,
    ): Promise<ImportJobRecord> {
      return this.updatePhase(actor, jobId, "cancelled");
    },

    async listItems(
      actor: ImportJobActor,
      jobId: string,
    ): Promise<ImportItemRecord[]> {
      assertAdminRequester(actor);
      await requireJob(actor, jobId);
      const rows = await database
        .select()
        .from(conversationImportItems)
        .where(eq(conversationImportItems.jobId, jobId));
      return rows.map(asItem);
    },

    async runInventory(input: {
      actor: ImportJobActor;
      jobId: string;
      source: ConversationImportSource;
      signal?: AbortSignal;
      attempt?: ImportAttempt;
    }): Promise<{
      job: ImportJobRecord;
      items: ImportItemRecord[];
      attempt: ImportAttempt;
    }> {
      assertAdminRequester(input.actor);
      const admission = await this.acquireAttempt({
        actor: input.actor,
        jobId: input.jobId,
        kind: "inventory",
        attempt: input.attempt,
      });
      const { job, attempt } = admission;
      const operationController = new AbortController();
      const abortFromCaller = () => operationController.abort();
      if (input.signal?.aborted) operationController.abort();
      else
        input.signal?.addEventListener("abort", abortFromCaller, {
          once: true,
        });
      let leaseLost = false;
      const renewal = setInterval(
        () => {
          void this.renewAttempt({
            actor: input.actor,
            jobId: input.jobId,
            attempt,
            expectedPhase: "inventory",
          }).catch(() => {
            leaseLost = true;
            operationController.abort();
          });
        },
        Math.floor(IMPORT_ATTEMPT_LEASE_MS / 3),
      );

      const persistProgress = async (
        snapshot: Awaited<ReturnType<typeof runImportInventory>>,
        final = false,
      ) => {
        await database.transaction(async (tx) => {
          // Serialize inventory evidence with publication. Without taking the job lock before
          // touching item rows, a publisher holding the job while updating an item could deadlock
          // with an inventory page holding that item while clearing the approval below.
          const [live] = await tx
            .select()
            .from(conversationImportJobs)
            .where(
              and(
                attemptPredicate(job.id, attempt, "inventory"),
                eq(conversationImportJobs.requestedBy, input.actor.id),
              ),
            )
            .for("update");
          if (!live) {
            throw new ImportJobConflictError(
              "The inventory attempt lease or phase is no longer valid",
            );
          }
          const liveManifest = asManifest(live.manifest);
          for (const thread of snapshot.threads) {
            await upsertDiscoveredItem(tx, job, thread);
          }
          const existingItems = await tx
            .select({ sourceThreadId: conversationImportItems.sourceThreadId })
            .from(conversationImportItems)
            .where(eq(conversationImportItems.jobId, job.id));
          const threadIds = new Set(
            existingItems.map((row) => row.sourceThreadId),
          );
          for (const thread of snapshot.threads)
            threadIds.add(thread.sourceThreadId);
          const complete = snapshot.inventoryCompleteForDeclaredScope;
          const manifest: ImportJobManifest = {
            schemaVersion: 1,
            inventoryRevision: liveManifest.inventoryRevision + 1,
            sourceNamespace: job.sourceNamespace,
            sourceOrigin: job.sourceOrigin,
            sourceReference: job.sourceReference,
            inventoryCompleteForDeclaredScope: complete,
            pairCount: snapshot.checkpoint.pairs.length,
            threadCount: threadIds.size,
            notes: snapshot.gaps.map((gap) => {
              if (gap.pair)
                return `${gap.pair.userId}/${gap.pair.agentId}: ${gap.reason}`;
              if (gap.threadId) return `${gap.threadId}: ${gap.reason}`;
              return gap.reason;
            }),
          };
          const [updated] = await tx
            .update(conversationImportJobs)
            .set({
              checkpoint: snapshot.checkpoint,
              manifest,
              // Inventory is the evidence the administrator approved. A new page (including a
              // resumed page after a partial failure) changes that evidence, so an earlier approval
              // must never remain usable against the new manifest.
              approvedManifestHash: null,
              phase: complete
                ? "awaiting_confirmation"
                : final
                  ? "paused"
                  : "inventory",
              ...(final
                ? {
                    attemptToken: null,
                    attemptKind: null,
                    attemptLeaseExpiresAt: null,
                  }
                : {}),
              updatedAt: new Date(),
              version: sql`${conversationImportJobs.version} + 1`,
            })
            .where(
              and(
                eq(conversationImportJobs.id, job.id),
                eq(conversationImportJobs.requestedBy, input.actor.id),
                eq(conversationImportJobs.phase, "inventory"),
                eq(conversationImportJobs.attemptToken, attempt.token),
                eq(conversationImportJobs.attemptKind, attempt.kind),
                gt(
                  conversationImportJobs.attemptLeaseExpiresAt,
                  sql`clock_timestamp()`,
                ),
              ),
            )
            .returning();
          if (!updated) {
            throw new ImportJobConflictError(
              "The inventory attempt lease or phase is no longer valid",
            );
          }
        });
        const phase: ImportJobPhase = snapshot.inventoryCompleteForDeclaredScope
          ? "awaiting_confirmation"
          : final
            ? "paused"
            : "inventory";
        const pages = snapshot.checkpoint.pairs.reduce(
          (total, pair) => total + pair.pageCount,
          0,
        );
        const pairs = snapshot.checkpoint.pairs.length;
        const discovered = snapshot.threads.length;
        observeConversation(options.observe, {
          subsystem: "import",
          operation: "inventory",
          outcome: "progress",
          phase,
          correlation: { jobId: job.id },
          count: discovered,
        });
        observeConversation(options.observe, {
          subsystem: "import",
          operation: "inventory",
          outcome: "pages",
          phase,
          correlation: { jobId: job.id },
          count: pages,
        });
        observeConversation(options.observe, {
          subsystem: "import",
          operation: "inventory",
          outcome: "pairs",
          phase,
          correlation: { jobId: job.id },
          count: pairs,
        });
        observeConversation(options.observe, {
          subsystem: "import",
          operation: "inventory",
          outcome: "discovered",
          phase,
          correlation: { jobId: job.id },
          count: discovered,
        });
        for (const gap of snapshot.gaps) {
          observeConversation(options.observe, {
            subsystem: "import",
            operation: "inventory",
            outcome: "progress",
            phase,
            correlation: { jobId: job.id },
            gap: inventoryGap(gap.reason),
            count: 1,
          });
        }
      };
      try {
        const result = await runImportInventory({
          database,
          attempt,
          source: input.source,
          explicitPairs: job.scope.explicitPairs,
          explicitIds: job.scope.explicitIds,
          checkpoint: job.checkpoint,
          signal: operationController.signal,
          onPageCommit: (snapshot) => persistProgress(snapshot, false),
        });
        if (leaseLost) {
          throw new ImportJobConflictError(
            "The inventory attempt lease was lost",
          );
        }
        await persistProgress(result, true);

        const updated = await requireJob(input.actor, job.id);
        const items = await this.listItems(input.actor, job.id);
        observeConversation(options.observe, {
          subsystem: "import",
          operation: "inventory",
          outcome:
            updated.phase === "paused"
              ? "paused"
              : updated.phase === "cancelled"
                ? "cancelled"
                : "completed",
          phase: updated.phase,
          correlation: { jobId: job.id },
          count: items.length,
        });
        return { job: updated, items, attempt };
      } finally {
        clearInterval(renewal);
        input.signal?.removeEventListener("abort", abortFromCaller);
      }
    },

    async encryptItemResources(input: {
      actor: ImportJobActor;
      jobId: string;
      itemId: string;
      resources: unknown;
      attempt: ImportAttempt;
      expectedPhase: ImportJobPhase;
    }): Promise<ImportItemRecord> {
      assertAdminRequester(input.actor);
      const payload: EncryptedResourcePayload = {
        domain: RESOURCE_DOMAIN,
        jobId: input.jobId,
        itemId: input.itemId,
        resources: input.resources,
      };
      const encrypted = await encryptSecret(
        options.encryptionKey,
        JSON.stringify(payload),
      );
      const result = await database.transaction(async (tx) => {
        const [job] = await tx
          .select()
          .from(conversationImportJobs)
          .where(
            and(
              attemptPredicate(input.jobId, input.attempt, input.expectedPhase),
              eq(conversationImportJobs.requestedBy, input.actor.id),
            ),
          )
          .for("update")
          .limit(1);
        if (!job) {
          throw new ImportJobConflictError(
            "The import attempt lease or phase is no longer valid",
          );
        }
        const [item] = await tx
          .select()
          .from(conversationImportItems)
          .where(
            and(
              eq(conversationImportItems.id, input.itemId),
              eq(conversationImportItems.jobId, input.jobId),
            ),
          )
          .limit(1);
        if (!item)
          throw new ImportJobNotFoundError("Import item was not found");
        const [stillOwned] = await tx
          .update(conversationImportJobs)
          .set({ updatedAt: sql`${conversationImportJobs.updatedAt}` })
          .where(
            attemptPredicate(input.jobId, input.attempt, input.expectedPhase),
          )
          .returning({ id: conversationImportJobs.id });
        if (!stillOwned) {
          throw new ImportJobConflictError(
            "The import attempt lease expired before the resource write",
          );
        }
        const [updated] = await tx
          .update(conversationImportItems)
          .set({
            encryptedResources: encrypted,
            status: "staged",
            capturedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(conversationImportItems.id, item.id))
          .returning();
        return asItem(updated);
      });
      observeConversation(options.observe, {
        subsystem: "import",
        operation: "import",
        outcome: "staged",
        phase: input.expectedPhase,
        correlation: { jobId: input.jobId },
        count: 1,
      });
      return result;
    },

    async decryptItemResources(input: {
      actor: ImportJobActor;
      jobId: string;
      itemId: string;
    }): Promise<unknown> {
      assertAdminRequester(input.actor);
      await requireJob(input.actor, input.jobId);
      const [item] = await database
        .select()
        .from(conversationImportItems)
        .where(
          and(
            eq(conversationImportItems.id, input.itemId),
            eq(conversationImportItems.jobId, input.jobId),
          ),
        )
        .limit(1);
      if (!item?.encryptedResources) {
        throw new ImportJobNotFoundError(
          "Import item resources were not found",
        );
      }
      const plaintext = await decryptSecret(
        options.encryptionKey,
        item.encryptedResources,
      );
      const parsed = JSON.parse(plaintext) as EncryptedResourcePayload;
      if (
        parsed.domain !== RESOURCE_DOMAIN ||
        parsed.jobId !== input.jobId ||
        parsed.itemId !== input.itemId
      ) {
        throw new ImportJobConflictError(
          "Encrypted resource domain binding did not match",
        );
      }
      return parsed.resources;
    },

    async existingMapping(sourceNamespace: string, sourceThreadId: string) {
      const [row] = await database
        .select()
        .from(conversationImportMappings)
        .where(
          and(
            eq(conversationImportMappings.sourceNamespace, sourceNamespace),
            eq(conversationImportMappings.sourceThreadId, sourceThreadId),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async getItem(
      actor: ImportJobActor,
      jobId: string,
      itemId: string,
    ): Promise<ImportItemRecord> {
      assertAdminRequester(actor);
      await requireJob(actor, jobId);
      const [item] = await database
        .select()
        .from(conversationImportItems)
        .where(
          and(
            eq(conversationImportItems.id, itemId),
            eq(conversationImportItems.jobId, jobId),
          ),
        )
        .limit(1);
      if (!item) throw new ImportJobNotFoundError("Import item was not found");
      return asItem(item);
    },

    async markItem(input: {
      actor: ImportJobActor;
      jobId: string;
      itemId: string;
      status: ImportItemStatus;
      coverage?: Record<string, unknown>;
      contentHash?: string | null;
      failureCode?: string | null;
      converterVersion?: number;
      attempt: ImportAttempt;
      expectedPhase: ImportJobPhase;
    }): Promise<ImportItemRecord> {
      assertAdminRequester(input.actor);
      const result = await database.transaction(async (tx) => {
        const [job] = await tx
          .select()
          .from(conversationImportJobs)
          .where(
            and(
              attemptPredicate(input.jobId, input.attempt, input.expectedPhase),
              eq(conversationImportJobs.requestedBy, input.actor.id),
            ),
          )
          .for("update")
          .limit(1);
        if (!job) {
          throw new ImportJobConflictError(
            "The import attempt lease or expected phase is no longer valid",
          );
        }
        const [item] = await tx
          .select()
          .from(conversationImportItems)
          .where(
            and(
              eq(conversationImportItems.id, input.itemId),
              eq(conversationImportItems.jobId, input.jobId),
            ),
          )
          .limit(1);
        if (!item)
          throw new ImportJobNotFoundError("Import item was not found");
        const [stillOwned] = await tx
          .update(conversationImportJobs)
          .set({ updatedAt: sql`${conversationImportJobs.updatedAt}` })
          .where(
            attemptPredicate(input.jobId, input.attempt, input.expectedPhase),
          )
          .returning({ id: conversationImportJobs.id });
        if (!stillOwned) {
          throw new ImportJobConflictError(
            "The import attempt lease expired before the item write",
          );
        }
        const [updated] = await tx
          .update(conversationImportItems)
          .set({
            status: input.status,
            ...(input.coverage !== undefined
              ? { coverage: input.coverage }
              : {}),
            ...(input.contentHash !== undefined
              ? { contentHash: input.contentHash }
              : {}),
            ...(input.failureCode !== undefined
              ? { failureCode: input.failureCode }
              : {}),
            ...(input.converterVersion !== undefined
              ? { converterVersion: input.converterVersion }
              : {}),
            updatedAt: new Date(),
          })
          .where(eq(conversationImportItems.id, item.id))
          .returning();
        return asItem(updated);
      });
      emitItemObservation(options.observe, {
        jobId: input.jobId,
        phase: input.expectedPhase,
        status: result.status,
        failureCode: result.failureCode,
        coverage: result.coverage,
      });
      return result;
    },

    async publishImportedThread(input: {
      actor: ImportJobActor;
      job: ImportJobRecord;
      item: ImportItemRecord;
      destinationThreadId: string;
      ownerUserId: string;
      channelId: string | null;
      agentId: string | null;
      localReadiness: "history_only" | "ready";
      messages: unknown;
      state: unknown;
      contentHash: string;
      converterVersion: number;
      approvedManifestHash: string;
      attempt: ImportAttempt;
      expectedPhase: ImportJobPhase;
    }): Promise<ImportItemRecord> {
      assertAdminRequester(input.actor);
      const result = await database.transaction(async (tx) => {
        const [live] = await tx
          .select()
          .from(conversationImportJobs)
          .where(
            and(
              attemptPredicate(
                input.job.id,
                input.attempt,
                input.expectedPhase,
              ),
              eq(conversationImportJobs.requestedBy, input.actor.id),
            ),
          )
          .for("update")
          .limit(1);
        if (!live) {
          throw new ImportJobConflictError(
            "The import attempt lease or expected phase is no longer valid",
          );
        }
        if (
          live.approvedManifestHash !== input.approvedManifestHash ||
          capturedContentHash(live.manifest) !== input.approvedManifestHash
        ) {
          throw new ImportJobConflictError(
            "Approved manifest hash does not match the current inventory",
          );
        }
        const reservationKeys = [
          `source:${JSON.stringify([live.sourceNamespace, input.item.sourceThreadId])}`,
          `destination:${JSON.stringify([input.destinationThreadId])}`,
        ].sort();
        for (const key of reservationKeys) {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
          );
        }
        const [existingMapping] = await tx
          .select()
          .from(conversationImportMappings)
          .where(
            and(
              eq(
                conversationImportMappings.sourceNamespace,
                live.sourceNamespace,
              ),
              eq(
                conversationImportMappings.sourceThreadId,
                input.item.sourceThreadId,
              ),
            ),
          )
          .limit(1);
        if (existingMapping) {
          const [mappedDestination] = await tx
            .select({ ownerUserId: conversationThreads.ownerUserId })
            .from(conversationThreads)
            .where(
              eq(conversationThreads.id, existingMapping.destinationThreadId),
            )
            .limit(1);
          const identical =
            existingMapping.sourceOrigin === live.sourceOrigin &&
            existingMapping.sourceUserId === input.item.sourceUserId &&
            existingMapping.contentHash === input.contentHash &&
            existingMapping.destinationThreadId === input.destinationThreadId &&
            mappedDestination?.ownerUserId === input.ownerUserId;
          if (identical) {
            const [stillOwned] = await tx
              .update(conversationImportJobs)
              .set({ updatedAt: sql`${conversationImportJobs.updatedAt}` })
              .where(
                attemptPredicate(
                  input.job.id,
                  input.attempt,
                  input.expectedPhase,
                ),
              )
              .returning({ id: conversationImportJobs.id });
            if (!stillOwned) {
              throw new ImportJobConflictError(
                "The import attempt lease expired before idempotent publication",
              );
            }
            const [unchanged] = await tx
              .update(conversationImportItems)
              .set({
                status: "unchanged",
                contentHash: input.contentHash,
                converterVersion: input.converterVersion,
                failureCode: null,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(conversationImportItems.id, input.item.id),
                  eq(conversationImportItems.jobId, input.job.id),
                ),
              )
              .returning();
            if (!unchanged) {
              throw new ImportJobNotFoundError("Import item was not found");
            }
            return asItem(unchanged);
          }
          throw new ImportDestinationConflictError();
        }
        const [existingThread] = await tx
          .select({ id: conversationThreads.id })
          .from(conversationThreads)
          .where(eq(conversationThreads.id, input.destinationThreadId))
          .limit(1);
        if (existingThread) {
          throw new ImportDestinationConflictError();
        }
        try {
          await tx.insert(conversationThreads).values({
            id: input.destinationThreadId,
            ownerUserId: input.ownerUserId,
            channelId: input.channelId,
            agentId: input.agentId,
            provenance: "imported",
            localReadiness: input.localReadiness,
          });
        } catch (error) {
          if (
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "23505"
          ) {
            throw new ImportDestinationConflictError();
          }
          throw error;
        }
        await tx.insert(conversationBaselines).values({
          threadId: input.destinationThreadId,
          messages: input.messages as never,
          state: input.state as never,
          messageCount: Array.isArray(input.messages)
            ? input.messages.length
            : 0,
          baselineSequence: 0n,
          contentHash: input.contentHash,
        });
        await tx.insert(conversationImportMappings).values({
          sourceNamespace: input.job.sourceNamespace,
          sourceThreadId: input.item.sourceThreadId,
          sourceOrigin: input.job.sourceOrigin,
          sourceUserId: input.item.sourceUserId,
          destinationThreadId: input.destinationThreadId,
          itemId: input.item.id,
          contentHash: input.contentHash,
        });
        const [stillOwned] = await tx
          .update(conversationImportJobs)
          .set({ updatedAt: sql`${conversationImportJobs.updatedAt}` })
          .where(
            attemptPredicate(input.job.id, input.attempt, input.expectedPhase),
          )
          .returning({ id: conversationImportJobs.id });
        if (!stillOwned) {
          throw new ImportJobConflictError(
            "The import attempt lease expired before publication completed",
          );
        }
        const [updated] = await tx
          .update(conversationImportItems)
          .set({
            status: "published",
            contentHash: input.contentHash,
            converterVersion: input.converterVersion,
            publishedAt: new Date(),
            failureCode: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(conversationImportItems.id, input.item.id),
              eq(conversationImportItems.jobId, input.job.id),
            ),
          )
          .returning();
        if (!updated) {
          throw new ImportJobNotFoundError("Import item was not found");
        }
        return asItem(updated);
      });
      emitItemObservation(options.observe, {
        jobId: input.job.id,
        phase: input.expectedPhase,
        status: result.status,
        failureCode: result.failureCode,
        coverage: result.coverage,
      });
      return result;
    },
  };
}

async function upsertDiscoveredItem(
  tx: DatabaseExecutor,
  job: ImportJobRecord,
  thread: ImportInventoryThread,
) {
  const blocked =
    thread.ownership.classification === "identity-conflict" ||
    thread.ownership.classification === "explicit-unowned" ||
    thread.ownership.classification === "probe-not-found";
  const status: ImportItemStatus = blocked ? "blocked" : "discovered";
  const destinationUserId =
    thread.ownership.classification === "mapped"
      ? (thread.ownership.mappingUserId ?? null)
      : null;
  const destinationChannelId =
    thread.ownership.classification === "mapped"
      ? (thread.ownership.mappingChannelId ?? null)
      : null;

  const [existing] = await tx
    .select()
    .from(conversationImportItems)
    .where(
      and(
        eq(conversationImportItems.jobId, job.id),
        eq(conversationImportItems.sourceThreadId, thread.sourceThreadId),
      ),
    )
    .limit(1);

  if (existing) {
    if (
      existing.sourceUserId !== thread.sourceUserId ||
      existing.sourceAgentId !== thread.sourceAgentId
    ) {
      await tx
        .update(conversationImportItems)
        .set({
          status: "blocked",
          failureCode: "identity-conflict",
          ownershipEvidence: {
            ...thread.ownership,
            classification: "identity-conflict",
            notes: [
              ...thread.ownership.notes,
              "Duplicate sourceThreadId with a different owner/agent in this job.",
            ],
          },
          updatedAt: new Date(),
        })
        .where(eq(conversationImportItems.id, existing.id));
      return;
    }
    await tx
      .update(conversationImportItems)
      .set({
        ownershipEvidence: thread.ownership,
        destinationUserId,
        destinationChannelId,
        status: blocked ? "blocked" : existing.status,
        failureCode: blocked
          ? thread.ownership.classification
          : existing.failureCode,
        updatedAt: new Date(),
      })
      .where(eq(conversationImportItems.id, existing.id));
    return;
  }

  await tx.insert(conversationImportItems).values({
    jobId: job.id,
    sourceThreadId: thread.sourceThreadId,
    sourceUserId: thread.sourceUserId,
    sourceAgentId: thread.sourceAgentId,
    destinationUserId,
    destinationChannelId,
    status,
    ownershipEvidence: thread.ownership,
    coverage: { pairOrigins: thread.pairOrigins, discovery: thread.discovery },
    failureCode: blocked ? thread.ownership.classification : null,
  });
}

export type ConversationImportStore = ReturnType<
  typeof createConversationImportStore
>;
