CREATE TYPE "public"."course_catalog_status" AS ENUM('draft', 'approved', 'archived');--> statement-breakpoint
CREATE TYPE "public"."course_delivery_mode" AS ENUM('scheduled', 'self_paced');--> statement-breakpoint
CREATE TYPE "public"."course_difficulty" AS ENUM('foundation', 'intermediate', 'advanced');--> statement-breakpoint
CREATE TYPE "public"."course_rule_severity" AS ENUM('hard', 'warning');--> statement-breakpoint
CREATE TYPE "public"."course_rule_type" AS ENUM('prerequisite', 'mutual_exclusion', 'age_range', 'time_conflict', 'load_limit');--> statement-breakpoint
CREATE TABLE "course_rule_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"source_rule_version_id" uuid,
	"status" "course_catalog_status" DEFAULT 'draft' NOT NULL,
	"rule_type" "course_rule_type" NOT NULL,
	"severity" "course_rule_severity" NOT NULL,
	"subject_course_id" uuid,
	"related_course_id" uuid,
	"min_age" integer,
	"max_age" integer,
	"max_weekly_minutes" integer,
	"max_concurrent_courses" integer,
	"message" varchar(500) NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"invalidation_reason" varchar(512),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_rule_version_number_check" CHECK ("course_rule_version"."version" > 0),
	CONSTRAINT "course_rule_version_message_check" CHECK (char_length(trim("course_rule_version"."message")) between 1 and 500),
	CONSTRAINT "course_rule_version_payload_check" CHECK (("course_rule_version"."rule_type" = 'prerequisite' and "course_rule_version"."subject_course_id" is not null and "course_rule_version"."related_course_id" is not null and "course_rule_version"."subject_course_id" <> "course_rule_version"."related_course_id" and "course_rule_version"."min_age" is null and "course_rule_version"."max_age" is null and "course_rule_version"."max_weekly_minutes" is null and "course_rule_version"."max_concurrent_courses" is null) or ("course_rule_version"."rule_type" = 'mutual_exclusion' and "course_rule_version"."subject_course_id" is not null and "course_rule_version"."related_course_id" is not null and "course_rule_version"."subject_course_id"::text < "course_rule_version"."related_course_id"::text and "course_rule_version"."min_age" is null and "course_rule_version"."max_age" is null and "course_rule_version"."max_weekly_minutes" is null and "course_rule_version"."max_concurrent_courses" is null) or ("course_rule_version"."rule_type" = 'age_range' and "course_rule_version"."subject_course_id" is not null and "course_rule_version"."related_course_id" is null and ("course_rule_version"."min_age" is not null or "course_rule_version"."max_age" is not null) and ("course_rule_version"."min_age" is null or "course_rule_version"."min_age" between 3 and 100) and ("course_rule_version"."max_age" is null or "course_rule_version"."max_age" between 3 and 100) and ("course_rule_version"."min_age" is null or "course_rule_version"."max_age" is null or "course_rule_version"."max_age" >= "course_rule_version"."min_age") and "course_rule_version"."max_weekly_minutes" is null and "course_rule_version"."max_concurrent_courses" is null) or ("course_rule_version"."rule_type" = 'time_conflict' and "course_rule_version"."subject_course_id" is null and "course_rule_version"."related_course_id" is null and "course_rule_version"."min_age" is null and "course_rule_version"."max_age" is null and "course_rule_version"."max_weekly_minutes" is null and "course_rule_version"."max_concurrent_courses" is null) or ("course_rule_version"."rule_type" = 'load_limit' and "course_rule_version"."subject_course_id" is null and "course_rule_version"."related_course_id" is null and "course_rule_version"."min_age" is null and "course_rule_version"."max_age" is null and ("course_rule_version"."max_weekly_minutes" is not null or "course_rule_version"."max_concurrent_courses" is not null) and ("course_rule_version"."max_weekly_minutes" is null or "course_rule_version"."max_weekly_minutes" between 1 and 10080) and ("course_rule_version"."max_concurrent_courses" is null or "course_rule_version"."max_concurrent_courses" between 1 and 50))),
	CONSTRAINT "course_rule_version_state_check" CHECK (("course_rule_version"."status" = 'draft' and "course_rule_version"."approved_by_user_id" is null and "course_rule_version"."approved_at" is null and "course_rule_version"."invalidation_reason" is null) or ("course_rule_version"."status" = 'approved' and "course_rule_version"."approved_by_user_id" is not null and "course_rule_version"."approved_at" is not null and "course_rule_version"."invalidation_reason" is null) or ("course_rule_version"."status" = 'archived' and (("course_rule_version"."approved_by_user_id" is null and "course_rule_version"."approved_at" is null) or ("course_rule_version"."approved_by_user_id" is not null and "course_rule_version"."approved_at" is not null)) and char_length(trim("course_rule_version"."invalidation_reason")) > 0))
);
--> statement-breakpoint
CREATE TABLE "course_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(128) NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_rule_key_check" CHECK ("course_rule"."key" ~ '^[a-z][a-z0-9_.-]{2,127}$')
);
--> statement-breakpoint
CREATE TABLE "course_schedule_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_version_id" uuid NOT NULL,
	"weekday" integer NOT NULL,
	"start_minute" integer NOT NULL,
	"end_minute" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_schedule_weekday_check" CHECK ("course_schedule_session"."weekday" between 1 and 7),
	CONSTRAINT "course_schedule_minute_check" CHECK ("course_schedule_session"."start_minute" between 0 and 1439 and "course_schedule_session"."end_minute" between 1 and 1440 and "course_schedule_session"."end_minute" > "course_schedule_session"."start_minute")
);
--> statement-breakpoint
CREATE TABLE "course_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"source_course_version_id" uuid,
	"status" "course_catalog_status" DEFAULT 'draft' NOT NULL,
	"title" varchar(200) NOT NULL,
	"stage" varchar(128) NOT NULL,
	"difficulty" "course_difficulty" NOT NULL,
	"summary" text NOT NULL,
	"objectives" jsonb NOT NULL,
	"capability_tags" jsonb NOT NULL,
	"subject_tags" jsonb NOT NULL,
	"project_types" jsonb NOT NULL,
	"deliverables" jsonb NOT NULL,
	"not_suitable_conditions" jsonb NOT NULL,
	"delivery_mode" "course_delivery_mode" NOT NULL,
	"term_start_date" date,
	"term_end_date" date,
	"duration_weeks" integer NOT NULL,
	"total_instruction_minutes" integer NOT NULL,
	"weekly_load_minutes" integer NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"invalidation_reason" varchar(512),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_version_version_check" CHECK ("course_version"."version" > 0),
	CONSTRAINT "course_version_text_check" CHECK (char_length(trim("course_version"."title")) between 1 and 200 and char_length(trim("course_version"."stage")) between 1 and 128 and char_length(trim("course_version"."summary")) between 1 and 4000),
	CONSTRAINT "course_version_json_arrays_check" CHECK (jsonb_typeof("course_version"."objectives") = 'array' and jsonb_array_length("course_version"."objectives") between 1 and 30 and jsonb_typeof("course_version"."capability_tags") = 'array' and jsonb_array_length("course_version"."capability_tags") between 1 and 50 and jsonb_typeof("course_version"."subject_tags") = 'array' and jsonb_array_length("course_version"."subject_tags") between 1 and 30 and jsonb_typeof("course_version"."project_types") = 'array' and jsonb_array_length("course_version"."project_types") <= 30 and jsonb_typeof("course_version"."deliverables") = 'array' and jsonb_array_length("course_version"."deliverables") between 1 and 30 and jsonb_typeof("course_version"."not_suitable_conditions") = 'array' and jsonb_array_length("course_version"."not_suitable_conditions") <= 30),
	CONSTRAINT "course_version_effort_check" CHECK ("course_version"."duration_weeks" between 1 and 104 and "course_version"."total_instruction_minutes" between 1 and 100000 and "course_version"."weekly_load_minutes" between 1 and 10080),
	CONSTRAINT "course_version_term_check" CHECK (("course_version"."delivery_mode" = 'scheduled' and "course_version"."term_start_date" is not null and "course_version"."term_end_date" is not null and "course_version"."term_end_date" >= "course_version"."term_start_date") or ("course_version"."delivery_mode" = 'self_paced' and (("course_version"."term_start_date" is null and "course_version"."term_end_date" is null) or ("course_version"."term_start_date" is not null and "course_version"."term_end_date" is not null and "course_version"."term_end_date" >= "course_version"."term_start_date")))),
	CONSTRAINT "course_version_state_check" CHECK (("course_version"."status" = 'draft' and "course_version"."approved_by_user_id" is null and "course_version"."approved_at" is null and "course_version"."invalidation_reason" is null) or ("course_version"."status" = 'approved' and "course_version"."approved_by_user_id" is not null and "course_version"."approved_at" is not null and "course_version"."invalidation_reason" is null) or ("course_version"."status" = 'archived' and (("course_version"."approved_by_user_id" is null and "course_version"."approved_at" is null) or ("course_version"."approved_by_user_id" is not null and "course_version"."approved_at" is not null)) and char_length(trim("course_version"."invalidation_reason")) > 0))
);
--> statement-breakpoint
CREATE TABLE "course" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(64) NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_code_check" CHECK ("course"."code" ~ '^[A-Z][A-Z0-9_-]{1,63}$')
);
--> statement-breakpoint
ALTER TABLE "course_rule_version" ADD CONSTRAINT "course_rule_version_rule_id_course_rule_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."course_rule"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_rule_version" ADD CONSTRAINT "course_rule_version_source_rule_version_id_course_rule_version_id_fk" FOREIGN KEY ("source_rule_version_id") REFERENCES "public"."course_rule_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_rule_version" ADD CONSTRAINT "course_rule_version_subject_course_id_course_id_fk" FOREIGN KEY ("subject_course_id") REFERENCES "public"."course"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_rule_version" ADD CONSTRAINT "course_rule_version_related_course_id_course_id_fk" FOREIGN KEY ("related_course_id") REFERENCES "public"."course"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_rule_version" ADD CONSTRAINT "course_rule_version_created_by_user_id_app_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_rule_version" ADD CONSTRAINT "course_rule_version_approved_by_user_id_app_user_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_rule" ADD CONSTRAINT "course_rule_created_by_user_id_app_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_schedule_session" ADD CONSTRAINT "course_schedule_session_course_version_id_course_version_id_fk" FOREIGN KEY ("course_version_id") REFERENCES "public"."course_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_version" ADD CONSTRAINT "course_version_course_id_course_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."course"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_version" ADD CONSTRAINT "course_version_source_course_version_id_course_version_id_fk" FOREIGN KEY ("source_course_version_id") REFERENCES "public"."course_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_version" ADD CONSTRAINT "course_version_created_by_user_id_app_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_version" ADD CONSTRAINT "course_version_approved_by_user_id_app_user_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course" ADD CONSTRAINT "course_created_by_user_id_app_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "course_rule_version_rule_version_unique" ON "course_rule_version" USING btree ("rule_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "course_rule_version_source_unique" ON "course_rule_version" USING btree ("source_rule_version_id") WHERE "course_rule_version"."source_rule_version_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "course_rule_version_current_approved_unique" ON "course_rule_version" USING btree ("rule_id") WHERE "course_rule_version"."status" = 'approved';--> statement-breakpoint
CREATE INDEX "course_rule_version_type_status_idx" ON "course_rule_version" USING btree ("rule_type","status");--> statement-breakpoint
CREATE UNIQUE INDEX "course_rule_key_unique" ON "course_rule" USING btree (lower("key"));--> statement-breakpoint
CREATE UNIQUE INDEX "course_schedule_session_unique" ON "course_schedule_session" USING btree ("course_version_id","weekday","start_minute","end_minute");--> statement-breakpoint
CREATE INDEX "course_schedule_version_idx" ON "course_schedule_session" USING btree ("course_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "course_version_course_version_unique" ON "course_version" USING btree ("course_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "course_version_source_unique" ON "course_version" USING btree ("source_course_version_id") WHERE "course_version"."source_course_version_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "course_version_current_approved_unique" ON "course_version" USING btree ("course_id") WHERE "course_version"."status" = 'approved';--> statement-breakpoint
CREATE INDEX "course_version_status_created_idx" ON "course_version" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "course_code_unique" ON "course" USING btree (lower("code"));
--> statement-breakpoint
CREATE FUNCTION "require_course_catalog_admin"(actor_id uuid) RETURNS void AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "app_user"
    WHERE "id" = actor_id AND "active" = true AND "role" = 'admin'
  ) THEN
    RAISE EXCEPTION 'course catalog writes require an active admin';
  END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "protect_course_catalog_root"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'course catalog roots cannot be deleted';
  END IF;
  IF ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
    RAISE EXCEPTION 'course catalog roots are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "course_root_immutable"
BEFORE UPDATE OR DELETE ON "course"
FOR EACH ROW EXECUTE FUNCTION "protect_course_catalog_root"();
--> statement-breakpoint
CREATE TRIGGER "course_rule_root_immutable"
BEFORE UPDATE OR DELETE ON "course_rule"
FOR EACH ROW EXECUTE FUNCTION "protect_course_catalog_root"();
--> statement-breakpoint
CREATE FUNCTION "validate_course_root_insert"() RETURNS trigger AS $$
BEGIN
  PERFORM "require_course_catalog_admin"(NEW."created_by_user_id");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "course_root_insert_validate"
BEFORE INSERT ON "course"
FOR EACH ROW EXECUTE FUNCTION "validate_course_root_insert"();
--> statement-breakpoint
CREATE TRIGGER "course_rule_root_insert_validate"
BEFORE INSERT ON "course_rule"
FOR EACH ROW EXECUTE FUNCTION "validate_course_root_insert"();
--> statement-breakpoint
CREATE FUNCTION "validate_course_version_insert"() RETURNS trigger AS $$
DECLARE source_row "course_version"%ROWTYPE;
BEGIN
  PERFORM "require_course_catalog_admin"(NEW."created_by_user_id");
  IF NEW."source_course_version_id" IS NULL THEN
    IF NEW."version" <> 1 OR EXISTS (
      SELECT 1 FROM "course_version" WHERE "course_id" = NEW."course_id"
    ) THEN
      RAISE EXCEPTION 'initial course version must be version 1 and the first version';
    END IF;
  ELSE
    SELECT * INTO source_row FROM "course_version"
    WHERE "id" = NEW."source_course_version_id" FOR UPDATE;
    IF NOT FOUND OR source_row."course_id" <> NEW."course_id"
      OR source_row."version" + 1 <> NEW."version"
      OR source_row."status" = 'archived'
      OR EXISTS (
        SELECT 1 FROM "course_version"
        WHERE "course_id" = NEW."course_id" AND "version" > source_row."version"
      )
    THEN
      RAISE EXCEPTION 'invalid course version source chain';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "course_version_insert_validate"
BEFORE INSERT ON "course_version"
FOR EACH ROW EXECUTE FUNCTION "validate_course_version_insert"();
--> statement-breakpoint
CREATE FUNCTION "validate_course_version_update"() RETURNS trigger AS $$
DECLARE session_count integer;
BEGIN
  IF ROW(
    NEW."id", NEW."course_id", NEW."version", NEW."source_course_version_id",
    NEW."title", NEW."stage", NEW."difficulty", NEW."summary", NEW."objectives",
    NEW."capability_tags", NEW."subject_tags", NEW."project_types", NEW."deliverables",
    NEW."not_suitable_conditions", NEW."delivery_mode", NEW."term_start_date",
    NEW."term_end_date", NEW."duration_weeks", NEW."total_instruction_minutes",
    NEW."weekly_load_minutes", NEW."created_by_user_id", NEW."created_at"
  ) IS DISTINCT FROM ROW(
    OLD."id", OLD."course_id", OLD."version", OLD."source_course_version_id",
    OLD."title", OLD."stage", OLD."difficulty", OLD."summary", OLD."objectives",
    OLD."capability_tags", OLD."subject_tags", OLD."project_types", OLD."deliverables",
    OLD."not_suitable_conditions", OLD."delivery_mode", OLD."term_start_date",
    OLD."term_end_date", OLD."duration_weeks", OLD."total_instruction_minutes",
    OLD."weekly_load_minutes", OLD."created_by_user_id", OLD."created_at"
  ) THEN
    RAISE EXCEPTION 'course version content is immutable; create a revision';
  END IF;
  IF OLD."status" = 'archived' OR NOT (
    (OLD."status" = 'draft' AND NEW."status" IN ('approved', 'archived'))
    OR (OLD."status" = 'approved' AND NEW."status" = 'archived')
  ) THEN
    RAISE EXCEPTION 'invalid course version state transition';
  END IF;
  IF NEW."status" = 'approved' THEN
    PERFORM "require_course_catalog_admin"(NEW."approved_by_user_id");
    SELECT count(*) INTO session_count FROM "course_schedule_session"
    WHERE "course_version_id" = NEW."id";
    IF (NEW."delivery_mode" = 'scheduled' AND session_count = 0)
      OR (NEW."delivery_mode" = 'self_paced' AND session_count <> 0)
    THEN
      RAISE EXCEPTION 'course delivery mode and schedule do not match';
    END IF;
    IF EXISTS (
      SELECT 1 FROM "course_version"
      WHERE "course_id" = NEW."course_id" AND "version" > NEW."version"
    ) THEN
      RAISE EXCEPTION 'only the latest course version can be approved';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "course_version_update_validate"
BEFORE UPDATE ON "course_version"
FOR EACH ROW EXECUTE FUNCTION "validate_course_version_update"();
--> statement-breakpoint
CREATE FUNCTION "validate_course_schedule_change"() RETURNS trigger AS $$
DECLARE parent_status "course_catalog_status";
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'course schedule sessions are immutable';
  END IF;
  SELECT "status" INTO parent_status FROM "course_version"
  WHERE "id" = NEW."course_version_id" FOR UPDATE;
  IF parent_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'schedule sessions can only be added to draft course versions';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "course_schedule_session"
    WHERE "course_version_id" = NEW."course_version_id"
      AND "weekday" = NEW."weekday"
      AND NEW."start_minute" < "end_minute"
      AND "start_minute" < NEW."end_minute"
  ) THEN
    RAISE EXCEPTION 'course schedule sessions cannot overlap';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "course_schedule_change_validate"
BEFORE INSERT OR UPDATE OR DELETE ON "course_schedule_session"
FOR EACH ROW EXECUTE FUNCTION "validate_course_schedule_change"();
--> statement-breakpoint
CREATE FUNCTION "validate_course_rule_version_insert"() RETURNS trigger AS $$
DECLARE source_row "course_rule_version"%ROWTYPE;
BEGIN
  PERFORM "require_course_catalog_admin"(NEW."created_by_user_id");
  IF NEW."source_rule_version_id" IS NULL THEN
    IF NEW."version" <> 1 OR EXISTS (
      SELECT 1 FROM "course_rule_version" WHERE "rule_id" = NEW."rule_id"
    ) THEN
      RAISE EXCEPTION 'initial course rule version must be version 1 and the first version';
    END IF;
  ELSE
    SELECT * INTO source_row FROM "course_rule_version"
    WHERE "id" = NEW."source_rule_version_id" FOR UPDATE;
    IF NOT FOUND OR source_row."rule_id" <> NEW."rule_id"
      OR source_row."version" + 1 <> NEW."version"
      OR source_row."status" = 'archived'
      OR EXISTS (
        SELECT 1 FROM "course_rule_version"
        WHERE "rule_id" = NEW."rule_id" AND "version" > source_row."version"
      )
    THEN
      RAISE EXCEPTION 'invalid course rule version source chain';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "course_rule_version_insert_validate"
BEFORE INSERT ON "course_rule_version"
FOR EACH ROW EXECUTE FUNCTION "validate_course_rule_version_insert"();
--> statement-breakpoint
CREATE FUNCTION "validate_approved_course_rule"() RETURNS trigger AS $$
DECLARE lower_bound integer;
DECLARE upper_bound integer;
DECLARE has_cycle boolean;
BEGIN
  PERFORM "require_course_catalog_admin"(NEW."approved_by_user_id");
  IF NEW."subject_course_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "course_version"
    WHERE "course_id" = NEW."subject_course_id" AND "status" = 'approved'
  ) THEN
    RAISE EXCEPTION 'course rule references a course without an approved version';
  END IF;
  IF NEW."related_course_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "course_version"
    WHERE "course_id" = NEW."related_course_id" AND "status" = 'approved'
  ) THEN
    RAISE EXCEPTION 'course rule references a course without an approved version';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "course_rule_version" existing
    WHERE existing."status" = 'approved' AND existing."rule_id" <> NEW."rule_id"
      AND existing."rule_type" = NEW."rule_type"
      AND existing."subject_course_id" IS NOT DISTINCT FROM NEW."subject_course_id"
      AND existing."related_course_id" IS NOT DISTINCT FROM NEW."related_course_id"
      AND existing."min_age" IS NOT DISTINCT FROM NEW."min_age"
      AND existing."max_age" IS NOT DISTINCT FROM NEW."max_age"
      AND existing."max_weekly_minutes" IS NOT DISTINCT FROM NEW."max_weekly_minutes"
      AND existing."max_concurrent_courses" IS NOT DISTINCT FROM NEW."max_concurrent_courses"
  ) THEN
    RAISE EXCEPTION 'duplicate approved course rule';
  END IF;
  IF NEW."rule_type" = 'prerequisite' AND EXISTS (
    SELECT 1 FROM "course_rule_version" existing
    WHERE existing."status" = 'approved' AND existing."rule_type" = 'mutual_exclusion'
      AND existing."subject_course_id" = LEAST(NEW."subject_course_id", NEW."related_course_id")
      AND existing."related_course_id" = GREATEST(NEW."subject_course_id", NEW."related_course_id")
  ) THEN
    RAISE EXCEPTION 'prerequisite contradicts mutual exclusion';
  END IF;
  IF NEW."rule_type" = 'mutual_exclusion' AND EXISTS (
    SELECT 1 FROM "course_rule_version" existing
    WHERE existing."status" = 'approved' AND existing."rule_type" = 'prerequisite'
      AND ((existing."subject_course_id" = NEW."subject_course_id" AND existing."related_course_id" = NEW."related_course_id")
        OR (existing."subject_course_id" = NEW."related_course_id" AND existing."related_course_id" = NEW."subject_course_id"))
  ) THEN
    RAISE EXCEPTION 'mutual exclusion contradicts prerequisite';
  END IF;
  IF NEW."rule_type" = 'age_range' THEN
    SELECT max(value), min(upper_value) INTO lower_bound, upper_bound
    FROM (
      SELECT COALESCE(existing."min_age", 3) AS value,
        COALESCE(existing."max_age", 100) AS upper_value
      FROM "course_rule_version" existing
      WHERE existing."status" = 'approved' AND existing."rule_type" = 'age_range'
        AND existing."rule_id" <> NEW."rule_id"
        AND existing."subject_course_id" = NEW."subject_course_id"
      UNION ALL
      SELECT COALESCE(NEW."min_age", 3), COALESCE(NEW."max_age", 100)
    ) ranges;
    IF lower_bound > upper_bound THEN
      RAISE EXCEPTION 'approved age rules have no valid intersection';
    END IF;
  END IF;
  IF NEW."rule_type" = 'prerequisite' THEN
    WITH RECURSIVE edges(subject_id, required_id) AS (
      SELECT existing."subject_course_id", existing."related_course_id"
      FROM "course_rule_version" existing
      WHERE existing."status" = 'approved' AND existing."rule_type" = 'prerequisite'
        AND existing."rule_id" <> NEW."rule_id"
      UNION ALL
      SELECT NEW."subject_course_id", NEW."related_course_id"
    ), reach(node_id, path) AS (
      SELECT NEW."related_course_id", ARRAY[NEW."subject_course_id", NEW."related_course_id"]::uuid[]
      UNION ALL
      SELECT edges.required_id, reach.path || edges.required_id
      FROM reach JOIN edges ON edges.subject_id = reach.node_id
      WHERE NOT edges.required_id = ANY(reach.path)
    )
    SELECT EXISTS(SELECT 1 FROM reach WHERE node_id = NEW."subject_course_id") INTO has_cycle;
    IF has_cycle THEN
      RAISE EXCEPTION 'prerequisite rules cannot contain a cycle';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "course_rule_approval_validate"
BEFORE UPDATE ON "course_rule_version"
FOR EACH ROW
WHEN (NEW."status" = 'approved' AND OLD."status" <> 'approved')
EXECUTE FUNCTION "validate_approved_course_rule"();
--> statement-breakpoint
CREATE FUNCTION "validate_course_rule_version_update"() RETURNS trigger AS $$
BEGIN
  IF ROW(
    NEW."id", NEW."rule_id", NEW."version", NEW."source_rule_version_id", NEW."rule_type",
    NEW."severity", NEW."subject_course_id", NEW."related_course_id", NEW."min_age",
    NEW."max_age", NEW."max_weekly_minutes", NEW."max_concurrent_courses", NEW."message",
    NEW."created_by_user_id", NEW."created_at"
  ) IS DISTINCT FROM ROW(
    OLD."id", OLD."rule_id", OLD."version", OLD."source_rule_version_id", OLD."rule_type",
    OLD."severity", OLD."subject_course_id", OLD."related_course_id", OLD."min_age",
    OLD."max_age", OLD."max_weekly_minutes", OLD."max_concurrent_courses", OLD."message",
    OLD."created_by_user_id", OLD."created_at"
  ) THEN
    RAISE EXCEPTION 'course rule version content is immutable; create a revision';
  END IF;
  IF OLD."status" = 'archived' OR NOT (
    (OLD."status" = 'draft' AND NEW."status" IN ('approved', 'archived'))
    OR (OLD."status" = 'approved' AND NEW."status" = 'archived')
  ) THEN
    RAISE EXCEPTION 'invalid course rule version state transition';
  END IF;
  IF NEW."status" = 'approved' THEN
    IF EXISTS (
      SELECT 1 FROM "course_rule_version"
      WHERE "rule_id" = NEW."rule_id" AND "version" > NEW."version"
    ) THEN
      RAISE EXCEPTION 'only the latest course rule version can be approved';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "course_rule_version_update_validate"
BEFORE UPDATE ON "course_rule_version"
FOR EACH ROW EXECUTE FUNCTION "validate_course_rule_version_update"();
--> statement-breakpoint
CREATE FUNCTION "ensure_referenced_course_is_approved"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'approved' AND NEW."status" = 'archived'
    AND EXISTS (
      SELECT 1 FROM "course_rule_version"
      WHERE "status" = 'approved'
        AND ("subject_course_id" = OLD."course_id" OR "related_course_id" = OLD."course_id")
    )
    AND NOT EXISTS (
      SELECT 1 FROM "course_version"
      WHERE "course_id" = OLD."course_id" AND "status" = 'approved'
    )
  THEN
    RAISE EXCEPTION 'approved rules require an approved referenced course version';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "course_reference_availability_validate"
AFTER UPDATE ON "course_version"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "ensure_referenced_course_is_approved"();
