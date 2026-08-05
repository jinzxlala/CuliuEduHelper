CREATE TYPE "public"."knowledge_agent_run_kind" AS ENUM('smart_search', 'analysis_chat', 'analysis_report');--> statement-breakpoint
CREATE TYPE "public"."knowledge_agent_run_status" AS ENUM('queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."knowledge_analysis_source_type" AS ENUM('lecture', 'case');--> statement-breakpoint
CREATE TYPE "public"."knowledge_conversation_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."knowledge_message_role" AS ENUM('user', 'assistant');--> statement-breakpoint
CREATE TYPE "public"."knowledge_report_status" AS ENUM('queued', 'planning', 'computing', 'rendering', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."knowledge_workspace_role" AS ENUM('owner', 'editor', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."knowledge_workspace_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TABLE "knowledge_agent_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "knowledge_agent_run_kind" NOT NULL,
	"status" "knowledge_agent_run_status" DEFAULT 'queued' NOT NULL,
	"authorization_context_id" uuid NOT NULL,
	"smart_search_run_id" uuid,
	"workspace_id" uuid,
	"conversation_id" uuid,
	"input_snapshot_hash" varchar(64) NOT NULL,
	"git_commit_sha" varchar(40) NOT NULL,
	"model" varchar(128) NOT NULL,
	"prompt_version" varchar(128) NOT NULL,
	"schema_version" varchar(128) NOT NULL,
	"context_version" varchar(128) NOT NULL,
	"pricing_version" varchar(128) NOT NULL,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"total_tokens" integer,
	"cost_microunits" integer,
	"safe_error_code" varchar(128),
	"safe_error_summary" varchar(2048),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "knowledge_agent_run_snapshot_hash_check" CHECK ("knowledge_agent_run"."input_snapshot_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "knowledge_agent_run_git_sha_check" CHECK ("knowledge_agent_run"."git_commit_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "knowledge_agent_run_scope_check" CHECK (("knowledge_agent_run"."kind" = 'smart_search' and "knowledge_agent_run"."smart_search_run_id" is not null and "knowledge_agent_run"."workspace_id" is null and "knowledge_agent_run"."conversation_id" is null) or ("knowledge_agent_run"."kind" in ('analysis_chat', 'analysis_report') and "knowledge_agent_run"."smart_search_run_id" is null and "knowledge_agent_run"."workspace_id" is not null and "knowledge_agent_run"."conversation_id" is not null)),
	CONSTRAINT "knowledge_agent_run_usage_check" CHECK (("knowledge_agent_run"."prompt_tokens" is null and "knowledge_agent_run"."completion_tokens" is null and "knowledge_agent_run"."total_tokens" is null and "knowledge_agent_run"."cost_microunits" is null) or ("knowledge_agent_run"."prompt_tokens" >= 0 and "knowledge_agent_run"."completion_tokens" >= 0 and "knowledge_agent_run"."total_tokens" >= "knowledge_agent_run"."prompt_tokens" + "knowledge_agent_run"."completion_tokens" and "knowledge_agent_run"."cost_microunits" >= 0)),
	CONSTRAINT "knowledge_agent_run_state_check" CHECK (("knowledge_agent_run"."status" = 'queued' and "knowledge_agent_run"."started_at" is null and "knowledge_agent_run"."completed_at" is null and "knowledge_agent_run"."safe_error_code" is null and "knowledge_agent_run"."safe_error_summary" is null) or ("knowledge_agent_run"."status" = 'running' and "knowledge_agent_run"."started_at" is not null and "knowledge_agent_run"."completed_at" is null and "knowledge_agent_run"."safe_error_code" is null and "knowledge_agent_run"."safe_error_summary" is null) or ("knowledge_agent_run"."status" = 'succeeded' and "knowledge_agent_run"."started_at" is not null and "knowledge_agent_run"."completed_at" is not null and "knowledge_agent_run"."safe_error_code" is null and "knowledge_agent_run"."safe_error_summary" is null) or ("knowledge_agent_run"."status" = 'failed' and "knowledge_agent_run"."started_at" is not null and "knowledge_agent_run"."completed_at" is not null and "knowledge_agent_run"."safe_error_code" is not null and "knowledge_agent_run"."safe_error_summary" is not null))
);
--> statement-breakpoint
CREATE TABLE "knowledge_analysis_conversation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"title" varchar(200) NOT NULL,
	"status" "knowledge_conversation_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "knowledge_analysis_conversation_title_check" CHECK (char_length(trim("knowledge_analysis_conversation"."title")) between 1 and 200),
	CONSTRAINT "knowledge_analysis_conversation_state_check" CHECK (("knowledge_analysis_conversation"."status" = 'active' and "knowledge_analysis_conversation"."archived_at" is null) or ("knowledge_analysis_conversation"."status" = 'archived' and "knowledge_analysis_conversation"."archived_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "knowledge_analysis_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"role" "knowledge_message_role" NOT NULL,
	"content_markdown" text NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"agent_run_id" uuid,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_analysis_message_sequence_check" CHECK ("knowledge_analysis_message"."sequence" > 0),
	CONSTRAINT "knowledge_analysis_message_content_check" CHECK (char_length(trim("knowledge_analysis_message"."content_markdown")) between 1 and 60000),
	CONSTRAINT "knowledge_analysis_message_actor_check" CHECK (("knowledge_analysis_message"."role" = 'user' and "knowledge_analysis_message"."created_by_user_id" is not null and "knowledge_analysis_message"."agent_run_id" is null) or ("knowledge_analysis_message"."role" = 'assistant' and "knowledge_analysis_message"."created_by_user_id" is null and "knowledge_analysis_message"."agent_run_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "knowledge_analysis_report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"agent_run_id" uuid,
	"created_by_user_id" uuid NOT NULL,
	"requirements" varchar(4000) DEFAULT '' NOT NULL,
	"conversation_snapshot_hash" varchar(64) NOT NULL,
	"status" "knowledge_report_status" DEFAULT 'queued' NOT NULL,
	"structured_report" jsonb,
	"interactive_storage_key" text,
	"interactive_content_hash" varchar(64),
	"static_storage_key" text,
	"static_content_hash" varchar(64),
	"template_version" varchar(128) NOT NULL,
	"safe_error_code" varchar(128),
	"safe_error_summary" varchar(2048),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "knowledge_analysis_report_snapshot_hash_check" CHECK ("knowledge_analysis_report"."conversation_snapshot_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "knowledge_analysis_report_storage_check" CHECK (("knowledge_analysis_report"."interactive_storage_key" is null or ("knowledge_analysis_report"."interactive_storage_key" like 'knowledge/reports/%' and "knowledge_analysis_report"."interactive_storage_key" not like '%..%')) and ("knowledge_analysis_report"."static_storage_key" is null or ("knowledge_analysis_report"."static_storage_key" like 'knowledge/reports/%' and "knowledge_analysis_report"."static_storage_key" not like '%..%'))),
	CONSTRAINT "knowledge_analysis_report_hash_check" CHECK (("knowledge_analysis_report"."interactive_content_hash" is null or "knowledge_analysis_report"."interactive_content_hash" ~ '^[0-9a-f]{64}$') and ("knowledge_analysis_report"."static_content_hash" is null or "knowledge_analysis_report"."static_content_hash" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "knowledge_analysis_report_state_check" CHECK (("knowledge_analysis_report"."status" in ('queued', 'planning', 'computing', 'rendering') and "knowledge_analysis_report"."completed_at" is null and "knowledge_analysis_report"."structured_report" is null and "knowledge_analysis_report"."interactive_storage_key" is null and "knowledge_analysis_report"."interactive_content_hash" is null and "knowledge_analysis_report"."static_storage_key" is null and "knowledge_analysis_report"."static_content_hash" is null and "knowledge_analysis_report"."safe_error_code" is null and "knowledge_analysis_report"."safe_error_summary" is null) or ("knowledge_analysis_report"."status" = 'succeeded' and "knowledge_analysis_report"."completed_at" is not null and "knowledge_analysis_report"."agent_run_id" is not null and "knowledge_analysis_report"."structured_report" is not null and "knowledge_analysis_report"."interactive_storage_key" is not null and "knowledge_analysis_report"."interactive_content_hash" is not null and "knowledge_analysis_report"."static_storage_key" is not null and "knowledge_analysis_report"."static_content_hash" is not null and "knowledge_analysis_report"."safe_error_code" is null and "knowledge_analysis_report"."safe_error_summary" is null) or ("knowledge_analysis_report"."status" = 'failed' and "knowledge_analysis_report"."completed_at" is not null and "knowledge_analysis_report"."safe_error_code" is not null and "knowledge_analysis_report"."safe_error_summary" is not null))
);
--> statement-breakpoint
CREATE TABLE "knowledge_analysis_source" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_type" "knowledge_analysis_source_type" NOT NULL,
	"knowledge_batch_id" uuid NOT NULL,
	"source_id" varchar(511) NOT NULL,
	"lecture_id" varchar(511),
	"case_id" varchar(511),
	"content_hash" varchar(64) NOT NULL,
	"supersedes_source_id" uuid,
	"added_by_user_id" uuid NOT NULL,
	"removed_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "knowledge_analysis_source_hash_check" CHECK ("knowledge_analysis_source"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "knowledge_analysis_source_identity_check" CHECK (("knowledge_analysis_source"."source_type" = 'lecture' and "knowledge_analysis_source"."lecture_id" is not null and "knowledge_analysis_source"."case_id" is null and "knowledge_analysis_source"."source_id" = "knowledge_analysis_source"."lecture_id") or ("knowledge_analysis_source"."source_type" = 'case' and "knowledge_analysis_source"."case_id" is not null and "knowledge_analysis_source"."lecture_id" is null and "knowledge_analysis_source"."source_id" = "knowledge_analysis_source"."case_id")),
	CONSTRAINT "knowledge_analysis_source_removal_check" CHECK (("knowledge_analysis_source"."removed_at" is null and "knowledge_analysis_source"."removed_by_user_id" is null) or ("knowledge_analysis_source"."removed_at" is not null and "knowledge_analysis_source"."removed_by_user_id" is not null)),
	CONSTRAINT "knowledge_analysis_source_not_self_superseding" CHECK ("knowledge_analysis_source"."supersedes_source_id" is null or "knowledge_analysis_source"."supersedes_source_id" <> "knowledge_analysis_source"."id")
);
--> statement-breakpoint
CREATE TABLE "knowledge_analysis_workspace_member" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "knowledge_workspace_role" NOT NULL,
	"granted_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_analysis_workspace_member_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "knowledge_analysis_workspace" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" varchar(2000) DEFAULT '' NOT NULL,
	"status" "knowledge_workspace_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "knowledge_analysis_workspace_name_check" CHECK (char_length(trim("knowledge_analysis_workspace"."name")) between 1 and 200),
	CONSTRAINT "knowledge_analysis_workspace_state_check" CHECK (("knowledge_analysis_workspace"."status" = 'active' and "knowledge_analysis_workspace"."archived_at" is null) or ("knowledge_analysis_workspace"."status" = 'archived' and "knowledge_analysis_workspace"."archived_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "knowledge_smart_search_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"authorization_context_id" uuid NOT NULL,
	"knowledge_batch_id" uuid NOT NULL,
	"prompt" text NOT NULL,
	"prompt_hash" varchar(64) NOT NULL,
	"status" "knowledge_agent_run_status" DEFAULT 'queued' NOT NULL,
	"query_plan" jsonb,
	"candidate_references" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"result_references" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" text,
	"git_commit_sha" varchar(40) NOT NULL,
	"model" varchar(128) NOT NULL,
	"prompt_version" varchar(128) NOT NULL,
	"schema_version" varchar(128) NOT NULL,
	"retrieval_version" varchar(128) NOT NULL,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"total_tokens" integer,
	"cost_microunits" integer,
	"safe_error_code" varchar(128),
	"safe_error_summary" varchar(2048),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "knowledge_smart_search_prompt_hash_check" CHECK ("knowledge_smart_search_run"."prompt_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "knowledge_smart_search_git_sha_check" CHECK ("knowledge_smart_search_run"."git_commit_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "knowledge_smart_search_prompt_check" CHECK (char_length(trim("knowledge_smart_search_run"."prompt")) between 1 and 4000),
	CONSTRAINT "knowledge_smart_search_usage_check" CHECK (("knowledge_smart_search_run"."prompt_tokens" is null and "knowledge_smart_search_run"."completion_tokens" is null and "knowledge_smart_search_run"."total_tokens" is null and "knowledge_smart_search_run"."cost_microunits" is null) or ("knowledge_smart_search_run"."prompt_tokens" >= 0 and "knowledge_smart_search_run"."completion_tokens" >= 0 and "knowledge_smart_search_run"."total_tokens" >= "knowledge_smart_search_run"."prompt_tokens" + "knowledge_smart_search_run"."completion_tokens" and "knowledge_smart_search_run"."cost_microunits" >= 0)),
	CONSTRAINT "knowledge_smart_search_state_check" CHECK (("knowledge_smart_search_run"."status" = 'queued' and "knowledge_smart_search_run"."started_at" is null and "knowledge_smart_search_run"."completed_at" is null and "knowledge_smart_search_run"."safe_error_code" is null and "knowledge_smart_search_run"."safe_error_summary" is null) or ("knowledge_smart_search_run"."status" = 'running' and "knowledge_smart_search_run"."started_at" is not null and "knowledge_smart_search_run"."completed_at" is null and "knowledge_smart_search_run"."safe_error_code" is null and "knowledge_smart_search_run"."safe_error_summary" is null) or ("knowledge_smart_search_run"."status" = 'succeeded' and "knowledge_smart_search_run"."started_at" is not null and "knowledge_smart_search_run"."completed_at" is not null and "knowledge_smart_search_run"."query_plan" is not null and "knowledge_smart_search_run"."summary" is not null and "knowledge_smart_search_run"."safe_error_code" is null and "knowledge_smart_search_run"."safe_error_summary" is null) or ("knowledge_smart_search_run"."status" = 'failed' and "knowledge_smart_search_run"."started_at" is not null and "knowledge_smart_search_run"."completed_at" is not null and "knowledge_smart_search_run"."safe_error_code" is not null and "knowledge_smart_search_run"."safe_error_summary" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_analysis_conversation_id_workspace_unique" ON "knowledge_analysis_conversation" USING btree ("id","workspace_id");--> statement-breakpoint
ALTER TABLE "knowledge_agent_run" ADD CONSTRAINT "knowledge_agent_run_authorization_context_id_authorization_context_snapshot_id_fk" FOREIGN KEY ("authorization_context_id") REFERENCES "public"."authorization_context_snapshot"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_agent_run" ADD CONSTRAINT "knowledge_agent_run_smart_search_run_id_knowledge_smart_search_run_id_fk" FOREIGN KEY ("smart_search_run_id") REFERENCES "public"."knowledge_smart_search_run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_agent_run" ADD CONSTRAINT "knowledge_agent_run_workspace_id_knowledge_analysis_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."knowledge_analysis_workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_agent_run" ADD CONSTRAINT "knowledge_agent_run_conversation_workspace_fk" FOREIGN KEY ("conversation_id","workspace_id") REFERENCES "public"."knowledge_analysis_conversation"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_analysis_conversation" ADD CONSTRAINT "knowledge_analysis_conversation_workspace_id_knowledge_analysis_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."knowledge_analysis_workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_analysis_conversation" ADD CONSTRAINT "knowledge_analysis_conversation_created_by_user_id_app_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_analysis_message" ADD CONSTRAINT "knowledge_analysis_message_workspace_id_knowledge_analysis_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."knowledge_analysis_workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_analysis_message" ADD CONSTRAINT "knowledge_analysis_message_agent_run_id_knowledge_agent_run_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."knowledge_agent_run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_analysis_message" ADD CONSTRAINT "knowledge_analysis_message_created_by_user_id_app_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_analysis_message" ADD CONSTRAINT "knowledge_analysis_message_conversation_workspace_fk" FOREIGN KEY ("conversation_id","workspace_id") REFERENCES "public"."knowledge_analysis_conversation"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_analysis_report" ADD CONSTRAINT "knowledge_analysis_report_workspace_id_knowledge_analysis_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."knowledge_analysis_workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_analysis_report" ADD CONSTRAINT "knowledge_analysis_report_agent_run_id_knowledge_agent_run_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."knowledge_agent_run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_analysis_report" ADD CONSTRAINT "knowledge_analysis_report_created_by_user_id_app_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_analysis_report" ADD CONSTRAINT "knowledge_analysis_report_conversation_workspace_fk" FOREIGN KEY ("conversation_id","workspace_id") REFERENCES "public"."knowledge_analysis_conversation"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_analysis_source" ADD CONSTRAINT "knowledge_analysis_source_workspace_id_knowledge_analysis_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."knowledge_analysis_workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_analysis_source" ADD CONSTRAINT "knowledge_analysis_source_knowledge_batch_id_knowledge_import_batch_id_fk" FOREIGN KEY ("knowledge_batch_id") REFERENCES "public"."knowledge_import_batch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_analysis_source" ADD CONSTRAINT "knowledge_analysis_source_supersedes_source_id_knowledge_analysis_source_id_fk" FOREIGN KEY ("supersedes_source_id") REFERENCES "public"."knowledge_analysis_source"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_analysis_source" ADD CONSTRAINT "knowledge_analysis_source_added_by_user_id_app_user_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_analysis_source" ADD CONSTRAINT "knowledge_analysis_source_removed_by_user_id_app_user_id_fk" FOREIGN KEY ("removed_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_analysis_source" ADD CONSTRAINT "knowledge_analysis_source_lecture_fk" FOREIGN KEY ("knowledge_batch_id","lecture_id") REFERENCES "public"."knowledge_lecture_version"("batch_id","lecture_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_analysis_source" ADD CONSTRAINT "knowledge_analysis_source_case_fk" FOREIGN KEY ("knowledge_batch_id","case_id") REFERENCES "public"."knowledge_case_version"("batch_id","case_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_analysis_workspace_member" ADD CONSTRAINT "knowledge_analysis_workspace_member_workspace_id_knowledge_analysis_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."knowledge_analysis_workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_analysis_workspace_member" ADD CONSTRAINT "knowledge_analysis_workspace_member_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_analysis_workspace_member" ADD CONSTRAINT "knowledge_analysis_workspace_member_granted_by_user_id_app_user_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_analysis_workspace" ADD CONSTRAINT "knowledge_analysis_workspace_owner_user_id_app_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_smart_search_run" ADD CONSTRAINT "knowledge_smart_search_run_created_by_user_id_app_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_smart_search_run" ADD CONSTRAINT "knowledge_smart_search_run_authorization_context_id_authorization_context_snapshot_id_fk" FOREIGN KEY ("authorization_context_id") REFERENCES "public"."authorization_context_snapshot"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_smart_search_run" ADD CONSTRAINT "knowledge_smart_search_run_knowledge_batch_id_knowledge_import_batch_id_fk" FOREIGN KEY ("knowledge_batch_id") REFERENCES "public"."knowledge_import_batch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_agent_run_workspace_created_idx" ON "knowledge_agent_run" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "knowledge_agent_run_conversation_created_idx" ON "knowledge_agent_run" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "knowledge_analysis_conversation_workspace_updated_idx" ON "knowledge_analysis_conversation" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_analysis_message_sequence_unique" ON "knowledge_analysis_message" USING btree ("conversation_id","sequence");--> statement-breakpoint
CREATE INDEX "knowledge_analysis_message_conversation_created_idx" ON "knowledge_analysis_message" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "knowledge_analysis_report_workspace_created_idx" ON "knowledge_analysis_report" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "knowledge_analysis_report_conversation_created_idx" ON "knowledge_analysis_report" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_analysis_source_active_unique" ON "knowledge_analysis_source" USING btree ("workspace_id","source_type","source_id") WHERE "knowledge_analysis_source"."removed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_analysis_source_supersedes_unique" ON "knowledge_analysis_source" USING btree ("supersedes_source_id") WHERE "knowledge_analysis_source"."supersedes_source_id" is not null;--> statement-breakpoint
CREATE INDEX "knowledge_analysis_source_workspace_created_idx" ON "knowledge_analysis_source" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "knowledge_analysis_member_user_idx" ON "knowledge_analysis_workspace_member" USING btree ("user_id","workspace_id");--> statement-breakpoint
CREATE INDEX "knowledge_analysis_workspace_owner_updated_idx" ON "knowledge_analysis_workspace" USING btree ("owner_user_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_analysis_workspace_id_owner_unique" ON "knowledge_analysis_workspace" USING btree ("id","owner_user_id");--> statement-breakpoint
CREATE INDEX "knowledge_smart_search_user_created_idx" ON "knowledge_smart_search_run" USING btree ("created_by_user_id","created_at");--> statement-breakpoint
CREATE INDEX "knowledge_smart_search_batch_created_idx" ON "knowledge_smart_search_run" USING btree ("knowledge_batch_id","created_at");--> statement-breakpoint

CREATE FUNCTION "validate_knowledge_workspace_member"() RETURNS trigger AS $$
DECLARE
  workspace_owner uuid;
  account_role user_role;
  account_active boolean;
BEGIN
  SELECT owner_user_id INTO workspace_owner
  FROM knowledge_analysis_workspace
  WHERE id = NEW.workspace_id;

  SELECT role, active INTO account_role, account_active
  FROM app_user
  WHERE id = NEW.user_id;

  IF workspace_owner IS NULL OR account_role IS NULL OR account_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'knowledge workspace membership target is unavailable';
  END IF;
  IF account_role = 'service' THEN
    RAISE EXCEPTION 'service accounts cannot join knowledge workspaces';
  END IF;
  IF account_role = 'auditor' AND NEW.role <> 'viewer' THEN
    RAISE EXCEPTION 'auditors can only be knowledge workspace viewers';
  END IF;
  IF (NEW.user_id = workspace_owner AND NEW.role <> 'owner') OR
     (NEW.user_id <> workspace_owner AND NEW.role = 'owner') THEN
    RAISE EXCEPTION 'knowledge workspace owner membership is inconsistent';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "knowledge_workspace_member_validate"
BEFORE INSERT OR UPDATE ON "knowledge_analysis_workspace_member"
FOR EACH ROW EXECUTE FUNCTION "validate_knowledge_workspace_member"();--> statement-breakpoint

CREATE FUNCTION "protect_knowledge_workspace_owner_membership"() RETURNS trigger AS $$
DECLARE
  workspace_owner uuid;
BEGIN
  SELECT owner_user_id INTO workspace_owner
  FROM knowledge_analysis_workspace
  WHERE id = OLD.workspace_id;
  IF OLD.user_id = workspace_owner THEN
    RAISE EXCEPTION 'knowledge workspace owner membership cannot be deleted';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "knowledge_workspace_owner_membership_protect"
BEFORE DELETE ON "knowledge_analysis_workspace_member"
FOR EACH ROW EXECUTE FUNCTION "protect_knowledge_workspace_owner_membership"();--> statement-breakpoint

CREATE FUNCTION "validate_knowledge_analysis_source"() RETURNS trigger AS $$
DECLARE
  source_count integer;
  batch_status knowledge_import_status;
  expected_content_hash text;
  prior_source knowledge_analysis_source%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id::text, 0));
  SELECT status INTO batch_status
  FROM knowledge_import_batch
  WHERE id = NEW.knowledge_batch_id;
  IF batch_status IS DISTINCT FROM 'published' THEN
    RAISE EXCEPTION 'knowledge workspace sources must use a published batch';
  END IF;

  IF NEW.source_type = 'lecture' THEN
    SELECT d.content_hash INTO expected_content_hash
    FROM knowledge_lecture_version v
    JOIN source_document d ON d.id = v.source_document_id
    WHERE v.batch_id = NEW.knowledge_batch_id AND v.lecture_id = NEW.source_id;
  ELSE
    SELECT d.content_hash INTO expected_content_hash
    FROM knowledge_case_version v
    JOIN source_document d ON d.id = v.source_document_id
    WHERE v.batch_id = NEW.knowledge_batch_id AND v.case_id = NEW.source_id;
  END IF;
  IF expected_content_hash IS NULL OR expected_content_hash <> NEW.content_hash THEN
    RAISE EXCEPTION 'knowledge workspace source content hash is invalid';
  END IF;

  IF NEW.supersedes_source_id IS NOT NULL THEN
    SELECT * INTO prior_source
    FROM knowledge_analysis_source
    WHERE id = NEW.supersedes_source_id;
    IF prior_source.id IS NULL OR prior_source.workspace_id <> NEW.workspace_id OR
       prior_source.source_type <> NEW.source_type OR prior_source.source_id <> NEW.source_id OR
       prior_source.removed_at IS NULL THEN
      RAISE EXCEPTION 'knowledge workspace source revision is invalid';
    END IF;
  END IF;

  SELECT count(*) INTO source_count
  FROM knowledge_analysis_source
  WHERE workspace_id = NEW.workspace_id AND removed_at IS NULL;
  IF source_count >= 100 THEN
    RAISE EXCEPTION 'knowledge workspace source limit exceeded';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "knowledge_analysis_source_validate"
BEFORE INSERT ON "knowledge_analysis_source"
FOR EACH ROW EXECUTE FUNCTION "validate_knowledge_analysis_source"();--> statement-breakpoint

CREATE FUNCTION "protect_knowledge_analysis_source"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'knowledge workspace sources cannot be deleted';
  END IF;
  IF OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'removed knowledge workspace sources are immutable';
  END IF;
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR
     NEW.source_type <> OLD.source_type OR NEW.knowledge_batch_id <> OLD.knowledge_batch_id OR
     NEW.source_id <> OLD.source_id OR NEW.lecture_id IS DISTINCT FROM OLD.lecture_id OR
     NEW.case_id IS DISTINCT FROM OLD.case_id OR NEW.content_hash <> OLD.content_hash OR
     NEW.supersedes_source_id IS DISTINCT FROM OLD.supersedes_source_id OR
     NEW.added_by_user_id <> OLD.added_by_user_id OR NEW.created_at <> OLD.created_at OR
     NEW.removed_at IS NULL OR NEW.removed_by_user_id IS NULL THEN
    RAISE EXCEPTION 'knowledge workspace source content is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "knowledge_analysis_source_protect_update"
BEFORE UPDATE ON "knowledge_analysis_source"
FOR EACH ROW EXECUTE FUNCTION "protect_knowledge_analysis_source"();--> statement-breakpoint

CREATE TRIGGER "knowledge_analysis_source_protect_delete"
BEFORE DELETE ON "knowledge_analysis_source"
FOR EACH ROW EXECUTE FUNCTION "protect_knowledge_analysis_source"();--> statement-breakpoint

CREATE FUNCTION "validate_knowledge_conversation_limit"() RETURNS trigger AS $$
DECLARE
  conversation_count integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id::text, 0));
  SELECT count(*) INTO conversation_count
  FROM knowledge_analysis_conversation
  WHERE workspace_id = NEW.workspace_id;
  IF conversation_count >= 50 THEN
    RAISE EXCEPTION 'knowledge workspace conversation limit exceeded';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "knowledge_analysis_conversation_limit"
BEFORE INSERT ON "knowledge_analysis_conversation"
FOR EACH ROW EXECUTE FUNCTION "validate_knowledge_conversation_limit"();--> statement-breakpoint

CREATE FUNCTION "protect_append_only_knowledge_record"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% records are append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "knowledge_analysis_message_append_only"
BEFORE UPDATE OR DELETE ON "knowledge_analysis_message"
FOR EACH ROW EXECUTE FUNCTION "protect_append_only_knowledge_record"();--> statement-breakpoint

CREATE FUNCTION "protect_terminal_knowledge_run"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% records cannot be deleted', TG_TABLE_NAME;
  END IF;
  IF OLD.status IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION '% terminal records are immutable', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "knowledge_smart_search_run_terminal_protect"
BEFORE UPDATE OR DELETE ON "knowledge_smart_search_run"
FOR EACH ROW EXECUTE FUNCTION "protect_terminal_knowledge_run"();--> statement-breakpoint

CREATE TRIGGER "knowledge_agent_run_terminal_protect"
BEFORE UPDATE OR DELETE ON "knowledge_agent_run"
FOR EACH ROW EXECUTE FUNCTION "protect_terminal_knowledge_run"();--> statement-breakpoint

CREATE FUNCTION "protect_terminal_knowledge_report"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'knowledge reports cannot be deleted';
  END IF;
  IF OLD.status IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'terminal knowledge reports are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "knowledge_analysis_report_terminal_protect"
BEFORE UPDATE OR DELETE ON "knowledge_analysis_report"
FOR EACH ROW EXECUTE FUNCTION "protect_terminal_knowledge_report"();
