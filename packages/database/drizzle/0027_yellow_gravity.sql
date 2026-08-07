CREATE TABLE "knowledge_smart_search_result" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"knowledge_batch_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"source_type" "knowledge_analysis_source_type" NOT NULL,
	"source_id" varchar(511) NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"display_title" varchar(1000) NOT NULL,
	"display_summary" text NOT NULL,
	"source_date" date,
	"matched_terms" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rationale" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_smart_search_result_ordinal_check" CHECK ("knowledge_smart_search_result"."ordinal" >= 0),
	CONSTRAINT "knowledge_smart_search_result_hash_check" CHECK ("knowledge_smart_search_result"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "knowledge_smart_search_result_title_check" CHECK (char_length(trim("knowledge_smart_search_result"."display_title")) between 1 and 1000),
	CONSTRAINT "knowledge_smart_search_result_rationale_check" CHECK (char_length(trim("knowledge_smart_search_result"."rationale")) between 1 and 4000)
);
--> statement-breakpoint
ALTER TABLE "knowledge_smart_search_run" ADD COLUMN "intent" varchar(32);--> statement-breakpoint
ALTER TABLE "knowledge_smart_search_run" ADD COLUMN "applied_conditions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_smart_search_run" ADD COLUMN "limitations" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_smart_search_run" ADD COLUMN "exact_total" integer;--> statement-breakpoint
ALTER TABLE "knowledge_smart_search_run" ADD COLUMN "lecture_count" integer;--> statement-breakpoint
ALTER TABLE "knowledge_smart_search_run" ADD COLUMN "case_count" integer;--> statement-breakpoint
ALTER TABLE "knowledge_smart_search_run" ADD COLUMN "safe_error_stage" varchar(32);--> statement-breakpoint
ALTER TABLE "knowledge_smart_search_result" ADD CONSTRAINT "knowledge_smart_search_result_run_id_knowledge_smart_search_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."knowledge_smart_search_run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_smart_search_result" ADD CONSTRAINT "knowledge_smart_search_result_knowledge_batch_id_knowledge_import_batch_id_fk" FOREIGN KEY ("knowledge_batch_id") REFERENCES "public"."knowledge_import_batch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_smart_search_result_run_ordinal_unique" ON "knowledge_smart_search_result" USING btree ("run_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_smart_search_result_run_source_unique" ON "knowledge_smart_search_result" USING btree ("run_id","source_type","source_id");--> statement-breakpoint
CREATE INDEX "knowledge_smart_search_result_run_idx" ON "knowledge_smart_search_result" USING btree ("run_id","ordinal");--> statement-breakpoint
ALTER TABLE "knowledge_smart_search_run" ADD CONSTRAINT "knowledge_smart_search_intent_check" CHECK ("knowledge_smart_search_run"."intent" is null or "knowledge_smart_search_run"."intent" in ('semantic_search', 'catalog_browse', 'count', 'analysis_required'));--> statement-breakpoint
ALTER TABLE "knowledge_smart_search_run" ADD CONSTRAINT "knowledge_smart_search_counts_check" CHECK (("knowledge_smart_search_run"."exact_total" is null or "knowledge_smart_search_run"."exact_total" >= 0) and ("knowledge_smart_search_run"."lecture_count" is null or "knowledge_smart_search_run"."lecture_count" >= 0) and ("knowledge_smart_search_run"."case_count" is null or "knowledge_smart_search_run"."case_count" >= 0));--> statement-breakpoint
ALTER TABLE "knowledge_smart_search_run" ADD CONSTRAINT "knowledge_smart_search_error_stage_check" CHECK ("knowledge_smart_search_run"."safe_error_stage" is null or "knowledge_smart_search_run"."safe_error_stage" in ('planning', 'retrieval', 'rerank', 'pagination', 'workspace_handoff'));
--> statement-breakpoint
CREATE TRIGGER "knowledge_smart_search_result_immutable"
	BEFORE UPDATE OR DELETE ON "knowledge_smart_search_result"
	FOR EACH ROW EXECUTE FUNCTION "prevent_immutable_record_mutation"();
