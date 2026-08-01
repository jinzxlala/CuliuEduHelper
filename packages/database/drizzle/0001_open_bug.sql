CREATE TYPE "public"."knowledge_import_attempt_status" AS ENUM('running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."knowledge_import_stage" AS ENUM('authorization', 'validation', 'storage', 'database', 'search', 'finalize', 'complete');--> statement-breakpoint
CREATE TYPE "public"."knowledge_import_status" AS ENUM('staging', 'publishing', 'published', 'failed');--> statement-breakpoint
CREATE TYPE "public"."knowledge_source_role" AS ENUM('analysis_markdown', 'transcript_json', 'transcript_qa', 'transcript_srt', 'transcript_text');--> statement-breakpoint
CREATE TABLE "knowledge_case_version" (
	"batch_id" uuid NOT NULL,
	"case_id" varchar(511) NOT NULL,
	"lecture_id" varchar(511) NOT NULL,
	"source_document_id" uuid NOT NULL,
	"case_type" text NOT NULL,
	"curriculum_system" text,
	"academic_label" text NOT NULL,
	"background" text NOT NULL,
	"admission_result" text NOT NULL,
	"schools" text[] NOT NULL,
	"major" text,
	"research_methods" text[] NOT NULL,
	"activity_types" text[] NOT NULL,
	"ai_domains" text[] NOT NULL,
	"ai_depth" text,
	"confidence" varchar(16) NOT NULL,
	"evidence_boundary" text NOT NULL,
	"timestamp_refs" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_case_version_batch_id_case_id_pk" PRIMARY KEY("batch_id","case_id"),
	CONSTRAINT "knowledge_case_version_type_check" CHECK (char_length("knowledge_case_version"."case_type") > 0),
	CONSTRAINT "knowledge_case_version_confidence_check" CHECK ("knowledge_case_version"."confidence" in ('high', 'medium', 'low', 'unknown')),
	CONSTRAINT "knowledge_case_version_timestamp_gate_check" CHECK (jsonb_array_length("knowledge_case_version"."timestamp_refs") = 0)
);
--> statement-breakpoint
CREATE TABLE "knowledge_import_attempt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"background_job_id" uuid,
	"attempt_number" integer NOT NULL,
	"status" "knowledge_import_attempt_status" DEFAULT 'running' NOT NULL,
	"stage" "knowledge_import_stage" DEFAULT 'validation' NOT NULL,
	"error_code" varchar(128),
	"error_source_key" text,
	"error_source_role" "knowledge_source_role",
	"failure_summary" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "knowledge_import_attempt_number_check" CHECK ("knowledge_import_attempt"."attempt_number" > 0),
	CONSTRAINT "knowledge_import_attempt_state_check" CHECK (("knowledge_import_attempt"."status" = 'running' and "knowledge_import_attempt"."completed_at" is null and "knowledge_import_attempt"."error_code" is null and "knowledge_import_attempt"."failure_summary" is null) or ("knowledge_import_attempt"."status" = 'succeeded' and "knowledge_import_attempt"."completed_at" is not null and "knowledge_import_attempt"."error_code" is null and "knowledge_import_attempt"."failure_summary" is null and "knowledge_import_attempt"."stage" = 'complete') or ("knowledge_import_attempt"."status" = 'failed' and "knowledge_import_attempt"."completed_at" is not null and "knowledge_import_attempt"."error_code" is not null and "knowledge_import_attempt"."failure_summary" is not null)),
	CONSTRAINT "knowledge_import_attempt_failure_summary_check" CHECK ("knowledge_import_attempt"."failure_summary" is null or char_length("knowledge_import_attempt"."failure_summary") <= 2048)
);
--> statement-breakpoint
CREATE TABLE "knowledge_import_batch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"corpus_id" varchar(128) NOT NULL,
	"corpus_hash" varchar(64) NOT NULL,
	"manifest_version" varchar(32) NOT NULL,
	"mapping_version" varchar(32) NOT NULL,
	"status" "knowledge_import_status" DEFAULT 'staging' NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"expected_lecture_count" integer NOT NULL,
	"lecture_count" integer DEFAULT 0 NOT NULL,
	"case_count" integer DEFAULT 0 NOT NULL,
	"transcript_segment_count" integer DEFAULT 0 NOT NULL,
	"transcript_publication_approved" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "knowledge_import_batch_hash_check" CHECK ("knowledge_import_batch"."corpus_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "knowledge_import_batch_counts_check" CHECK ("knowledge_import_batch"."expected_lecture_count" > 0 and "knowledge_import_batch"."lecture_count" >= 0 and "knowledge_import_batch"."case_count" >= 0 and "knowledge_import_batch"."transcript_segment_count" >= 0),
	CONSTRAINT "knowledge_import_batch_privacy_gate_check" CHECK ("knowledge_import_batch"."transcript_publication_approved" = false and "knowledge_import_batch"."transcript_segment_count" = 0),
	CONSTRAINT "knowledge_import_batch_state_check" CHECK (("knowledge_import_batch"."status" = 'published' and "knowledge_import_batch"."published_at" is not null) or ("knowledge_import_batch"."status" <> 'published' and "knowledge_import_batch"."published_at" is null)),
	CONSTRAINT "knowledge_import_batch_current_check" CHECK ("knowledge_import_batch"."is_current" = false or "knowledge_import_batch"."status" = 'published')
);
--> statement-breakpoint
CREATE TABLE "knowledge_import_source" (
	"batch_id" uuid NOT NULL,
	"lecture_id" varchar(511) NOT NULL,
	"source_role" "knowledge_source_role" NOT NULL,
	"source_document_id" uuid NOT NULL,
	"evidence_object_id" uuid NOT NULL,
	"source_key" text NOT NULL,
	"logical_path" text NOT NULL,
	"root_id" varchar(128) NOT NULL,
	"byte_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_import_source_batch_id_lecture_id_source_role_pk" PRIMARY KEY("batch_id","lecture_id","source_role"),
	CONSTRAINT "knowledge_import_source_bytes_check" CHECK ("knowledge_import_source"."byte_count" > 0),
	CONSTRAINT "knowledge_import_source_logical_path_check" CHECK ("knowledge_import_source"."logical_path" like 'knowledge/%' and "knowledge_import_source"."logical_path" not like '%..%')
);
--> statement-breakpoint
CREATE TABLE "knowledge_lecture_version" (
	"batch_id" uuid NOT NULL,
	"lecture_id" varchar(511) NOT NULL,
	"source_document_id" uuid NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"trend_text" text NOT NULL,
	"ai_cross_disciplinary_text" text NOT NULL,
	"failure_text" text NOT NULL,
	"lecture_date" date,
	"organization" text,
	"speakers" text[] NOT NULL,
	"schools" text[] NOT NULL,
	"majors" text[] NOT NULL,
	"source_path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_lecture_version_batch_id_lecture_id_pk" PRIMARY KEY("batch_id","lecture_id"),
	CONSTRAINT "knowledge_lecture_version_title_check" CHECK (char_length("knowledge_lecture_version"."title") > 0),
	CONSTRAINT "knowledge_lecture_version_source_path_check" CHECK ("knowledge_lecture_version"."source_path" like 'knowledge/analysis/%' and "knowledge_lecture_version"."source_path" not like '%..%')
);
--> statement-breakpoint
ALTER TABLE "knowledge_case_version" ADD CONSTRAINT "knowledge_case_version_batch_id_knowledge_import_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."knowledge_import_batch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_case_version" ADD CONSTRAINT "knowledge_case_version_source_document_id_source_document_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."source_document"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_case_version" ADD CONSTRAINT "knowledge_case_version_lecture_fk" FOREIGN KEY ("batch_id","lecture_id") REFERENCES "public"."knowledge_lecture_version"("batch_id","lecture_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_import_attempt" ADD CONSTRAINT "knowledge_import_attempt_batch_id_knowledge_import_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."knowledge_import_batch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_import_attempt" ADD CONSTRAINT "knowledge_import_attempt_background_job_id_background_job_id_fk" FOREIGN KEY ("background_job_id") REFERENCES "public"."background_job"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_import_source" ADD CONSTRAINT "knowledge_import_source_batch_id_knowledge_import_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."knowledge_import_batch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_import_source" ADD CONSTRAINT "knowledge_import_source_source_document_id_source_document_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."source_document"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_import_source" ADD CONSTRAINT "knowledge_import_source_evidence_object_id_evidence_object_id_fk" FOREIGN KEY ("evidence_object_id") REFERENCES "public"."evidence_object"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_lecture_version" ADD CONSTRAINT "knowledge_lecture_version_batch_id_knowledge_import_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."knowledge_import_batch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_lecture_version" ADD CONSTRAINT "knowledge_lecture_version_source_document_id_source_document_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."source_document"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_case_version_lecture_idx" ON "knowledge_case_version" USING btree ("batch_id","lecture_id");--> statement-breakpoint
CREATE INDEX "knowledge_case_version_source_idx" ON "knowledge_case_version" USING btree ("source_document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_import_attempt_batch_number_unique" ON "knowledge_import_attempt" USING btree ("batch_id","attempt_number");--> statement-breakpoint
CREATE INDEX "knowledge_import_attempt_batch_started_idx" ON "knowledge_import_attempt" USING btree ("batch_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_import_batch_identity_unique" ON "knowledge_import_batch" USING btree ("corpus_id","corpus_hash","mapping_version");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_import_batch_current_unique" ON "knowledge_import_batch" USING btree ("is_current") WHERE "knowledge_import_batch"."is_current" = true;--> statement-breakpoint
CREATE INDEX "knowledge_import_batch_status_created_idx" ON "knowledge_import_batch" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_import_source_batch_document_unique" ON "knowledge_import_source" USING btree ("batch_id","source_document_id");--> statement-breakpoint
CREATE INDEX "knowledge_import_source_document_idx" ON "knowledge_import_source" USING btree ("source_document_id");--> statement-breakpoint
CREATE INDEX "knowledge_lecture_version_source_idx" ON "knowledge_lecture_version" USING btree ("source_document_id");