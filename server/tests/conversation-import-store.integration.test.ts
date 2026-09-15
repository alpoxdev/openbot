import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  createConversationImportStore,
  ImportJobAccessError,
  ImportJobConflictError,
} from "../src/conversations/import-store";
import type { ConversationImportSource } from "../src/conversations/import-source";
import { runImportInventory } from "../src/conversations/import-inventory";
import { capturedContentHash } from "../src/conversations/import-validation";
import type { ConversationObservation } from "../src/conversations/observability";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelAgents,
  channels,
  conversationImportItems,
  conversationImportJobs,
  intelligenceChannelMappings,
  userRoles,
  users,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const KEY = `${"A".repeat(43)}=`;
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createConversationImportStore(database, { encryptionKey: KEY });
const prefix = `conv-import-${randomUUID().slice(0, 8)}`;

const created = {
  users: [] as string[],
  channels: [] as string[],
  agents: [] as string[],
  jobs: [] as string[],
};

afterEach(async () => {
  for (const id of created.jobs.splice(0)) {
    await database
      .delete(conversationImportItems)
      .where(eq(conversationImportItems.jobId, id));
    await database
      .delete(conversationImportJobs)
      .where(eq(conversationImportJobs.id, id));
  }
  for (const id of created.channels.splice(0)) {
    await database
      .delete(intelligenceChannelMappings)
      .where(eq(intelligenceChannelMappings.channelId, id));
    await database.delete(channels).where(eq(channels.id, id));
  }
  for (const id of created.agents.splice(0)) {
    await database.delete(agentProfiles).where(eq(agentProfiles.agentId, id));
    await database.delete(agents).where(eq(agents.id, id));
  }
  for (const id of created.users.splice(0)) {
    await database.delete(users).where(eq(users.id, id));
  }
});

afterAll(async () => {
  await database.$client.close();
});

async function seedUser(label: string) {
  const id = `${prefix}-${label}-${randomUUID()}`;
  await database.insert(users).values({ id, email: `${id}@example.test` });
  await database.insert(userRoles).values({
    userId: id,
    role: label.includes("admin") ? "admin" : "user",
  });
  created.users.push(id);
  return id;
}

async function seedAgent(label: string, deleted = false) {
  const id = `${prefix}-agent-${label}-${randomUUID()}`;
  await database.insert(agents).values({
    id,
    name: label,
    type: "built_in",
    configuration: {},
  });
  await database.insert(agentProfiles).values({
    agentId: id,
    title: label,
    roleDescription: "fixture",
    avatarSeed: id,
    visibility: "private",
    deletedAt: deleted ? new Date() : null,
  });
  created.agents.push(id);
  return id;
}

async function seedMappedChannel(
  userId: string,
  agentId: string,
  threadId: string,
) {
  const id = `${prefix}-channel-${randomUUID()}`;
  await database.insert(channels).values({
    id,
    name: "import mapping",
    description: "fixture",
  });
  created.channels.push(id);
  await database.insert(channelAgents).values({ channelId: id, agentId });
  await database.insert(intelligenceChannelMappings).values({
    userId,
    channelId: id,
    threadId,
  });
  return id;
}

function unusedGet() {
  return {
    async getThread() {
      return {
        ok: false as const,
        gap: "not-found" as const,
        message: "unused",
      };
    },
    async getThreadMessages() {
      return {
        ok: false as const,
        gap: "not-found" as const,
        message: "unused",
      };
    },
    async getThreadEvents() {
      return {
        ok: false as const,
        gap: "unavailable" as const,
        message: "unused",
      };
    },
    async getThreadState() {
      return {
        ok: false as const,
        gap: "unavailable" as const,
        message: "unused",
      };
    },
  };
}

function pagingSource(
  userId: string,
  agentId: string,
  sequence: Array<{
    threads: { id: string; name: string | null }[];
    nextCursor: string | null;
  }>,
  getThread?: ConversationImportSource["getThread"],
): ConversationImportSource {
  return {
    async listThreads(params) {
      expect(params.includeArchived).toBe(true);
      if (params.userId !== userId || params.agentId !== agentId) {
        return { ok: true, value: { threads: [], nextCursor: null } };
      }
      const keyCursor = params.cursor ?? "";
      const page =
        keyCursor === ""
          ? sequence[0]
          : (sequence.find(
              (_entry, i) => i > 0 && sequence[i - 1]?.nextCursor === keyCursor,
            ) ?? sequence[sequence.length - 1]);
      return {
        ok: true,
        value: { threads: page!.threads, nextCursor: page!.nextCursor },
      };
    },
    ...unusedGet(),
    ...(getThread ? { getThread } : {}),
  };
}

describe("conversation import store", () => {
  test("keeps a database lease active when the application clock jumps ahead", async () => {
    const admin = await seedUser("admin");
    const job = await store.createJob({
      actor: { id: admin, role: "admin" },
      sourceNamespace: "ns-a",
      sourceOrigin: "https://intelligence.example.test",
      sourceReference: "clock-skew",
      explicitPairs: [],
    });
    created.jobs.push(job.id);

    const admitted = await store.acquireAttempt({
      actor: { id: admin, role: "admin" },
      jobId: job.id,
      kind: "inventory",
    });
    const active = await store.getJob({ id: admin, role: "admin" }, job.id);
    expect(active.attemptStatus).toBe("active");
    expect(active.attemptKind).toBe("inventory");
    expect(active.attemptToken).toBe(admitted.attempt.token);

    const realDateNow = Date.now;
    try {
      Date.now = () => realDateNow() + 5 * 60_000;
      await expect(
        store.acquireAttempt({
          actor: { id: admin, role: "admin" },
          jobId: job.id,
          kind: "inventory",
        }),
      ).rejects.toBeInstanceOf(ImportJobConflictError);
      const stillActive = await store.getJob(
        { id: admin, role: "admin" },
        job.id,
      );
      expect(stillActive.attemptStatus).toBe("active");
      expect(stillActive.attemptKind).toBe("inventory");
      expect(stillActive.attemptToken).toBe(admitted.attempt.token);
    } finally {
      Date.now = realDateNow;
    }
  });

  test("admits only one concurrent attempt for a job", async () => {
    const admin = await seedUser("admin");
    const job = await store.createJob({
      actor: { id: admin, role: "admin" },
      sourceNamespace: "ns-a",
      sourceOrigin: "https://intelligence.example.test",
      sourceReference: "same-job-race",
      explicitPairs: [],
    });
    created.jobs.push(job.id);
    const actor = { id: admin, role: "admin" as const };
    const outcomes = await Promise.allSettled([
      store.acquireAttempt({ actor, jobId: job.id, kind: "inventory" }),
      store.acquireAttempt({ actor, jobId: job.id, kind: "inventory" }),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(
      ImportJobConflictError,
    );
    const active = await store.getJob(actor, job.id);
    expect(active.attemptStatus).toBe("active");
    expect(active.attemptKind).toBe("inventory");
  });

  test("reclaims an expired run attempt without losing its approval", async () => {
    const admin = await seedUser("admin");
    const actor = { id: admin, role: "admin" as const };
    const job = await store.createJob({
      actor,
      sourceNamespace: "ns-a",
      sourceOrigin: "https://intelligence.example.test",
      sourceReference: "expired-run",
      explicitPairs: [],
    });
    created.jobs.push(job.id);
    const inventoried = await store.runInventory({
      actor,
      jobId: job.id,
      source: pagingSource(admin, "", [{ threads: [], nextCursor: null }]),
    });
    const hash = capturedContentHash(inventoried.job.manifest);
    await store.approveManifest(actor, job.id, hash);
    const first = await store.acquireAttempt({
      actor,
      jobId: job.id,
      kind: "run",
      approvedManifestHash: hash,
    });
    await database
      .update(conversationImportJobs)
      .set({ attemptLeaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(conversationImportJobs.id, job.id));

    const expired = await store.getJob(actor, job.id);
    expect(expired.attemptStatus).toBe("expired");
    expect(expired.attemptKind).toBe("run");
    expect(expired.approvedManifestHash).toBe(hash);

    const resumed = await store.acquireAttempt({
      actor,
      jobId: job.id,
      kind: "run",
      approvedManifestHash: hash,
    });
    expect(resumed.attempt.token).not.toBe(first.attempt.token);
    expect(resumed.job.attemptStatus).toBe("active");
    expect(resumed.job.attemptKind).toBe("run");
    expect(resumed.job.approvedManifestHash).toBe(hash);
  });

  test("pauses incomplete inventory and leaves it unapprovable", async () => {
    const admin = await seedUser("admin");
    const owner = await seedUser("owner");
    const agentId = await seedAgent("bot");
    const actor = { id: admin, role: "admin" as const };
    const job = await store.createJob({
      actor,
      sourceNamespace: "ns-a",
      sourceOrigin: "https://intelligence.example.test",
      sourceReference: "page-cap",
      explicitPairs: [{ userId: owner, agentId }],
    });
    created.jobs.push(job.id);
    let page = 0;
    const source: ConversationImportSource = {
      async listThreads(params) {
        if (params.userId !== owner || params.agentId !== agentId) {
          return { ok: true, value: { threads: [], nextCursor: null } };
        }
        page += 1;
        return {
          ok: true,
          value: {
            threads: [],
            nextCursor: `cursor-${page}`,
          },
        };
      },
      ...unusedGet(),
    };
    const result = await store.runInventory({
      actor,
      jobId: job.id,
      source,
    });
    expect(result.job.phase).toBe("paused");
    expect(result.job.manifest.inventoryCompleteForDeclaredScope).toBe(false);
    expect(result.job.approvedManifestHash).toBeNull();
    expect(result.job.attemptStatus).toBe("none");
    await expect(
      store.approveManifest(
        actor,
        job.id,
        capturedContentHash(result.job.manifest),
      ),
    ).rejects.toBeInstanceOf(ImportJobConflictError);
  });

  test("scopes jobs to the requesting admin and refuses a different admin", async () => {
    const admin = await seedUser("admin");
    const other = await seedUser("other-admin");
    const job = await store.createJob({
      actor: { id: admin, role: "admin" },
      sourceNamespace: "ns-a",
      sourceOrigin: "https://intelligence.example.test",
      sourceReference: "proj-1",
      explicitPairs: [],
    });
    created.jobs.push(job.id);
    expect(job.requestedBy).toBe(admin);
    expect(job.phase).toBe("inventory");
    await expect(
      store.getJob({ id: other, role: "admin" }, job.id),
    ).rejects.toBeInstanceOf(ImportJobAccessError);
    await expect(
      store.createJob({
        actor: { id: admin, role: "user" },
        sourceNamespace: "ns-a",
        sourceOrigin: "https://intelligence.example.test",
        sourceReference: "proj-1",
        explicitPairs: [],
      }),
    ).rejects.toBeInstanceOf(ImportJobAccessError);
  });

  test("does not persist source credentials on the job row", async () => {
    const admin = await seedUser("admin");
    const job = await store.createJob({
      actor: { id: admin, role: "admin" },
      sourceNamespace: "ns-a",
      sourceOrigin: "https://intelligence.example.test",
      sourceReference: "proj-1",
      explicitPairs: [{ userId: admin, agentId: "agent-x" }],
    });
    created.jobs.push(job.id);
    const [row] = await database
      .select()
      .from(conversationImportJobs)
      .where(eq(conversationImportJobs.id, job.id));
    expect(JSON.stringify(row)).not.toMatch(/apiKey|Bearer|secret/i);
  });

  test("inventories mapped vs unmapped threads without treating the admin as owner", async () => {
    const admin = await seedUser("admin");
    const owner = await seedUser("owner");
    const agentId = await seedAgent("bot");
    const mappedThread = `${prefix}-mapped-${randomUUID()}`;
    await seedMappedChannel(owner, agentId, mappedThread);
    const unmappedThread = `${prefix}-unmapped-${randomUUID()}`;

    const job = await store.createJob({
      actor: { id: admin, role: "admin" },
      sourceNamespace: "ns-a",
      sourceOrigin: "https://intelligence.example.test",
      sourceReference: "proj-1",
      explicitPairs: [{ userId: owner, agentId }],
    });
    created.jobs.push(job.id);

    const source = pagingSource(owner, agentId, [
      {
        threads: [
          { id: mappedThread, name: "mapped" },
          { id: unmappedThread, name: "unmapped" },
        ],
        nextCursor: null,
      },
    ]);
    const { items, job: after } = await store.runInventory({
      actor: { id: admin, role: "admin" },
      jobId: job.id,
      source,
    });
    expect(after.manifest.inventoryCompleteForDeclaredScope).toBe(true);
    const mapped = items.find((item) => item.sourceThreadId === mappedThread);
    const unmapped = items.find(
      (item) => item.sourceThreadId === unmappedThread,
    );
    expect(mapped?.ownershipEvidence.classification).toBe("mapped");
    expect(mapped?.destinationUserId).toBe(owner);
    expect(mapped?.destinationUserId).not.toBe(admin);
    expect(unmapped?.ownershipEvidence.classification).toBe("unmapped");
    expect(unmapped?.destinationUserId).toBeNull();
  });

  test("blocks identity conflicts on the same source thread", async () => {
    const admin = await seedUser("admin");
    const userA = await seedUser("a");
    const userB = await seedUser("b");
    const agentId = await seedAgent("bot");
    const threadId = `${prefix}-shared-${randomUUID()}`;

    const job = await store.createJob({
      actor: { id: admin, role: "admin" },
      sourceNamespace: "ns-a",
      sourceOrigin: "https://intelligence.example.test",
      sourceReference: "proj-1",
      explicitPairs: [
        { userId: userA, agentId },
        { userId: userB, agentId },
      ],
    });
    created.jobs.push(job.id);

    const source: ConversationImportSource = {
      async listThreads(params) {
        expect(params.includeArchived).toBe(true);
        if (params.agentId !== agentId) {
          return { ok: true, value: { threads: [], nextCursor: null } };
        }
        if (params.userId !== userA && params.userId !== userB) {
          return { ok: true, value: { threads: [], nextCursor: null } };
        }
        return {
          ok: true,
          value: {
            threads: [{ id: threadId, name: "dup" }],
            nextCursor: null,
          },
        };
      },
      ...unusedGet(),
    };

    const { items } = await store.runInventory({
      actor: { id: admin, role: "admin" },
      jobId: job.id,
      source,
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.status).toBe("blocked");
    expect(items[0]?.ownershipEvidence.classification).toBe(
      "identity-conflict",
    );
  });

  test("detects cursor cycles and does not claim completeness", async () => {
    const admin = await seedUser("admin");
    const owner = await seedUser("owner");
    const agentId = await seedAgent("bot");
    const job = await store.createJob({
      actor: { id: admin, role: "admin" },
      sourceNamespace: "ns-a",
      sourceOrigin: "https://intelligence.example.test",
      sourceReference: "proj-1",
      explicitPairs: [{ userId: owner, agentId }],
    });
    created.jobs.push(job.id);
    const source = pagingSource(owner, agentId, [
      { threads: [{ id: "t1", name: "one" }], nextCursor: "loop" },
      { threads: [{ id: "t2", name: "two" }], nextCursor: "loop" },
    ]);
    const { job: after } = await store.runInventory({
      actor: { id: admin, role: "admin" },
      jobId: job.id,
      source,
    });
    expect(after.manifest.inventoryCompleteForDeclaredScope).toBe(false);
    expect(after.checkpoint.pairs[0]?.cycleDetected).toBe(true);
    expect(after.phase).toBe("paused");
    expect(after.manifest.inventoryCompleteForDeclaredScope).toBe(false);
  });

  test("probes mapped thread ids absent from list pages", async () => {
    const admin = await seedUser("admin");
    const owner = await seedUser("owner");
    const agentId = await seedAgent("bot");
    const mappedHidden = `${prefix}-hidden-${randomUUID()}`;
    await seedMappedChannel(owner, agentId, mappedHidden);
    const job = await store.createJob({
      actor: { id: admin, role: "admin" },
      sourceNamespace: "ns-a",
      sourceOrigin: "https://intelligence.example.test",
      sourceReference: "proj-1",
      explicitPairs: [{ userId: owner, agentId }],
    });
    created.jobs.push(job.id);
    const source = pagingSource(
      owner,
      agentId,
      [{ threads: [], nextCursor: null }],
      async ({ threadId, userId }) => {
        if (threadId === mappedHidden && userId === owner) {
          return {
            ok: true,
            value: { id: mappedHidden, name: "hidden", agentId },
          };
        }
        return { ok: false, gap: "not-found", message: "missing" };
      },
    );
    const { items } = await store.runInventory({
      actor: { id: admin, role: "admin" },
      jobId: job.id,
      source,
    });
    const hidden = items.find((item) => item.sourceThreadId === mappedHidden);
    expect(hidden?.ownershipEvidence.classification).toBe("mapped");
    expect(hidden?.destinationUserId).toBe(owner);
  });

  test("empty list page with a distinct next cursor continues", async () => {
    const admin = await seedUser("admin");
    const owner = await seedUser("owner");
    const agentId = await seedAgent("bot");
    const job = await store.createJob({
      actor: { id: admin, role: "admin" },
      sourceNamespace: "ns-a",
      sourceOrigin: "https://intelligence.example.test",
      sourceReference: "proj-1",
      explicitPairs: [{ userId: owner, agentId }],
    });
    created.jobs.push(job.id);
    const source = pagingSource(owner, agentId, [
      { threads: [], nextCursor: "page-2" },
      { threads: [{ id: "later", name: "later" }], nextCursor: null },
    ]);
    const { items, job: after } = await store.runInventory({
      actor: { id: admin, role: "admin" },
      jobId: job.id,
      source,
    });
    expect(items.some((item) => item.sourceThreadId === "later")).toBe(true);
    expect(
      after.checkpoint.pairs.find((p) => p.userId === owner)?.exhausted,
    ).toBe(true);
  });

  test("waits for page checkpoint persistence before requesting the next page", async () => {
    const _admin = await seedUser("admin");
    const owner = await seedUser("owner");
    const agentId = await seedAgent("bot");
    let targetPageCalls = 0;
    let resolvePageOne!: () => void;
    const pageOneRequested = new Promise<void>((resolve) => {
      resolvePageOne = resolve;
    });
    let resolvePersistence!: () => void;
    const persistenceRelease = new Promise<void>((resolve) => {
      resolvePersistence = resolve;
    });
    let resolvePersistenceStarted!: () => void;
    const persistenceStarted = new Promise<void>((resolve) => {
      resolvePersistenceStarted = resolve;
    });
    const source: ConversationImportSource = {
      async listThreads(params) {
        if (params.userId !== owner || params.agentId !== agentId) {
          return { ok: true, value: { threads: [], nextCursor: null } };
        }
        targetPageCalls += 1;
        if (targetPageCalls === 1) resolvePageOne();
        return {
          ok: true,
          value: {
            threads: [{ id: `checkpoint-${targetPageCalls}`, name: "page" }],
            nextCursor: targetPageCalls === 1 ? "page-2" : null,
          },
        };
      },
      ...unusedGet(),
    };
    const run = runImportInventory({
      database,
      attempt: { token: randomUUID(), kind: "inventory" },
      source,
      explicitPairs: [{ userId: owner, agentId }],
      onPageCommit: async () => {
        if (targetPageCalls === 1) {
          resolvePersistenceStarted();
          await persistenceRelease;
        }
      },
    });

    await pageOneRequested;
    await persistenceStarted;
    await Promise.resolve();
    expect(targetPageCalls).toBe(1);
    resolvePersistence();
    await run;
    expect(targetPageCalls).toBe(2);
  });

  test("rejects inventory when checkpoint persistence fails", async () => {
    const _admin = await seedUser("admin");
    const owner = await seedUser("owner");
    const agentId = await seedAgent("bot");
    let checkpointWrites = 0;
    const source = pagingSource(owner, agentId, [
      {
        threads: [{ id: "checkpoint-failure", name: "page" }],
        nextCursor: null,
      },
    ]);
    await expect(
      runImportInventory({
        database,
        attempt: { token: randomUUID(), kind: "inventory" },
        source,
        explicitPairs: [{ userId: owner, agentId }],
        onPageCommit: async () => {
          checkpointWrites += 1;
          throw new Error("checkpoint write failed");
        },
      }),
    ).rejects.toThrow("checkpoint write failed");
    expect(checkpointWrites).toBe(1);
  });

  test("second-page failure keeps first-page items for resume", async () => {
    const admin = await seedUser("admin");
    const owner = await seedUser("owner");
    const agentId = await seedAgent("bot");
    const job = await store.createJob({
      actor: { id: admin, role: "admin" },
      sourceNamespace: "ns-a",
      sourceOrigin: "https://intelligence.example.test",
      sourceReference: "proj-1",
      explicitPairs: [{ userId: owner, agentId }],
    });
    created.jobs.push(job.id);
    let calls = 0;
    const failing: ConversationImportSource = {
      async listThreads(params) {
        expect(params.includeArchived).toBe(true);
        if (params.userId !== owner || params.agentId !== agentId) {
          return { ok: true, value: { threads: [], nextCursor: null } };
        }
        calls += 1;
        if (calls === 1) {
          return {
            ok: true,
            value: {
              threads: [{ id: "kept", name: "one" }],
              nextCursor: "page-2",
            },
          };
        }
        return { ok: false, code: "transient", message: "boom" };
      },
      ...unusedGet(),
    };
    const first = await store.runInventory({
      actor: { id: admin, role: "admin" },
      jobId: job.id,
      source: failing,
    });
    expect(first.items.some((item) => item.sourceThreadId === "kept")).toBe(
      true,
    );
    expect(first.job.phase).toBe("paused");
    expect(first.job.manifest.inventoryCompleteForDeclaredScope).toBe(false);
    expect(first.job.manifest.threadCount).toBeGreaterThanOrEqual(1);
    await expect(
      store.approveManifest(
        { id: admin, role: "admin" },
        job.id,
        capturedContentHash(first.job.manifest),
      ),
    ).rejects.toBeInstanceOf(ImportJobConflictError);
    expect(
      first.job.checkpoint.pairs.find((p) => p.userId === owner)?.nextCursor,
    ).toBe("page-2");

    const resume: ConversationImportSource = {
      async listThreads(params) {
        if (params.userId !== owner || params.agentId !== agentId) {
          return { ok: true, value: { threads: [], nextCursor: null } };
        }
        expect(params.cursor).toBe("page-2");
        return {
          ok: true,
          value: { threads: [{ id: "second", name: "two" }], nextCursor: null },
        };
      },
      ...unusedGet(),
    };
    const second = await store.runInventory({
      actor: { id: admin, role: "admin" },
      jobId: job.id,
      source: resume,
    });
    expect(second.items.map((item) => item.sourceThreadId).sort()).toEqual([
      "kept",
      "second",
    ]);
    expect(second.job.manifest.threadCount).toBeGreaterThanOrEqual(2);
  });

  test("explicit unowned id is blocked and does not adopt the admin", async () => {
    const admin = await seedUser("admin");
    const owner = await seedUser("owner");
    const agentId = await seedAgent("bot");
    const explicitId = `${prefix}-hint-${randomUUID()}`;
    const job = await store.createJob({
      actor: { id: admin, role: "admin" },
      sourceNamespace: "ns-a",
      sourceOrigin: "https://intelligence.example.test",
      sourceReference: "proj-1",
      explicitPairs: [{ userId: owner, agentId }],
      explicitIds: [{ threadId: explicitId, userId: owner }],
    });
    created.jobs.push(job.id);
    const source = pagingSource(
      owner,
      agentId,
      [{ threads: [], nextCursor: null }],
      async ({ threadId }) => {
        if (threadId === explicitId) {
          return { ok: true, value: { id: explicitId, name: "hint", agentId } };
        }
        return { ok: false, gap: "not-found", message: "missing" };
      },
    );
    const { items } = await store.runInventory({
      actor: { id: admin, role: "admin" },
      jobId: job.id,
      source,
    });
    const hinted = items.find((item) => item.sourceThreadId === explicitId);
    expect(hinted?.status).toBe("blocked");
    expect(hinted?.ownershipEvidence.classification).toBe("explicit-unowned");
    expect(hinted?.destinationUserId).toBeNull();
    expect(hinted?.destinationUserId).not.toBe(admin);
  });

  test("approves a matching manifest hash and cancels without deleting staged rows", async () => {
    const admin = await seedUser("admin");
    const job = await store.createJob({
      actor: { id: admin, role: "admin" },
      sourceNamespace: "ns-a",
      sourceOrigin: "https://intelligence.example.test",
      sourceReference: "proj-1",
      explicitPairs: [],
    });
    created.jobs.push(job.id);
    await expect(
      store.approveManifest(
        { id: admin, role: "admin" },
        job.id,
        capturedContentHash(job.manifest),
      ),
    ).rejects.toBeInstanceOf(ImportJobConflictError);
    const inventoried = await store.runInventory({
      actor: { id: admin, role: "admin" },
      jobId: job.id,
      source: pagingSource(admin, "", [{ threads: [], nextCursor: null }]),
    });
    const hash = capturedContentHash(inventoried.job.manifest);
    const approved = await store.approveManifest(
      { id: admin, role: "admin" },
      job.id,
      hash,
    );
    expect(approved.approvedManifestHash).toBe(hash);
    await expect(
      store.approveManifest({ id: admin, role: "admin" }, job.id, "deadbeef"),
    ).rejects.toBeInstanceOf(ImportJobConflictError);
    const cancelled = await store.cancelJob(
      { id: admin, role: "admin" },
      job.id,
    );
    expect(cancelled.phase).toBe("cancelled");
  });

  test("reinventory gets a fresh revision even when count and metadata are unchanged", async () => {
    const admin = await seedUser("admin");
    const owner = await seedUser("owner");
    const agentId = await seedAgent("bot");
    const threadId = `${prefix}-revision-${randomUUID()}`;
    const _channelId = await seedMappedChannel(owner, agentId, threadId);
    const source = pagingSource(
      owner,
      agentId,
      [{ threads: [{ id: threadId, name: "same" }], nextCursor: null }],
      async () => ({
        ok: true,
        value: { id: threadId, name: "same", agentId },
      }),
    );
    const job = await store.createJob({
      actor: { id: admin, role: "admin" },
      sourceNamespace: "ns-a",
      sourceOrigin: "https://intelligence.example.test",
      sourceReference: "proj-1",
      explicitPairs: [{ userId: owner, agentId }],
    });
    created.jobs.push(job.id);

    const first = await store.runInventory({
      actor: { id: admin, role: "admin" },
      jobId: job.id,
      source,
    });
    const hash1 = capturedContentHash(first.job.manifest);
    await store.approveManifest({ id: admin, role: "admin" }, job.id, hash1);
    const second = await store.runInventory({
      actor: { id: admin, role: "admin" },
      jobId: job.id,
      source,
    });
    const hash2 = capturedContentHash(second.job.manifest);
    expect(second.job.manifest.threadCount).toBe(
      first.job.manifest.threadCount,
    );
    expect(second.job.manifest.notes).toEqual(first.job.manifest.notes);
    expect(second.job.manifest.inventoryRevision).toBeGreaterThan(
      first.job.manifest.inventoryRevision,
    );
    expect(hash2).not.toBe(hash1);
    expect(second.job.approvedManifestHash).toBeNull();
    await expect(
      store.approveManifest({ id: admin, role: "admin" }, job.id, hash1),
    ).rejects.toThrow(/hash|manifest/i);
  });

  test("refuses confirmation while inventory is in progress", async () => {
    const admin = await seedUser("admin");
    const owner = await seedUser("owner");
    const agentId = await seedAgent("bot");
    const threadId = `${prefix}-approval-race-${randomUUID()}`;
    const _channelId = await seedMappedChannel(owner, agentId, threadId);
    const source = pagingSource(
      owner,
      agentId,
      [{ threads: [{ id: threadId, name: "same" }], nextCursor: null }],
      async () => ({
        ok: true,
        value: { id: threadId, name: "same", agentId },
      }),
    );
    const job = await store.createJob({
      actor: { id: admin, role: "admin" },
      sourceNamespace: "ns-a",
      sourceOrigin: "https://intelligence.example.test",
      sourceReference: "proj-1",
      explicitPairs: [{ userId: owner, agentId }],
    });
    created.jobs.push(job.id);
    const first = await store.runInventory({
      actor: { id: admin, role: "admin" },
      jobId: job.id,
      source,
    });
    const hash1 = capturedContentHash(first.job.manifest);
    await store.approveManifest({ id: admin, role: "admin" }, job.id, hash1);

    // Force a fresh source page so the second inventory is genuinely in flight rather than resuming
    // an exhausted checkpoint without a network read.
    await database
      .update(conversationImportJobs)
      .set({ checkpoint: { pairs: [], probes: [] } })
      .where(eq(conversationImportJobs.id, job.id));
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blockedSource: ConversationImportSource = {
      ...source,
      async listThreads(params) {
        started();
        await gate;
        return source.listThreads(params);
      },
    };
    const running = store.runInventory({
      actor: { id: admin, role: "admin" },
      jobId: job.id,
      source: blockedSource,
    });
    let after: Awaited<typeof running>;
    await began;
    try {
      await expect(
        store.approveManifest({ id: admin, role: "admin" }, job.id, hash1),
      ).rejects.toThrow(/import attempt is active/i);
    } finally {
      release();
      after = await running;
    }
    expect(after.job.approvedManifestHash).toBeNull();
    expect(after.job.manifest.inventoryRevision).toBeGreaterThan(
      first.job.manifest.inventoryRevision,
    );
  });

  test("encrypts resources with job/item domain binding and omits keys from ciphertext JSON", async () => {
    const admin = await seedUser("admin");
    const owner = await seedUser("owner");
    const agentId = await seedAgent("bot");
    const threadId = `${prefix}-enc-${randomUUID()}`;
    const job = await store.createJob({
      actor: { id: admin, role: "admin" },
      sourceNamespace: "ns-a",
      sourceOrigin: "https://intelligence.example.test",
      sourceReference: "proj-1",
      explicitPairs: [{ userId: owner, agentId }],
    });
    created.jobs.push(job.id);
    const source = pagingSource(owner, agentId, [
      { threads: [{ id: threadId, name: "enc" }], nextCursor: null },
    ]);
    const inventoried = await store.runInventory({
      actor: { id: admin, role: "admin" },
      jobId: job.id,
      source,
    });
    const hash = capturedContentHash(inventoried.job.manifest);
    await store.approveManifest({ id: admin, role: "admin" }, job.id, hash);
    const admitted = await store.acquireAttempt({
      actor: { id: admin, role: "admin" },
      jobId: job.id,
      kind: "run",
      approvedManifestHash: hash,
    });
    const item = inventoried.items[0]!;
    const staged = await store.encryptItemResources({
      actor: { id: admin, role: "admin" },
      jobId: job.id,
      itemId: item.id,
      resources: {
        messages: [{ id: "m1", role: "user", content: "secret-transcript" }],
      },
      attempt: admitted.attempt,
      expectedPhase: "importing",
    });
    expect(staged.status).toBe("staged");
    expect(staged.hasEncryptedResources).toBe(true);
    const [row] = await database
      .select()
      .from(conversationImportItems)
      .where(eq(conversationImportItems.id, item.id));
    expect(row?.encryptedResources).not.toContain("secret-transcript");
    const decrypted = await store.decryptItemResources({
      actor: { id: admin, role: "admin" },
      jobId: job.id,
      itemId: item.id,
    });
    expect(decrypted).toEqual({
      messages: [{ id: "m1", role: "user", content: "secret-transcript" }],
    });
  });

  test("fences stale attempts from progress, item, publication, and phase writes", async () => {
    const admin = await seedUser("admin");
    const owner = await seedUser("owner");
    const agentId = await seedAgent("bot");
    const threadId = `${prefix}-stale-${randomUUID()}`;
    await seedMappedChannel(owner, agentId, threadId);
    const actor = { id: admin, role: "admin" as const };
    const job = await store.createJob({
      actor,
      sourceNamespace: "ns-a",
      sourceOrigin: "https://intelligence.example.test",
      sourceReference: "stale-attempt",
      explicitPairs: [{ userId: owner, agentId }],
    });
    created.jobs.push(job.id);
    const source = pagingSource(owner, agentId, [
      { threads: [{ id: threadId, name: "stale" }], nextCursor: null },
    ]);
    const inventoried = await store.runInventory({
      actor,
      jobId: job.id,
      source,
    });
    const item = inventoried.items[0];
    if (!item) throw new Error("missing imported item");
    const hash = capturedContentHash(inventoried.job.manifest);
    await store.approveManifest(actor, job.id, hash);
    const first = await store.acquireAttempt({
      actor,
      jobId: job.id,
      kind: "run",
      approvedManifestHash: hash,
    });
    await database
      .update(conversationImportJobs)
      .set({ attemptLeaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(conversationImportJobs.id, job.id));
    const resumed = await store.acquireAttempt({
      actor,
      jobId: job.id,
      kind: "run",
      approvedManifestHash: hash,
    });

    await expect(
      store.runInventory({
        actor,
        jobId: job.id,
        source,
        attempt: first.attempt,
      }),
    ).rejects.toBeInstanceOf(ImportJobConflictError);
    await expect(
      store.encryptItemResources({
        actor,
        jobId: job.id,
        itemId: item.id,
        resources: { messages: [] },
        attempt: first.attempt,
        expectedPhase: "importing",
      }),
    ).rejects.toBeInstanceOf(ImportJobConflictError);
    await expect(
      store.markItem({
        actor,
        jobId: job.id,
        itemId: item.id,
        status: "failed",
        failureCode: "stale-attempt",
        attempt: first.attempt,
        expectedPhase: "importing",
      }),
    ).rejects.toBeInstanceOf(ImportJobConflictError);
    await expect(
      store.publishImportedThread({
        actor,
        job: resumed.job,
        item,
        destinationThreadId: threadId,
        ownerUserId: owner,
        channelId: item.destinationChannelId,
        agentId,
        localReadiness: "history_only",
        messages: [],
        state: {},
        contentHash: "stale-content",
        converterVersion: 1,
        approvedManifestHash: hash,
        attempt: first.attempt,
        expectedPhase: "importing",
      }),
    ).rejects.toBeInstanceOf(ImportJobConflictError);
    await expect(
      store.updatePhase(actor, job.id, "completed_with_gaps", {
        attempt: first.attempt,
        expectedPhase: "importing",
        approvedManifestHash: hash,
        expectedInventoryRevision: resumed.job.manifest.inventoryRevision,
      }),
    ).rejects.toBeInstanceOf(ImportJobConflictError);
    const live = await store.getJob(actor, job.id);
    expect(live.attemptToken).toBe(resumed.attempt.token);
    expect(live.phase).toBe("importing");
    await store.cancelJob(actor, job.id);
    await expect(
      store.markItem({
        actor,
        jobId: job.id,
        itemId: item.id,
        status: "failed",
        failureCode: "cancelled",
        attempt: resumed.attempt,
        expectedPhase: "importing",
      }),
    ).rejects.toBeInstanceOf(ImportJobConflictError);
  });

  test("observes committed inventory progress without exposing source identifiers", async () => {
    const admin = await seedUser("admin");
    const agentId = await seedAgent("observe");
    const actor = { id: admin, role: "admin" as const };
    const threadId = `${prefix}-observe-thread-${randomUUID()}`;
    const observations: ConversationObservation[] = [];
    const observedStore = createConversationImportStore(database, {
      encryptionKey: KEY,
      observe: (observation) => observations.push(observation),
    });
    const job = await observedStore.createJob({
      actor,
      sourceNamespace: "observe-source",
      sourceOrigin: "https://intelligence.example.test",
      sourceReference: "observe-project",
      explicitPairs: [{ userId: admin, agentId }],
    });
    created.jobs.push(job.id);

    const result = await observedStore.runInventory({
      actor,
      jobId: job.id,
      source: pagingSource(admin, agentId, [
        { threads: [{ id: threadId, name: "observed" }], nextCursor: null },
      ]),
    });

    expect(
      observations.some(
        (observation) =>
          observation.operation === "inventory" &&
          observation.outcome === "pages" &&
          observation.count === 1,
      ),
    ).toBe(true);
    expect(
      observations.some(
        (observation) =>
          observation.operation === "inventory" &&
          observation.outcome === "pairs" &&
          observation.count === 1,
      ),
    ).toBe(true);
    expect(
      observations.some(
        (observation) =>
          observation.operation === "inventory" &&
          observation.outcome === "discovered" &&
          observation.count === 1,
      ),
    ).toBe(true);
    expect(
      observations.some(
        (observation) =>
          observation.operation === "inventory" &&
          observation.phase === result.job.phase &&
          observation.outcome === "completed",
      ),
    ).toBe(true);
    expect(JSON.stringify(observations)).not.toContain(threadId);
    expect(JSON.stringify(observations)).not.toContain(admin);

    const throwingStore = createConversationImportStore(database, {
      encryptionKey: KEY,
      observe: () => {
        throw new Error("observer failure");
      },
    });
    const throwingJob = await throwingStore.createJob({
      actor,
      sourceNamespace: "observe-source",
      sourceOrigin: "https://intelligence.example.test",
      sourceReference: "throwing-observer",
      explicitPairs: [{ userId: admin, agentId }],
    });
    created.jobs.push(throwingJob.id);
    await expect(
      throwingStore.runInventory({
        actor,
        jobId: throwingJob.id,
        source: pagingSource(admin, agentId, [
          { threads: [], nextCursor: null },
        ]),
      }),
    ).resolves.toMatchObject({
      job: { phase: "awaiting_confirmation" },
    });
  });
});
