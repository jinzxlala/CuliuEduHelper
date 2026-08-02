CREATE TYPE "public"."student_fact_suggestion_decision" AS ENUM('pending', 'accepted', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."student_import_candidate_decision" AS ENUM('pending', 'create', 'link', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."student_import_kind" AS ENUM('basic', 'incremental');--> statement-breakpoint
CREATE TYPE "public"."student_import_status" AS ENUM('uploaded', 'processing', 'review_ready', 'partially_applied', 'applied', 'failed');--> statement-breakpoint
CREATE TABLE "student_fact_suggestion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"candidate_id" uuid,
	"student_id" uuid,
	"field_key" varchar(128) NOT NULL,
	"proposed_value" jsonb NOT NULL,
	"edited_value" jsonb,
	"source_locator" jsonb NOT NULL,
	"confidence" "confidence_level" NOT NULL,
	"decision" "student_fact_suggestion_decision" DEFAULT 'pending' NOT NULL,
	"resulting_fact_id" uuid,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_fact_suggestion_scope_check" CHECK (("student_fact_suggestion"."candidate_id" is not null and "student_fact_suggestion"."student_id" is null) or ("student_fact_suggestion"."candidate_id" is null and "student_fact_suggestion"."student_id" is not null)),
	CONSTRAINT "student_fact_suggestion_field_key_check" CHECK ("student_fact_suggestion"."field_key" ~ '^[a-z][a-z0-9_.-]{0,127}$'),
	CONSTRAINT "student_fact_suggestion_decision_check" CHECK (("student_fact_suggestion"."decision" = 'pending' and "student_fact_suggestion"."resulting_fact_id" is null and "student_fact_suggestion"."decided_by_user_id" is null and "student_fact_suggestion"."decided_at" is null) or ("student_fact_suggestion"."decision" = 'accepted' and "student_fact_suggestion"."resulting_fact_id" is not null and "student_fact_suggestion"."decided_by_user_id" is not null and "student_fact_suggestion"."decided_at" is not null) or ("student_fact_suggestion"."decision" = 'rejected' and "student_fact_suggestion"."resulting_fact_id" is null and "student_fact_suggestion"."decided_by_user_id" is not null and "student_fact_suggestion"."decided_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "student_import_batch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "student_import_kind" NOT NULL,
	"status" "student_import_status" DEFAULT 'uploaded' NOT NULL,
	"selected_student_id" uuid,
	"authorization_context_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"original_file_name" varchar(255) NOT NULL,
	"mime_type" varchar(255) NOT NULL,
	"byte_count" integer NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"storage_key" text NOT NULL,
	"model" varchar(128),
	"prompt_version" varchar(64) NOT NULL,
	"schema_version" varchar(64) NOT NULL,
	"redaction_version" varchar(64) NOT NULL,
	"model_usage" jsonb,
	"error_code" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_import_batch_hash_check" CHECK ("student_import_batch"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "student_import_batch_file_check" CHECK ("student_import_batch"."byte_count" between 1 and 20971520 and char_length(trim("student_import_batch"."original_file_name")) between 1 and 255 and char_length(trim("student_import_batch"."mime_type")) between 1 and 255 and "student_import_batch"."storage_key" like 'student-import/%'),
	CONSTRAINT "student_import_batch_scope_check" CHECK (("student_import_batch"."kind" = 'basic' and "student_import_batch"."selected_student_id" is null) or ("student_import_batch"."kind" = 'incremental' and "student_import_batch"."selected_student_id" is not null)),
	CONSTRAINT "student_import_batch_status_error_check" CHECK (("student_import_batch"."status" = 'failed' and char_length(trim("student_import_batch"."error_code")) > 0) or ("student_import_batch"."status" <> 'failed' and "student_import_batch"."error_code" is null))
);
--> statement-breakpoint
CREATE TABLE "student_import_candidate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"source_ordinal" integer NOT NULL,
	"source_locator" jsonb NOT NULL,
	"display_label" varchar(200) NOT NULL,
	"possible_student_id" uuid,
	"decision" "student_import_candidate_decision" DEFAULT 'pending' NOT NULL,
	"created_student_id" uuid,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_import_candidate_ordinal_check" CHECK ("student_import_candidate"."source_ordinal" > 0),
	CONSTRAINT "student_import_candidate_decision_check" CHECK (("student_import_candidate"."decision" = 'pending' and "student_import_candidate"."created_student_id" is null and "student_import_candidate"."decided_by_user_id" is null and "student_import_candidate"."decided_at" is null) or ("student_import_candidate"."decision" = 'create' and "student_import_candidate"."created_student_id" is not null and "student_import_candidate"."decided_by_user_id" is not null and "student_import_candidate"."decided_at" is not null) or ("student_import_candidate"."decision" = 'link' and "student_import_candidate"."possible_student_id" is not null and "student_import_candidate"."created_student_id" is null and "student_import_candidate"."decided_by_user_id" is not null and "student_import_candidate"."decided_at" is not null) or ("student_import_candidate"."decision" = 'rejected' and "student_import_candidate"."created_student_id" is null and "student_import_candidate"."decided_by_user_id" is not null and "student_import_candidate"."decided_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "student_fact_suggestion" ADD CONSTRAINT "student_fact_suggestion_batch_id_student_import_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."student_import_batch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_fact_suggestion" ADD CONSTRAINT "student_fact_suggestion_candidate_id_student_import_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."student_import_candidate"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_fact_suggestion" ADD CONSTRAINT "student_fact_suggestion_student_id_student_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."student"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_fact_suggestion" ADD CONSTRAINT "student_fact_suggestion_resulting_fact_id_student_fact_id_fk" FOREIGN KEY ("resulting_fact_id") REFERENCES "public"."student_fact"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_fact_suggestion" ADD CONSTRAINT "student_fact_suggestion_decided_by_user_id_app_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_import_batch" ADD CONSTRAINT "student_import_batch_selected_student_id_student_id_fk" FOREIGN KEY ("selected_student_id") REFERENCES "public"."student"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_import_batch" ADD CONSTRAINT "student_import_batch_authorization_context_id_authorization_context_snapshot_id_fk" FOREIGN KEY ("authorization_context_id") REFERENCES "public"."authorization_context_snapshot"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_import_batch" ADD CONSTRAINT "student_import_batch_created_by_user_id_app_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_import_candidate" ADD CONSTRAINT "student_import_candidate_batch_id_student_import_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."student_import_batch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_import_candidate" ADD CONSTRAINT "student_import_candidate_possible_student_id_student_id_fk" FOREIGN KEY ("possible_student_id") REFERENCES "public"."student"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_import_candidate" ADD CONSTRAINT "student_import_candidate_created_student_id_student_id_fk" FOREIGN KEY ("created_student_id") REFERENCES "public"."student"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_import_candidate" ADD CONSTRAINT "student_import_candidate_decided_by_user_id_app_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "student_fact_suggestion_batch_decision_idx" ON "student_fact_suggestion" USING btree ("batch_id","decision");--> statement-breakpoint
CREATE INDEX "student_fact_suggestion_student_created_idx" ON "student_fact_suggestion" USING btree ("student_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "student_import_batch_content_actor_unique" ON "student_import_batch" USING btree ("kind","content_hash","created_by_user_id","selected_student_id");--> statement-breakpoint
CREATE INDEX "student_import_batch_status_created_idx" ON "student_import_batch" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "student_import_batch_student_created_idx" ON "student_import_batch" USING btree ("selected_student_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "student_import_candidate_batch_ordinal_unique" ON "student_import_candidate" USING btree ("batch_id","source_ordinal");--> statement-breakpoint
CREATE INDEX "student_import_candidate_batch_decision_idx" ON "student_import_candidate" USING btree ("batch_id","decision");