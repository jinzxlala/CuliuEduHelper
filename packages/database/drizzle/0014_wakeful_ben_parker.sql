CREATE TYPE "public"."knowledge_transcript_submission_status" AS ENUM('queued', 'processing', 'draft_ready', 'published', 'failed');--> statement-breakpoint
CREATE TABLE "knowledge_transcript_submission" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"authorization_context_id" uuid NOT NULL,
	"background_job_id" uuid NOT NULL,
	"source_key" text NOT NULL,
	"lecture_id" varchar(511) NOT NULL,
	"original_file_name" varchar(255) NOT NULL,
	"mime_type" varchar(255) NOT NULL,
	"byte_count" integer NOT NULL,
	"storage_key" text NOT NULL,
	"original_content_hash" varchar(64) NOT NULL,
	"transcript_text" text NOT NULL,
	"transcript_text_hash" varchar(64) NOT NULL,
	"model_input_hash" varchar(64) NOT NULL,
	"outbound_confirmed_at" timestamp with time zone NOT NULL,
	"status" "knowledge_transcript_submission_status" DEFAULT 'queued' NOT NULL,
	"generated_analysis_markdown" text,
	"generated_analysis_hash" varchar(64),
	"reviewed_analysis_markdown" text,
	"reviewed_analysis_hash" varchar(64),
	"provider" varchar(64) NOT NULL,
	"model" varchar(128) NOT NULL,
	"provider_request_id" varchar(256),
	"prompt_version" varchar(64) NOT NULL,
	"prompt_hash" varchar(64) NOT NULL,
	"schema_version" varchar(64) NOT NULL,
	"schema_hash" varchar(64) NOT NULL,
	"redaction_version" varchar(64) NOT NULL,
	"git_commit_sha" varchar(40) NOT NULL,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"total_tokens" integer,
	"published_batch_id" uuid,
	"failure_code" varchar(128),
	"failure_summary" varchar(1024),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "knowledge_transcript_submission_mime_check" CHECK ("knowledge_transcript_submission"."mime_type" in ('text/markdown', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
	CONSTRAINT "knowledge_transcript_submission_size_check" CHECK ("knowledge_transcript_submission"."byte_count" between 1 and 20971520),
	CONSTRAINT "knowledge_transcript_submission_text_check" CHECK (char_length(trim("knowledge_transcript_submission"."transcript_text")) between 1 and 500000),
	CONSTRAINT "knowledge_transcript_submission_hashes_check" CHECK ("knowledge_transcript_submission"."original_content_hash" ~ '^[0-9a-f]{64}$' and "knowledge_transcript_submission"."transcript_text_hash" ~ '^[0-9a-f]{64}$' and "knowledge_transcript_submission"."model_input_hash" ~ '^[0-9a-f]{64}$' and "knowledge_transcript_submission"."prompt_hash" ~ '^[0-9a-f]{64}$' and "knowledge_transcript_submission"."schema_hash" ~ '^[0-9a-f]{64}$' and "knowledge_transcript_submission"."git_commit_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "knowledge_transcript_submission_generated_pair_check" CHECK (("knowledge_transcript_submission"."generated_analysis_markdown" is null) = ("knowledge_transcript_submission"."generated_analysis_hash" is null)),
	CONSTRAINT "knowledge_transcript_submission_reviewed_pair_check" CHECK (("knowledge_transcript_submission"."reviewed_analysis_markdown" is null) = ("knowledge_transcript_submission"."reviewed_analysis_hash" is null)),
	CONSTRAINT "knowledge_transcript_submission_published_check" CHECK (("knowledge_transcript_submission"."status" = 'published' and "knowledge_transcript_submission"."published_batch_id" is not null and "knowledge_transcript_submission"."reviewed_analysis_markdown" is not null and "knowledge_transcript_submission"."completed_at" is not null) or ("knowledge_transcript_submission"."status" <> 'published' and "knowledge_transcript_submission"."published_batch_id" is null)),
	CONSTRAINT "knowledge_transcript_submission_failure_check" CHECK (("knowledge_transcript_submission"."status" = 'failed' and "knowledge_transcript_submission"."failure_code" is not null and "knowledge_transcript_submission"."failure_summary" is not null and "knowledge_transcript_submission"."completed_at" is not null) or ("knowledge_transcript_submission"."status" <> 'failed' and "knowledge_transcript_submission"."failure_code" is null and "knowledge_transcript_submission"."failure_summary" is null)),
	CONSTRAINT "knowledge_transcript_submission_usage_check" CHECK (("knowledge_transcript_submission"."prompt_tokens" is null and "knowledge_transcript_submission"."completion_tokens" is null and "knowledge_transcript_submission"."total_tokens" is null) or ("knowledge_transcript_submission"."prompt_tokens" >= 0 and "knowledge_transcript_submission"."completion_tokens" >= 0 and "knowledge_transcript_submission"."total_tokens" >= 0 and "knowledge_transcript_submission"."prompt_tokens" + "knowledge_transcript_submission"."completion_tokens" <= "knowledge_transcript_submission"."total_tokens")),
	CONSTRAINT "knowledge_transcript_submission_storage_check" CHECK ("knowledge_transcript_submission"."storage_key" like 'knowledge/%' and "knowledge_transcript_submission"."storage_key" not like '%..%')
);
--> statement-breakpoint
ALTER TABLE "knowledge_transcript_submission" ADD CONSTRAINT "knowledge_transcript_submission_actor_user_id_app_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_transcript_submission" ADD CONSTRAINT "knowledge_transcript_submission_authorization_context_id_authorization_context_snapshot_id_fk" FOREIGN KEY ("authorization_context_id") REFERENCES "public"."authorization_context_snapshot"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_transcript_submission" ADD CONSTRAINT "knowledge_transcript_submission_background_job_id_background_job_id_fk" FOREIGN KEY ("background_job_id") REFERENCES "public"."background_job"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_transcript_submission" ADD CONSTRAINT "knowledge_transcript_submission_published_batch_id_knowledge_import_batch_id_fk" FOREIGN KEY ("published_batch_id") REFERENCES "public"."knowledge_import_batch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_transcript_submission_job_unique" ON "knowledge_transcript_submission" USING btree ("background_job_id");--> statement-breakpoint
CREATE INDEX "knowledge_transcript_submission_actor_created_idx" ON "knowledge_transcript_submission" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "knowledge_transcript_submission_status_created_idx" ON "knowledge_transcript_submission" USING btree ("status","created_at");
