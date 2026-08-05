CREATE TABLE "knowledge_analysis_conversation_summary" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"through_sequence" integer NOT NULL,
	"content_markdown" text NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_analysis_summary_version_check" CHECK ("knowledge_analysis_conversation_summary"."version" > 0),
	CONSTRAINT "knowledge_analysis_summary_sequence_check" CHECK ("knowledge_analysis_conversation_summary"."through_sequence" > 0),
	CONSTRAINT "knowledge_analysis_summary_hash_check" CHECK ("knowledge_analysis_conversation_summary"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "knowledge_analysis_summary_content_check" CHECK (char_length(trim("knowledge_analysis_conversation_summary"."content_markdown")) between 1 and 60000)
);
--> statement-breakpoint
ALTER TABLE "knowledge_analysis_conversation_summary" ADD CONSTRAINT "knowledge_analysis_conversation_summary_workspace_id_knowledge_analysis_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."knowledge_analysis_workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_analysis_conversation_summary" ADD CONSTRAINT "knowledge_analysis_conversation_summary_agent_run_id_knowledge_agent_run_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."knowledge_agent_run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_analysis_conversation_summary" ADD CONSTRAINT "knowledge_analysis_summary_conversation_workspace_fk" FOREIGN KEY ("conversation_id","workspace_id") REFERENCES "public"."knowledge_analysis_conversation"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_analysis_summary_conversation_version_unique" ON "knowledge_analysis_conversation_summary" USING btree ("conversation_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_analysis_summary_conversation_sequence_unique" ON "knowledge_analysis_conversation_summary" USING btree ("conversation_id","through_sequence");--> statement-breakpoint
CREATE TRIGGER "knowledge_analysis_conversation_summary_append_only"
BEFORE UPDATE OR DELETE ON "knowledge_analysis_conversation_summary"
FOR EACH ROW EXECUTE FUNCTION "protect_append_only_knowledge_record"();
