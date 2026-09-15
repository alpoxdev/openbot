CREATE TYPE "public"."conversation_import_item_status" AS ENUM('discovered', 'staged', 'validated', 'published', 'unchanged', 'blocked', 'failed', 'excluded');--> statement-breakpoint
CREATE TYPE "public"."conversation_import_phase" AS ENUM('inventory', 'awaiting_confirmation', 'importing', 'paused', 'cancelled', 'completed', 'completed_with_gaps', 'failed');--> statement-breakpoint
CREATE TABLE "conversation_import_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"source_thread_id" text NOT NULL,
	"source_user_id" text NOT NULL,
	"source_agent_id" text NOT NULL,
	"destination_user_id" text,
	"destination_channel_id" text,
	"status" "conversation_import_item_status" DEFAULT 'discovered' NOT NULL,
	"ownership_evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"coverage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"encrypted_resources" text,
	"content_hash" text,
	"converter_version" integer DEFAULT 1 NOT NULL,
	"captured_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_import_items_converter_check" CHECK ("conversation_import_items"."converter_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "conversation_import_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requested_by" text NOT NULL,
	"source_namespace" text NOT NULL,
	"source_origin" text NOT NULL,
	"source_reference" text NOT NULL,
	"phase" "conversation_import_phase" DEFAULT 'inventory' NOT NULL,
	"scope" jsonb NOT NULL,
	"manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"approved_manifest_hash" text,
	"checkpoint" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_import_jobs_version_check" CHECK ("conversation_import_jobs"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "conversation_import_mappings" (
	"source_namespace" text NOT NULL,
	"source_thread_id" text NOT NULL,
	"source_origin" text NOT NULL,
	"source_user_id" text NOT NULL,
	"destination_thread_id" text NOT NULL,
	"item_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_import_mappings_source_namespace_source_thread_id_pk" PRIMARY KEY("source_namespace","source_thread_id")
);
--> statement-breakpoint
ALTER TABLE "conversation_import_items" ADD CONSTRAINT "conversation_import_items_job_id_conversation_import_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."conversation_import_jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_import_jobs" ADD CONSTRAINT "conversation_import_jobs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_import_mappings" ADD CONSTRAINT "conversation_import_mappings_destination_thread_id_conversation_threads_id_fk" FOREIGN KEY ("destination_thread_id") REFERENCES "public"."conversation_threads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_import_mappings" ADD CONSTRAINT "conversation_import_mappings_item_id_conversation_import_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."conversation_import_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_import_items_job_thread_idx" ON "conversation_import_items" USING btree ("job_id","source_thread_id");--> statement-breakpoint
CREATE INDEX "conversation_import_items_status_idx" ON "conversation_import_items" USING btree ("job_id","status");--> statement-breakpoint
CREATE INDEX "conversation_import_jobs_requester_idx" ON "conversation_import_jobs" USING btree ("requested_by","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_import_mapping_destination_idx" ON "conversation_import_mappings" USING btree ("destination_thread_id");