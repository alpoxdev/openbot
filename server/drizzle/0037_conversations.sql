CREATE TYPE "public"."conversation_local_readiness" AS ENUM('not_ready', 'history_only', 'ready');--> statement-breakpoint
CREATE TYPE "public"."conversation_provenance" AS ENUM('local', 'imported');--> statement-breakpoint
CREATE TYPE "public"."conversation_run_status" AS ENUM('pending', 'running', 'stopping', 'interrupted', 'completed', 'failed', 'stopped');--> statement-breakpoint
CREATE TABLE "conversation_baselines" (
	"thread_id" text PRIMARY KEY NOT NULL,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"baseline_sequence" bigint DEFAULT 0 NOT NULL,
	"content_hash" text,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_baselines_message_count_nonnegative" CHECK ("conversation_baselines"."message_count" >= 0),
	CONSTRAINT "conversation_baselines_sequence_nonnegative" CHECK ("conversation_baselines"."baseline_sequence" >= 0)
);
--> statement-breakpoint
CREATE TABLE "conversation_events" (
	"thread_id" text NOT NULL,
	"sequence" bigint NOT NULL,
	"run_id" text,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_events_sequence_nonnegative" CHECK ("conversation_events"."sequence" >= 0)
);
--> statement-breakpoint
CREATE TABLE "conversation_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"status" "conversation_run_status" DEFAULT 'pending' NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"generation" integer DEFAULT 0 NOT NULL,
	"stop_target_run_id" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_runs_generation_nonnegative" CHECK ("conversation_runs"."generation" >= 0)
);
--> statement-breakpoint
CREATE TABLE "conversation_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"channel_id" text,
	"agent_id" text,
	"provenance" "conversation_provenance" NOT NULL,
	"local_readiness" "conversation_local_readiness" DEFAULT 'not_ready' NOT NULL,
	"next_sequence" bigint DEFAULT 0 NOT NULL,
	"latest_sequence" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_threads_next_sequence_nonnegative" CHECK ("conversation_threads"."next_sequence" >= 0),
	CONSTRAINT "conversation_threads_latest_sequence_nonnegative" CHECK ("conversation_threads"."latest_sequence" >= 0)
);
--> statement-breakpoint
ALTER TABLE "conversation_baselines" ADD CONSTRAINT "conversation_baselines_thread_id_conversation_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."conversation_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_thread_id_conversation_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."conversation_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_run_id_conversation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."conversation_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_runs" ADD CONSTRAINT "conversation_runs_thread_id_conversation_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."conversation_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_threads" ADD CONSTRAINT "conversation_threads_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_threads" ADD CONSTRAINT "conversation_threads_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_events_thread_sequence_idx" ON "conversation_events" USING btree ("thread_id","sequence");--> statement-breakpoint
CREATE INDEX "conversation_events_by_run_idx" ON "conversation_events" USING btree ("run_id","sequence");--> statement-breakpoint
CREATE INDEX "conversation_runs_by_thread_idx" ON "conversation_runs" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "conversation_runs_active_lease_idx" ON "conversation_runs" USING btree ("thread_id","status","lease_until");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_runs_one_active_per_thread_idx" ON "conversation_runs" USING btree ("thread_id") WHERE "conversation_runs"."status" in ('pending', 'running', 'stopping');--> statement-breakpoint
CREATE INDEX "conversation_threads_by_owner_idx" ON "conversation_threads" USING btree ("owner_user_id","updated_at");--> statement-breakpoint
CREATE INDEX "conversation_threads_by_channel_idx" ON "conversation_threads" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "conversation_threads_by_agent_idx" ON "conversation_threads" USING btree ("agent_id");