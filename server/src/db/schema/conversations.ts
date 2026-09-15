/**
 * Authoritative conversation history: threads, canonical baselines, monotone events, and run leases.
 *
 * ADDITIVE. Existing mapping/attachment/credential tables stay as they are. Schema installation
 * does not import, backfill, or rewrite transcripts.
 *
 * Provenance distinguishes a locally created thread from one published after import. Local
 * readiness is independent: a thread may exist before it is safe to continue.
 */
import type { Message } from "@ag-ui/client";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { channels, users } from "./core";
import { jsonb } from "./json";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const conversationProvenance = pgEnum("conversation_provenance", [
  "local",
  "imported",
]);

export const conversationLocalReadiness = pgEnum(
  "conversation_local_readiness",
  ["not_ready", "history_only", "ready"],
);

export const conversationRunStatus = pgEnum("conversation_run_status", [
  "pending",
  "running",
  "stopping",
  "interrupted",
  "completed",
  "failed",
  "stopped",
]);

/**
 * One conversation. Ownership, optional channel, and agent identity live here so later store
 * and engine layers can authorize without reconstructing Intelligence mappings.
 *
 * Owner and optional channel use ON DELETE RESTRICT: user/channel removal must not erase
 * transcripts. Soft-deleted channels still exist, so an FK is valid. Agent id is stored as
 * text with no FK so a deleted agent's original id remains on the row.
 */
export const conversationThreads = pgTable(
  "conversation_threads",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    channelId: text("channel_id").references(() => channels.id, {
      onDelete: "restrict",
    }),
    agentId: text("agent_id"),
    provenance: conversationProvenance("provenance").notNull(),
    localReadiness: conversationLocalReadiness("local_readiness")
      .notNull()
      .default("not_ready"),
    nextSequence: bigint("next_sequence", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    latestSequence: bigint("latest_sequence", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("conversation_threads_by_owner_idx").on(
      table.ownerUserId,
      table.updatedAt,
    ),
    index("conversation_threads_by_channel_idx").on(table.channelId),
    index("conversation_threads_by_agent_idx").on(table.agentId),
    check(
      "conversation_threads_next_sequence_nonnegative",
      sql`${table.nextSequence} >= 0`,
    ),
    check(
      "conversation_threads_latest_sequence_nonnegative",
      sql`${table.latestSequence} >= 0`,
    ),
  ],
);

/**
 * Canonical imported-or-new baseline: full messages and state as of the last published snapshot.
 * Event tails append after baselineSequence; replay is baseline plus events with sequence
 * greater than that watermark. One row per thread.
 */
export const conversationBaselines = pgTable(
  "conversation_baselines",
  {
    threadId: text("thread_id")
      .primaryKey()
      .references(() => conversationThreads.id, { onDelete: "cascade" }),
    messages: jsonb("messages")
      .$type<Message[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    state: jsonb("state").notNull().default({}),
    messageCount: integer("message_count").notNull().default(0),
    baselineSequence: bigint("baseline_sequence", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    contentHash: text("content_hash"),
    publishedAt: timestamp("published_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check(
      "conversation_baselines_message_count_nonnegative",
      sql`${table.messageCount} >= 0`,
    ),
    check(
      "conversation_baselines_sequence_nonnegative",
      sql`${table.baselineSequence} >= 0`,
    ),
  ],
);

/**
 * Durable run. Lease owner/until, generation fence, and the exact run Stop must target.
 * Duplicate run IDs do not start a second execution. At most one pending/running/stopping
 * run per thread.
 */
export const conversationRuns = pgTable(
  "conversation_runs",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => conversationThreads.id, { onDelete: "cascade" }),
    status: conversationRunStatus("status").notNull().default("pending"),
    leaseOwner: text("lease_owner"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    generation: integer("generation").notNull().default(0),
    stopTargetRunId: text("stop_target_run_id"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("conversation_runs_by_thread_idx").on(
      table.threadId,
      table.createdAt,
    ),
    index("conversation_runs_active_lease_idx").on(
      table.threadId,
      table.status,
      table.leaseUntil,
    ),
    uniqueIndex("conversation_runs_one_active_per_thread_idx")
      .on(table.threadId)
      .where(sql`${table.status} in ('pending', 'running', 'stopping')`),
    check(
      "conversation_runs_generation_nonnegative",
      sql`${table.generation} >= 0`,
    ),
  ],
);

/**
 * Monotone per-thread event sequence. Sequence is unique within a thread so append is
 * collision-safe across replicas.
 */
export const conversationEvents = pgTable(
  "conversation_events",
  {
    threadId: text("thread_id")
      .notNull()
      .references(() => conversationThreads.id, { onDelete: "cascade" }),
    sequence: bigint("sequence", { mode: "bigint" }).notNull(),
    runId: text("run_id").references(() => conversationRuns.id, {
      onDelete: "set null",
    }),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull().default({}),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("conversation_events_thread_sequence_idx").on(
      table.threadId,
      table.sequence,
    ),
    index("conversation_events_by_run_idx").on(table.runId, table.sequence),
    check(
      "conversation_events_sequence_nonnegative",
      sql`${table.sequence} >= 0`,
    ),
  ],
);
