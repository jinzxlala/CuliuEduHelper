CREATE TYPE "public"."timetable_run_status" AS ENUM('draft', 'solving', 'solved', 'partially_solved', 'infeasible', 'failed', 'approved', 'archived');--> statement-breakpoint
CREATE TABLE "timetable_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"authorization_context_snapshot_id" uuid NOT NULL,
	"background_job_id" uuid,
	"status" timetable_run_status DEFAULT 'draft' NOT NULL,
	"input_snapshot" jsonb NOT NULL,
	"input_hash" varchar(64) NOT NULL,
	"output" jsonb,
	"output_hash" varchar(64),
	"solver_version" varchar(64) NOT NULL,
	"constraint_version" varchar(128) NOT NULL,
	"objective_version" varchar(128) NOT NULL,
	"runtime_ms" integer,
	"failure_code" varchar(128),
	"created_by_user_id" uuid NOT NULL,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"archived_reason" varchar(512),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "timetable_run_input_hash_check" CHECK ("timetable_run"."input_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "timetable_run_output_hash_check" CHECK ("timetable_run"."output_hash" is null or "timetable_run"."output_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "timetable_run_result_check" CHECK (("timetable_run"."status" in ('draft', 'solving') and "timetable_run"."output" is null and "timetable_run"."output_hash" is null) or ("timetable_run"."status" in ('solved', 'partially_solved', 'infeasible', 'approved', 'archived') and "timetable_run"."output" is not null and "timetable_run"."output_hash" is not null) or ("timetable_run"."status" = 'failed' and "timetable_run"."failure_code" is not null)),
	CONSTRAINT "timetable_run_approval_check" CHECK (("timetable_run"."status" = 'approved' and "timetable_run"."approved_by_user_id" is not null and "timetable_run"."approved_at" is not null) or ("timetable_run"."status" <> 'approved'))
);
--> statement-breakpoint
ALTER TABLE "timetable_run" ADD CONSTRAINT "timetable_run_authorization_context_snapshot_id_authorization_context_snapshot_id_fk" FOREIGN KEY ("authorization_context_snapshot_id") REFERENCES "public"."authorization_context_snapshot"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_run" ADD CONSTRAINT "timetable_run_background_job_id_background_job_id_fk" FOREIGN KEY ("background_job_id") REFERENCES "public"."background_job"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_run" ADD CONSTRAINT "timetable_run_created_by_user_id_app_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timetable_run" ADD CONSTRAINT "timetable_run_approved_by_user_id_app_user_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "timetable_run_input_hash_unique" ON "timetable_run" USING btree ("input_hash");--> statement-breakpoint
CREATE INDEX "timetable_run_status_created_idx" ON "timetable_run" USING btree ("status","created_at");