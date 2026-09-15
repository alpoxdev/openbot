import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./core";
import { conversationThreads } from "./conversations";
import { jsonb } from "./json";

export const conversationImportPhase = pgEnum("conversation_import_phase", [
  "inventory",
  "awaiting_confirmation",
  "importing",
  "paused",
  "cancelled",
  "completed",
  "completed_with_gaps",
  "failed",
]);
export const conversationImportItemStatus = pgEnum(
  "conversation_import_item_status",
  [
    "discovered",
    "staged",
    "validated",
    "published",
    "unchanged",
    "blocked",
    "failed",
    "excluded",
  ],
);

/** Credentials are deliberately absent: resuming source reads requires reauthorization. */
export const conversationImportJobs = pgTable(
  "conversation_import_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestedBy: text("requested_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    sourceNamespace: text("source_namespace").notNull(),
    sourceOrigin: text("source_origin").notNull(),
    sourceReference: text("source_reference").notNull(),
    phase: conversationImportPhase("phase").notNull().default("inventory"),
    scope: jsonb("scope").notNull(),
    manifest: jsonb("manifest").notNull().default({}),
    approvedManifestHash: text("approved_manifest_hash"),
    checkpoint: jsonb("checkpoint").notNull().default({}),
    attemptToken: text("attempt_token"),
    attemptKind: text("attempt_kind"),
    attemptLeaseExpiresAt: timestamp("attempt_lease_expires_at", {
      withTimezone: true,
    }),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("conversation_import_jobs_requester_idx").on(
      table.requestedBy,
      table.createdAt,
    ),
    check("conversation_import_jobs_version_check", sql`${table.version} > 0`),
    check(
      "conversation_import_jobs_attempt_check",
      sql`(${table.attemptToken} is null and ${table.attemptKind} is null and ${table.attemptLeaseExpiresAt} is null) or (${table.attemptToken} is not null and ${table.attemptKind} in ('inventory', 'run') and ${table.attemptLeaseExpiresAt} is not null)`,
    ),
  ],
);

/** Raw source resources are AES-GCM envelopes, never plaintext JSON snapshots. */
export const conversationImportItems = pgTable(
  "conversation_import_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => conversationImportJobs.id, { onDelete: "restrict" }),
    sourceThreadId: text("source_thread_id").notNull(),
    sourceUserId: text("source_user_id").notNull(),
    sourceAgentId: text("source_agent_id").notNull(),
    destinationUserId: text("destination_user_id"),
    destinationChannelId: text("destination_channel_id"),
    status: conversationImportItemStatus("status")
      .notNull()
      .default("discovered"),
    ownershipEvidence: jsonb("ownership_evidence").notNull().default({}),
    coverage: jsonb("coverage").notNull().default({}),
    encryptedResources: text("encrypted_resources"),
    contentHash: text("content_hash"),
    converterVersion: integer("converter_version").notNull().default(1),
    capturedAt: timestamp("captured_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    failureCode: text("failure_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("conversation_import_items_job_thread_idx").on(
      table.jobId,
      table.sourceThreadId,
    ),
    index("conversation_import_items_status_idx").on(table.jobId, table.status),
    check(
      "conversation_import_items_converter_check",
      sql`${table.converterVersion} > 0`,
    ),
  ],
);

/** A source record can publish once; later conflicting revisions never overwrite local work. */
export const conversationImportMappings = pgTable(
  "conversation_import_mappings",
  {
    sourceNamespace: text("source_namespace").notNull(),
    sourceThreadId: text("source_thread_id").notNull(),
    sourceOrigin: text("source_origin").notNull(),
    sourceUserId: text("source_user_id").notNull(),
    destinationThreadId: text("destination_thread_id")
      .notNull()
      .references(() => conversationThreads.id, { onDelete: "restrict" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => conversationImportItems.id, { onDelete: "restrict" }),
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.sourceNamespace, table.sourceThreadId] }),
    uniqueIndex("conversation_import_mapping_destination_idx").on(
      table.destinationThreadId,
    ),
  ],
);
