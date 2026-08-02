CREATE TYPE "public"."candidate_schedule_kind" AS ENUM('weekly', 'short_term');--> statement-breakpoint
CREATE TYPE "public"."scheduling_resource_status" AS ENUM('draft', 'approved', 'archived');--> statement-breakpoint
CREATE TABLE "candidate_schedule_occurrence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_schedule_id" uuid NOT NULL,
	"session_date" date NOT NULL,
	"start_minute" integer NOT NULL,
	"end_minute" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candidate_schedule_occurrence_minute_check" CHECK ("candidate_schedule_occurrence"."start_minute" between 0 and 1439 and "candidate_schedule_occurrence"."end_minute" between 1 and 1440 and "candidate_schedule_occurrence"."end_minute" > "candidate_schedule_occurrence"."start_minute")
);
--> statement-breakpoint
CREATE TABLE "candidate_schedule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offering_version_id" uuid NOT NULL,
	"label" varchar(160) NOT NULL,
	"kind" "candidate_schedule_kind" NOT NULL,
	"preference_rank" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candidate_schedule_rank_check" CHECK ("candidate_schedule"."preference_rank" between 1 and 1000)
);
--> statement-breakpoint
CREATE TABLE "course_offering_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offering_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"source_version_id" uuid,
	"status" "scheduling_resource_status" DEFAULT 'draft' NOT NULL,
	"course_version_id" uuid NOT NULL,
	"location_version_id" uuid NOT NULL,
	"class_name" varchar(200) NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"required_qualification_tags" jsonb NOT NULL,
	"allowed_teacher_ids" jsonb NOT NULL,
	"student_roster_text" jsonb NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"locked_teacher_version_id" uuid,
	"locked_candidate_schedule_id" uuid,
	"created_by_user_id" uuid NOT NULL,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"archived_reason" varchar(512),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_offering_version_number_check" CHECK ("course_offering_version"."version" > 0),
	CONSTRAINT "course_offering_version_date_check" CHECK ("course_offering_version"."end_date" >= "course_offering_version"."start_date"),
	CONSTRAINT "course_offering_version_priority_check" CHECK ("course_offering_version"."priority" between 1 and 1000),
	CONSTRAINT "course_offering_version_json_check" CHECK (jsonb_typeof("course_offering_version"."required_qualification_tags") = 'array' and jsonb_array_length("course_offering_version"."required_qualification_tags") between 1 and 50 and jsonb_typeof("course_offering_version"."allowed_teacher_ids") = 'array' and jsonb_typeof("course_offering_version"."student_roster_text") = 'array')
);
--> statement-breakpoint
CREATE TABLE "course_offering" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(64) NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_offering_code_check" CHECK ("course_offering"."code" ~ '^[A-Z][A-Z0-9_-]{1,63}$')
);
--> statement-breakpoint
CREATE TABLE "teacher_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"teacher_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"source_version_id" uuid,
	"status" "scheduling_resource_status" DEFAULT 'draft' NOT NULL,
	"name" varchar(160) NOT NULL,
	"qualification_tags" jsonb NOT NULL,
	"weekly_availability" jsonb NOT NULL,
	"unavailable_dates" jsonb NOT NULL,
	"preferred_tags" jsonb NOT NULL,
	"max_daily_minutes" integer NOT NULL,
	"max_weekly_minutes" integer NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"archived_reason" varchar(512),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teacher_version_number_check" CHECK ("teacher_version"."version" > 0),
	CONSTRAINT "teacher_version_limits_check" CHECK ("teacher_version"."max_daily_minutes" between 1 and 1440 and "teacher_version"."max_weekly_minutes" between 1 and 10080),
	CONSTRAINT "teacher_version_json_check" CHECK (jsonb_typeof("teacher_version"."qualification_tags") = 'array' and jsonb_array_length("teacher_version"."qualification_tags") between 1 and 100 and jsonb_typeof("teacher_version"."weekly_availability") = 'array' and jsonb_array_length("teacher_version"."weekly_availability") between 1 and 50 and jsonb_typeof("teacher_version"."unavailable_dates") = 'array' and jsonb_typeof("teacher_version"."preferred_tags") = 'array')
);
--> statement-breakpoint
CREATE TABLE "teacher" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(64) NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teacher_code_check" CHECK ("teacher"."code" ~ '^[A-Z][A-Z0-9_-]{1,63}$')
);
--> statement-breakpoint
CREATE TABLE "teaching_location_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"source_version_id" uuid,
	"status" "scheduling_resource_status" DEFAULT 'draft' NOT NULL,
	"name" varchar(160) NOT NULL,
	"weekly_availability" jsonb NOT NULL,
	"unavailable_dates" jsonb NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"archived_reason" varchar(512),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teaching_location_version_number_check" CHECK ("teaching_location_version"."version" > 0),
	CONSTRAINT "teaching_location_version_json_check" CHECK (jsonb_typeof("teaching_location_version"."weekly_availability") = 'array' and jsonb_array_length("teaching_location_version"."weekly_availability") between 1 and 50 and jsonb_typeof("teaching_location_version"."unavailable_dates") = 'array')
);
--> statement-breakpoint
CREATE TABLE "teaching_location" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(64) NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teaching_location_code_check" CHECK ("teaching_location"."code" ~ '^[A-Z][A-Z0-9_-]{1,63}$')
);
--> statement-breakpoint
ALTER TABLE "candidate_schedule_occurrence" ADD CONSTRAINT "candidate_schedule_occurrence_candidate_schedule_id_candidate_schedule_id_fk" FOREIGN KEY ("candidate_schedule_id") REFERENCES "public"."candidate_schedule"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_schedule" ADD CONSTRAINT "candidate_schedule_offering_version_id_course_offering_version_id_fk" FOREIGN KEY ("offering_version_id") REFERENCES "public"."course_offering_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_offering_version" ADD CONSTRAINT "course_offering_version_offering_id_course_offering_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."course_offering"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_offering_version" ADD CONSTRAINT "course_offering_version_source_version_id_course_offering_version_id_fk" FOREIGN KEY ("source_version_id") REFERENCES "public"."course_offering_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_offering_version" ADD CONSTRAINT "course_offering_version_course_version_id_course_version_id_fk" FOREIGN KEY ("course_version_id") REFERENCES "public"."course_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_offering_version" ADD CONSTRAINT "course_offering_version_location_version_id_teaching_location_version_id_fk" FOREIGN KEY ("location_version_id") REFERENCES "public"."teaching_location_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_offering_version" ADD CONSTRAINT "course_offering_version_locked_teacher_version_id_teacher_version_id_fk" FOREIGN KEY ("locked_teacher_version_id") REFERENCES "public"."teacher_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_offering_version" ADD CONSTRAINT "course_offering_version_locked_candidate_schedule_id_candidate_schedule_id_fk" FOREIGN KEY ("locked_candidate_schedule_id") REFERENCES "public"."candidate_schedule"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_offering_version" ADD CONSTRAINT "course_offering_version_created_by_user_id_app_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_offering_version" ADD CONSTRAINT "course_offering_version_approved_by_user_id_app_user_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_offering" ADD CONSTRAINT "course_offering_created_by_user_id_app_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teacher_version" ADD CONSTRAINT "teacher_version_teacher_id_teacher_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."teacher"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teacher_version" ADD CONSTRAINT "teacher_version_source_version_id_teacher_version_id_fk" FOREIGN KEY ("source_version_id") REFERENCES "public"."teacher_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teacher_version" ADD CONSTRAINT "teacher_version_created_by_user_id_app_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teacher_version" ADD CONSTRAINT "teacher_version_approved_by_user_id_app_user_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teacher" ADD CONSTRAINT "teacher_created_by_user_id_app_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teaching_location_version" ADD CONSTRAINT "teaching_location_version_location_id_teaching_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."teaching_location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teaching_location_version" ADD CONSTRAINT "teaching_location_version_source_version_id_teaching_location_version_id_fk" FOREIGN KEY ("source_version_id") REFERENCES "public"."teaching_location_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teaching_location_version" ADD CONSTRAINT "teaching_location_version_created_by_user_id_app_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teaching_location_version" ADD CONSTRAINT "teaching_location_version_approved_by_user_id_app_user_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teaching_location" ADD CONSTRAINT "teaching_location_created_by_user_id_app_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_schedule_occurrence_unique" ON "candidate_schedule_occurrence" USING btree ("candidate_schedule_id","session_date","start_minute","end_minute");--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_schedule_label_unique" ON "candidate_schedule" USING btree ("offering_version_id","label");--> statement-breakpoint
CREATE UNIQUE INDEX "course_offering_version_identity_unique" ON "course_offering_version" USING btree ("offering_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "course_offering_version_source_unique" ON "course_offering_version" USING btree ("source_version_id") WHERE "course_offering_version"."source_version_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "course_offering_version_approved_unique" ON "course_offering_version" USING btree ("offering_id") WHERE "course_offering_version"."status" = 'approved';--> statement-breakpoint
CREATE UNIQUE INDEX "course_offering_code_unique" ON "course_offering" USING btree (lower("code"));--> statement-breakpoint
CREATE UNIQUE INDEX "teacher_version_identity_unique" ON "teacher_version" USING btree ("teacher_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "teacher_version_source_unique" ON "teacher_version" USING btree ("source_version_id") WHERE "teacher_version"."source_version_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "teacher_version_approved_unique" ON "teacher_version" USING btree ("teacher_id") WHERE "teacher_version"."status" = 'approved';--> statement-breakpoint
CREATE UNIQUE INDEX "teacher_code_unique" ON "teacher" USING btree (lower("code"));--> statement-breakpoint
CREATE UNIQUE INDEX "teaching_location_version_identity_unique" ON "teaching_location_version" USING btree ("location_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "teaching_location_version_source_unique" ON "teaching_location_version" USING btree ("source_version_id") WHERE "teaching_location_version"."source_version_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "teaching_location_version_approved_unique" ON "teaching_location_version" USING btree ("location_id") WHERE "teaching_location_version"."status" = 'approved';--> statement-breakpoint
CREATE UNIQUE INDEX "teaching_location_code_unique" ON "teaching_location" USING btree (lower("code"));