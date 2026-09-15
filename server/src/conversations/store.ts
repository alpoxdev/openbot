import type { BaseEvent, Message, State } from "@ag-ui/client";
import { and, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import type { AgentProfileStore } from "../agents/profile-store";
import type { AgentActor } from "../agents/profile-types";
import {
  agentProfiles,
  agents,
  channelAgents,
  channelMemberships,
  channels,
  conversationBaselines,
  conversationEvents,
  conversationRuns,
  conversationThreads,
  revokedAccess,
  userRoles,
  users,
} from "../db/schema";
import {
  historyEvent,
  projectConversation,
  type ConversationSnapshot,
} from "./events";
import type {
  AcquireRunInput,
  AcquireRunResult,
  CheckpointBaselineInput,
  ConversationAccess,
  ConversationActor,
  ConversationEventRecord,
  ConversationRunRecord,
  ConversationThreadPage,
  ConversationThreadRecord,
  ConversationThreadQuery,
  ConversationThreadSummary,
  CreateThreadInput,
  FinishRunInput,
  PublishBaselineInput,
} from "./types";
import {
  ConversationAccessError,
  ConversationConflictError,
  ConversationLeaseError,
  ConversationNotFoundError,
} from "./types";

type Executor = {
  select: Database["select"];
  insert: Database["insert"];
  update: Database["update"];
  delete: Database["delete"];
};

const MIN_LEASE_MS = 1_000;
const MAX_LEASE_MS = 15 * 60 * 1_000;
const MAX_EVENT_PAGE = 500;
const MAX_APPEND_BATCH = 256;
const DEFAULT_THREAD_PAGE = 50;
export const MAX_THREAD_PAGE = 100;

type ThreadCursor = {
  updatedAt: string;
  id: string;
  agentId: string | null;
  directOnly: boolean;
};

function requireThreadPageLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ConversationConflictError("Invalid conversation page limit");
  }
  return Math.min(limit, MAX_THREAD_PAGE);
}

function encodeThreadCursor(cursor: ThreadCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function validThreadCursorTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = value.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6})([+-]\d{2})(?::?(\d{2}))$/,
  );
  if (!match) return false;
  return Number.isFinite(
    Date.parse(`${match[1]}${match[2]}:${match[3] ?? "00"}`),
  );
}

function decodeThreadCursor(
  value: string | undefined,
  query: ConversationThreadQuery,
): ThreadCursor | undefined {
  if (value === undefined) return undefined;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ConversationConflictError("Invalid conversation cursor");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as unknown;
  } catch {
    throw new ConversationConflictError("Invalid conversation cursor");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConversationConflictError("Invalid conversation cursor");
  }
  const cursor = parsed as Partial<ThreadCursor>;
  if (
    typeof cursor.id !== "string" ||
    cursor.id.length === 0 ||
    !validThreadCursorTimestamp(cursor.updatedAt) ||
    (cursor.agentId !== null && typeof cursor.agentId !== "string") ||
    typeof cursor.directOnly !== "boolean"
  ) {
    throw new ConversationConflictError("Invalid conversation cursor");
  }
  const agentId = query.agentId ?? null;
  const directOnly = query.directOnly === true;
  if (cursor.agentId !== agentId || cursor.directOnly !== directOnly) {
    throw new ConversationConflictError("Cursor does not match query");
  }
  return cursor as ThreadCursor;
}

function postgresErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as {
    code?: unknown;
    cause?: { code?: unknown; errno?: unknown };
  };
  if (typeof record.code === "string" && /^\d{5}$/.test(record.code)) {
    return record.code;
  }
  const cause = record.cause;
  if (cause && typeof cause.errno === "number") return String(cause.errno);
  if (cause && typeof cause.errno === "string" && /^\d{5}$/.test(cause.errno))
    return cause.errno;
  if (cause && typeof cause.code === "string" && /^\d{5}$/.test(cause.code)) {
    return cause.code;
  }
  return undefined;
}

function asBigint(value: bigint | number | string): bigint {
  return typeof value === "bigint" ? value : BigInt(value);
}

function asRun(
  row: typeof conversationRuns.$inferSelect,
): ConversationRunRecord {
  return {
    id: row.id,
    threadId: row.threadId,
    status: row.status,
    leaseOwner: row.leaseOwner,
    leaseUntil: row.leaseUntil,
    generation: row.generation,
    stopTargetRunId: row.stopTargetRunId,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

function asThread(
  row: typeof conversationThreads.$inferSelect,
): ConversationThreadRecord {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    channelId: row.channelId,
    agentId: row.agentId,
    provenance: row.provenance,
    localReadiness: row.localReadiness,
    nextSequence: asBigint(row.nextSequence),
    latestSequence: asBigint(row.latestSequence),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function requireLeaseMs(leaseMs: number) {
  if (
    !Number.isFinite(leaseMs) ||
    leaseMs < MIN_LEASE_MS ||
    leaseMs > MAX_LEASE_MS
  ) {
    throw new ConversationConflictError("Invalid lease duration");
  }
}

function requirePageLimit(limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVENT_PAGE) {
    throw new ConversationConflictError("Invalid event page limit");
  }
}

function leaseUntilSql(leaseMs: number) {
  requireLeaseMs(leaseMs);
  return sql`clock_timestamp() + make_interval(secs => ${leaseMs / 1000})`;
}

const heldLease = and(
  sql`${conversationRuns.leaseUntil} > clock_timestamp()`,
  sql`${conversationRuns.status} in ('pending', 'running', 'stopping')`,
);

/**
 * The roster only needs the opening text, not a baseline or event tail. Extract it in PostgreSQL so
 * the JSONB transcript never crosses the process boundary during listing.
 */
const THREAD_PREVIEW = sql<string | null>`
  (
    select case
      when jsonb_typeof(message.value->'content') = 'string'
        then left(message.value->>'content', 240)
      when jsonb_typeof(message.value->'content') = 'array'
        then (
          select left(btrim(part.value->>'text'), 240)
          from jsonb_array_elements(message.value->'content')
            with ordinality as part(value, ordinality)
          where jsonb_typeof(part.value->'text') = 'string'
            and btrim(part.value->>'text') <> ''
          order by part.ordinality
          limit 1
        )
      else null
    end
    from jsonb_array_elements(
      coalesce(${conversationBaselines.messages}, '[]'::jsonb)
    ) with ordinality as message(value, ordinality)
    where (
      (
        jsonb_typeof(message.value->'content') = 'string'
        and btrim(message.value->>'content') <> ''
      )
      or (
        jsonb_typeof(message.value->'content') = 'array'
        and exists (
          select 1
          from jsonb_array_elements(message.value->'content')
            with ordinality as part(value, ordinality)
          where jsonb_typeof(part.value->'text') = 'string'
            and btrim(part.value->>'text') <> ''
        )
      )
    )
    order by message.ordinality
    limit 1
  )
`;

async function actorRevoked(
  executor: Executor,
  actorId: string,
): Promise<boolean> {
  const [user] = await executor
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, actorId))
    .limit(1);
  if (!user) return true;
  const [revoked] = await executor
    .select({ email: revokedAccess.email })
    .from(revokedAccess)
    .where(eq(revokedAccess.email, user.email.toLowerCase()))
    .limit(1);
  return Boolean(revoked);
}

async function currentActorRole(
  executor: Executor,
  actorId: string,
): Promise<AgentActor["role"] | null> {
  const roles = await executor
    .select({ role: userRoles.role })
    .from(userRoles)
    .where(eq(userRoles.userId, actorId));
  if (roles.some((row) => row.role === "admin")) return "admin";
  if (roles.some((row) => row.role === "user")) return "user";
  return null;
}

async function actorRole(
  executor: Executor,
  actorId: string,
): Promise<AgentActor["role"] | null> {
  if (await actorRevoked(executor, actorId)) return null;
  return currentActorRole(executor, actorId);
}

async function liveMembership(
  executor: Executor,
  actorId: string,
  channelId: string,
): Promise<boolean> {
  const [row] = await executor
    .select({ channelId: channelMemberships.channelId })
    .from(channelMemberships)
    .innerJoin(channels, eq(channels.id, channelMemberships.channelId))
    .where(
      and(
        eq(channelMemberships.channelId, channelId),
        eq(channelMemberships.userId, actorId),
        isNull(channels.deletedAt),
      ),
    )
    .limit(1);
  return Boolean(row);
}

async function agentExecutable(
  executor: Executor,
  actorId: string,
  agentId: string,
): Promise<boolean> {
  const [agent] = await executor
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  if (!agent) return false;
  const role = await actorRole(executor, actorId);
  if (!role) return false;
  const visibility =
    role === "admin"
      ? undefined
      : or(
          eq(agentProfiles.visibility, "public"),
          eq(agentProfiles.ownerUserId, actorId),
        );
  const [profile] = await executor
    .select({ deletedAt: agentProfiles.deletedAt })
    .from(agentProfiles)
    .where(
      and(
        eq(agentProfiles.agentId, agentId),
        isNull(agentProfiles.deletedAt),
        visibility,
      ),
    )
    .limit(1);
  return Boolean(profile);
}

async function channelHasAgent(
  executor: Executor,
  channelId: string,
  agentId: string,
): Promise<boolean> {
  const [row] = await executor
    .select({ agentId: channelAgents.agentId })
    .from(channelAgents)
    .where(
      and(
        eq(channelAgents.channelId, channelId),
        eq(channelAgents.agentId, agentId),
      ),
    )
    .limit(1);
  return Boolean(row);
}

async function accessFor(
  executor: Executor,
  actor: ConversationActor,
  thread: ConversationThreadRecord,
  mode: "history" | "run",
  selectedAgentId?: string,
): Promise<ConversationAccess> {
  if (!(await actorRole(executor, actor.id))) return "none";
  const agentId = selectedAgentId ?? thread.agentId;

  if (thread.channelId) {
    const member = await liveMembership(executor, actor.id, thread.channelId);
    if (!member) return "none";
    if (
      selectedAgentId &&
      selectedAgentId !== thread.agentId &&
      !(await channelHasAgent(executor, thread.channelId, selectedAgentId))
    )
      return "none";
    if (mode === "history") return "history";
    if (thread.localReadiness !== "ready") return "history";
    if (!agentId) return "history";
    if (!(await agentExecutable(executor, actor.id, agentId))) return "history";
    if (!(await channelHasAgent(executor, thread.channelId, agentId))) {
      return "history";
    }
    return "run";
  }

  if (thread.ownerUserId !== actor.id) return "none";
  if (selectedAgentId && selectedAgentId !== thread.agentId) return "none";
  if (mode === "history") return "history";
  if (thread.localReadiness !== "ready") return "history";
  if (!thread.agentId) return "history";
  if (!(await agentExecutable(executor, actor.id, thread.agentId)))
    return "history";
  return "run";
}

async function requireAccess(
  executor: Executor,
  actor: ConversationActor,
  thread: ConversationThreadRecord,
  mode: "history" | "run",
  selectedAgentId?: string,
): Promise<ConversationAccess> {
  const access = await accessFor(
    executor,
    actor,
    thread,
    mode,
    selectedAgentId,
  );
  if (access === "none") throw new ConversationAccessError();
  if (mode === "run" && access !== "run") throw new ConversationAccessError();
  return access;
}

async function lockThread(executor: Executor, threadId: string) {
  const [row] = await executor
    .select()
    .from(conversationThreads)
    .where(eq(conversationThreads.id, threadId))
    .for("update");
  return row ? asThread(row) : null;
}

async function lockRun(executor: Executor, runId: string) {
  const [row] = await executor
    .select()
    .from(conversationRuns)
    .where(eq(conversationRuns.id, runId))
    .for("update");
  return row ?? null;
}

function eventPayload(event: BaseEvent): BaseEvent {
  return historyEvent(event);
}

async function writeEvents(
  executor: Executor,
  thread: ConversationThreadRecord,
  runId: string,
  events: readonly BaseEvent[],
): Promise<ConversationEventRecord[]> {
  if (events.length === 0) return [];
  if (events.length > MAX_APPEND_BATCH) {
    throw new ConversationConflictError("Event batch too large");
  }
  let sequence = thread.nextSequence === 0n ? 1n : thread.nextSequence;
  const written: ConversationEventRecord[] = [];
  for (const event of events) {
    const payload = eventPayload(event);
    const [row] = await executor
      .insert(conversationEvents)
      .values({
        threadId: thread.id,
        sequence,
        runId,
        type: payload.type,
        payload,
      })
      .returning();
    written.push({
      threadId: row.threadId,
      sequence: asBigint(row.sequence),
      runId: row.runId,
      type: row.type,
      payload: row.payload as BaseEvent,
      createdAt: row.createdAt,
    });
    sequence += 1n;
  }
  const latestEvent = written.at(-1);
  if (!latestEvent)
    throw new Error("Writing events unexpectedly returned no rows");
  const latest = latestEvent.sequence;
  await executor
    .update(conversationThreads)
    .set({
      nextSequence: latest + 1n,
      latestSequence: latest,
      updatedAt: sql`now()`,
    })
    .where(eq(conversationThreads.id, thread.id));
  return written;
}

async function writeBaseline(
  executor: Executor,
  threadId: string,
  input: PublishBaselineInput,
) {
  await executor
    .update(conversationBaselines)
    .set({
      messages: input.messages,
      state: input.state,
      messageCount: input.messages.length,
      baselineSequence: input.baselineSequence,
      contentHash: input.contentHash ?? null,
      publishedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(eq(conversationBaselines.threadId, threadId));
}

function interruptedEvent(threadId: string, runId: string): BaseEvent {
  return {
    type: "RUN_ERROR",
    threadId,
    runId,
    message: "Conversation run was interrupted",
    code: "conversation_interrupted",
  } as BaseEvent;
}

async function interruptExpiredOnThread(
  executor: Executor,
  thread: ConversationThreadRecord,
): Promise<number> {
  const expired = await executor
    .select({ id: conversationRuns.id })
    .from(conversationRuns)
    .where(
      and(
        eq(conversationRuns.threadId, thread.id),
        sql`${conversationRuns.status} in ('pending', 'running', 'stopping')`,
        sql`${conversationRuns.leaseUntil} <= clock_timestamp()`,
      ),
    )
    .orderBy(conversationRuns.id);
  let current = thread;
  let count = 0;
  for (const row of expired) {
    const run = await lockRun(executor, row.id);
    if (
      !run ||
      run.threadId !== thread.id ||
      !["pending", "running", "stopping"].includes(run.status) ||
      !run.leaseUntil
    )
      continue;
    const ownerFence =
      run.leaseOwner === null
        ? isNull(conversationRuns.leaseOwner)
        : eq(conversationRuns.leaseOwner, run.leaseOwner);
    const [updated] = await executor
      .update(conversationRuns)
      .set({
        status: "interrupted",
        finishedAt: sql`now()`,
        leaseOwner: null,
        leaseUntil: null,
        stopTargetRunId: null,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(conversationRuns.id, run.id),
          eq(conversationRuns.threadId, thread.id),
          ownerFence,
          eq(conversationRuns.generation, run.generation),
          sql`${conversationRuns.status} in ('pending', 'running', 'stopping')`,
          sql`${conversationRuns.leaseUntil} <= clock_timestamp()`,
        ),
      )
      .returning({ id: conversationRuns.id });
    if (!updated) continue;
    // The status transition and terminal event share this transaction and both locks.
    const written = await writeEvents(executor, current, run.id, [
      interruptedEvent(thread.id, run.id),
    ]);
    const latest = written.at(-1)?.sequence;
    if (latest !== undefined) {
      current = {
        ...current,
        nextSequence: latest + 1n,
        latestSequence: latest,
      };
    }
    count += 1;
  }
  return count;
}

/** Shared insertion for channel creation and direct-chat minting on the caller's transaction. */
export async function createConversationWithin(
  executor: Executor,
  input: CreateThreadInput,
): Promise<ConversationThreadRecord> {
  const [thread] = await executor
    .insert(conversationThreads)
    .values({
      id: input.id,
      ownerUserId: input.ownerUserId,
      channelId: input.channelId ?? null,
      agentId: input.agentId ?? null,
      provenance: input.provenance,
      localReadiness: input.localReadiness ?? "not_ready",
    })
    .returning();
  await executor.insert(conversationBaselines).values({
    threadId: thread.id,
    messages: [],
    state: {},
    messageCount: 0,
  });
  return asThread(thread);
}

export function createConversationStore(database: Database) {
  return {
    async assertReady(): Promise<void> {
      // Parse every required relation/column without reading any person's history.
      await database.execute(sql`
        select t.id, t.latest_sequence, b.messages, b.state, b.baseline_sequence,
               r.generation, r.lease_until, e.sequence, e.payload
        from conversation_threads t
        left join conversation_baselines b on b.thread_id = t.id
        left join conversation_runs r on r.thread_id = t.id
        left join conversation_events e on e.thread_id = t.id
        limit 0
      `);
    },
    async createThread(
      input: CreateThreadInput,
    ): Promise<ConversationThreadRecord> {
      try {
        return await database.transaction((tx) =>
          createConversationWithin(tx, input),
        );
      } catch (error) {
        if (postgresErrorCode(error) === "23505") {
          throw new ConversationConflictError("Thread id already exists");
        }
        throw error;
      }
    },

    async createOwnedThread(
      actor: AgentActor,
      threadId: string,
      agentId: string,
      profiles: Pick<AgentProfileStore, "getWithin">,
    ) {
      return database.transaction(async (tx) => {
        const role = await actorRole(tx, actor.id);
        if (!role) throw new ConversationAccessError();
        if (!(await profiles.getWithin(tx, { ...actor, role }, agentId))) {
          throw new ConversationAccessError();
        }
        return createConversationWithin(tx, {
          id: threadId,
          ownerUserId: actor.id,
          agentId,
          provenance: "local",
          localReadiness: "ready",
        });
      });
    },

    async authorize(
      actor: ConversationActor,
      threadId: string,
      mode: "history" | "run",
      agentId?: string,
    ): Promise<ConversationAccess> {
      const [row] = await database
        .select()
        .from(conversationThreads)
        .where(eq(conversationThreads.id, threadId))
        .limit(1);
      if (!row) throw new ConversationNotFoundError();
      return accessFor(database, actor, asThread(row), mode, agentId);
    },

    async list(
      actor: ConversationActor,
      query: ConversationThreadQuery = {},
    ): Promise<ConversationThreadPage> {
      // Keyset pagination stays bounded even when a caller has thousands of direct or channel
      // threads. The cursor carries its filters so it cannot silently skip rows when reused.
      const limit = requireThreadPageLimit(query.limit ?? DEFAULT_THREAD_PAGE);
      if (
        query.agentId !== undefined &&
        (typeof query.agentId !== "string" || query.agentId.length === 0)
      ) {
        throw new ConversationConflictError("Invalid conversation agent id");
      }
      if (
        query.directOnly !== undefined &&
        typeof query.directOnly !== "boolean"
      ) {
        throw new ConversationConflictError(
          "Invalid conversation directOnly filter",
        );
      }
      if (query.cursor !== undefined && typeof query.cursor !== "string") {
        throw new ConversationConflictError("Invalid conversation cursor");
      }
      const directOnly = query.directOnly === true;
      const cursor = decodeThreadCursor(query.cursor, {
        ...query,
        directOnly,
      });
      if (!(await actorRole(database, actor.id))) {
        return { threads: [], nextCursor: null };
      }
      const filters = [
        or(
          and(
            eq(conversationThreads.ownerUserId, actor.id),
            isNull(conversationThreads.channelId),
          ),
          and(
            eq(channelMemberships.userId, actor.id),
            isNull(channels.deletedAt),
          ),
        ),
        ...(query.agentId !== undefined
          ? [eq(conversationThreads.agentId, query.agentId)]
          : []),
        ...(directOnly ? [isNull(conversationThreads.channelId)] : []),
        ...(cursor
          ? [
              or(
                lt(
                  conversationThreads.updatedAt,
                  sql`${cursor.updatedAt}::timestamptz`,
                ),
                and(
                  eq(
                    conversationThreads.updatedAt,
                    sql`${cursor.updatedAt}::timestamptz`,
                  ),
                  lt(conversationThreads.id, cursor.id),
                ),
              ),
            ]
          : []),
      ];
      const rows = await database
        .select({
          id: conversationThreads.id,
          agentId: conversationThreads.agentId,
          channelId: conversationThreads.channelId,
          provenance: conversationThreads.provenance,
          localReadiness: conversationThreads.localReadiness,
          updatedAt: conversationThreads.updatedAt,
          updatedAtCursor: sql<string>`
            to_char(
              ${conversationThreads.updatedAt},
              'YYYY-MM-DD"T"HH24:MI:SS.US'
            ) || to_char(${conversationThreads.updatedAt}, 'TZH:TZM')
          `,
          preview: THREAD_PREVIEW,
        })
        .from(conversationThreads)
        .leftJoin(channels, eq(channels.id, conversationThreads.channelId))
        .leftJoin(
          channelMemberships,
          and(
            eq(channelMemberships.channelId, conversationThreads.channelId),
            eq(channelMemberships.userId, actor.id),
            isNull(channels.deletedAt),
          ),
        )
        .leftJoin(
          conversationBaselines,
          eq(conversationBaselines.threadId, conversationThreads.id),
        )
        .where(and(...filters))
        .orderBy(
          desc(conversationThreads.updatedAt),
          desc(conversationThreads.id),
        )
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        threads: page.map(
          (row): ConversationThreadSummary => ({
            id: row.id,
            agentId: row.agentId,
            channelId: row.channelId,
            provenance: row.provenance,
            localReadiness: row.localReadiness,
            updatedAt: row.updatedAt,
            title: row.preview,
            preview: row.preview,
          }),
        ),
        nextCursor:
          rows.length > limit && last
            ? encodeThreadCursor({
                updatedAt: last.updatedAtCursor,
                id: last.id,
                agentId: query.agentId ?? null,
                directOnly,
              })
            : null,
      };
    },

    async readSnapshot(
      actor: ConversationActor,
      threadId: string,
    ): Promise<{
      thread: ConversationThreadRecord;
      snapshot: ConversationSnapshot;
      baselineSequence: bigint;
      latestSequence: bigint;
    }> {
      return database.transaction(async (tx) => {
        const thread = await lockThread(tx, threadId);
        if (!thread) throw new ConversationNotFoundError();
        await requireAccess(tx, actor, thread, "history");
        const [baseline] = await tx
          .select()
          .from(conversationBaselines)
          .where(eq(conversationBaselines.threadId, threadId))
          .limit(1);
        if (!baseline) throw new ConversationNotFoundError();
        const watermark = asBigint(baseline.baselineSequence);
        const tail = await tx
          .select()
          .from(conversationEvents)
          .where(
            and(
              eq(conversationEvents.threadId, threadId),
              gt(conversationEvents.sequence, watermark),
            ),
          )
          .orderBy(conversationEvents.sequence);
        const events = tail.map((row) => row.payload as BaseEvent);
        const snapshot = await projectConversation(
          {
            messages: (baseline.messages ?? []) as Message[],
            state: (baseline.state ?? {}) as State,
          },
          events,
        );
        return {
          thread,
          snapshot,
          baselineSequence: watermark,
          latestSequence: thread.latestSequence,
        };
      });
    },

    async readEventPage(
      actor: ConversationActor,
      threadId: string,
      afterSequence = 0n,
      limit = 100,
    ): Promise<ConversationEventRecord[]> {
      requirePageLimit(limit);
      const [row] = await database
        .select()
        .from(conversationThreads)
        .where(eq(conversationThreads.id, threadId))
        .limit(1);
      if (!row) throw new ConversationNotFoundError();
      await requireAccess(database, actor, asThread(row), "history");
      const rows = await database
        .select()
        .from(conversationEvents)
        .where(
          and(
            eq(conversationEvents.threadId, threadId),
            gt(conversationEvents.sequence, afterSequence),
          ),
        )
        .orderBy(conversationEvents.sequence)
        .limit(limit);
      return rows.map((event) => ({
        threadId: event.threadId,
        sequence: asBigint(event.sequence),
        runId: event.runId,
        type: event.type,
        payload: event.payload as BaseEvent,
        createdAt: event.createdAt,
      }));
    },

    async publishBaseline(
      actor: ConversationActor,
      threadId: string,
      input: PublishBaselineInput,
    ): Promise<void> {
      await database.transaction(async (tx) => {
        const thread = await lockThread(tx, threadId);
        if (!thread) throw new ConversationNotFoundError();
        await requireAccess(tx, actor, thread, "history");
        if (thread.localReadiness !== "not_ready") {
          throw new ConversationConflictError(
            "Baseline already published; use a fenced checkpoint",
          );
        }
        const [event] = await tx
          .select({ sequence: conversationEvents.sequence })
          .from(conversationEvents)
          .where(eq(conversationEvents.threadId, threadId))
          .limit(1);
        if (event) {
          throw new ConversationConflictError(
            "Cannot overwrite a thread that already has events",
          );
        }
        const [active] = await tx
          .select({ id: conversationRuns.id })
          .from(conversationRuns)
          .where(
            and(
              eq(conversationRuns.threadId, threadId),
              sql`${conversationRuns.status} in ('pending', 'running', 'stopping')`,
            ),
          )
          .limit(1);
        if (active) {
          throw new ConversationConflictError(
            "Cannot overwrite a thread with an active run",
          );
        }
        await writeBaseline(tx, threadId, input);
        await tx
          .update(conversationThreads)
          .set({
            localReadiness: "history_only",
            updatedAt: sql`now()`,
          })
          .where(eq(conversationThreads.id, threadId));
      });
    },

    async checkpointBaseline(
      actor: ConversationActor,
      threadId: string,
      input: CheckpointBaselineInput,
    ): Promise<void> {
      await database.transaction(async (tx) => {
        const thread = await lockThread(tx, threadId);
        if (!thread) throw new ConversationNotFoundError();
        await requireAccess(tx, actor, thread, "run");
        const run = await lockRun(tx, input.runId);
        if (
          !run ||
          run.threadId !== threadId ||
          run.leaseOwner !== input.leaseOwner ||
          run.generation !== input.generation
        ) {
          throw new ConversationLeaseError();
        }
        const [held] = await tx
          .select({ id: conversationRuns.id })
          .from(conversationRuns)
          .where(and(eq(conversationRuns.id, input.runId), heldLease))
          .limit(1);
        if (!held) throw new ConversationLeaseError();
        if (asBigint(input.baselineSequence) !== thread.latestSequence) {
          throw new ConversationConflictError(
            "Checkpoint watermark must match latest sequence",
          );
        }
        await writeBaseline(tx, threadId, input);
      });
    },

    async acquireRun(
      actor: ConversationActor,
      input: AcquireRunInput,
    ): Promise<AcquireRunResult> {
      requireLeaseMs(input.leaseMs);
      return database.transaction(async (tx) => {
        const thread = await lockThread(tx, input.threadId);
        if (!thread) throw new ConversationNotFoundError();
        await requireAccess(tx, actor, thread, "run", input.agentId);
        await interruptExpiredOnThread(tx, thread);

        const [existing] = await tx
          .select()
          .from(conversationRuns)
          .where(eq(conversationRuns.id, input.runId))
          .limit(1);
        if (existing) {
          if (existing.threadId !== input.threadId) {
            throw new ConversationConflictError(
              "Run id belongs to another thread",
            );
          }
          return { outcome: "duplicate" as const, run: asRun(existing) };
        }

        const [active] = await tx
          .select()
          .from(conversationRuns)
          .where(
            and(
              eq(conversationRuns.threadId, input.threadId),
              sql`${conversationRuns.status} in ('pending', 'running', 'stopping')`,
            ),
          )
          .limit(1);
        if (active) {
          return { outcome: "collision" as const, run: asRun(active) };
        }

        const [inserted] = await tx
          .insert(conversationRuns)
          .values({
            id: input.runId,
            threadId: input.threadId,
            status: "running",
            leaseOwner: input.leaseOwner,
            leaseUntil: leaseUntilSql(input.leaseMs),
            generation: 1,
            stopTargetRunId: input.runId,
            startedAt: sql`now()`,
          })
          .onConflictDoNothing()
          .returning();
        if (inserted)
          return { outcome: "acquired" as const, run: asRun(inserted) };

        const [again] = await tx
          .select()
          .from(conversationRuns)
          .where(eq(conversationRuns.id, input.runId))
          .limit(1);
        if (again) {
          if (again.threadId !== input.threadId) {
            throw new ConversationConflictError(
              "Run id belongs to another thread",
            );
          }
          return { outcome: "duplicate" as const, run: asRun(again) };
        }
        const [other] = await tx
          .select()
          .from(conversationRuns)
          .where(
            and(
              eq(conversationRuns.threadId, input.threadId),
              sql`${conversationRuns.status} in ('pending', 'running', 'stopping')`,
            ),
          )
          .limit(1);
        if (other) return { outcome: "collision" as const, run: asRun(other) };
        throw new ConversationConflictError(
          "Run acquire raced without a winner",
        );
      });
    },

    async renewLease(input: {
      runId: string;
      leaseOwner: string;
      generation: number;
      leaseMs: number;
    }): Promise<ConversationRunRecord> {
      requireLeaseMs(input.leaseMs);
      const [updated] = await database
        .update(conversationRuns)
        .set({
          leaseUntil: leaseUntilSql(input.leaseMs),
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(conversationRuns.id, input.runId),
            eq(conversationRuns.leaseOwner, input.leaseOwner),
            eq(conversationRuns.generation, input.generation),
            heldLease,
          ),
        )
        .returning();
      if (!updated) throw new ConversationLeaseError();
      return asRun(updated);
    },

    async appendEvents(input: {
      threadId: string;
      runId: string;
      leaseOwner: string;
      generation: number;
      events: readonly BaseEvent[];
    }): Promise<ConversationEventRecord[]> {
      if (input.events.length === 0) return [];
      return database.transaction(async (tx) => {
        const thread = await lockThread(tx, input.threadId);
        if (!thread) throw new ConversationNotFoundError();
        const run = await lockRun(tx, input.runId);
        if (
          !run ||
          run.threadId !== input.threadId ||
          run.leaseOwner !== input.leaseOwner ||
          run.generation !== input.generation
        ) {
          throw new ConversationLeaseError();
        }
        const [held] = await tx
          .select({ id: conversationRuns.id })
          .from(conversationRuns)
          .where(and(eq(conversationRuns.id, input.runId), heldLease))
          .limit(1);
        if (!held) throw new ConversationLeaseError();
        return writeEvents(tx, thread, input.runId, input.events);
      });
    },

    async finishRun(input: FinishRunInput): Promise<ConversationRunRecord> {
      return database.transaction(async (tx) => {
        const [located] = await tx
          .select({ threadId: conversationRuns.threadId })
          .from(conversationRuns)
          .where(eq(conversationRuns.id, input.runId))
          .limit(1);
        if (!located) throw new ConversationLeaseError();
        const thread = await lockThread(tx, located.threadId);
        if (!thread) throw new ConversationNotFoundError();
        const run = await lockRun(tx, input.runId);
        if (!run) throw new ConversationLeaseError();
        if (
          run.leaseOwner !== input.leaseOwner ||
          run.generation !== input.generation
        ) {
          throw new ConversationLeaseError();
        }
        const [held] = await tx
          .select()
          .from(conversationRuns)
          .where(and(eq(conversationRuns.id, input.runId), heldLease))
          .limit(1);
        if (!held) throw new ConversationLeaseError();

        const events = input.events;
        if (events && events.length > 0) {
          await writeEvents(tx, thread, input.runId, events);
        }
        if (input.snapshot) {
          let latest = thread.latestSequence;
          if (events && events.length > 0) {
            const latestThread = await lockThread(tx, run.threadId);
            if (!latestThread) throw new ConversationNotFoundError();
            latest = latestThread.latestSequence;
          }
          if (asBigint(input.snapshot.baselineSequence) !== latest) {
            throw new ConversationConflictError(
              "Finish snapshot watermark must match latest sequence",
            );
          }
          await writeBaseline(tx, run.threadId, input.snapshot);
        }
        const [updated] = await tx
          .update(conversationRuns)
          .set({
            status: input.status,
            finishedAt: sql`now()`,
            leaseOwner: null,
            leaseUntil: null,
            stopTargetRunId: null,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(conversationRuns.id, input.runId),
              eq(conversationRuns.leaseOwner, input.leaseOwner),
              eq(conversationRuns.generation, input.generation),
              heldLease,
            ),
          )
          .returning();
        if (!updated) throw new ConversationLeaseError();
        return asRun(updated);
      });
    },

    async requestStop(input: {
      actor: ConversationActor;
      threadId: string;
      runId: string;
      agentId?: string;
    }): Promise<boolean> {
      return database.transaction(async (tx) => {
        const thread = await lockThread(tx, input.threadId);
        if (!thread) throw new ConversationNotFoundError();
        await requireAccess(tx, input.actor, thread, "run", input.agentId);
        const [updated] = await tx
          .update(conversationRuns)
          .set({
            status: "stopping",
            stopTargetRunId: input.runId,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(conversationRuns.id, input.runId),
              eq(conversationRuns.threadId, input.threadId),
              sql`${conversationRuns.status} in ('pending', 'running')`,
              sql`${conversationRuns.leaseUntil} > clock_timestamp()`,
            ),
          )
          .returning({ id: conversationRuns.id });
        return Boolean(updated);
      });
    },

    async getActiveRun(
      actor: ConversationActor,
      threadId: string,
    ): Promise<ConversationRunRecord | null> {
      const [row] = await database
        .select()
        .from(conversationThreads)
        .where(eq(conversationThreads.id, threadId))
        .limit(1);
      if (!row) throw new ConversationNotFoundError();
      await requireAccess(database, actor, asThread(row), "history");
      const [active] = await database
        .select()
        .from(conversationRuns)
        .where(
          and(
            eq(conversationRuns.threadId, threadId),
            sql`${conversationRuns.status} in ('pending', 'running', 'stopping')`,
          ),
        )
        .limit(1);
      return active ? asRun(active) : null;
    },

    async getLatestRun(
      actor: ConversationActor,
      threadId: string,
    ): Promise<ConversationRunRecord | null> {
      const [row] = await database
        .select()
        .from(conversationThreads)
        .where(eq(conversationThreads.id, threadId))
        .limit(1);
      if (!row) throw new ConversationNotFoundError();
      await requireAccess(database, actor, asThread(row), "history");
      const [latest] = await database
        .select()
        .from(conversationRuns)
        .where(eq(conversationRuns.threadId, threadId))
        .orderBy(desc(conversationRuns.createdAt), desc(conversationRuns.id))
        .limit(1);
      return latest ? asRun(latest) : null;
    },

    async getRunTerminalEvent(
      actor: ConversationActor,
      threadId: string,
      runId: string,
    ): Promise<BaseEvent | null> {
      const [row] = await database
        .select()
        .from(conversationThreads)
        .where(eq(conversationThreads.id, threadId))
        .limit(1);
      if (!row) throw new ConversationNotFoundError();
      await requireAccess(database, actor, asThread(row), "history");
      const [event] = await database
        .select({ payload: conversationEvents.payload })
        .from(conversationEvents)
        .where(
          and(
            eq(conversationEvents.threadId, threadId),
            eq(conversationEvents.runId, runId),
            eq(conversationEvents.type, "RUN_ERROR"),
          ),
        )
        .orderBy(desc(conversationEvents.sequence))
        .limit(1);
      return event ? (event.payload as BaseEvent) : null;
    },

    async reapExpiredRuns(): Promise<number> {
      return database.transaction(async (tx) => {
        const expired = await tx
          .select({
            id: conversationRuns.id,
            threadId: conversationRuns.threadId,
          })
          .from(conversationRuns)
          .where(
            and(
              sql`${conversationRuns.status} in ('pending', 'running', 'stopping')`,
              sql`${conversationRuns.leaseUntil} <= clock_timestamp()`,
            ),
          )
          .orderBy(conversationRuns.threadId, conversationRuns.id)
          .limit(100);
        let count = 0;
        for (const row of expired) {
          const thread = await lockThread(tx, row.threadId);
          if (thread) count += await interruptExpiredOnThread(tx, thread);
        }
        return count;
      });
    },
  };
}

export type ConversationStore = ReturnType<typeof createConversationStore>;
