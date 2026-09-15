import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createConversationStore } from "../src/conversations/store";
import { createAgentProfileStore } from "../src/agents/profile-store";
import {
  ConversationAccessError,
  ConversationConflictError,
  ConversationLeaseError,
} from "../src/conversations/types";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelAgents,
  channelMemberships,
  channels,
  conversationEvents,
  conversationRuns,
  conversationThreads,
  revokedAccess,
  userRoles,
  users,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createConversationStore(database);
const prefix = `conv-store-${randomUUID().slice(0, 8)}`;

const created = {
  users: [] as string[],
  channels: [] as string[],
  agents: [] as string[],
  threads: [] as string[],
  emails: [] as string[],
};

afterEach(async () => {
  for (const id of created.threads.splice(0)) {
    await database
      .delete(conversationThreads)
      .where(eq(conversationThreads.id, id));
  }
  for (const id of created.channels.splice(0)) {
    await database.delete(channels).where(eq(channels.id, id));
  }
  for (const id of created.agents.splice(0)) {
    await database.delete(agentProfiles).where(eq(agentProfiles.agentId, id));
    await database.delete(agents).where(eq(agents.id, id));
  }
  for (const email of created.emails.splice(0)) {
    await database.delete(revokedAccess).where(eq(revokedAccess.email, email));
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
  const email = `${id}@example.test`;
  await database.insert(users).values({ id, email });
  await database.insert(userRoles).values({ userId: id, role: "user" });
  created.users.push(id);
  return { id, email };
}

async function seedAgent(
  label: string,
  options: {
    ownerUserId?: string | null;
    visibility?: "public" | "private";
  } = {},
) {
  const id = `${prefix}-agent-${label}-${randomUUID()}`;
  await database.insert(agents).values({
    id,
    name: label,
    type: "built_in",
    configuration: {},
  });
  await database.insert(agentProfiles).values({
    agentId: id,
    ownerUserId: options.ownerUserId ?? null,
    title: `${label} fixture`,
    roleDescription: "Test",
    avatarSeed: id,
    visibility: options.visibility ?? "public",
  });
  created.agents.push(id);
  return id;
}

async function seedChannel(ownerId: string, agentId: string) {
  const id = `${prefix}-channel-${randomUUID()}`;
  await database.insert(channels).values({
    id,
    name: "Conversation store test",
    description: "fixture",
  });
  created.channels.push(id);
  await database.insert(channelMemberships).values({
    channelId: id,
    userId: ownerId,
  });
  await database.insert(channelAgents).values({ channelId: id, agentId });
  return id;
}

async function readyDirectThread(ownerId: string, agentId: string) {
  const threadId = `${prefix}-thread-${randomUUID()}`;
  created.threads.push(threadId);
  await store.createThread({
    id: threadId,
    ownerUserId: ownerId,
    agentId,
    provenance: "local",
  });
  await database
    .update(conversationThreads)
    .set({ localReadiness: "ready" })
    .where(eq(conversationThreads.id, threadId));
  return threadId;
}

describe("conversation store", () => {
  test("mint commits an authorized empty baseline and refuses private or deleted bots", async () => {
    const owner = await seedUser("mint-owner");
    const stranger = await seedUser("mint-stranger");
    const agentId = await seedAgent("mint", {
      ownerUserId: owner.id,
      visibility: "private",
    });
    const profiles = createAgentProfileStore(database, undefined);
    const threadId = `${prefix}-mint-${randomUUID()}`;
    created.threads.push(threadId);
    await store.createOwnedThread(
      { ...owner, role: "user" },
      threadId,
      agentId,
      profiles,
    );
    const snapshot = await store.readSnapshot(owner, threadId);
    expect(snapshot.thread.ownerUserId).toBe(owner.id);
    expect(snapshot.thread.agentId).toBe(agentId);
    expect(snapshot.thread.localReadiness).toBe("ready");
    expect(snapshot.snapshot.messages).toEqual([]);
    const forbiddenId = `${threadId}-forbidden`;
    await expect(
      store.createOwnedThread(
        { ...stranger, role: "user" },
        forbiddenId,
        agentId,
        profiles,
      ),
    ).rejects.toBeInstanceOf(ConversationAccessError);
    expect(
      await database
        .select()
        .from(conversationThreads)
        .where(eq(conversationThreads.id, forbiddenId)),
    ).toEqual([]);
    await database
      .update(agentProfiles)
      .set({ deletedAt: new Date() })
      .where(eq(agentProfiles.agentId, agentId));
    await expect(
      store.createOwnedThread(
        { ...owner, role: "user" },
        `${threadId}-deleted`,
        agentId,
        profiles,
      ),
    ).rejects.toBeInstanceOf(ConversationAccessError);
    expect(
      (await store.readSnapshot(owner, threadId)).snapshot.messages,
    ).toEqual([]);
  });

  test("creates a thread, publishes a baseline, and projects the committed tail", async () => {
    const owner = await seedUser("owner");
    const agentId = await seedAgent("bot");
    const threadId = `${prefix}-thread-${randomUUID()}`;
    created.threads.push(threadId);
    await store.createThread({
      id: threadId,
      ownerUserId: owner.id,
      agentId,
      provenance: "local",
    });
    await store.publishBaseline({ id: owner.id }, threadId, {
      messages: [],
      state: {},
      baselineSequence: 0n,
    });
    await database
      .update(conversationThreads)
      .set({ localReadiness: "ready" })
      .where(eq(conversationThreads.id, threadId));
    const acquired = await store.acquireRun(
      { id: owner.id },
      {
        threadId,
        runId: `${threadId}-run-1`,
        leaseOwner: "replica-a",
        leaseMs: 30_000,
      },
    );
    expect(acquired.outcome).toBe("acquired");
    if (acquired.outcome !== "acquired") throw new Error("expected acquire");
    const written = await store.appendEvents({
      threadId,
      runId: acquired.run.id,
      leaseOwner: "replica-a",
      generation: acquired.run.generation,
      events: [
        { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "hello" },
        { type: "TEXT_MESSAGE_END", messageId: "m1" },
      ],
    });
    expect(written[0]?.sequence).toBe(1n);
    const page = await store.readEventPage({ id: owner.id }, threadId, 0n);
    expect(page.map((event) => event.sequence)).toEqual([1n, 2n, 3n]);
    const snapshot = await store.readSnapshot({ id: owner.id }, threadId);
    expect(snapshot.baselineSequence).toBe(0n);
    expect(snapshot.latestSequence).toBe(3n);
    expect(
      snapshot.snapshot.messages.some((message) => message.id === "m1"),
    ).toBe(true);
  });

  test("rejects a duplicate thread id and does not re-execute a duplicate run id", async () => {
    const owner = await seedUser("dup");
    const agentId = await seedAgent("dup");
    const threadId = await readyDirectThread(owner.id, agentId);
    await expect(
      store.createThread({
        id: threadId,
        ownerUserId: owner.id,
        agentId,
        provenance: "local",
      }),
    ).rejects.toBeInstanceOf(ConversationConflictError);

    const runId = `${threadId}-run`;
    const first = await store.acquireRun(
      { id: owner.id },
      { threadId, runId, leaseOwner: "a", leaseMs: 30_000 },
    );
    expect(first.outcome).toBe("acquired");
    const second = await store.acquireRun(
      { id: owner.id },
      { threadId, runId, leaseOwner: "b", leaseMs: 30_000 },
    );
    expect(second.outcome).toBe("duplicate");
    const otherRun = await store.acquireRun(
      { id: owner.id },
      {
        threadId,
        runId: `${threadId}-run-2`,
        leaseOwner: "c",
        leaseMs: 30_000,
      },
    );
    expect(otherRun.outcome).toBe("collision");
  });

  test("foreign actors and revoked owners cannot read or run", async () => {
    const owner = await seedUser("own");
    const stranger = await seedUser("str");
    const agentId = await seedAgent("auth");
    const threadId = await readyDirectThread(owner.id, agentId);
    await expect(
      store.readSnapshot({ id: stranger.id }, threadId),
    ).rejects.toBeInstanceOf(ConversationAccessError);
    await expect(
      store.acquireRun(
        { id: stranger.id },
        { threadId, runId: `${threadId}-x`, leaseOwner: "x", leaseMs: 1000 },
      ),
    ).rejects.toBeInstanceOf(ConversationAccessError);

    created.emails.push(owner.email.toLowerCase());
    await database.insert(revokedAccess).values({
      email: owner.email.toLowerCase(),
      revokedBy: stranger.id,
    });
    expect((await store.list({ id: owner.id })).threads).toEqual([]);
    await expect(
      store.readSnapshot({ id: owner.id }, threadId),
    ).rejects.toBeInstanceOf(ConversationAccessError);
  });

  test("an actor without a live role cannot read an existing thread", async () => {
    const owner = await seedUser("role-missing");
    const agentId = await seedAgent("role-missing");
    const threadId = await readyDirectThread(owner.id, agentId);

    await database.delete(userRoles).where(eq(userRoles.userId, owner.id));

    expect(await store.authorize(owner, threadId, "history")).toBe("none");
    expect((await store.list(owner)).threads).toEqual([]);
    await expect(store.readSnapshot(owner, threadId)).rejects.toBeInstanceOf(
      ConversationAccessError,
    );
    await expect(
      store.acquireRun(owner, {
        threadId,
        runId: `${threadId}-missing-role`,
        leaseOwner: "missing-role",
        leaseMs: 1000,
      }),
    ).rejects.toBeInstanceOf(ConversationAccessError);
  });

  test("visibility and role changes are rechecked for existing channel threads", async () => {
    const owner = await seedUser("policy-owner");
    const admin = await seedUser("policy-admin");
    const publicAgentId = await seedAgent("policy-public");
    const publicThreadId = await readyDirectThread(owner.id, publicAgentId);
    expect(await store.authorize(owner, publicThreadId, "run")).toBe("run");
    await database
      .update(agentProfiles)
      .set({ visibility: "private" })
      .where(eq(agentProfiles.agentId, publicAgentId));
    expect(await store.authorize(owner, publicThreadId, "history")).toBe(
      "history",
    );
    expect(await store.authorize(owner, publicThreadId, "run")).toBe("history");

    const agentId = await seedAgent("policy-private", {
      ownerUserId: owner.id,
      visibility: "private",
    });
    const channelId = await seedChannel(owner.id, agentId);
    await database.insert(channelMemberships).values({
      channelId,
      userId: admin.id,
    });
    const threadId = `${prefix}-policy-${randomUUID()}`;
    created.threads.push(threadId);
    await store.createThread({
      id: threadId,
      ownerUserId: owner.id,
      channelId,
      agentId,
      provenance: "local",
      localReadiness: "ready",
    });

    await database
      .update(userRoles)
      .set({ role: "admin" })
      .where(eq(userRoles.userId, admin.id));
    expect(await store.authorize(admin, threadId, "run")).toBe("run");

    await database
      .update(userRoles)
      .set({ role: "user" })
      .where(eq(userRoles.userId, admin.id));
    expect(await store.authorize(admin, threadId, "history")).toBe("history");
    expect(await store.authorize(admin, threadId, "run")).toBe("history");
    await expect(
      store.acquireRun(admin, {
        threadId,
        runId: `${threadId}-demoted`,
        leaseOwner: "demoted",
        leaseMs: 1000,
      }),
    ).rejects.toBeInstanceOf(ConversationAccessError);

    expect(await store.authorize(owner, threadId, "run")).toBe("run");
  });

  test("a channel can run a different member bot without granting unrelated bots access", async () => {
    const owner = await seedUser("multi");
    const first = await seedAgent("first");
    const second = await seedAgent("second");
    const outside = await seedAgent("outside");
    const channelId = await seedChannel(owner.id, first);
    await database.insert(channelAgents).values({ channelId, agentId: second });
    const threadId = `${prefix}-multi-${randomUUID()}`;
    created.threads.push(threadId);
    await store.createThread({
      id: threadId,
      ownerUserId: owner.id,
      channelId,
      agentId: first,
      provenance: "local",
      localReadiness: "ready",
    });
    await database.delete(agents).where(eq(agents.id, first));
    expect(await store.authorize(owner, threadId, "run", second)).toBe("run");
    expect(await store.authorize(owner, threadId, "run", outside)).toBe("none");
    const acquired = await store.acquireRun(owner, {
      threadId,
      agentId: second,
      runId: `${threadId}-run`,
      leaseOwner: "replica",
      leaseMs: 10_000,
    });
    expect(acquired.outcome).toBe("acquired");
    expect(
      await store.requestStop({
        actor: owner,
        threadId,
        agentId: second,
        runId: `${threadId}-run`,
      }),
    ).toBe(true);
  });
  test("channel-bound history requires live membership; deleted channel is none", async () => {
    const owner = await seedUser("ch-own");
    const member = await seedUser("ch-mem");
    const agentId = await seedAgent("ch");
    const channelId = await seedChannel(owner.id, agentId);
    await database.insert(channelMemberships).values({
      channelId,
      userId: member.id,
    });
    const threadId = `${prefix}-ch-${randomUUID()}`;
    created.threads.push(threadId);
    await store.createThread({
      id: threadId,
      ownerUserId: owner.id,
      channelId,
      agentId,
      provenance: "local",
      localReadiness: "ready",
    });
    expect(await store.authorize({ id: member.id }, threadId, "history")).toBe(
      "history",
    );
    expect(await store.authorize({ id: member.id }, threadId, "run")).toBe(
      "run",
    );
    expect(await store.authorize({ id: owner.id }, threadId, "run")).toBe(
      "run",
    );

    await database
      .delete(channelMemberships)
      .where(eq(channelMemberships.userId, owner.id));
    expect(await store.authorize({ id: owner.id }, threadId, "history")).toBe(
      "none",
    );

    await database.insert(channelMemberships).values({
      channelId,
      userId: owner.id,
    });
    await database
      .update(channels)
      .set({ deletedAt: new Date() })
      .where(eq(channels.id, channelId));
    expect(await store.authorize({ id: member.id }, threadId, "run")).toBe(
      "none",
    );
    expect(await store.authorize({ id: owner.id }, threadId, "history")).toBe(
      "none",
    );
    await expect(
      store.acquireRun(
        { id: member.id },
        { threadId, runId: `${threadId}-gone`, leaseOwner: "m", leaseMs: 1000 },
      ),
    ).rejects.toBeInstanceOf(ConversationAccessError);
  });

  test("lists bounded previews with deterministic cursors and live ACL filters", async () => {
    const owner = await seedUser("page-owner");
    const member = await seedUser("page-member");
    const stranger = await seedUser("page-stranger");
    const firstAgent = await seedAgent("page-first");
    const secondAgent = await seedAgent("page-second");

    const makeThread = async (
      id: string,
      options: {
        ownerUserId: string;
        agentId: string;
        channelId?: string;
        preview?: string;
      },
    ) => {
      created.threads.push(id);
      await store.createThread({
        id,
        ownerUserId: options.ownerUserId,
        agentId: options.agentId,
        channelId: options.channelId,
        provenance: "local",
        localReadiness: "not_ready",
      });
      if (options.preview !== undefined) {
        await store.publishBaseline({ id: options.ownerUserId }, id, {
          messages: [
            {
              id: `${id}-message`,
              role: "user",
              content: options.preview,
            },
          ],
          state: {},
          baselineSequence: 0n,
        });
        await database
          .update(conversationThreads)
          .set({ localReadiness: "ready" })
          .where(eq(conversationThreads.id, id));
      }
    };

    const directIds = [
      `${prefix}-page-a`,
      `${prefix}-page-b`,
      `${prefix}-page-c`,
      `${prefix}-page-d`,
    ];
    for (const [index, id] of directIds.entries()) {
      await makeThread(id, {
        ownerUserId: owner.id,
        agentId: index % 2 === 0 ? firstAgent : secondAgent,
        preview: index === 1 ? "  opening preview  " : `preview-${index}`,
      });
    }
    for (const [index, id] of directIds.entries()) {
      await database
        .update(conversationThreads)
        .set({
          updatedAt: sql`${
            index < 2
              ? "2026-01-02 03:04:05.123456+00"
              : "2026-01-02 03:04:05.123455+00"
          }::timestamptz`,
        })
        .where(eq(conversationThreads.id, id));
    }

    const channelId = await seedChannel(owner.id, firstAgent);
    await database.insert(channelMemberships).values({
      channelId,
      userId: member.id,
    });
    const channelThreadId = `${prefix}-page-channel`;
    await makeThread(channelThreadId, {
      ownerUserId: owner.id,
      agentId: firstAgent,
      channelId,
    });
    const deletedChannelId = await seedChannel(owner.id, secondAgent);
    await database.insert(channelMemberships).values({
      channelId: deletedChannelId,
      userId: member.id,
    });
    const deletedThreadId = `${prefix}-page-deleted`;
    await makeThread(deletedThreadId, {
      ownerUserId: owner.id,
      agentId: secondAgent,
      channelId: deletedChannelId,
    });
    await database
      .update(channels)
      .set({ deletedAt: new Date() })
      .where(eq(channels.id, deletedChannelId));

    const foreignThreadId = `${prefix}-page-foreign`;
    await makeThread(foreignThreadId, {
      ownerUserId: stranger.id,
      agentId: firstAgent,
      preview: "not visible",
    });

    const firstPage = await store.list(owner, {
      directOnly: true,
      limit: 2,
    });
    expect(firstPage.threads).toHaveLength(2);
    expect(firstPage.threads.every((thread) => thread.channelId === null)).toBe(
      true,
    );
    expect(firstPage.threads[0]?.updatedAt).toEqual(
      firstPage.threads[1]?.updatedAt,
    );
    expect(firstPage.nextCursor).not.toBeNull();
    expect(firstPage.threads[0]?.preview).toBe("  opening preview  ");
    const cursorPayload = JSON.parse(
      Buffer.from(firstPage.nextCursor ?? "", "base64url").toString("utf8"),
    ) as { updatedAt?: string };
    expect(cursorPayload.updatedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}[+-]\d{2}:\d{2}$/,
    );
    expect(cursorPayload.updatedAt).toContain(".123456");

    const secondPage = await store.list(owner, {
      directOnly: true,
      limit: 2,
      cursor: firstPage.nextCursor ?? undefined,
    });
    const pagedIds = [
      ...firstPage.threads.map((thread) => thread.id),
      ...secondPage.threads.map((thread) => thread.id),
    ];
    expect(new Set(pagedIds).size).toBe(pagedIds.length);
    expect(pagedIds).toEqual([
      directIds[1],
      directIds[0],
      directIds[3],
      directIds[2],
    ]);
    expect(secondPage.nextCursor).toBeNull();
    expect(
      pagedIds.includes(foreignThreadId) ||
        pagedIds.includes(channelThreadId) ||
        pagedIds.includes(deletedThreadId),
    ).toBe(false);

    const filtered = await store.list(owner, {
      agentId: firstAgent,
      directOnly: true,
      limit: 100,
    });
    expect(filtered.threads.map((thread) => thread.agentId)).toEqual([
      firstAgent,
      firstAgent,
    ]);
    expect((await store.list(owner, { limit: 100_000 })).threads).toHaveLength(
      5,
    );

    const channelPage = await store.list(member, { limit: 100 });
    expect(channelPage.threads.map((thread) => thread.id)).toEqual([
      channelThreadId,
    ]);
    expect(
      (await store.list(stranger, { limit: 100 })).threads.map(
        (thread) => thread.id,
      ),
    ).toEqual([foreignThreadId]);
    await expect(
      store.list(owner, { cursor: "not-a-cursor" }),
    ).rejects.toBeInstanceOf(ConversationConflictError);
  });

  test("expired lease cannot append or finish after an explicit SQL expiry", async () => {
    const owner = await seedUser("lease");
    const agentId = await seedAgent("lease");
    const threadId = await readyDirectThread(owner.id, agentId);
    const acquired = await store.acquireRun(
      { id: owner.id },
      {
        threadId,
        runId: `${threadId}-run`,
        leaseOwner: "replica-a",
        leaseMs: 30_000,
      },
    );
    expect(acquired.outcome).toBe("acquired");
    if (acquired.outcome !== "acquired") throw new Error("expected acquire");
    await store.appendEvents({
      threadId,
      runId: acquired.run.id,
      leaseOwner: "replica-a",
      generation: acquired.run.generation,
      events: [{ type: "STEP_STARTED", stepName: "partial" }],
    });
    await database
      .update(conversationRuns)
      .set({ leaseUntil: sql`now() - interval '1 second'` })
      .where(eq(conversationRuns.id, acquired.run.id));
    await expect(
      store.appendEvents({
        threadId,
        runId: acquired.run.id,
        leaseOwner: "replica-a",
        generation: acquired.run.generation,
        events: [{ type: "STEP_FINISHED", stepName: "partial" }],
      }),
    ).rejects.toBeInstanceOf(ConversationLeaseError);
    await expect(
      store.finishRun({
        runId: acquired.run.id,
        leaseOwner: "replica-a",
        generation: acquired.run.generation,
        status: "completed",
      }),
    ).rejects.toBeInstanceOf(ConversationLeaseError);
    expect(await store.reapExpiredRuns()).toBeGreaterThan(0);
    const events = await database
      .select()
      .from(conversationEvents)
      .where(eq(conversationEvents.threadId, threadId));
    expect(events).toHaveLength(2);
    expect(events.at(-1)?.type).toBe("RUN_ERROR");
    expect(events.at(-1)?.runId).toBe(acquired.run.id);
    expect(events.at(-1)?.payload).toMatchObject({
      type: "RUN_ERROR",
      threadId,
      runId: acquired.run.id,
      code: "conversation_interrupted",
    });
    const [run] = await database
      .select()
      .from(conversationRuns)
      .where(eq(conversationRuns.id, acquired.run.id));
    expect(run.status).toBe("interrupted");
  });

  test("refuses a second baseline publish and stop/finish remain fenced", async () => {
    const owner = await seedUser("stop");
    const agentId = await seedAgent("stop");
    const threadId = `${prefix}-stop-${randomUUID()}`;
    created.threads.push(threadId);
    await store.createThread({
      id: threadId,
      ownerUserId: owner.id,
      agentId,
      provenance: "local",
    });
    await store.publishBaseline({ id: owner.id }, threadId, {
      messages: [],
      state: {},
      baselineSequence: 0n,
    });
    await expect(
      store.publishBaseline({ id: owner.id }, threadId, {
        messages: [{ id: "overwrite", role: "user", content: "no" }],
        state: {},
        baselineSequence: 0n,
      }),
    ).rejects.toBeInstanceOf(ConversationConflictError);
    await database
      .update(conversationThreads)
      .set({ localReadiness: "ready" })
      .where(eq(conversationThreads.id, threadId));
    const acquired = await store.acquireRun(
      { id: owner.id },
      {
        threadId,
        runId: `${threadId}-run`,
        leaseOwner: "replica-a",
        leaseMs: 30_000,
      },
    );
    if (acquired.outcome !== "acquired") throw new Error("expected acquire");
    expect(
      await store.requestStop({
        actor: { id: owner.id },
        threadId,
        runId: acquired.run.id,
      }),
    ).toBe(true);
    const active = await store.getActiveRun({ id: owner.id }, threadId);
    expect(active?.status).toBe("stopping");
    const finished = await store.finishRun({
      runId: acquired.run.id,
      leaseOwner: "replica-a",
      generation: acquired.run.generation,
      status: "stopped",
    });
    expect(finished.status).toBe("stopped");
    expect(await store.getActiveRun({ id: owner.id }, threadId)).toBeNull();
  });
});
