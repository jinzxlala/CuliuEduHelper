CREATE TYPE "public"."course_recommendation_status" AS ENUM('draft', 'accepted', 'rejected', 'needs_review');--> statement-breakpoint
CREATE TABLE "course_recommendation_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" uuid NOT NULL,
	"profile_version_id" uuid NOT NULL,
	"authorization_context_snapshot_id" uuid NOT NULL,
	"snapshot_hash" varchar(64) NOT NULL,
	"payload" jsonb NOT NULL,
	"eligible_course_version_ids" jsonb NOT NULL,
	"eligible_offering_version_ids" jsonb NOT NULL,
	"profile_claim_ids" jsonb NOT NULL,
	"model_provider" varchar(64) NOT NULL,
	"model" varchar(128) NOT NULL,
	"prompt_version" varchar(128) NOT NULL,
	"schema_version" varchar(128) NOT NULL,
	"redaction_version" varchar(128) NOT NULL,
	"pricing_version" varchar(128) NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_recommendation_snapshot_hash_check" CHECK ("course_recommendation_snapshot"."snapshot_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "course_recommendation_snapshot_json_check" CHECK (jsonb_typeof("course_recommendation_snapshot"."payload") = 'object' and jsonb_typeof("course_recommendation_snapshot"."eligible_course_version_ids") = 'array' and jsonb_array_length("course_recommendation_snapshot"."eligible_course_version_ids") between 1 and 5000 and jsonb_typeof("course_recommendation_snapshot"."eligible_offering_version_ids") = 'array' and jsonb_typeof("course_recommendation_snapshot"."profile_claim_ids") = 'array' and jsonb_array_length("course_recommendation_snapshot"."profile_claim_ids") between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "course_recommendation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"background_job_id" uuid,
	"status" "course_recommendation_status" DEFAULT 'draft' NOT NULL,
	"output" jsonb NOT NULL,
	"provider_request_id" varchar(256) NOT NULL,
	"prompt_tokens" integer NOT NULL,
	"completion_tokens" integer NOT NULL,
	"accepted_at" timestamp with time zone,
	"decided_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_recommendation_usage_check" CHECK ("course_recommendation"."prompt_tokens" >= 0 and "course_recommendation"."completion_tokens" >= 0),
	CONSTRAINT "course_recommendation_status_check" CHECK (("course_recommendation"."status" = 'accepted' and "course_recommendation"."accepted_at" is not null and "course_recommendation"."decided_by_user_id" is not null) or ("course_recommendation"."status" <> 'accepted'))
);
--> statement-breakpoint
ALTER TABLE "course_recommendation_snapshot" ADD CONSTRAINT "course_recommendation_snapshot_student_id_student_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."student"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_recommendation_snapshot" ADD CONSTRAINT "course_recommendation_snapshot_profile_version_id_profile_version_id_fk" FOREIGN KEY ("profile_version_id") REFERENCES "public"."profile_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_recommendation_snapshot" ADD CONSTRAINT "course_recommendation_snapshot_authorization_context_snapshot_id_authorization_context_snapshot_id_fk" FOREIGN KEY ("authorization_context_snapshot_id") REFERENCES "public"."authorization_context_snapshot"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_recommendation_snapshot" ADD CONSTRAINT "course_recommendation_snapshot_created_by_user_id_app_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_recommendation" ADD CONSTRAINT "course_recommendation_student_id_student_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."student"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_recommendation" ADD CONSTRAINT "course_recommendation_snapshot_id_course_recommendation_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."course_recommendation_snapshot"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_recommendation" ADD CONSTRAINT "course_recommendation_background_job_id_background_job_id_fk" FOREIGN KEY ("background_job_id") REFERENCES "public"."background_job"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_recommendation" ADD CONSTRAINT "course_recommendation_decided_by_user_id_app_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "course_recommendation_snapshot_hash_unique" ON "course_recommendation_snapshot" USING btree ("student_id","snapshot_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "course_recommendation_snapshot_unique" ON "course_recommendation" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "course_recommendation_student_created_idx" ON "course_recommendation" USING btree ("student_id","created_at");