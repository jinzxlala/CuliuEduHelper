ALTER TABLE "knowledge_case_version" ADD COLUMN "profile_summary" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_case_version" ADD COLUMN "development_path" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_case_version" ADD COLUMN "core_projects" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_case_version" ADD COLUMN "core_strengths" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_case_version" ADD COLUMN "application_strategy" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_case_version" ADD COLUMN "advisor_insights" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_case_version" ADD COLUMN "verified_facts" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_case_version" ADD COLUMN "interpretations" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_case_version" ADD COLUMN "missing_information" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_case_version" ADD COLUMN "evidence_points" jsonb DEFAULT '[]'::jsonb NOT NULL;