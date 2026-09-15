import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import type {
  ConversationImportStore,
  ImportAttempt,
  ImportJobRecord,
} from "../src/conversations/import-store";
import {
  ImportJobAccessError,
  ImportJobConflictError,
} from "../src/conversations/import-store";
import type { ConversationImporter } from "../src/conversations/importer";
import type { ConversationObservation } from "../src/conversations/observability";
import { capturedContentHash } from "../src/conversations/import-validation";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

function job(overrides: Partial<ImportJobRecord> = {}): ImportJobRecord {
  const now = new Date();
  return {
    id: "00000000-0000-0000-0000-000000000001",
    requestedBy: "admin",
    sourceNamespace: "https://source.example.test",
    sourceOrigin: "https://source.example.test",
    sourceReference: "project",
    phase: "inventory",
    scope: { explicitPairs: [], explicitIds: [], sourceReference: "project" },
    manifest: {
      schemaVersion: 1,
      inventoryRevision: 0,
      sourceNamespace: "https://source.example.test",
      sourceOrigin: "https://source.example.test",
      sourceReference: "project",
      inventoryCompleteForDeclaredScope: false,
      pairCount: 0,
      threadCount: 0,
      notes: [],
    },
    approvedManifestHash: null,
    checkpoint: { pairs: [], probes: [] },
    attemptToken: null,
    attemptKind: null,
    attemptLeaseExpiresAt: null,
    attemptStatus: "none",
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function storeStub(
  initial = job(),
  options: {
    inventory?: (signal: AbortSignal) => Promise<void>;
  } = {},
) {
  let current = initial;
  const created: Parameters<ConversationImportStore["createJob"]>[0][] = [];
  const store = {
    created,
    get current() {
      return current;
    },
    async createJob(
      input: Parameters<ConversationImportStore["createJob"]>[0],
    ) {
      created.push(input);
      current = job({
        requestedBy: input.actor.id,
        sourceNamespace: input.sourceNamespace,
        sourceOrigin: input.sourceOrigin,
        sourceReference: input.sourceReference,
        scope: {
          explicitPairs: input.explicitPairs,
          explicitIds: input.explicitIds ?? [],
          sourceReference: input.sourceReference,
        },
        manifest: {
          ...current.manifest,
          sourceNamespace: input.sourceNamespace,
          sourceOrigin: input.sourceOrigin,
          sourceReference: input.sourceReference,
        },
      });
      return current;
    },
    async getJob(actor: { id: string }, id: string) {
      if (id !== current.id) throw new Error("missing");
      if (actor.id !== current.requestedBy) throw new ImportJobAccessError();
      return current;
    },
    async acquireAttempt(input: {
      actor: { id: string };
      jobId: string;
      kind: "inventory" | "run";
      approvedManifestHash?: string;
    }) {
      if (input.jobId !== current.id) throw new Error("missing");
      if (input.actor.id !== current.requestedBy)
        throw new ImportJobAccessError();
      if (current.attemptStatus === "active") {
        throw new ImportJobConflictError(
          "Another authorized import attempt currently owns this job",
        );
      }
      if (
        input.kind === "run" &&
        (!current.approvedManifestHash ||
          current.approvedManifestHash !== input.approvedManifestHash)
      ) {
        throw new ImportJobConflictError(
          "Approved manifest hash does not match the current inventory",
        );
      }
      const attempt: ImportAttempt = {
        token: `${input.kind}-attempt`,
        kind: input.kind,
      };
      current = job({
        ...current,
        phase: input.kind === "inventory" ? "inventory" : "importing",
        approvedManifestHash:
          input.kind === "inventory" ? null : current.approvedManifestHash,
        attemptToken: attempt.token,
        attemptKind: attempt.kind,
        attemptLeaseExpiresAt: new Date(Date.now() + 30_000),
        attemptStatus: "active",
      });
      return { job: current, attempt };
    },
    async listJobs(actor: { id: string }) {
      return actor.id === current.requestedBy ? [current] : [];
    },
    async listItems() {
      return [];
    },
    async runInventory(input: {
      signal?: AbortSignal;
      attempt?: ImportAttempt;
    }) {
      await options.inventory?.(input.signal ?? new AbortController().signal);
      if (current.phase === "cancelled")
        return { job: current, items: [], attempt: input.attempt! };
      current = job({
        ...current,
        phase: "awaiting_confirmation",
        manifest: {
          ...current.manifest,
          inventoryCompleteForDeclaredScope: true,
        },
        attemptToken: null,
        attemptKind: null,
        attemptLeaseExpiresAt: null,
        attemptStatus: "none",
      });
      return { job: current, items: [], attempt: input.attempt! };
    },
    async approveManifest(_actor: unknown, id: string, hash: string) {
      if (id !== current.id) throw new Error("missing");
      if (current.attemptStatus === "active") {
        throw new ImportJobConflictError(
          "Manifest cannot be approved while an import attempt is active",
        );
      }
      current = job({
        ...current,
        phase: "awaiting_confirmation",
        approvedManifestHash: hash,
      });
      return current;
    },
    async cancelJob() {
      current = job({
        ...current,
        phase: "cancelled",
        attemptToken: null,
        attemptKind: null,
        attemptLeaseExpiresAt: null,
        attemptStatus: "none",
      });
      return current;
    },
    async updatePhase(
      _actor: unknown,
      _id: string,
      phase: ImportJobRecord["phase"],
      options?: {
        attempt?: ImportAttempt;
        expectedPhase?: ImportJobRecord["phase"];
      },
    ) {
      void options;
      current = job({
        ...current,
        phase,
        ...(phase === "failed" ||
        phase === "completed" ||
        phase === "completed_with_gaps"
          ? {
              attemptToken: null,
              attemptKind: null,
              attemptLeaseExpiresAt: null,
              attemptStatus: "none" as const,
            }
          : {}),
      });
      return current;
    },
  } as unknown as ConversationImportStore & {
    created: Parameters<ConversationImportStore["createJob"]>[0][];
    readonly current: ImportJobRecord;
  };
  return store;
}

function mounted(
  session: { id: string; email?: string } | null,
  store: ConversationImportStore,
  importer: ConversationImporter = {
    runApprovedImport: async () => ({
      jobId: "job",
      phase: "completed",
      counts: {
        selected: 0,
        published: 0,
        unchanged: 0,
        blocked: 0,
        failed: 0,
        excluded: 0,
        sourceChanged: 0,
      },
      coverage: {},
    }),
  },
  observe?: (observation: ConversationObservation) => void,
) {
  const args = [
    loadConfig(testEnvironment()),
    {
      handler: () => new Response(null, { status: 204 }),
      api: {
        getSession: async () =>
          session
            ? {
                user: {
                  id: session.id,
                  email: session.email ?? `${session.id}@example.test`,
                },
              }
            : null,
      },
    },
    {
      rolesForUser: async (id: string) =>
        id === "admin" || id === "other-admin" ? ["admin"] : ["user"],
    },
  ] as unknown as Parameters<typeof createApp>;
  // Keep the import dependency after every existing positional argument. This mirrors the
  // production call and proves adding the route did not shift thread/routine wiring.
  while (args.length < 30) args.push(undefined as never);
  args.push({ importStore: store, importer, observe } as never);
  return createApp(...args);
}

describe("mounted conversation import routes", () => {
  test.each(["inventory", "run"])(
    "rejects restarting cancelled work through %s before acceptance",
    async (operation) => {
      const state = storeStub(job({ phase: "cancelled" }));
      const app = mounted({ id: "admin" }, state);
      const response = await app.request(
        `http://openbot.test/api/admin/conversation-imports/${state.current.id}/${operation}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ apiKey: "transient-key" }),
        },
      );
      expect(response.status).toBe(409);
      expect(state.current.phase).toBe("cancelled");
    },
  );

  test("rejects unapproved imports without changing the job into a failed operation", async () => {
    const state = storeStub(job({ phase: "awaiting_confirmation" }));
    const response = await mounted({ id: "admin" }, state).request(
      `http://openbot.test/api/admin/conversation-imports/${state.current.id}/run`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: "transient-key" }),
      },
    );
    expect(response.status).toBe(409);
    expect(state.current.phase).toBe("awaiting_confirmation");
  });

  test("acknowledges an approved run only after storing an active polling phase", async () => {
    const manifest = {
      ...job().manifest,
      inventoryCompleteForDeclaredScope: true,
    };
    const state = storeStub(
      job({
        phase: "awaiting_confirmation",
        manifest,
        approvedManifestHash: capturedContentHash(manifest),
      }),
    );
    const response = await mounted({ id: "admin" }, state).request(
      `http://openbot.test/api/admin/conversation-imports/${state.current.id}/run`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: "transient-key" }),
      },
    );
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.job.phase).toBe("importing");
    expect(body.job.attemptStatus).toBe("active");
    expect(body.job.attemptKind).toBe("run");
    expect(body.operation).toMatchObject({
      claimScope: "database",
      attemptStatus: "active",
      attemptKind: "run",
    });
    expect(state.current.phase).toBe("importing");
    expect(JSON.stringify(body)).not.toContain("transient-key");
  });

  test("claims before acknowledging and rejects a concurrent operation", async () => {
    let release!: () => void;
    const state = storeStub(job(), {
      inventory: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    const app = mounted({ id: "admin" }, state);
    const path = `http://openbot.test/api/admin/conversation-imports/${state.current.id}/inventory`;
    const first = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "transient-key" }),
    });
    expect(first.status).toBe(202);
    const second = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "transient-key" }),
    });
    expect(second.status).toBe(409);
    expect(state.current.attemptStatus).toBe("active");
    await app.request(
      `http://openbot.test/api/admin/conversation-imports/${state.current.id}/cancel`,
      { method: "POST" },
    );
    release();
  });

  test("reclaims an expired approved run attempt", async () => {
    const manifest = {
      ...job().manifest,
      inventoryCompleteForDeclaredScope: true,
    };
    const state = storeStub(
      job({
        phase: "paused",
        manifest,
        approvedManifestHash: capturedContentHash(manifest),
        attemptToken: "expired-attempt",
        attemptKind: "run",
        attemptLeaseExpiresAt: new Date(Date.now() - 1_000),
        attemptStatus: "expired",
      }),
    );
    const response = await mounted({ id: "admin" }, state).request(
      `http://openbot.test/api/admin/conversation-imports/${state.current.id}/run`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: "transient-key" }),
      },
    );
    expect(response.status).toBe(202);
    expect((await response.json()).operation).toMatchObject({
      claimScope: "database",
      attemptStatus: "active",
      attemptKind: "run",
    });
  });

  test("requires a signed-in administrator", async () => {
    const store = storeStub();
    const anonymous = mounted(null, store);
    const unauthenticated = await anonymous.request(
      "http://openbot.test/api/admin/conversation-imports",
    );
    expect(unauthenticated.status).toBe(401);

    const ordinary = mounted({ id: "member" }, store);
    const forbidden = await ordinary.request(
      "http://openbot.test/api/admin/conversation-imports",
    );
    expect(forbidden.status).toBe(403);
  });

  test("normalizes the origin and keeps ownership scoped to the requester", async () => {
    const state = storeStub();
    const app = mounted({ id: "admin" }, state);
    const created = await app.request(
      "http://openbot.test/api/admin/conversation-imports",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceOrigin: "https://source.example.test/ignored/path",
          sourceReference: "project",
          explicitPairs: [],
        }),
      },
    );
    expect(created.status).toBe(201);
    expect(state.created[0]?.sourceOrigin).toBe("https://source.example.test");
    expect(JSON.stringify(await created.json())).not.toMatch(
      /apiKey|Bearer|secret/i,
    );

    const foreign = mounted({ id: "other-admin" }, state);
    const response = await foreign.request(
      `http://openbot.test/api/admin/conversation-imports/${state.current.id}`,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "Import job was not found.",
    });
  });

  test("rejects credential-bearing source reference URLs without echoing secrets", async () => {
    const state = storeStub();
    const app = mounted({ id: "admin" }, state);
    const canary = "source-reference-secret-canary";
    const response = await app.request(
      "http://openbot.test/api/admin/conversation-imports",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceOrigin: "https://source.example.test",
          sourceReference: `https://user:${canary}@project.example.test/import?apiKey=${canary}#token=${canary}`,
          explicitPairs: [],
        }),
      },
    );
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).not.toContain(canary);
    expect(state.created).toHaveLength(0);
  });

  test("redacts unsafe legacy source references in public job projections", async () => {
    const canary = "legacy-source-reference-secret";
    const state = storeStub(
      job({
        sourceReference: `https://user:${canary}@project.example.test/import`,
      }),
    );
    const response = await mounted({ id: "admin" }, state).request(
      "http://openbot.test/api/admin/conversation-imports",
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.jobs[0]?.sourceReference).toBe("[redacted]");
    expect(JSON.stringify(body)).not.toContain(canary);
  });

  test("requires and confirms the current inventory manifest hash", async () => {
    const state = storeStub(
      job({
        phase: "awaiting_confirmation",
        manifest: {
          ...job().manifest,
          inventoryCompleteForDeclaredScope: true,
        },
      }),
    );
    const app = mounted({ id: "admin" }, state);
    const response = await app.request(
      `http://openbot.test/api/admin/conversation-imports/${state.current.id}/confirm`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ manifestHash: "current-manifest-hash" }),
      },
    );
    expect(response.status).toBe(200);
    expect((await response.json()).job.approvedManifestHash).toBe(
      "current-manifest-hash",
    );
  });

  test("refuses confirmation while a database attempt is active", async () => {
    let release!: () => void;
    const state = storeStub(job(), {
      inventory: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    const app = mounted({ id: "admin" }, state);
    const inventory = await app.request(
      `http://openbot.test/api/admin/conversation-imports/${state.current.id}/inventory`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: "transient-key" }),
      },
    );
    expect(inventory.status).toBe(202);
    const response = await app.request(
      `http://openbot.test/api/admin/conversation-imports/${state.current.id}/confirm`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ manifestHash: "current-manifest-hash" }),
      },
    );
    expect(response.status).toBe(409);
    await app.request(
      `http://openbot.test/api/admin/conversation-imports/${state.current.id}/cancel`,
      { method: "POST" },
    );
    release();
  });

  test("keeps accepted inventory alive after disconnect and cancellation aborts it", async () => {
    let release!: () => void;
    let observedSignal: AbortSignal | undefined;
    const state = storeStub(job(), {
      inventory: (signal) =>
        new Promise<void>((resolve) => {
          observedSignal = signal;
          release = resolve;
        }),
    });
    const app = mounted({ id: "admin" }, state);
    const accepted = await app.request(
      `http://openbot.test/api/admin/conversation-imports/${state.current.id}/inventory`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: "transient-key" }),
      },
    );
    expect(accepted.status).toBe(202);
    const cancelled = await app.request(
      `http://openbot.test/api/admin/conversation-imports/${state.current.id}/cancel`,
      { method: "POST" },
    );
    expect(cancelled.status).toBe(200);
    expect(state.current.phase).toBe("cancelled");
    expect(state.current.attemptStatus).toBe("none");
    expect(observedSignal?.aborted).toBe(true);
    release();
  });

  test("redacts background failures", async () => {
    const state = storeStub(job(), {
      inventory: async () => {
        throw new Error("Bearer source-secret");
      },
    });
    const app = mounted({ id: "admin" }, state);
    const accepted = await app.request(
      `http://openbot.test/api/admin/conversation-imports/${state.current.id}/inventory`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: "source-secret" }),
      },
    );
    expect(accepted.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const detail = await app.request(
      `http://openbot.test/api/admin/conversation-imports/${state.current.id}`,
    );
    expect(JSON.stringify(await detail.json())).not.toContain("source-secret");
    expect(state.current.phase).toBe("failed");
  });

  test("emits fixed import summary counts and a terminal phase with latency", async () => {
    const manifest = {
      ...job().manifest,
      inventoryCompleteForDeclaredScope: true,
    };
    const state = storeStub(
      job({
        phase: "awaiting_confirmation",
        manifest,
        approvedManifestHash: capturedContentHash(manifest),
      }),
    );
    const summary = {
      jobId: state.current.id,
      phase: "completed_with_gaps" as const,
      counts: {
        selected: 2,
        published: 1,
        unchanged: 1,
        blocked: 0,
        failed: 0,
        excluded: 0,
        sourceChanged: 0,
      },
      coverage: {},
    };
    const observations: ConversationObservation[] = [];
    const app = mounted(
      { id: "admin" },
      state,
      { runApprovedImport: async () => summary } as ConversationImporter,
      (observation) => observations.push(observation),
    );
    const accepted = await app.request(
      `http://openbot.test/api/admin/conversation-imports/${state.current.id}/run`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: "transient-key" }),
      },
    );
    expect(accepted.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      observations.some(
        (observation) =>
          observation.operation === "import" &&
          observation.outcome === "selected" &&
          observation.count === 2,
      ),
    ).toBe(true);
    expect(
      observations.some(
        (observation) =>
          observation.operation === "import" &&
          observation.outcome === "published" &&
          observation.count === 1,
      ),
    ).toBe(true);
    const terminal = observations.find(
      (observation) =>
        observation.operation === "import" &&
        observation.outcome === "completed" &&
        observation.phase === "completed_with_gaps",
    );
    expect(terminal?.latencyMs).toEqual(expect.any(Number));
    expect(JSON.stringify(observations)).not.toContain("transient-key");
    expect(JSON.stringify(observations)).not.toContain(state.current.id);
  });

  test("reports a sanitized failure when terminal phase persistence fails", async () => {
    const failureCanary = "source-failure-canary";
    const state = storeStub(job(), {
      inventory: async () => {
        throw new Error(`provider message ${failureCanary}`);
      },
    });
    state.updatePhase = (async () => {
      throw new Error("terminal persistence failed");
    }) as typeof state.updatePhase;
    const observations: ConversationObservation[] = [];
    const app = mounted({ id: "admin" }, state, undefined, (observation) =>
      observations.push(observation),
    );
    const accepted = await app.request(
      `http://openbot.test/api/admin/conversation-imports/${state.current.id}/inventory`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: failureCanary }),
      },
    );
    expect(accepted.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      observations.some(
        (observation) =>
          observation.operation === "inventory" &&
          observation.outcome === "failed" &&
          observation.error === "persistence" &&
          observation.gap === "persistence",
      ),
    ).toBe(true);
    expect(JSON.stringify(observations)).not.toContain(failureCanary);
  });
});
