CREATE TYPE "public"."plan_course_dependency_kind" AS ENUM('selected', 'in_progress', 'rule_reference');--> statement-breakpoint
CREATE TYPE "public"."plan_review_action" AS ENUM('created', 'submitted', 'returned', 'approved', 'invalidated', 'archived');--> statement-breakpoint
CREATE TYPE "public"."plan_rule_override_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."plan_status" AS ENUM('draft', 'in_review', 'approved', 'needs_review', 'archived');--> statement-breakpoint
CREATE TABLE "plan_course_dependency" (
	"plan_version_id" uuid NOT NULL,
	"course_version_id" uuid NOT NULL,
	"dependency_kind" "plan_course_dependency_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_course_dependency_plan_version_id_course_version_id_pk" PRIMARY KEY("plan_version_id","course_version_id")
);
--> statement-breakpoint
CREATE TABLE "plan_review_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_version_id" uuid NOT NULL,
	"action" "plan_review_action" NOT NULL,
	"from_status" "plan_status",
	"to_status" "plan_status" NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_user_id" uuid,
	"reason" varchar(512),
	"request_correlation_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_review_record_actor_check" CHECK (("plan_review_record"."actor_type" = 'user' and "plan_review_record"."actor_user_id" is not null) or ("plan_review_record"."actor_type" = 'service' and "plan_review_record"."actor_user_id" is null)),
	CONSTRAINT "plan_review_record_reason_check" CHECK (("plan_review_record"."action" in ('returned', 'invalidated', 'archived') and char_length(trim("plan_review_record"."reason")) > 0) or ("plan_review_record"."action" not in ('returned', 'invalidated', 'archived')))
);
--> statement-breakpoint
CREATE TABLE "plan_rule_dependency" (
	"plan_version_id" uuid NOT NULL,
	"rule_version_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_rule_dependency_plan_version_id_rule_version_id_pk" PRIMARY KEY("plan_version_id","rule_version_id")
);
--> statement-breakpoint
CREATE TABLE "plan_rule_override" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_version_id" uuid NOT NULL,
	"rule_version_id" uuid NOT NULL,
	"scope_key" varchar(64) NOT NULL,
	"violation_key" varchar(64) NOT NULL,
	"reason" text NOT NULL,
	"status" "plan_rule_override_status" DEFAULT 'pending' NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" varchar(512),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_rule_override_key_check" CHECK ("plan_rule_override"."violation_key" ~ '^[0-9a-f]{64}$' and "plan_rule_override"."scope_key" ~ '^(short_term|route_[ab]_phase_[1-9][0-9]*)$'),
	CONSTRAINT "plan_rule_override_reason_check" CHECK (char_length(trim("plan_rule_override"."reason")) between 1 and 1000),
	CONSTRAINT "plan_rule_override_state_check" CHECK (("plan_rule_override"."status" = 'pending' and "plan_rule_override"."decided_by_user_id" is null and "plan_rule_override"."decided_at" is null and "plan_rule_override"."decision_reason" is null) or ("plan_rule_override"."status" = 'approved' and "plan_rule_override"."decided_by_user_id" is not null and "plan_rule_override"."decided_at" is not null and "plan_rule_override"."decision_reason" is null) or ("plan_rule_override"."status" = 'rejected' and "plan_rule_override"."decided_by_user_id" is not null and "plan_rule_override"."decided_at" is not null and char_length(trim("plan_rule_override"."decision_reason")) > 0))
);
--> statement-breakpoint
CREATE TABLE "plan_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"source_plan_version_id" uuid,
	"status" "plan_status" DEFAULT 'draft' NOT NULL,
	"profile_version_id" uuid NOT NULL,
	"student_input" jsonb NOT NULL,
	"content" jsonb NOT NULL,
	"catalog_snapshot" jsonb NOT NULL,
	"evaluation" jsonb NOT NULL,
	"catalog_snapshot_hash" varchar(64) NOT NULL,
	"input_snapshot_hash" varchar(64) NOT NULL,
	"review_due_date" date NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"invalidation_reason" varchar(512),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_version_number_check" CHECK ("plan_version"."version" > 0),
	CONSTRAINT "plan_version_hashes_check" CHECK ("plan_version"."catalog_snapshot_hash" ~ '^[0-9a-f]{64}$' and "plan_version"."input_snapshot_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "plan_version_json_check" CHECK (jsonb_typeof("plan_version"."student_input") = 'object' and jsonb_typeof("plan_version"."content") = 'object' and jsonb_typeof("plan_version"."catalog_snapshot") = 'object' and jsonb_typeof("plan_version"."evaluation") = 'object'),
	CONSTRAINT "plan_version_state_check" CHECK (("plan_version"."status" in ('draft', 'in_review') and "plan_version"."approved_by_user_id" is null and "plan_version"."approved_at" is null and "plan_version"."invalidation_reason" is null) or ("plan_version"."status" = 'approved' and "plan_version"."approved_by_user_id" is not null and "plan_version"."approved_at" is not null and "plan_version"."invalidation_reason" is null) or ("plan_version"."status" = 'needs_review' and "plan_version"."approved_by_user_id" is not null and "plan_version"."approved_at" is not null and char_length(trim("plan_version"."invalidation_reason")) > 0) or ("plan_version"."status" = 'archived' and (("plan_version"."approved_by_user_id" is null and "plan_version"."approved_at" is null) or ("plan_version"."approved_by_user_id" is not null and "plan_version"."approved_at" is not null)) and char_length(trim("plan_version"."invalidation_reason")) > 0))
);
--> statement-breakpoint
ALTER TABLE "plan_course_dependency" ADD CONSTRAINT "plan_course_dependency_plan_version_id_plan_version_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "public"."plan_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_course_dependency" ADD CONSTRAINT "plan_course_dependency_course_version_id_course_version_id_fk" FOREIGN KEY ("course_version_id") REFERENCES "public"."course_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_review_record" ADD CONSTRAINT "plan_review_record_plan_version_id_plan_version_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "public"."plan_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_review_record" ADD CONSTRAINT "plan_review_record_actor_user_id_app_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_rule_dependency" ADD CONSTRAINT "plan_rule_dependency_plan_version_id_plan_version_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "public"."plan_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_rule_dependency" ADD CONSTRAINT "plan_rule_dependency_rule_version_id_course_rule_version_id_fk" FOREIGN KEY ("rule_version_id") REFERENCES "public"."course_rule_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_rule_override" ADD CONSTRAINT "plan_rule_override_plan_version_id_plan_version_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "public"."plan_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_rule_override" ADD CONSTRAINT "plan_rule_override_rule_version_id_course_rule_version_id_fk" FOREIGN KEY ("rule_version_id") REFERENCES "public"."course_rule_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_rule_override" ADD CONSTRAINT "plan_rule_override_requested_by_user_id_app_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_rule_override" ADD CONSTRAINT "plan_rule_override_decided_by_user_id_app_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_version" ADD CONSTRAINT "plan_version_student_id_student_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."student"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_version" ADD CONSTRAINT "plan_version_source_plan_version_id_plan_version_id_fk" FOREIGN KEY ("source_plan_version_id") REFERENCES "public"."plan_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_version" ADD CONSTRAINT "plan_version_profile_version_id_profile_version_id_fk" FOREIGN KEY ("profile_version_id") REFERENCES "public"."profile_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_version" ADD CONSTRAINT "plan_version_created_by_user_id_app_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_version" ADD CONSTRAINT "plan_version_approved_by_user_id_app_user_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plan_course_dependency_course_idx" ON "plan_course_dependency" USING btree ("course_version_id");--> statement-breakpoint
CREATE INDEX "plan_review_record_version_created_idx" ON "plan_review_record" USING btree ("plan_version_id","created_at");--> statement-breakpoint
CREATE INDEX "plan_rule_dependency_rule_idx" ON "plan_rule_dependency" USING btree ("rule_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_rule_override_active_unique" ON "plan_rule_override" USING btree ("plan_version_id","violation_key") WHERE "plan_rule_override"."status" in ('pending', 'approved');--> statement-breakpoint
CREATE INDEX "plan_rule_override_plan_created_idx" ON "plan_rule_override" USING btree ("plan_version_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_version_student_version_unique" ON "plan_version" USING btree ("student_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_version_source_unique" ON "plan_version" USING btree ("source_plan_version_id") WHERE "plan_version"."source_plan_version_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "plan_version_current_approved_unique" ON "plan_version" USING btree ("student_id") WHERE "plan_version"."status" = 'approved';--> statement-breakpoint
CREATE INDEX "plan_version_student_created_idx" ON "plan_version" USING btree ("student_id","created_at");--> statement-breakpoint
CREATE INDEX "plan_version_profile_idx" ON "plan_version" USING btree ("profile_version_id");
--> statement-breakpoint
CREATE FUNCTION "validate_plan_version_update"() RETURNS trigger AS $$
BEGIN
  IF ROW(
    NEW."id", NEW."student_id", NEW."version", NEW."source_plan_version_id",
    NEW."profile_version_id", NEW."student_input", NEW."content", NEW."catalog_snapshot",
    NEW."evaluation", NEW."catalog_snapshot_hash", NEW."input_snapshot_hash",
    NEW."review_due_date", NEW."created_by_user_id", NEW."created_at"
  ) IS DISTINCT FROM ROW(
    OLD."id", OLD."student_id", OLD."version", OLD."source_plan_version_id",
    OLD."profile_version_id", OLD."student_input", OLD."content", OLD."catalog_snapshot",
    OLD."evaluation", OLD."catalog_snapshot_hash", OLD."input_snapshot_hash",
    OLD."review_due_date", OLD."created_by_user_id", OLD."created_at"
  ) THEN
    RAISE EXCEPTION 'plan versions are immutable';
  END IF;

  IF OLD."approved_by_user_id" IS NOT NULL AND ROW(
    NEW."approved_by_user_id", NEW."approved_at"
  ) IS DISTINCT FROM ROW(
    OLD."approved_by_user_id", OLD."approved_at"
  ) THEN
    RAISE EXCEPTION 'plan approval metadata is immutable';
  END IF;
  IF NOT (
    (OLD."status" = 'draft' AND NEW."status" IN ('in_review', 'archived')) OR
    (OLD."status" = 'in_review' AND NEW."status" IN ('draft', 'approved', 'archived')) OR
    (OLD."status" = 'approved' AND NEW."status" IN ('needs_review', 'archived')) OR
    (OLD."status" = 'needs_review' AND NEW."status" = 'archived')
  ) THEN
    RAISE EXCEPTION 'invalid plan status transition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "plan_version_update_validate"
BEFORE UPDATE ON "plan_version"
FOR EACH ROW EXECUTE FUNCTION "validate_plan_version_update"();
--> statement-breakpoint
CREATE FUNCTION "reject_plan_version_delete"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'plan versions cannot be deleted';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "plan_version_delete_reject"
BEFORE DELETE ON "plan_version"
FOR EACH ROW EXECUTE FUNCTION "reject_plan_version_delete"();
--> statement-breakpoint
CREATE FUNCTION "validate_plan_dependency_insert"() RETURNS trigger AS $$
DECLARE parent_status "plan_status";
BEGIN
  SELECT "status" INTO parent_status FROM "plan_version"
  WHERE "id" = NEW."plan_version_id" FOR UPDATE;
  IF parent_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'plan dependencies can only be added to a draft';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "plan_course_dependency_insert_validate"
BEFORE INSERT ON "plan_course_dependency"
FOR EACH ROW EXECUTE FUNCTION "validate_plan_dependency_insert"();
--> statement-breakpoint
CREATE TRIGGER "plan_rule_dependency_insert_validate"
BEFORE INSERT ON "plan_rule_dependency"
FOR EACH ROW EXECUTE FUNCTION "validate_plan_dependency_insert"();
--> statement-breakpoint
CREATE FUNCTION "reject_plan_append_only_change"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'plan dependency and review records are append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "plan_course_dependency_change_reject"
BEFORE UPDATE OR DELETE ON "plan_course_dependency"
FOR EACH ROW EXECUTE FUNCTION "reject_plan_append_only_change"();
--> statement-breakpoint
CREATE TRIGGER "plan_rule_dependency_change_reject"
BEFORE UPDATE OR DELETE ON "plan_rule_dependency"
FOR EACH ROW EXECUTE FUNCTION "reject_plan_append_only_change"();
--> statement-breakpoint
CREATE TRIGGER "plan_review_record_change_reject"
BEFORE UPDATE OR DELETE ON "plan_review_record"
FOR EACH ROW EXECUTE FUNCTION "reject_plan_append_only_change"();
--> statement-breakpoint
CREATE FUNCTION "validate_plan_rule_override_insert"() RETURNS trigger AS $$
DECLARE parent_status "plan_status";
BEGIN
  SELECT "status" INTO parent_status FROM "plan_version"
  WHERE "id" = NEW."plan_version_id" FOR UPDATE;
  IF parent_status NOT IN ('draft', 'in_review') THEN
    RAISE EXCEPTION 'rule overrides can only be requested for an active draft';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "plan_rule_override_insert_validate"
BEFORE INSERT ON "plan_rule_override"
FOR EACH ROW EXECUTE FUNCTION "validate_plan_rule_override_insert"();
--> statement-breakpoint
CREATE FUNCTION "validate_plan_rule_override_update"() RETURNS trigger AS $$
DECLARE parent_status "plan_status";
BEGIN
  IF ROW(
    NEW."id", NEW."plan_version_id", NEW."rule_version_id", NEW."scope_key",
    NEW."violation_key", NEW."reason", NEW."requested_by_user_id", NEW."created_at"
  ) IS DISTINCT FROM ROW(
    OLD."id", OLD."plan_version_id", OLD."rule_version_id", OLD."scope_key",
    OLD."violation_key", OLD."reason", OLD."requested_by_user_id", OLD."created_at"
  ) OR OLD."status" <> 'pending' OR NEW."status" NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'invalid rule override decision';
  END IF;
  SELECT "status" INTO parent_status FROM "plan_version"
  WHERE "id" = NEW."plan_version_id" FOR UPDATE;
  IF parent_status NOT IN ('draft', 'in_review') THEN
    RAISE EXCEPTION 'rule overrides cannot be decided after the plan is closed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "plan_rule_override_update_validate"
BEFORE UPDATE ON "plan_rule_override"
FOR EACH ROW EXECUTE FUNCTION "validate_plan_rule_override_update"();
--> statement-breakpoint
CREATE TRIGGER "plan_rule_override_delete_reject"
BEFORE DELETE ON "plan_rule_override"
FOR EACH ROW EXECUTE FUNCTION "reject_plan_append_only_change"();
--> statement-breakpoint
CREATE FUNCTION "invalidate_plans_for_course_version"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'approved' AND NEW."status" = 'archived' THEN
    WITH changed AS (
      UPDATE "plan_version" plan
      SET "status" = 'needs_review',
          "invalidation_reason" = 'course_version_archived:' || NEW."id"::text,
          "updated_at" = now()
      FROM "plan_course_dependency" dependency
      WHERE plan."id" = dependency."plan_version_id"
        AND dependency."course_version_id" = NEW."id"
        AND dependency."dependency_kind" IN ('selected', 'in_progress')
        AND plan."status" = 'approved'
      RETURNING plan."id"
    )
    INSERT INTO "plan_review_record" (
      "plan_version_id", "action", "from_status", "to_status", "actor_type", "reason"
    )
    SELECT "id", 'invalidated', 'approved', 'needs_review', 'service',
           'course_version_archived:' || NEW."id"::text
    FROM changed;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "course_version_plan_invalidation"
AFTER UPDATE OF "status" ON "course_version"
FOR EACH ROW EXECUTE FUNCTION "invalidate_plans_for_course_version"();
--> statement-breakpoint
CREATE FUNCTION "invalidate_plans_for_rule_version"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'approved' AND NEW."status" = 'archived' THEN
    WITH changed AS (
      UPDATE "plan_version" plan
      SET "status" = 'needs_review',
          "invalidation_reason" = 'course_rule_version_archived:' || NEW."id"::text,
          "updated_at" = now()
      FROM "plan_rule_dependency" dependency
      WHERE plan."id" = dependency."plan_version_id"
        AND dependency."rule_version_id" = NEW."id"
        AND plan."status" = 'approved'
      RETURNING plan."id"
    )
    INSERT INTO "plan_review_record" (
      "plan_version_id", "action", "from_status", "to_status", "actor_type", "reason"
    )
    SELECT "id", 'invalidated', 'approved', 'needs_review', 'service',
           'course_rule_version_archived:' || NEW."id"::text
    FROM changed;
  ELSIF OLD."status" = 'draft' AND NEW."status" = 'approved' THEN
    WITH affected AS (
      SELECT DISTINCT plan."id"
      FROM "plan_version" plan
      JOIN "plan_course_dependency" dependency
        ON dependency."plan_version_id" = plan."id"
      JOIN "course_version" course_version
        ON course_version."id" = dependency."course_version_id"
      WHERE plan."status" = 'approved'
        AND dependency."dependency_kind" IN ('selected', 'in_progress')
        AND (
          NEW."rule_type" IN ('time_conflict', 'load_limit') OR
          course_version."course_id" = NEW."subject_course_id" OR
          course_version."course_id" = NEW."related_course_id"
        )
        AND NOT EXISTS (
          SELECT 1 FROM "plan_rule_dependency" existing_dependency
          WHERE existing_dependency."plan_version_id" = plan."id"
            AND existing_dependency."rule_version_id" = NEW."id"
        )
    ), changed AS (
      UPDATE "plan_version" plan
      SET "status" = 'needs_review',
          "invalidation_reason" = 'course_rule_version_approved:' || NEW."id"::text,
          "updated_at" = now()
      FROM affected
      WHERE plan."id" = affected."id"
      RETURNING plan."id"
    )
    INSERT INTO "plan_review_record" (
      "plan_version_id", "action", "from_status", "to_status", "actor_type", "reason"
    )
    SELECT "id", 'invalidated', 'approved', 'needs_review', 'service',
           'course_rule_version_approved:' || NEW."id"::text
    FROM changed;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "course_rule_version_plan_invalidation"
AFTER UPDATE OF "status" ON "course_rule_version"
FOR EACH ROW EXECUTE FUNCTION "invalidate_plans_for_rule_version"();
--> statement-breakpoint
CREATE FUNCTION "invalidate_plans_for_profile_version"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'approved' AND NEW."status" IN ('needs_review', 'archived') THEN
    WITH changed AS (
      UPDATE "plan_version" plan
      SET "status" = 'needs_review',
          "invalidation_reason" = 'profile_version_' || NEW."status"::text || ':' || NEW."id"::text,
          "updated_at" = now()
      WHERE plan."profile_version_id" = NEW."id"
        AND plan."status" = 'approved'
      RETURNING plan."id"
    )
    INSERT INTO "plan_review_record" (
      "plan_version_id", "action", "from_status", "to_status", "actor_type", "reason"
    )
    SELECT "id", 'invalidated', 'approved', 'needs_review', 'service',
           'profile_version_' || NEW."status"::text || ':' || NEW."id"::text
    FROM changed;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "profile_version_plan_invalidation"
AFTER UPDATE OF "status" ON "profile_version"
FOR EACH ROW EXECUTE FUNCTION "invalidate_plans_for_profile_version"();
