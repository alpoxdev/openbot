import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  cancelConversationImport,
  confirmConversationImport,
  conversationImportDetailQueryOptions,
  conversationImportKeys,
  createConversationImport,
  defaultSourceOrigin,
  inventoryConversationImport,
  isActiveImportPhase,
  listConversationImportsQueryOptions,
  readBrowserThreadHints,
  runConversationImport,
  type ConversationImportItem,
  type ConversationImportJob,
  type ConversationImportJobDetail,
  type ConversationImportPhase,
} from "@/lib/conversation-import";
import { queryClient } from "@/query-client";

function coverageText(coverage: unknown): string {
  if (coverage == null) return "none recorded";
  if (typeof coverage === "string") return coverage;
  try {
    return JSON.stringify(coverage);
  } catch {
    return "unreadable coverage";
  }
}

function phaseLabel(
  phase: ConversationImportPhase,
  job?: Pick<ConversationImportJob, "manifest" | "approvedManifestHash">,
): string {
  switch (phase) {
    case "inventory":
      return "Discovering records";
    case "awaiting_confirmation":
      return "Waiting for confirmation";
    case "importing":
      return "Importing into this server";
    case "paused":
      return job?.manifest.inventoryCompleteForDeclaredScope &&
        job.approvedManifestHash
        ? "Paused — authorize again to continue import"
        : "Paused — authorize again to continue discovery";
    case "cancelled":
      return "Cancelled";
    case "completed":
      return "Imported records stored on this server";
    case "completed_with_gaps":
      return "Finished with gaps — not a complete history of the source";
    case "failed":
      return "Failed";
    default:
      return phase;
  }
}

function itemSummary(items: ConversationImportItem[]) {
  const counts = {
    total: items.length,
    published: 0,
    unchanged: 0,
    failed: 0,
    blocked: 0,
    other: 0,
  };
  for (const item of items) {
    if (item.status === "published") counts.published += 1;
    else if (item.status === "unchanged") counts.unchanged += 1;
    else if (item.status === "failed") counts.failed += 1;
    else if (item.status === "blocked") counts.blocked += 1;
    else counts.other += 1;
  }
  return counts;
}

function JobItems({ items }: { items: ConversationImportItem[] }) {
  if (items.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No conversations discovered for the declared scope yet.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {items.map((item) => (
        <li className="rounded-md border px-3 py-2 text-sm" key={item.id}>
          <p>
            Source thread {item.sourceThreadId} · source person{" "}
            {item.sourceUserId}
            {item.sourceAgentId ? ` · coworker ${item.sourceAgentId}` : ""}
          </p>
          <p className="text-muted-foreground">
            Owner on this server: {item.destinationUserId ?? "unmapped"} ·
            status {item.status}
            {item.failureCode ? ` · ${item.failureCode}` : ""}
          </p>
          <p className="text-muted-foreground">
            Coverage: {coverageText(item.coverage)}
          </p>
        </li>
      ))}
    </ul>
  );
}

function ActiveJob({
  jobId,
  apiKey,
  onClearKey,
}: {
  jobId: string;
  apiKey: string;
  onClearKey: () => void;
}) {
  const detail = useQuery(conversationImportDetailQueryOptions(jobId));
  const [problem, setProblem] = useState<string | null>(null);
  const [pendingCredentialOperation, setPendingCredentialOperation] = useState<
    "inventory" | "run" | null
  >(null);
  const [pendingConfirm, setPendingConfirm] = useState(false);
  const [pendingCancel, setPendingCancel] = useState(false);

  const payload = detail.data;
  const job = payload?.job;
  const items = payload?.items ?? [];
  const manifestHash = payload?.manifestHash ?? null;

  useEffect(() => {
    return () => {
      onClearKey();
    };
  }, [onClearKey]);

  /*
   * Read through the phase rather than the job: the poll rewrites the job object every few seconds,
   * so depending on it re-ran this effect on each poll to ask a question only the phase answers.
   */
  const phase = job?.phase;
  useEffect(() => {
    if (!phase) return;
    if (
      phase === "completed" ||
      phase === "completed_with_gaps" ||
      phase === "cancelled" ||
      phase === "failed"
    ) {
      onClearKey();
    }
  }, [phase, onClearKey]);

  const refresh = (updated: ConversationImportJob) => {
    queryClient.setQueryData(
      conversationImportKeys.detail(jobId),
      (previous: ConversationImportJobDetail | undefined) => {
        // An accepted operation can resolve after a cancellation response. Never let that stale
        // acknowledgement put a cancelled job back into an actionable phase.
        if (previous?.job.phase === "cancelled") return previous;
        return previous
          ? { ...previous, job: updated }
          : {
              job: updated,
              items: [],
              manifestHash: updated.approvedManifestHash,
            };
      },
    );
    void queryClient.invalidateQueries({
      queryKey: conversationImportKeys.all,
    });
  };

  const runCredentialOperation = async (
    operation: "inventory" | "run",
    key: string,
  ) => {
    try {
      const updated =
        operation === "inventory"
          ? await inventoryConversationImport(jobId, key)
          : await runConversationImport(jobId, key);
      refresh(updated);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingCredentialOperation(null);
    }
  };

  const confirmAction = async (hash: string) => {
    if (pendingConfirm) return;
    setProblem(null);
    setPendingConfirm(true);
    try {
      const updated = await confirmConversationImport(jobId, hash);
      refresh(updated);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingConfirm(false);
    }
  };

  const cancelAction = async () => {
    if (pendingCancel) return;
    setProblem(null);
    setPendingCancel(true);
    try {
      const updated = await cancelConversationImport(jobId);
      refresh(updated);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingCancel(false);
    }
  };

  if (detail.isPending) {
    return (
      <p className="mt-4 text-muted-foreground text-sm">Loading this import…</p>
    );
  }
  if (detail.error) {
    return (
      <p className="mt-4 text-destructive text-sm" role="alert">
        {detail.error.message}
      </p>
    );
  }
  if (!job) return null;

  const incomplete =
    !job.manifest.inventoryCompleteForDeclaredScope ||
    job.phase === "completed_with_gaps" ||
    job.phase === "paused";
  const counts = itemSummary(items);
  const confirmed = Boolean(job.approvedManifestHash);
  const completeDiscovery = job.manifest.inventoryCompleteForDeclaredScope;
  const validApprovedInventory = confirmed && completeDiscovery;
  const storedHistoryCount = counts.published + counts.unchanged;
  const hasStoredHistory = storedHistoryCount > 0;
  const hasPartialImportCoverage =
    job.phase === "failed" ||
    job.phase === "completed_with_gaps" ||
    (job.phase === "paused" && validApprovedInventory) ||
    items.some(
      (item) =>
        item.status === "failed" ||
        item.status === "blocked" ||
        item.failureCode === "source-changed" ||
        item.failureCode === "sourceChanged",
    );
  const attemptActive = job.attemptStatus === "active";
  const canConfirm =
    job.phase === "awaiting_confirmation" &&
    Boolean(manifestHash) &&
    !confirmed;
  const canRun =
    validApprovedInventory &&
    (job.phase === "awaiting_confirmation" ||
      job.phase === "completed" ||
      job.phase === "completed_with_gaps" ||
      job.phase === "importing" ||
      job.phase === "failed" ||
      job.phase === "paused");
  const canInventory =
    job.phase === "inventory" ||
    (job.phase === "paused" && !validApprovedInventory) ||
    (job.phase === "failed" && !validApprovedInventory);
  const canCancel = isActiveImportPhase(job.phase) || job.phase === "paused";
  const resumingImport =
    job.phase === "importing" &&
    job.attemptStatus === "expired" &&
    job.attemptKind === "run";
  const runLabel = resumingImport
    ? "Resume import"
    : job.phase === "completed" ||
        job.phase === "completed_with_gaps" ||
        job.phase === "failed" ||
        job.phase === "paused"
      ? "Retry import"
      : "Import confirmed records";

  const startCredentialOperation = (operation: "inventory" | "run") => {
    if (!apiKey || pendingCredentialOperation) return;
    // Capture the key only in this one bounded operation closure. The parent state is cleared
    // before handing it off, so a follow-up operation requires fresh authorization.
    const key = apiKey;
    onClearKey();
    setProblem(null);
    setPendingCredentialOperation(operation);
    void runCredentialOperation(operation, key);
  };

  return (
    <div className="mt-6 flex flex-col gap-3">
      <p className="text-sm">{phaseLabel(job.phase, job)}</p>
      <p className="text-muted-foreground text-sm">
        Source {job.sourceOrigin} · {job.sourceReference}.{" "}
        {job.manifest.pairCount} ownership pairs, {job.manifest.threadCount}{" "}
        threads in the inventory.
      </p>
      {hasPartialImportCoverage ? (
        hasStoredHistory ? (
          <p className="text-sm" role="status">
            This report is partial. It is not a complete history of every
            conversation on the old source. Imported records already stored on
            this server remain here while failed, blocked, or source-changed
            records can be reviewed.
          </p>
        ) : (
          <p className="text-sm" role="status">
            This report is partial. It is not a complete history of every
            conversation on the old source. No imported records are reported as
            stored on this server yet; failed, blocked, or source-changed
            records can be reviewed.
          </p>
        )
      ) : job.phase === "completed" ? (
        <p className="text-muted-foreground text-sm">
          Imported records are already stored on this server. The approved
          inventory can be explicitly retried with fresh authorization.
        </p>
      ) : incomplete ? (
        <p className="text-sm" role="status">
          This report is partial. It is not a complete history of every
          conversation on the old source. Imported records are stored on this
          server after confirmation.
        </p>
      ) : (
        <p className="text-muted-foreground text-sm">
          Inventory for the declared scope is complete. Confirm before anything
          is stored on this server.
        </p>
      )}
      {job.manifest.notes.map((note) => (
        <p className="text-muted-foreground text-sm" key={note}>
          {note}
        </p>
      ))}
      <p className="text-sm">
        {storedHistoryCount} stored on this server · {counts.failed} failed ·{" "}
        {counts.blocked} blocked · {counts.total} discovered
      </p>
      <JobItems items={items} />
      {problem ? (
        <p className="text-destructive text-sm" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {canInventory ? (
          <Button
            disabled={
              attemptActive || !apiKey || pendingCredentialOperation !== null
            }
            onClick={() => {
              startCredentialOperation("inventory");
            }}
            size="sm"
          >
            {job.phase === "paused"
              ? "Authorize and resume discovery"
              : job.phase === "failed"
                ? "Retry discovery"
                : "Discover conversations"}
          </Button>
        ) : null}
        {canConfirm ? (
          <Button
            disabled={
              attemptActive ||
              pendingConfirm ||
              pendingCredentialOperation !== null ||
              !manifestHash
            }
            onClick={() => {
              if (!manifestHash) return;
              void confirmAction(manifestHash);
            }}
            size="sm"
          >
            Confirm inventory
          </Button>
        ) : null}
        {canRun ? (
          <Button
            disabled={
              attemptActive || !apiKey || pendingCredentialOperation !== null
            }
            onClick={() => {
              startCredentialOperation("run");
            }}
            size="sm"
          >
            {runLabel}
          </Button>
        ) : null}
        {canCancel ? (
          <Button
            disabled={pendingCancel}
            onClick={() => {
              void cancelAction();
            }}
            size="sm"
            variant="outline"
          >
            Cancel
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function ConversationImport() {
  const user = useQuery(currentUserQueryOptions());
  const jobs = useQuery({
    ...listConversationImportsQueryOptions(),
    enabled: user.data?.role === "admin",
  });

  const [sourceOrigin, setSourceOrigin] = useState(defaultSourceOrigin);
  const [sourceReference, setSourceReference] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [useHints, setUseHints] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pendingCreate, setPendingCreate] = useState(false);
  const clearApiKey = useCallback(() => {
    setApiKey("");
  }, []);

  useEffect(() => {
    return clearApiKey;
  }, [clearApiKey]);

  const createAction = async () => {
    if (pendingCreate) return;
    setProblem(null);
    setPendingCreate(true);
    try {
      const created = await createConversationImport({
        sourceOrigin,
        sourceReference,
        explicitIds: useHints
          ? readBrowserThreadHints(user.data?.id ?? "")
          : undefined,
      });
      setActiveJobId(created.id);
      void queryClient.invalidateQueries({
        queryKey: conversationImportKeys.all,
      });
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingCreate(false);
    }
  };

  if (user.data?.role !== "admin") return null;

  const listed = jobs.data?.jobs ?? [];

  return (
    <PageSection
      description="Optional. Bring selected conversations from an old CopilotKit source onto this server. New conversations already live here and do not need this. No CopilotKit account sign-in needed. An old CopilotKit project API key authorizes this import only and is not stored in this browser."
      title="Import old conversations"
    >
      <div className="mt-4 flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="conversation-import-origin">Source origin</Label>
          <Input
            autoComplete="off"
            id="conversation-import-origin"
            onChange={(event) => setSourceOrigin(event.target.value)}
            placeholder="https://your-old-copilotkit-source.example"
            value={sourceOrigin}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="conversation-import-reference">
            Source reference
          </Label>
          <Input
            autoComplete="off"
            id="conversation-import-reference"
            onChange={(event) => setSourceReference(event.target.value)}
            value={sourceReference}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="conversation-import-key">
            Old CopilotKit project API key
          </Label>
          <Input
            autoComplete="off"
            id="conversation-import-key"
            onChange={(event) => setApiKey(event.target.value)}
            type="password"
            value={apiKey}
          />
        </div>
        <label
          className="flex items-center gap-2 text-sm"
          htmlFor="conversation-import-hints"
        >
          <Checkbox
            aria-label="Use remembered thread ids as hints"
            checked={useHints}
            id="conversation-import-hints"
            onCheckedChange={(checked) => setUseHints(checked === true)}
          />
          Use remembered thread ids for this account as hints only — they are
          not proof of ownership
        </label>
        {problem ? (
          <p className="text-destructive text-sm" role="alert">
            {problem}
          </p>
        ) : null}
        <Button
          disabled={pendingCreate || !sourceOrigin || !sourceReference}
          onClick={() => {
            void createAction();
          }}
          size="sm"
        >
          Start import job
        </Button>
        {jobs.error ? (
          <p className="text-destructive text-sm" role="alert">
            {jobs.error.message}
          </p>
        ) : null}
        {listed.length > 0 ? (
          <ul className="flex flex-col gap-1 text-sm">
            {listed.map((listedJob) => (
              <li key={listedJob.id}>
                <button
                  className="text-left underline"
                  onClick={() => setActiveJobId(listedJob.id)}
                  type="button"
                >
                  {listedJob.id} · {phaseLabel(listedJob.phase, listedJob)}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {activeJobId ? (
          <ActiveJob
            apiKey={apiKey}
            jobId={activeJobId}
            onClearKey={clearApiKey}
          />
        ) : null}
      </div>
    </PageSection>
  );
}
