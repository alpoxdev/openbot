import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createConversationImporter } from "../src/conversations/importer";
import { createConversationImportStore } from "../src/conversations/import-store";
import type { ConversationImportSource } from "../src/conversations/import-source";
import { capturedContentHash } from "../src/conversations/import-validation";
import { createConversationStore } from "../src/conversations/store";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelAgents,
  channelMemberships,
  channels,
  conversationBaselines,
  conversationImportItems,
  conversationImportJobs,
  conversationImportMappings,
  conversationThreads,
  intelligenceChannelMappings,
  userRoles,
  users,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const KEY = `${"A".repeat(43)}=`;
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const importStore = createConversationImportStore(database, {
  encryptionKey: KEY,
});
const conversations = createConversationStore(database);
const importer = createConversationImporter({
  database,
  importStore,
  conversations,
});
const prefix = `conv-imp-${randomUUID().slice(0, 8)}`;

const created = {
  users: [] as string[],
  channels: [] as string[],
  agents: [] as string[],
  jobs: [] as string[],
  threads: [] as string[],
};

afterEach(async () => {
  for (const id of created.jobs.splice(0)) {
    await database
      .delete(conversationImportMappings)
      .where(eq(conversationImportMappings.itemId, id))
      .catch(() => undefined);
    const items = await database
      .select({ id: conversationImportItems.id })
      .from(conversationImportItems)
      .where(eq(conversationImportItems.jobId, id));
    for (const item of items) {
      await database
        .delete(conversationImportMappings)
        .where(eq(conversationImportMappings.itemId, item.id));
    }
    await database
      .delete(conversationImportItems)
      .where(eq(conversationImportItems.jobId, id));
    await database
      .delete(conversationImportJobs)
      .where(eq(conversationImportJobs.id, id));
  }
  for (const id of created.threads.splice(0)) {
    await database
      .delete(conversationThreads)
      .where(eq(conversationThreads.id, id));
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
  await database
    .insert(agents)
    .values({ id, name: label, type: "built_in", configuration: {} });
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
  await database
    .insert(channels)
    .values({ id, name: "import", description: "fixture" });
  created.channels.push(id);
  await database.insert(channelMemberships).values({ channelId: id, userId });
  await database.insert(channelAgents).values({ channelId: id, agentId });
  await database
    .insert(intelligenceChannelMappings)
    .values({ userId, channelId: id, threadId });
  return id;
}

const TOOL_MESSAGES = [
  { id: "u1", role: "user", content: "please use the tool" },
  {
    id: "a1",
    role: "assistant",
    content: null,
    toolCalls: [{ id: "call-1", name: "lookup", args: '{"q":"x"}' }],
  },
  { id: "t1", role: "tool", content: "result", toolCallId: "call-1" },
  { id: "a2", role: "assistant", content: "done" },
];

function recordingSource(options: {
  owner: string;
  agentId: string;
  threadId: string;
  messages?: unknown[];
  secondMessages?: unknown[];
  writes?: string[];
  state?: { kind: "snapshot"; state: unknown; skippedDeltas: number };
  stateFailure?: Extract<
    Awaited<ReturnType<ConversationImportSource["getThreadState"]>>,
    { ok: false }
  >;
  metadata?: {
    agentId?: string;
    organizationId?: string;
    createdById?: string;
  };
  secondMetadata?: {
    agentId?: string;
    organizationId?: string;
    createdById?: string;
  };
  events?: {
    events: { type: string }[];
    decodeErrorRowIds: string[];
    truncated: boolean;
  };
  confirmMessages?: unknown[];
}): ConversationImportSource {
  const writes = options.writes ?? [];
  let messageReads = 0;
  let metadataReads = 0;
  return {
    async listThreads(params) {
      writes.push(`LIST ${params.userId}`);
      if (
        params.userId !== options.owner ||
        params.agentId !== options.agentId
      ) {
        return { ok: true, value: { threads: [], nextCursor: null } };
      }
      return {
        ok: true,
        value: {
          threads: [
            { id: options.threadId, name: "t", agentId: options.agentId },
          ],
          nextCursor: null,
        },
      };
    },
    async getThread(params) {
      writes.push(`GET ${params.threadId}`);
      if (params.threadId !== options.threadId) {
        return { ok: false, gap: "not-found", message: "missing" };
      }
      metadataReads += 1;
      const metadata =
        metadataReads > 1 ? options.secondMetadata : options.metadata;
      const agentId =
        metadata && "agentId" in metadata ? metadata.agentId : options.agentId;
      const createdById =
        metadata && "createdById" in metadata
          ? metadata.createdById
          : options.owner;
      return {
        ok: true,
        value: {
          id: options.threadId,
          name: "t",
          ...(agentId === undefined ? {} : { agentId }),
          ...(createdById === undefined ? {} : { createdById }),
          ...(metadata?.organizationId === undefined
            ? {}
            : { organizationId: metadata.organizationId }),
        },
      };
    },
    async getThreadMessages(params) {
      writes.push(`MESSAGES ${params.threadId}`);
      messageReads += 1;
      const payload =
        messageReads === 1
          ? (options.messages ?? TOOL_MESSAGES)
          : (options.confirmMessages ??
            options.secondMessages ??
            options.messages ??
            TOOL_MESSAGES);
      return { ok: true, value: { messages: payload as never } };
    },
    async getThreadEvents() {
      writes.push("EVENTS");
      if (options.events) return { ok: true, value: options.events };
      return { ok: false, gap: "unavailable", message: "debug off" };
    },
    async getThreadState() {
      writes.push("STATE");
      if (options.stateFailure) return options.stateFailure;
      if (options.state) return { ok: true, value: options.state };
      return { ok: false, gap: "no-snapshot", message: "none" };
    },
  };
}

describe("conversation importer", () => {
  test("captures, publishes, and reads back offline; retry is unchanged", async () => {
    const admin = await seedUser("admin");
    const owner = await seedUser("owner");
    const agentId = await seedAgent("bot");
    const threadId = `${prefix}-thread-${randomUUID()}`;
    created.threads.push(threadId);
    await seedMappedChannel(owner, agentId, threadId);
    const writes: string[] = [];
    const source = recordingSource({
      owner,
      agentId,
      threadId,
      writes,
      // Only an explicitly inert state can seed a runnable local continuation.
      state: { kind: "snapshot", state: {}, skippedDeltas: 0 },
      events: {
        events: [{ type: "TEXT_MESSAGE_START" }],
        decodeErrorRowIds: [],
        truncated: false,
      },
    });
    const job = await importStore.createJob({
      actor: { id: admin, role: "admin" },
      sourceNamespace: "ns-a",
      sourceOrigin: "https://intelligence.example.test",
      sourceReference: "proj",
      explicitPairs: [{ userId: owner, agentId }],
    });
    created.jobs.push(job.id);
    await importStore.runInventory({
      actor: { id: admin, role: "admin" },
      jobId: job.id,
      source,
    });
    const ready = await importStore.getJob(
      { id: admin, role: "admin" },
      job.id,
    );
    const hash = capturedContentHash(ready.manifest);
    await importStore.approveManifest(
      { id: admin, role: "admin" },
      job.id,
      hash,
    );
    const summary = await importer.runApprovedImport({
      actor: { id: admin, role: "admin" },
      jobId: job.id,
      approvedManifestHash: hash,
      source,
    });
    expect(summary.phase).toBe("completed");
    expect(summary.counts.published).toBe(1);
    expect(JSON.stringify(summary)).not.toContain("please use the tool");
    expect(
      writes.some(
        (entry) => entry.startsWith("PATCH") || entry.startsWith("POST"),
      ),
    ).toBe(false);

    const snapshot = await conversations.readSnapshot({ id: owner }, threadId);
    expect(snapshot.thread.provenance).toBe("imported");
    expect(snapshot.thread.ownerUserId).toBe(owner);
    expect(snapshot.snapshot.messages.length).toBeGreaterThan(1);

    const retry = await importer.runApprovedImport({
      actor: { id: admin, role: "admin" },
      jobId: job.id,
      approvedManifestHash: hash,
      source,
    });
    expect(retry.counts.unchanged).toBe(1);
    expect(retry.phase).toBe("completed");
  });

  test("cross-job same-source races publish once and mark the loser unchanged", async () => {
    const admin = await seedUser("admin");
    const owner = await seedUser("owner");
    const agentId = await seedAgent("bot");
    const threadId = `${prefix}-cross-job-${randomUUID()}`;
    await seedMappedChannel(owner, agentId, threadId);
    created.threads.push(threadId);
    const sourceOptions = {
      owner,
      agentId,
      threadId,
      state: { kind: "snapshot" as const, state: {}, skippedDeltas: 0 },
      events: {
        events: [{ type: "TEXT_MESSAGE_START" }],
        decodeErrorRowIds: [],
        truncated: false,
      },
    };
    let atFirstRead = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    const makeSource = () => {
      const base = recordingSource(sourceOptions);
      let firstRead = true;
      return {
        ...base,
        async getThreadMessages(
          params: Parameters<typeof base.getThreadMessages>[0],
        ) {
          const result = await base.getThreadMessages(params);
          if (firstRead) {
            firstRead = false;
            atFirstRead += 1;
            if (atFirstRead === 2) release();
            await bothRead;
          }
          return result;
        },
      } satisfies ConversationImportSource;
    };
    const actor = { id: admin, role: "admin" as const };
    const firstJob = await importStore.createJob({
      actor,
      sourceNamespace: "ns-a",
      sourceOrigin: "https://intelligence.example.test",
      sourceReference: "cross-job",
      explicitPairs: [{ userId: owner, agentId }],
    });
    const secondJob = await importStore.createJob({
      actor,
      sourceNamespace: "ns-a",
      sourceOrigin: "https://intelligence.example.test",
      sourceReference: "cross-job",
      explicitPairs: [{ userId: owner, agentId }],
    });
    created.jobs.push(firstJob.id, secondJob.id);
    await importStore.runInventory({
      actor,
      jobId: firstJob.id,
      source: makeSource(),
    });
    await importStore.runInventory({
      actor,
      jobId: secondJob.id,
      source: makeSource(),
    });
    for (const jobId of [firstJob.id, secondJob.id]) {
      const ready = await importStore.getJob(actor, jobId);
      await importStore.approveManifest(
        actor,
        jobId,
        capturedContentHash(ready.manifest),
      );
    }
    const firstReady = await importStore.getJob(actor, firstJob.id);
    const secondReady = await importStore.getJob(actor, secondJob.id);
    const [first, second] = await Promise.all([
      importer.runApprovedImport({
        actor,
        jobId: firstJob.id,
        approvedManifestHash: capturedContentHash(firstReady.manifest),
        source: makeSource(),
      }),
      importer.runApprovedImport({
        actor,
        jobId: secondJob.id,
        approvedManifestHash: capturedContentHash(secondReady.manifest),
        source: makeSource(),
      }),
    ]);
    expect(atFirstRead).toBe(2);
    expect([first.counts.published, second.counts.published].sort()).toEqual([
      0, 1,
    ]);
    expect([first.counts.unchanged, second.counts.unchanged].sort()).toEqual([
      0, 1,
    ]);
    expect(first.phase).toBe("completed");
    expect(second.phase).toBe("completed");
  });

  test("source-changed second read does not overwrite", async () => {
    const admin = await seedUser("admin");
    const owner = await seedUser("owner");
    const agentId = await seedAgent("bot");
    const threadId = `${prefix}-chg-${randomUUID()}`;
    created.threads.push(threadId);
    await seedMappedChannel(owner, agentId, threadId);
    const source = recordingSource({
      owner,
      agentId,
      threadId,
      messages: TOOL_MESSAGES,
      secondMessages: [{ id: "u1", role: "user", content: "changed" }],
    });
    const job = await importStore.createJob({
      actor: { id: admin, role: "admin" },
      sourceNamespace: "ns-a",
      sourceOrigin: "https://intelligence.example.test",
      sourceReference: "proj",
      explicitPairs: [{ userId: owner, agentId }],
    });
    created.jobs.push(job.id);
    await importStore.runInventory({
      actor: { id: admin, role: "admin" },
      jobId: job.id,
      source,
    });
    const ready = await importStore.getJob(
      { id: admin, role: "admin" },
      job.id,
    );
    const hash = capturedContentHash(ready.manifest);
    await importStore.approveManifest(
      { id: admin, role: "admin" },
      job.id,
      hash,
    );
    const summary = await importer.runApprovedImport({
      actor: { id: admin, role: "admin" },
      jobId: job.id,
      approvedManifestHash: hash,
      source,
    });
    expect(summary.counts.sourceChanged).toBe(1);
    expect(summary.phase).toBe("completed_with_gaps");
  });

  test("fetched agent disagreement is quarantined instead of publishing under inventory agent", async () => {
    const admin = await seedUser("admin");
    const owner = await seedUser("owner");
    const inventoryAgent = await seedAgent("inventory-agent");
    const threadId = `${prefix}-agent-conflict-${randomUUID()}`;
    created.threads.push(threadId);
    await seedMappedChannel(owner, inventoryAgent, threadId);
    const source = recordingSource({
      owner,
      agentId: inventoryAgent,
      threadId,
      metadata: { agentId: `${inventoryAgent}-different` },
    });
    const actor = { id: admin, role: "admin" as const };
    const job = await importStore.createJob({
      actor,
      sourceNamespace: "ns-a",
      sourceOrigin: "https://intelligence.example.test",
      sourceReference: "agent-conflict",
      explicitPairs: [{ userId: owner, agentId: inventoryAgent }],
    });
    created.jobs.push(job.id);
    await importStore.runInventory({ actor, jobId: job.id, source });
    const ready = await importStore.getJob(actor, job.id);
    const hash = capturedContentHash(ready.manifest);
    await importStore.approveManifest(actor, job.id, hash);

    const summary = await importer.runApprovedImport({
      actor,
      jobId: job.id,
      approvedManifestHash: hash,
      source,
    });
    expect(summary.counts.blocked).toBe(1);
    expect(summary.counts.published).toBe(0);
    await expect(
      conversations.readSnapshot({ id: owner }, threadId),
    ).rejects.toThrow();
  });

  test("missing fetched agent metadata remains a history-only import", async () => {
    const admin = await seedUser("admin");
    const owner = await seedUser("owner");
    const agentId = await seedAgent("historical-agent", true);
    const threadId = `${prefix}-missing-agent-${randomUUID()}`;
    created.threads.push(threadId);
    await seedMappedChannel(owner, agentId, threadId);
    const source = recordingSource({
      owner,
      agentId,
      threadId,
      metadata: { agentId: undefined },
      secondMetadata: { agentId: undefined },
      state: { kind: "snapshot", state: {}, skippedDeltas: 0 },
      events: {
        events: [{ type: "TEXT_MESSAGE_START" }],
        decodeErrorRowIds: [],
        truncated: false,
      },
    });
    const actor = { id: admin, role: "admin" as const };
    const job = await importStore.createJob({
      actor,
      sourceNamespace: "ns-a",
      sourceOrigin: "https://intelligence.example.test",
      sourceReference: "missing-agent",
      explicitPairs: [{ userId: owner, agentId }],
    });
    created.jobs.push(job.id);
    await importStore.runInventory({ actor, jobId: job.id, source });
    const ready = await importStore.getJob(actor, job.id);
    const hash = capturedContentHash(ready.manifest);
    await importStore.approveManifest(actor, job.id, hash);

    const summary = await importer.runApprovedImport({
      actor,
      jobId: job.id,
      approvedManifestHash: hash,
      source,
    });
    expect(summary.counts.published).toBe(1);
    expect(summary.phase).toBe("completed_with_gaps");
    const snapshot = await conversations.readSnapshot({ id: owner }, threadId);
    expect(snapshot.thread.localReadiness).toBe("history_only");
  });

  test("organization disagreement across capture reads fails before publication", async () => {
    const admin = await seedUser("admin");
    const owner = await seedUser("owner");
    const agentId = await seedAgent("org-agent");
    const threadId = `${prefix}-org-conflict-${randomUUID()}`;
    created.threads.push(threadId);
    await seedMappedChannel(owner, agentId, threadId);
    const source = recordingSource({
      owner,
      agentId,
      threadId,
      metadata: { organizationId: "organization-a" },
      secondMetadata: { organizationId: "organization-b" },
    });
    const actor = { id: admin, role: "admin" as const };
    const job = await importStore.createJob({
      actor,
      sourceNamespace: "ns-a",
      sourceOrigin: "https://intelligence.example.test",
      sourceReference: "organization-conflict",
      explicitPairs: [{ userId: owner, agentId }],
    });
    created.jobs.push(job.id);
    await importStore.runInventory({ actor, jobId: job.id, source });
    const ready = await importStore.getJob(actor, job.id);
    const hash = capturedContentHash(ready.manifest);
    await importStore.approveManifest(actor, job.id, hash);

    const summary = await importer.runApprovedImport({
      actor,
      jobId: job.id,
      approvedManifestHash: hash,
      source,
    });
    expect(summary.counts.sourceChanged).toBe(1);
    expect(summary.counts.published).toBe(0);
    await expect(
      conversations.readSnapshot({ id: owner }, threadId),
    ).rejects.toThrow();
  });

  test("contradictory source query user cannot justify publication to mapped owner", async () => {
    const admin = await seedUser("admin");
    const mappedOwner = await seedUser("mapped-owner");
    const queriedUser = await seedUser("queried-user");
    const agentId = await seedAgent("owner-agent");
    const threadId = `${prefix}-owner-conflict-${randomUUID()}`;
    created.threads.push(threadId);
    const channelId = await seedMappedChannel(mappedOwner, agentId, threadId);
    const source = recordingSource({
      owner: queriedUser,
      agentId,
      threadId,
    });
    const actor = { id: admin, role: "admin" as const };
    const job = await importStore.createJob({
      actor,
      sourceNamespace: "ns-a",
      sourceOrigin: "https://intelligence.example.test",
      sourceReference: "owner-conflict",
      explicitPairs: [{ userId: queriedUser, agentId }],
    });
    created.jobs.push(job.id);
    await importStore.runInventory({ actor, jobId: job.id, source });
    const [item] = await importStore.listItems(actor, job.id);
    if (!item) throw new Error("missing imported item");
    // Inventory normally blocks this contradictory pairing. Keep the item shape otherwise
    // unchanged to probe the importer defense if stale/hand-edited inventory reaches it.
    await database
      .update(conversationImportItems)
      .set({
        status: "discovered",
        destinationUserId: mappedOwner,
        destinationChannelId: channelId,
        ownershipEvidence: {
          classification: "mapped",
          mappingUserId: mappedOwner,
          mappingChannelId: channelId,
          mappingThreadId: threadId,
          notes: [],
        },
      })
      .where(eq(conversationImportItems.id, item.id));
    const ready = await importStore.getJob(actor, job.id);
    const hash = capturedContentHash(ready.manifest);
    await importStore.approveManifest(actor, job.id, hash);

    const summary = await importer.runApprovedImport({
      actor,
      jobId: job.id,
      approvedManifestHash: hash,
      source,
    });
    expect(summary.counts.blocked).toBe(1);
    expect(summary.counts.published).toBe(0);
    await expect(
      conversations.readSnapshot({ id: mappedOwner }, threadId),
    ).rejects.toThrow();
  });

  test("reinventory clears a stale approval and rejects the old manifest hash", async () => {
    const admin = await seedUser("admin");
    const owner = await seedUser("owner");
    const agentId = await seedAgent("bot");
    const firstThreadId = `${prefix}-manifest-one-${randomUUID()}`;
    const secondThreadId = `${prefix}-manifest-two-${randomUUID()}`;
    created.threads.push(firstThreadId, secondThreadId);
    await seedMappedChannel(owner, agentId, firstThreadId);
    const source = recordingSource({ owner, agentId, threadId: firstThreadId });
    const changedSource: ConversationImportSource = {
      ...source,
      async listThreads(params) {
        const listed = await source.listThreads(params);
        if (
          params.userId !== owner ||
          params.agentId !== agentId ||
          !listed.ok
        ) {
          return listed;
        }
        return {
          ok: true,
          value: {
            threads: [
              ...listed.value.threads,
              { id: secondThreadId, name: "new", agentId },
            ],
            nextCursor: null,
          },
        };
      },
    };
    const job = await importStore.createJob({
      actor: { id: admin, role: "admin" },
      sourceNamespace: "ns-a",
      sourceOrigin: "https://intelligence.example.test",
      sourceReference: "proj",
      explicitPairs: [{ userId: owner, agentId }],
    });
    created.jobs.push(job.id);
    const first = await importStore.runInventory({
      actor: { id: admin, role: "admin" },
      jobId: job.id,
      source,
    });
    const hash1 = capturedContentHash(first.job.manifest);
    await importStore.approveManifest(
      { id: admin, role: "admin" },
      job.id,
      hash1,
    );

    // A fresh inventory session may be requested after an earlier complete inventory. Reset only the
    // durable cursor checkpoint, not staged items or the approval, to model that explicit re-scan.
    await database
      .update(conversationImportJobs)
      .set({ checkpoint: { pairs: [], probes: [] } })
      .where(eq(conversationImportJobs.id, job.id));
    const second = await importStore.runInventory({
      actor: { id: admin, role: "admin" },
      jobId: job.id,
      source: changedSource,
    });
    expect(capturedContentHash(second.job.manifest)).not.toBe(hash1);
    expect(second.job.approvedManifestHash).toBeNull();
    await expect(
      importer.runApprovedImport({
        actor: { id: admin, role: "admin" },
        jobId: job.id,
        approvedManifestHash: hash1,
        source: changedSource,
      }),
    ).rejects.toThrow(/current inventory|approved manifest/i);
  });

  test("owner B cannot read owner A imported history", async () => {
    const admin = await seedUser("admin");
    const ownerA = await seedUser("a");
    const ownerB = await seedUser("b");
    const agentId = await seedAgent("bot");
    const threadId = `${prefix}-ab-${randomUUID()}`;
    created.threads.push(threadId);
    await seedMappedChannel(ownerA, agentId, threadId);
    const source = recordingSource({
      owner: ownerA,
      agentId,
      threadId,
      state: { kind: "snapshot", state: {}, skippedDeltas: 0 },
    });
    const job = await importStore.createJob({
      actor: { id: admin, role: "admin" },
      sourceNamespace: "ns-a",
      sourceOrigin: "https://intelligence.example.test",
      sourceReference: "proj",
      explicitPairs: [{ userId: ownerA, agentId }],
    });
    created.jobs.push(job.id);
    await importStore.runInventory({
      actor: { id: admin, role: "admin" },
      jobId: job.id,
      source,
    });
    const ready = await importStore.getJob(
      { id: admin, role: "admin" },
      job.id,
    );
    const hash = capturedContentHash(ready.manifest);
    await importStore.approveManifest(
      { id: admin, role: "admin" },
      job.id,
      hash,
    );
    await importer.runApprovedImport({
      actor: { id: admin, role: "admin" },
      jobId: job.id,
      approvedManifestHash: hash,
      source,
    });
    await expect(
      conversations.readSnapshot({ id: ownerB }, threadId),
    ).rejects.toThrow();
  });

  test("cancel before publish leaves no new destination thread", async () => {
    const admin = await seedUser("admin");
    const owner = await seedUser("owner");
    const agentId = await seedAgent("bot");
    const threadId = `${prefix}-can-${randomUUID()}`;
    created.threads.push(threadId);
    await seedMappedChannel(owner, agentId, threadId);
    const source = recordingSource({ owner, agentId, threadId });
    const job = await importStore.createJob({
      actor: { id: admin, role: "admin" },
      sourceNamespace: "ns-a",
      sourceOrigin: "https://intelligence.example.test",
      sourceReference: "proj",
      explicitPairs: [{ userId: owner, agentId }],
    });
    created.jobs.push(job.id);
    await importStore.runInventory({
      actor: { id: admin, role: "admin" },
      jobId: job.id,
      source,
    });
    const ready = await importStore.getJob(
      { id: admin, role: "admin" },
      job.id,
    );
    const hash = capturedContentHash(ready.manifest);
    await importStore.approveManifest(
      { id: admin, role: "admin" },
      job.id,
      hash,
    );
    await importStore.cancelJob({ id: admin, role: "admin" }, job.id);
    await expect(
      importer.runApprovedImport({
        actor: { id: admin, role: "admin" },
        jobId: job.id,
        approvedManifestHash: hash,
        source,
      }),
    ).rejects.toThrow(/cancelled/i);
    const [row] = await database
      .select()
      .from(conversationThreads)
      .where(eq(conversationThreads.id, threadId));
    expect(row).toBeUndefined();
  });

  test("all blocked inventory completes with gaps, not success", async () => {
    const admin = await seedUser("admin");
    const owner = await seedUser("owner");
    const agentId = await seedAgent("bot");
    const threadId = `${prefix}-blk-${randomUUID()}`;
    created.threads.push(threadId);
    const source = recordingSource({ owner, agentId, threadId });
    const job = await importStore.createJob({
      actor: { id: admin, role: "admin" },
      sourceNamespace: "ns-a",
      sourceOrigin: "https://intelligence.example.test",
      sourceReference: "proj",
      explicitPairs: [{ userId: owner, agentId }],
      explicitIds: [{ threadId, userId: owner }],
    });
    created.jobs.push(job.id);
    await importStore.runInventory({
      actor: { id: admin, role: "admin" },
      jobId: job.id,
      source,
    });
    const ready = await importStore.getJob(
      { id: admin, role: "admin" },
      job.id,
    );
    const hash = capturedContentHash(ready.manifest);
    await importStore.approveManifest(
      { id: admin, role: "admin" },
      job.id,
      hash,
    );
    const summary = await importer.runApprovedImport({
      actor: { id: admin, role: "admin" },
      jobId: job.id,
      approvedManifestHash: hash,
      source,
    });
    expect(summary.counts.selected).toBeGreaterThan(0);
    expect(summary.counts.blocked).toBeGreaterThan(0);
    expect(summary.phase).toBe("completed_with_gaps");
  });

  test("missing events and state remain explicit gaps after publish", async () => {
    const admin = await seedUser("admin");
    const owner = await seedUser("owner");
    const agentId = await seedAgent("bot");
    const threadId = `${prefix}-gap-${randomUUID()}`;
    created.threads.push(threadId);
    await seedMappedChannel(owner, agentId, threadId);
    const source = recordingSource({ owner, agentId, threadId });
    const job = await importStore.createJob({
      actor: { id: admin, role: "admin" },
      sourceNamespace: "ns-a",
      sourceOrigin: "https://intelligence.example.test",
      sourceReference: "proj",
      explicitPairs: [{ userId: owner, agentId }],
    });
    created.jobs.push(job.id);
    await importStore.runInventory({
      actor: { id: admin, role: "admin" },
      jobId: job.id,
      source,
    });
    const ready = await importStore.getJob(
      { id: admin, role: "admin" },
      job.id,
    );
    const hash = capturedContentHash(ready.manifest);
    await importStore.approveManifest(
      { id: admin, role: "admin" },
      job.id,
      hash,
    );
    const summary = await importer.runApprovedImport({
      actor: { id: admin, role: "admin" },
      jobId: job.id,
      approvedManifestHash: hash,
      source,
    });
    expect(summary.counts.published).toBe(1);
    expect(summary.phase).toBe("completed_with_gaps");
    expect(summary.coverage.resourceGaps).toBe(true);
    expect(summary.coverage.historyOnly).toBe(true);
  });

  test("opaque source state is encrypted evidence, not runnable local state, and retry retains the gap", async () => {
    const admin = await seedUser("admin");
    const owner = await seedUser("owner");
    const agentId = await seedAgent("bot");
    const threadId = `${prefix}-opaque-${randomUUID()}`;
    created.threads.push(threadId);
    await seedMappedChannel(owner, agentId, threadId);
    const source = recordingSource({
      owner,
      agentId,
      threadId,
      state: {
        kind: "snapshot",
        state: { oldRunAssertion: "secret", pendingInterrupt: { id: "i1" } },
        skippedDeltas: 0,
      },
      events: {
        events: [{ type: "TEXT_MESSAGE_START" }],
        decodeErrorRowIds: [],
        truncated: false,
      },
    });
    const job = await importStore.createJob({
      actor: { id: admin, role: "admin" },
      sourceNamespace: "ns-a",
      sourceOrigin: "https://intelligence.example.test",
      sourceReference: "proj",
      explicitPairs: [{ userId: owner, agentId }],
    });
    created.jobs.push(job.id);
    await importStore.runInventory({
      actor: { id: admin, role: "admin" },
      jobId: job.id,
      source,
    });
    const ready = await importStore.getJob(
      { id: admin, role: "admin" },
      job.id,
    );
    const hash = capturedContentHash(ready.manifest);
    await importStore.approveManifest(
      { id: admin, role: "admin" },
      job.id,
      hash,
    );

    const summary = await importer.runApprovedImport({
      actor: { id: admin, role: "admin" },
      jobId: job.id,
      approvedManifestHash: hash,
      source,
    });
    expect(summary.phase).toBe("completed_with_gaps");
    expect(summary.coverage.historyOnly).toBe(true);
    const snapshot = await conversations.readSnapshot({ id: owner }, threadId);
    expect(snapshot.thread.localReadiness).toBe("history_only");
    expect(snapshot.snapshot.state).toEqual({});
    const item = (
      await importStore.listItems({ id: admin, role: "admin" }, job.id)
    )[0];
    if (!item) throw new Error("missing imported item");
    await expect(
      importStore.decryptItemResources({
        actor: { id: admin, role: "admin" },
        jobId: job.id,
        itemId: item.id,
      }),
    ).resolves.toMatchObject({
      state: {
        kind: "snapshot",
        state: { oldRunAssertion: "secret", pendingInterrupt: { id: "i1" } },
      },
    });

    const retry = await importer.runApprovedImport({
      actor: { id: admin, role: "admin" },
      jobId: job.id,
      approvedManifestHash: hash,
      source,
    });
    expect(retry.counts.unchanged).toBe(1);
    expect(retry.phase).toBe("completed_with_gaps");
    expect(retry.coverage.historyOnly).toBe(true);
    expect(retry.coverage.resourceGaps).toBe(true);
  });

  test("skipped-delta state diagnostics stay out of plaintext coverage", async () => {
    const admin = await seedUser("admin");
    const owner = await seedUser("owner");
    const agentId = await seedAgent("bot");
    const threadId = `${prefix}-skipped-${randomUUID()}`;
    created.threads.push(threadId);
    await seedMappedChannel(owner, agentId, threadId);
    const canaries = {
      secret: "state-secret-canary",
      message: "state-message-canary",
      tool: "state-tool-canary",
      assertion: "state-assertion-canary",
    };
    const source = recordingSource({
      owner,
      agentId,
      threadId,
      stateFailure: {
        ok: false,
        gap: "skipped-deltas",
        message: "state diagnostic is unavailable",
        details: {
          skippedDeltas: 3,
          state: {
            secret: canaries.secret,
            message: canaries.message,
            tool: { name: canaries.tool },
            assertion: canaries.assertion,
          },
        },
      },
      events: {
        events: [{ type: "TEXT_MESSAGE_START" }],
        decodeErrorRowIds: [],
        truncated: false,
      },
    });
    const actor = { id: admin, role: "admin" as const };
    const job = await importStore.createJob({
      actor,
      sourceNamespace: "ns-a",
      sourceOrigin: "https://intelligence.example.test",
      sourceReference: "proj",
      explicitPairs: [{ userId: owner, agentId }],
    });
    created.jobs.push(job.id);
    await importStore.runInventory({ actor, jobId: job.id, source });
    const ready = await importStore.getJob(actor, job.id);
    const hash = capturedContentHash(ready.manifest);
    await importStore.approveManifest(actor, job.id, hash);

    const summary = await importer.runApprovedImport({
      actor,
      jobId: job.id,
      approvedManifestHash: hash,
      source,
    });
    expect(summary.phase).toBe("completed_with_gaps");

    const item = (await importStore.listItems(actor, job.id))[0];
    if (!item) throw new Error("missing imported item");
    expect(item.coverage.state).toEqual({
      available: false,
      gap: "skipped-deltas",
      skippedDeltas: 3,
    });
    const coverage = JSON.stringify(item.coverage);
    for (const canary of Object.values(canaries)) {
      expect(coverage).not.toContain(canary);
    }

    await expect(
      importStore.decryptItemResources({
        actor,
        jobId: job.id,
        itemId: item.id,
      }),
    ).resolves.toMatchObject({
      state: {
        gap: "skipped-deltas",
        details: {
          skippedDeltas: 3,
          state: {
            secret: canaries.secret,
            message: canaries.message,
            tool: { name: canaries.tool },
            assertion: canaries.assertion,
          },
        },
      },
    });
  });

  test("mapping with another origin or owner is a destination conflict", async () => {
    const admin = await seedUser("admin");
    const owner = await seedUser("owner");
    const other = await seedUser("other");
    const agentId = await seedAgent("bot");
    const threadId = `${prefix}-conf-${randomUUID()}`;
    created.threads.push(threadId);
    await seedMappedChannel(owner, agentId, threadId);
    const source = recordingSource({
      owner,
      agentId,
      threadId,
      state: { kind: "snapshot", state: { step: 1 }, skippedDeltas: 0 },
      events: {
        events: [{ type: "TEXT_MESSAGE_START" }],
        decodeErrorRowIds: [],
        truncated: false,
      },
    });
    const job = await importStore.createJob({
      actor: { id: admin, role: "admin" },
      sourceNamespace: "ns-a",
      sourceOrigin: "https://intelligence.example.test",
      sourceReference: "proj",
      explicitPairs: [{ userId: owner, agentId }],
    });
    created.jobs.push(job.id);
    await importStore.runInventory({
      actor: { id: admin, role: "admin" },
      jobId: job.id,
      source,
    });
    const items = await importStore.listItems(
      { id: admin, role: "admin" },
      job.id,
    );
    const item = items.find((row) => row.sourceThreadId === threadId);
    if (!item) throw new Error("missing item");
    await database.insert(conversationThreads).values({
      id: `${threadId}-other`,
      ownerUserId: other,
      provenance: "imported",
      localReadiness: "history_only",
    });
    created.threads.push(`${threadId}-other`);
    await database.insert(conversationBaselines).values({
      threadId: `${threadId}-other`,
      messages: [],
      state: {},
    });
    await database.insert(conversationImportMappings).values({
      sourceNamespace: "ns-a",
      sourceThreadId: threadId,
      sourceOrigin: "https://other.example.test",
      sourceUserId: other,
      destinationThreadId: `${threadId}-other`,
      itemId: item.id,
      contentHash: "not-the-same",
    });
    const ready = await importStore.getJob(
      { id: admin, role: "admin" },
      job.id,
    );
    const hash = capturedContentHash(ready.manifest);
    await importStore.approveManifest(
      { id: admin, role: "admin" },
      job.id,
      hash,
    );
    const summary = await importer.runApprovedImport({
      actor: { id: admin, role: "admin" },
      jobId: job.id,
      approvedManifestHash: hash,
      source,
    });
    expect(summary.counts.blocked).toBeGreaterThan(0);
    expect(summary.phase).toBe("completed_with_gaps");
    const destination = await conversations.readSnapshot(
      { id: other },
      `${threadId}-other`,
    );
    expect(destination.thread.ownerUserId).toBe(other);
    expect(destination.snapshot.messages).toEqual([]);
    const mapping = await importStore.existingMapping("ns-a", threadId);
    expect(mapping?.destinationThreadId).toBe(`${threadId}-other`);
  });

  test("cancel during importing is not overwritten by a later phase write", async () => {
    const admin = await seedUser("admin");
    const owner = await seedUser("owner");
    const agentId = await seedAgent("bot");
    const threadId = `${prefix}-race-${randomUUID()}`;
    created.threads.push(threadId);
    await seedMappedChannel(owner, agentId, threadId);
    const source = recordingSource({ owner, agentId, threadId });
    const job = await importStore.createJob({
      actor: { id: admin, role: "admin" },
      sourceNamespace: "ns-a",
      sourceOrigin: "https://intelligence.example.test",
      sourceReference: "proj",
      explicitPairs: [{ userId: owner, agentId }],
    });
    created.jobs.push(job.id);
    await importStore.runInventory({
      actor: { id: admin, role: "admin" },
      jobId: job.id,
      source,
    });
    const ready = await importStore.getJob(
      { id: admin, role: "admin" },
      job.id,
    );
    const hash = capturedContentHash(ready.manifest);
    await importStore.approveManifest(
      { id: admin, role: "admin" },
      job.id,
      hash,
    );
    const admitted = await importStore.acquireAttempt({
      actor: { id: admin, role: "admin" },
      jobId: job.id,
      kind: "run",
      approvedManifestHash: hash,
    });
    await importStore.cancelJob({ id: admin, role: "admin" }, job.id);
    await expect(
      importStore.updatePhase(
        { id: admin, role: "admin" },
        job.id,
        "completed_with_gaps",
        {
          attempt: admitted.attempt,
          expectedPhase: "importing",
          approvedManifestHash: hash,
          expectedInventoryRevision: ready.manifest.inventoryRevision,
        },
      ),
    ).rejects.toThrow(/lease|phase|cancelled/i);
    const live = await importStore.getJob({ id: admin, role: "admin" }, job.id);
    expect(live.phase).toBe("cancelled");
  });
});
