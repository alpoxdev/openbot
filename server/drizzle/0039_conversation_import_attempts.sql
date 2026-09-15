ALTER TABLE "conversation_baselines" ALTER COLUMN "baseline_sequence" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "conversation_threads" ALTER COLUMN "next_sequence" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "conversation_threads" ALTER COLUMN "latest_sequence" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "conversation_import_jobs" ADD COLUMN "attempt_token" text;--> statement-breakpoint
ALTER TABLE "conversation_import_jobs" ADD COLUMN "attempt_kind" text;--> statement-breakpoint
ALTER TABLE "conversation_import_jobs" ADD COLUMN "attempt_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversation_import_jobs" ADD CONSTRAINT "conversation_import_jobs_attempt_check" CHECK (("conversation_import_jobs"."attempt_token" is null and "conversation_import_jobs"."attempt_kind" is null and "conversation_import_jobs"."attempt_lease_expires_at" is null) or ("conversation_import_jobs"."attempt_token" is not null and "conversation_import_jobs"."attempt_kind" in ('inventory', 'run') and "conversation_import_jobs"."attempt_lease_expires_at" is not null));