import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import { requireAdmin } from "../auth/guards";
import {
  ImportJobAccessError,
  ImportJobConflictError,
  ImportJobNotFoundError,
  type ConversationImportStore,
  type ImportAttempt,
  type ImportJobActor,
  type ImportJobRecord,
} from "./import-store";
import type { ConversationImporter } from "./importer";
import {
  createConversationImportSource,
  resolveImportSourceOrigin,
} from "./import-source";
import { capturedContentHash } from "./import-validation";
import {
  observeConversation,
  type ConversationObservationError,
  type ConversationObserver,
} from "./observability";

const MAX_ID_LENGTH = 512;
const MAX_SOURCE_REFERENCE_LENGTH = 1_024;
const MAX_SOURCE_NAMESPACE_LENGTH = 512;
const MAX_API_KEY_LENGTH = 16_384;
const MAX_SCOPE_ENTRIES = 10_000;

type ImportOperation = {
  kind: "inventory" | "run";
  controller: AbortController;
  attempt: ImportAttempt;
  startedAt: number;
};

export type ConversationImportRouteDependencies = {
  importStore: ConversationImportStore;
  importer: ConversationImporter;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  observe?: ConversationObserver;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(
  value: unknown,
  maxLength: number,
  options: { allowEmpty?: boolean } = {},
): value is string {
  return (
    typeof value === "string" &&
    value.length <= maxLength &&
    (options.allowEmpty === true || value.length > 0)
  );
}

function unsafeSourceReference(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    );
  } catch {
    // Non-URL project labels are intentionally supported.
    return false;
  }
}

function projectSourceReference(value: string): string {
  return unsafeSourceReference(value) ? "[redacted]" : value;
}

function parsePairs(
  value: unknown,
): { userId: string; agentId: string }[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_SCOPE_ENTRIES) return null;
  const pairs: { userId: string; agentId: string }[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      !boundedString(entry.userId, MAX_ID_LENGTH) ||
      !boundedString(entry.agentId, MAX_ID_LENGTH)
    ) {
      return null;
    }
    pairs.push({ userId: entry.userId, agentId: entry.agentId });
  }
  return pairs;
}

function parseIds(
  value: unknown,
): { threadId: string; userId: string }[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_SCOPE_ENTRIES) return null;
  const ids: { threadId: string; userId: string }[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      !boundedString(entry.threadId, MAX_ID_LENGTH) ||
      !boundedString(entry.userId, MAX_ID_LENGTH)
    ) {
      return null;
    }
    ids.push({ threadId: entry.threadId, userId: entry.userId });
  }
  return ids;
}

function actorFor(
  context: Context<{ Variables: AppVariables }>,
): ImportJobActor {
  // The route calls requireAdmin before this helper. Keeping the value literal here prevents a
  // future role expansion from accidentally becoming a store actor with broader import powers.
  return { id: context.var.actor.id, role: "admin" };
}

function projectJob(job: ImportJobRecord) {
  return {
    id: job.id,
    sourceOrigin: job.sourceOrigin,
    sourceReference: projectSourceReference(job.sourceReference),
    phase: job.phase,
    manifest: {
      inventoryCompleteForDeclaredScope:
        job.manifest.inventoryCompleteForDeclaredScope,
      pairCount: job.manifest.pairCount,
      threadCount: job.manifest.threadCount,
      notes: job.manifest.notes,
      inventoryRevision: job.manifest.inventoryRevision,
    },
    approvedManifestHash: job.approvedManifestHash,
    attemptStatus: job.attemptStatus,
    attemptKind: job.attemptKind,
  };
}

function projectItem(
  item: Awaited<ReturnType<ConversationImportStore["getItem"]>>,
) {
  return {
    id: item.id,
    sourceThreadId: item.sourceThreadId,
    sourceUserId: item.sourceUserId,
    sourceAgentId: item.sourceAgentId,
    destinationUserId: item.destinationUserId,
    status: item.status,
    coverage: item.coverage,
    failureCode: item.failureCode,
  };
}

function safeError(error: unknown): {
  status: 404 | 409 | 500;
  message: string;
} {
  if (
    error instanceof ImportJobNotFoundError ||
    error instanceof ImportJobAccessError
  ) {
    // Foreign jobs and missing jobs intentionally have one response. Job ids are access-controlled
    // data, so a requester must not be able to probe whether another administrator has one.
    return { status: 404, message: "Import job was not found." };
  }
  if (error instanceof ImportJobConflictError) {
    return { status: 409, message: error.message };
  }
  return {
    status: 500,
    message: "Conversation import could not be completed.",
  };
}

async function requestBody(
  context: Context,
): Promise<Record<string, unknown> | null> {
  const body = await context.req.json().catch(() => null);
  return isRecord(body) ? body : null;
}

function sourceFor(
  job: ImportJobRecord,
  apiKey: unknown,
  observe: ConversationObserver | undefined,
): ReturnType<typeof createConversationImportSource> {
  if (!boundedString(apiKey, MAX_API_KEY_LENGTH)) {
    return {
      ok: false,
      code: "unauthorized",
      message: "Source credential is unavailable.",
    };
  }
  // The request never supplies an origin for an existing job. The origin persisted at creation is
  // already normalized and is the only host to which this transient credential may be sent.
  return createConversationImportSource(
    {
      origin: job.sourceOrigin,
      apiKey,
    },
    {
      observe,
      jobId: job.id,
    },
  );
}

function accepted(job: ImportJobRecord) {
  return {
    job: projectJob(job),
    operation: {
      accepted: true,
      claimScope: "database",
      attemptStatus: job.attemptStatus,
      attemptKind: job.attemptKind,
    },
  };
}

function elapsedSince(startedAt: number): number {
  const elapsed = Date.now() - startedAt;
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 0;
}

function terminalOutcome(
  phase: ImportJobRecord["phase"],
): "progress" | "paused" | "cancelled" | "completed" | "failed" | "started" {
  switch (phase) {
    case "inventory":
      return "progress";
    case "awaiting_confirmation":
      return "completed";
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

function observationError(error: unknown): ConversationObservationError {
  if (error instanceof ImportJobAccessError) return "authorization";
  if (error instanceof ImportJobConflictError) return "conflict";
  if (error instanceof ImportJobNotFoundError) return "authorization";
  return "unknown";
}

function observeImportSummary(
  observer: ConversationObserver | undefined,
  summary: Awaited<ReturnType<ConversationImporter["runApprovedImport"]>>,
  startedAt: number,
) {
  const correlation = { jobId: summary.jobId };
  const common = {
    subsystem: "import" as const,
    operation: "import" as const,
    phase: summary.phase,
    correlation,
  };
  observeConversation(observer, {
    ...common,
    outcome: "selected",
    count: summary.counts.selected,
  });
  observeConversation(observer, {
    ...common,
    outcome: "published",
    count: summary.counts.published,
  });
  observeConversation(observer, {
    ...common,
    outcome: "unchanged",
    count: summary.counts.unchanged,
  });
  observeConversation(observer, {
    ...common,
    outcome: "blocked",
    count: summary.counts.blocked,
  });
  observeConversation(observer, {
    ...common,
    outcome: "failed",
    count: summary.counts.failed,
  });
  observeConversation(observer, {
    ...common,
    outcome: "excluded",
    count: summary.counts.excluded,
  });
  observeConversation(observer, {
    ...common,
    outcome: "sourceChanged",
    count: summary.counts.sourceChanged,
  });
  observeConversation(observer, {
    ...common,
    outcome: terminalOutcome(summary.phase),
    latencyMs: elapsedSince(startedAt),
  });
}

export function createConversationImportRoutes(
  dependencies: ConversationImportRouteDependencies,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  const operations = new Map<string, ImportOperation>();

  const withAdmin = async (
    context: Context<{ Variables: AppVariables }>,
    next: () => Promise<void>,
  ) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    return next();
  };

  async function loadJob(
    context: Context<{ Variables: AppVariables }>,
  ): Promise<ImportJobRecord> {
    const id = context.req.param("id");
    if (!boundedString(id, MAX_ID_LENGTH)) {
      throw new ImportJobNotFoundError();
    }
    return dependencies.importStore.getJob(actorFor(context), id);
  }

  async function startOperation(
    context: Context<{ Variables: AppVariables }>,
    kind: ImportOperation["kind"],
    sourceApiKey: unknown,
  ): Promise<Response> {
    const startedAt = Date.now();
    const actor = actorFor(context);
    const job = await loadJob(context);
    if (job.phase === "cancelled") {
      throw new ImportJobConflictError("Cancelled import jobs cannot restart.");
    }
    if (kind === "inventory" && job.phase === "importing") {
      throw new ImportJobConflictError(
        "Finish or cancel the current import before discovering records again.",
      );
    }
    const source = sourceFor(job, sourceApiKey, dependencies.observe);
    if (!source.ok) {
      // Never return the adapter's response body or a source URL here. The adapter's diagnostics are
      // intentionally safe for internal control flow, not a contract that may echo request data.
      return context.json(
        { error: "Source credential or origin was rejected." },
        400,
      );
    }
    const admission = await dependencies.importStore.acquireAttempt({
      actor,
      jobId: job.id,
      kind,
      approvedManifestHash:
        kind === "run" ? (job.approvedManifestHash ?? undefined) : undefined,
    });

    const operation: ImportOperation = {
      kind,
      controller: new AbortController(),
      attempt: admission.attempt,
      startedAt,
    };
    operations.set(job.id, operation);
    const activeJob = admission.job;
    observeConversation(dependencies.observe, {
      subsystem: "import",
      operation: kind === "inventory" ? "inventory" : "import",
      outcome: "started",
      phase: activeJob.phase,
      correlation: { jobId: job.id },
      latencyMs: elapsedSince(startedAt),
    });
    const run = async () => {
      let terminalPhase: ImportJobRecord["phase"] | undefined;
      let terminalError: ConversationObservationError | undefined;
      try {
        if (kind === "inventory") {
          const result = await dependencies.importStore.runInventory({
            actor,
            jobId: job.id,
            source: source.value,
            signal: operation.controller.signal,
            attempt: operation.attempt,
          });
          terminalPhase = result.job.phase;
          observeConversation(dependencies.observe, {
            subsystem: "import",
            operation: "inventory",
            outcome: terminalOutcome(result.job.phase),
            phase: result.job.phase,
            correlation: { jobId: job.id },
            latencyMs: elapsedSince(operation.startedAt),
            count: result.items.length,
          });
        } else {
          const approvedManifestHash = activeJob.approvedManifestHash;
          if (!approvedManifestHash) {
            throw new ImportJobConflictError(
              "An approved manifest is required before importing",
            );
          }
          const summary = await dependencies.importer.runApprovedImport({
            actor,
            jobId: job.id,
            approvedManifestHash,
            source: source.value,
            signal: operation.controller.signal,
            attempt: operation.attempt,
          });
          terminalPhase = summary.phase;
          observeImportSummary(
            dependencies.observe,
            summary,
            operation.startedAt,
          );
        }
      } catch (error) {
        // Cancellation is persisted first by the cancel route, and every store mutation checks that
        // phase. Do not turn an intentional cancellation into a failed job.
        try {
          const live = await dependencies.importStore.getJob(actor, job.id);
          if (live.phase === "cancelled") {
            terminalPhase = "cancelled";
          } else if (
            live.attemptStatus === "active" &&
            live.attemptToken === operation.attempt.token
          ) {
            await dependencies.importStore.updatePhase(
              actor,
              job.id,
              "failed",
              {
                attempt: operation.attempt,
                expectedPhase: kind === "inventory" ? "inventory" : "importing",
                approvedManifestHash:
                  kind === "run"
                    ? (job.approvedManifestHash ?? undefined)
                    : undefined,
              },
            );
            terminalPhase = "failed";
          }
        } catch {
          terminalError = "persistence";
          // The operation's response was already accepted. A transient failure while recording its
          // terminal phase must not expose source errors or become an unhandled rejection.
        }
        if (terminalPhase !== "cancelled") {
          observeConversation(dependencies.observe, {
            subsystem: "import",
            operation: kind === "inventory" ? "inventory" : "import",
            outcome: "failed",
            ...(terminalPhase === undefined ? {} : { phase: terminalPhase }),
            correlation: { jobId: job.id },
            latencyMs: elapsedSince(operation.startedAt),
            error: terminalError ?? observationError(error),
            ...(terminalError === "persistence"
              ? { gap: "persistence" as const }
              : {}),
          });
          if (terminalError === "persistence") {
            observeConversation(dependencies.observe, {
              subsystem: "import",
              operation: "persistence",
              outcome: "failed",
              correlation: { jobId: job.id },
              latencyMs: elapsedSince(operation.startedAt),
              error: "persistence",
              gap: "persistence",
            });
          }
        }
      } finally {
        if (operations.get(job.id) === operation) operations.delete(job.id);
      }
    };
    // The promise intentionally outlives this request. It is not attached to the request signal, so
    // a browser navigation/disconnect cannot abandon an accepted inventory or import.
    void run();
    return context.json(accepted(activeJob), 202);
  }

  routes.get("/", dependencies.requireUser, withAdmin, async (context) => {
    try {
      const jobs = await dependencies.importStore.listJobs(actorFor(context));
      return context.json({ jobs: jobs.map(projectJob) });
    } catch (error) {
      const safe = safeError(error);
      return context.json({ error: safe.message }, safe.status);
    }
  });

  routes.post("/", dependencies.requireUser, withAdmin, async (context) => {
    const body = await requestBody(context);
    if (!body)
      return context.json({ error: "A JSON import request is required." }, 400);
    if (
      !boundedString(body.sourceOrigin, MAX_SOURCE_REFERENCE_LENGTH) ||
      !boundedString(body.sourceReference, MAX_SOURCE_REFERENCE_LENGTH)
    ) {
      return context.json(
        { error: "A source origin and source reference are required." },
        400,
      );
    }
    if (unsafeSourceReference(body.sourceReference)) {
      return context.json(
        { error: "Source reference must not contain URL credentials." },
        400,
      );
    }
    const origin = resolveImportSourceOrigin(body.sourceOrigin);
    if (!origin.ok) {
      return context.json(
        { error: "Source origin must be a valid HTTPS origin." },
        400,
      );
    }
    if (
      body.sourceNamespace !== undefined &&
      !boundedString(body.sourceNamespace, MAX_SOURCE_NAMESPACE_LENGTH)
    ) {
      return context.json({ error: "Source namespace is invalid." }, 400);
    }
    const explicitPairs = parsePairs(body.explicitPairs);
    const explicitIds = parseIds(body.explicitIds);
    if (!explicitPairs || !explicitIds) {
      return context.json({ error: "Import scope is invalid." }, 400);
    }
    try {
      const job = await dependencies.importStore.createJob({
        actor: actorFor(context),
        sourceNamespace:
          body.sourceNamespace === undefined
            ? origin.value
            : body.sourceNamespace,
        sourceOrigin: origin.value,
        sourceReference: body.sourceReference,
        explicitPairs,
        explicitIds,
      });
      return context.json({ job: projectJob(job) }, 201);
    } catch (error) {
      const safe = safeError(error);
      return context.json({ error: safe.message }, safe.status);
    }
  });

  routes.get("/:id", dependencies.requireUser, withAdmin, async (context) => {
    try {
      const job = await loadJob(context);
      const items = await dependencies.importStore.listItems(
        actorFor(context),
        job.id,
      );
      return context.json({
        job: projectJob(job),
        items: items.map(projectItem),
        manifestHash: job.manifest.inventoryCompleteForDeclaredScope
          ? capturedContentHash(job.manifest)
          : null,
      });
    } catch (error) {
      const safe = safeError(error);
      return context.json({ error: safe.message }, safe.status);
    }
  });

  routes.post(
    "/:id/inventory",
    dependencies.requireUser,
    withAdmin,
    async (context) => {
      const body = await requestBody(context);
      if (!body || !boundedString(body.apiKey, MAX_API_KEY_LENGTH)) {
        return context.json({ error: "A source API key is required." }, 400);
      }
      try {
        return await startOperation(context, "inventory", body.apiKey);
      } catch (error) {
        const safe = safeError(error);
        return context.json({ error: safe.message }, safe.status);
      }
    },
  );

  routes.post(
    "/:id/confirm",
    dependencies.requireUser,
    withAdmin,
    async (context) => {
      const body = await requestBody(context);
      if (!body || !boundedString(body.manifestHash, MAX_ID_LENGTH)) {
        return context.json({ error: "A manifest hash is required." }, 400);
      }
      try {
        const job = await dependencies.importStore.approveManifest(
          actorFor(context),
          context.req.param("id"),
          body.manifestHash,
        );
        return context.json({ job: projectJob(job) });
      } catch (error) {
        const safe = safeError(error);
        return context.json({ error: safe.message }, safe.status);
      }
    },
  );

  routes.post(
    "/:id/run",
    dependencies.requireUser,
    withAdmin,
    async (context) => {
      const body = await requestBody(context);
      if (!body || !boundedString(body.apiKey, MAX_API_KEY_LENGTH)) {
        return context.json({ error: "A source API key is required." }, 400);
      }
      try {
        return await startOperation(context, "run", body.apiKey);
      } catch (error) {
        const safe = safeError(error);
        return context.json({ error: safe.message }, safe.status);
      }
    },
  );

  routes.post(
    "/:id/cancel",
    dependencies.requireUser,
    withAdmin,
    async (context) => {
      try {
        const actor = actorFor(context);
        const job = await dependencies.importStore.cancelJob(
          actor,
          context.req.param("id"),
        );
        const operation = operations.get(job.id);
        operation?.controller.abort();
        return context.json({ job: projectJob(job) });
      } catch (error) {
        const safe = safeError(error);
        return context.json({ error: safe.message }, safe.status);
      }
    },
  );

  return routes;
}
