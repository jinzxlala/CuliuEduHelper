CREATE TYPE "public"."profile_review_action" AS ENUM('revised', 'submitted', 'returned', 'approved', 'invalidated', 'archived');--> statement-breakpoint
CREATE TABLE "profile_review_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_version_id" uuid NOT NULL,
	"action" "profile_review_action" NOT NULL,
	"from_status" "profile_status",
	"to_status" "profile_status" NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_user_id" uuid,
	"reason" varchar(512),
	"request_correlation_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_review_record_actor_check" CHECK (("profile_review_record"."actor_type" = 'user' and "profile_review_record"."actor_user_id" is not null) or "profile_review_record"."actor_type" = 'service'),
	CONSTRAINT "profile_review_record_reason_check" CHECK (("profile_review_record"."action" in ('returned', 'invalidated', 'archived') and char_length(trim("profile_review_record"."reason")) > 0) or ("profile_review_record"."action" not in ('returned', 'invalidated', 'archived')))
);
--> statement-breakpoint
ALTER TABLE "profile_version" DROP CONSTRAINT "profile_version_state_check";--> statement-breakpoint
DROP INDEX "profile_version_model_task_unique";--> statement-breakpoint
ALTER TABLE "profile_version" ADD COLUMN "source_profile_version_id" uuid;--> statement-breakpoint
ALTER TABLE "profile_review_record" ADD CONSTRAINT "profile_review_record_profile_version_id_profile_version_id_fk" FOREIGN KEY ("profile_version_id") REFERENCES "public"."profile_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_review_record" ADD CONSTRAINT "profile_review_record_actor_user_id_app_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "profile_review_record_version_created_idx" ON "profile_review_record" USING btree ("profile_version_id","created_at");--> statement-breakpoint
ALTER TABLE "profile_version" ADD CONSTRAINT "profile_version_source_profile_version_id_profile_version_id_fk" FOREIGN KEY ("source_profile_version_id") REFERENCES "public"."profile_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "profile_version_source_unique" ON "profile_version" USING btree ("source_profile_version_id") WHERE "profile_version"."source_profile_version_id" is not null;--> statement-breakpoint
CREATE INDEX "profile_version_model_task_idx" ON "profile_version" USING btree ("model_task_run_id");--> statement-breakpoint
ALTER TABLE "profile_version" ADD CONSTRAINT "profile_version_state_check" CHECK (("profile_version"."status" in ('draft', 'in_review') and "profile_version"."approved_by_user_id" is null and "profile_version"."approved_at" is null and "profile_version"."invalidation_reason" is null) or ("profile_version"."status" = 'approved' and "profile_version"."approved_by_user_id" is not null and "profile_version"."approved_at" is not null and "profile_version"."invalidation_reason" is null) or ("profile_version"."status" = 'needs_review' and "profile_version"."approved_by_user_id" is not null and "profile_version"."approved_at" is not null and "profile_version"."invalidation_reason" is not null) or ("profile_version"."status" = 'archived' and (("profile_version"."approved_by_user_id" is null and "profile_version"."approved_at" is null) or ("profile_version"."approved_by_user_id" is not null and "profile_version"."approved_at" is not null)) and "profile_version"."invalidation_reason" is not null));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "validate_profile_version_scope"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "profile_input_snapshot" s
    JOIN "model_task_run" r ON r."id" = NEW."model_task_run_id"
    WHERE s."id" = NEW."input_snapshot_id"
      AND s."student_id" = NEW."student_id"
      AND s."snapshot_hash" = NEW."input_snapshot_hash"
      AND r."student_id" = NEW."student_id"
      AND r."input_snapshot_id" = NEW."input_snapshot_id"
      AND r."input_snapshot_hash" = NEW."input_snapshot_hash"
      AND (
        (
          NEW."source_profile_version_id" IS NULL
          AND s."created_by_user_id" = NEW."created_by_user_id"
          AND r."status" IN ('running', 'succeeded')
        )
        OR (
          NEW."source_profile_version_id" IS NOT NULL
          AND r."status" = 'succeeded'
          AND EXISTS (
            SELECT 1
            FROM "profile_version" source
            JOIN "app_user" creator ON creator."id" = NEW."created_by_user_id"
            WHERE source."id" = NEW."source_profile_version_id"
              AND source."student_id" = NEW."student_id"
              AND source."input_snapshot_id" = NEW."input_snapshot_id"
              AND source."input_snapshot_hash" = NEW."input_snapshot_hash"
              AND source."model_task_run_id" = NEW."model_task_run_id"
              AND creator."active" = true
              AND creator."role" IN ('admin', 'advisor')
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'profile version does not match its model run, source, and snapshot';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "protect_profile_version_content"() RETURNS trigger AS $$
BEGIN
  IF NEW."id" <> OLD."id"
    OR NEW."student_id" <> OLD."student_id"
    OR NEW."version" <> OLD."version"
    OR NEW."input_snapshot_id" <> OLD."input_snapshot_id"
    OR NEW."input_snapshot_hash" <> OLD."input_snapshot_hash"
    OR NEW."model_task_run_id" <> OLD."model_task_run_id"
    OR NEW."source_profile_version_id" IS DISTINCT FROM OLD."source_profile_version_id"
    OR NEW."questions_to_confirm" <> OLD."questions_to_confirm"
    OR NEW."created_by_user_id" <> OLD."created_by_user_id"
    OR NEW."created_at" <> OLD."created_at"
  THEN
    RAISE EXCEPTION 'profile version content is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "profile_snapshot_is_current"(target_snapshot_id uuid, target_student_id uuid)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1
    FROM "profile_input_snapshot" snapshot
    WHERE snapshot."id" = target_snapshot_id
      AND snapshot."student_id" = target_student_id
      AND snapshot."fact_count" = (
        SELECT count(*) FROM "profile_input_snapshot_fact" WHERE "snapshot_id" = target_snapshot_id
      )
      AND snapshot."evidence_locator_count" = (
        SELECT count(*) FROM "profile_input_snapshot_evidence" WHERE "snapshot_id" = target_snapshot_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM "profile_input_snapshot_fact" snapshot_fact
        JOIN "student_fact" fact ON fact."id" = snapshot_fact."student_fact_id"
        WHERE snapshot_fact."snapshot_id" = target_snapshot_id
          AND (
            fact."student_id" <> target_student_id
            OR fact."confirmation_status" <> 'confirmed'
            OR fact."valid_to" IS NOT NULL
            OR fact."access_level" NOT IN ('internal', 'sensitive')
            OR EXISTS (
              SELECT 1 FROM "student_fact" child WHERE child."supersedes_id" = fact."id"
            )
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM "profile_input_snapshot_evidence" snapshot_evidence
        JOIN "evidence_locator" locator ON locator."id" = snapshot_evidence."evidence_locator_id"
        JOIN "evidence_object" evidence ON evidence."id" = locator."evidence_object_id"
        WHERE snapshot_evidence."snapshot_id" = target_snapshot_id
          AND (
            evidence."data_domain" <> 'student'
            OR evidence."student_id" <> target_student_id
            OR evidence."access_level" NOT IN ('internal', 'sensitive')
            OR EXISTS (
              SELECT 1 FROM "evidence_invalidation" invalidation
              WHERE invalidation."evidence_object_id" = evidence."id"
            )
            OR EXISTS (
              SELECT 1 FROM "evidence_object" child WHERE child."supersedes_id" = evidence."id"
            )
          )
      )
  );
$$ LANGUAGE sql STABLE;
--> statement-breakpoint
CREATE FUNCTION "validate_profile_revision_source_current"() RETURNS trigger AS $$
BEGIN
  IF NEW."source_profile_version_id" IS NOT NULL
    AND NOT "profile_snapshot_is_current"(NEW."input_snapshot_id", NEW."student_id") THEN
    RAISE EXCEPTION 'profile revision requires a current input snapshot';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "profile_revision_source_current"
BEFORE INSERT ON "profile_version"
FOR EACH ROW EXECUTE FUNCTION "validate_profile_revision_source_current"();
--> statement-breakpoint
CREATE FUNCTION "protect_profile_status_transition"() RETURNS trigger AS $$
BEGIN
  IF NEW."status" = OLD."status" THEN
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD."status" = 'draft' AND NEW."status" IN ('in_review', 'archived'))
    OR (OLD."status" = 'in_review' AND NEW."status" IN ('draft', 'approved', 'archived'))
    OR (OLD."status" = 'approved' AND NEW."status" IN ('needs_review', 'archived'))
    OR (OLD."status" = 'needs_review' AND NEW."status" = 'archived')
  ) THEN
    RAISE EXCEPTION 'invalid profile status transition';
  END IF;
  IF OLD."approved_by_user_id" IS NOT NULL AND (
    NEW."approved_by_user_id" IS DISTINCT FROM OLD."approved_by_user_id"
    OR NEW."approved_at" IS DISTINCT FROM OLD."approved_at"
  ) THEN
    RAISE EXCEPTION 'profile approval identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "profile_status_transition_protect"
BEFORE UPDATE ON "profile_version"
FOR EACH ROW EXECUTE FUNCTION "protect_profile_status_transition"();
--> statement-breakpoint
CREATE FUNCTION "validate_profile_approval"() RETURNS trigger AS $$
DECLARE claim_count integer;
DECLARE category_count integer;
BEGIN
  IF NEW."status" <> 'approved' OR OLD."status" = 'approved' THEN
    RETURN NEW;
  END IF;
  IF NOT "profile_snapshot_is_current"(NEW."input_snapshot_id", NEW."student_id") THEN
    RAISE EXCEPTION 'approved profile requires a current input snapshot';
  END IF;
  SELECT count(*), count(DISTINCT "category")
    INTO claim_count, category_count
    FROM "profile_claim"
    WHERE "profile_version_id" = NEW."id";
  IF claim_count <> 8 OR category_count <> 8 THEN
    RAISE EXCEPTION 'approved profile requires exactly eight distinct claims';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "profile_claim"
    WHERE "profile_version_id" = NEW."id"
      AND "category" = 'one_sentence_label'
      AND "information_nature" = 'inference'
  ) THEN
    RAISE EXCEPTION 'approved profile label must be an inference';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "profile_claim" claim
    WHERE claim."profile_version_id" = NEW."id"
      AND (
        claim."evidence_count" <> (
          SELECT count(*) FROM "claim_evidence" link WHERE link."profile_claim_id" = claim."id"
        )
        OR (
          claim."information_nature" <> 'missing'
          AND NOT EXISTS (
            SELECT 1
            FROM "claim_evidence" link
            JOIN "profile_input_snapshot_evidence" snapshot_evidence
              ON snapshot_evidence."snapshot_id" = NEW."input_snapshot_id"
             AND snapshot_evidence."evidence_locator_id" = link."evidence_locator_id"
            JOIN "evidence_locator" locator ON locator."id" = link."evidence_locator_id"
            JOIN "evidence_object" evidence ON evidence."id" = locator."evidence_object_id"
            WHERE link."profile_claim_id" = claim."id"
              AND link."validation_status" = 'valid'
              AND evidence."data_domain" = 'student'
              AND evidence."student_id" = NEW."student_id"
              AND NOT EXISTS (
                SELECT 1 FROM "evidence_invalidation" invalidation
                WHERE invalidation."evidence_object_id" = evidence."id"
              )
              AND NOT EXISTS (
                SELECT 1 FROM "evidence_object" child WHERE child."supersedes_id" = evidence."id"
              )
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'approved profile claims require valid current student evidence';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "profile_approval_validate"
BEFORE UPDATE ON "profile_version"
FOR EACH ROW EXECUTE FUNCTION "validate_profile_approval"();
--> statement-breakpoint
CREATE FUNCTION "validate_profile_review_record"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "profile_version" version
    WHERE version."id" = NEW."profile_version_id" AND version."status" = NEW."to_status"
  ) THEN
    RAISE EXCEPTION 'profile review record does not match current profile status';
  END IF;
  IF NOT (
    (NEW."action" = 'revised' AND NEW."from_status" IN ('draft', 'approved', 'needs_review') AND NEW."to_status" = 'draft')
    OR (NEW."action" = 'submitted' AND NEW."from_status" = 'draft' AND NEW."to_status" = 'in_review')
    OR (NEW."action" = 'returned' AND NEW."from_status" = 'in_review' AND NEW."to_status" = 'draft')
    OR (NEW."action" = 'approved' AND NEW."from_status" = 'in_review' AND NEW."to_status" = 'approved')
    OR (NEW."action" = 'invalidated' AND NEW."from_status" = 'approved' AND NEW."to_status" = 'needs_review')
    OR (NEW."action" = 'archived' AND NEW."from_status" <> 'archived' AND NEW."to_status" = 'archived')
  ) THEN
    RAISE EXCEPTION 'invalid profile review record transition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "profile_review_record_validate"
BEFORE INSERT ON "profile_review_record"
FOR EACH ROW EXECUTE FUNCTION "validate_profile_review_record"();
--> statement-breakpoint
CREATE TRIGGER "profile_review_record_immutable"
BEFORE UPDATE OR DELETE ON "profile_review_record"
FOR EACH ROW EXECUTE FUNCTION "reject_profile_immutable_change"();
--> statement-breakpoint
CREATE FUNCTION "mark_profiles_from_evidence_invalidation"() RETURNS trigger AS $$
DECLARE affected record;
DECLARE reason_text text := 'evidence_invalidated:' || NEW."evidence_object_id"::text;
BEGIN
  FOR affected IN
    UPDATE "profile_version" version
      SET "status" = 'needs_review', "invalidation_reason" = reason_text, "updated_at" = NEW."created_at"
    WHERE version."status" = 'approved'
      AND EXISTS (
        SELECT 1
        FROM "profile_claim" claim
        JOIN "claim_evidence" link ON link."profile_claim_id" = claim."id"
        JOIN "evidence_locator" locator ON locator."id" = link."evidence_locator_id"
        WHERE claim."profile_version_id" = version."id"
          AND locator."evidence_object_id" = NEW."evidence_object_id"
      )
    RETURNING version."id", version."student_id"
  LOOP
    INSERT INTO "profile_review_record" (
      "profile_version_id", "action", "from_status", "to_status", "actor_type",
      "actor_user_id", "reason", "created_at"
    ) VALUES (
      affected."id", 'invalidated', 'approved', 'needs_review', 'service',
      NEW."invalidated_by_user_id", reason_text, NEW."created_at"
    );
    INSERT INTO "audit_event" (
      "actor_type", "actor_user_id", "action", "student_id", "object_type", "object_id",
      "result", "request_correlation_id", "details", "created_at"
    ) VALUES (
      'service', NEW."invalidated_by_user_id", 'student.profile.needs_review', affected."student_id",
      'profile_version', affected."id"::text, 'allowed', gen_random_uuid(),
      jsonb_build_object('cause', 'evidence_invalidated', 'evidenceObjectId', NEW."evidence_object_id"),
      NEW."created_at"
    );
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "profile_invalidate_from_evidence"
AFTER INSERT ON "evidence_invalidation"
FOR EACH ROW EXECUTE FUNCTION "mark_profiles_from_evidence_invalidation"();
--> statement-breakpoint
CREATE FUNCTION "mark_profiles_from_evidence_supersession"() RETURNS trigger AS $$
DECLARE affected record;
DECLARE reason_text text := 'evidence_superseded:' || NEW."supersedes_id"::text;
BEGIN
  IF NEW."supersedes_id" IS NULL THEN RETURN NEW; END IF;
  FOR affected IN
    UPDATE "profile_version" version
      SET "status" = 'needs_review', "invalidation_reason" = reason_text, "updated_at" = NEW."created_at"
    WHERE version."status" = 'approved'
      AND EXISTS (
        SELECT 1
        FROM "profile_claim" claim
        JOIN "claim_evidence" link ON link."profile_claim_id" = claim."id"
        JOIN "evidence_locator" locator ON locator."id" = link."evidence_locator_id"
        WHERE claim."profile_version_id" = version."id"
          AND locator."evidence_object_id" = NEW."supersedes_id"
      )
    RETURNING version."id", version."student_id"
  LOOP
    INSERT INTO "profile_review_record" (
      "profile_version_id", "action", "from_status", "to_status", "actor_type",
      "actor_user_id", "reason", "created_at"
    ) VALUES (
      affected."id", 'invalidated', 'approved', 'needs_review', 'service',
      NEW."uploaded_by_user_id", reason_text, NEW."created_at"
    );
    INSERT INTO "audit_event" (
      "actor_type", "actor_user_id", "action", "student_id", "object_type", "object_id",
      "result", "request_correlation_id", "details", "created_at"
    ) VALUES (
      'service', NEW."uploaded_by_user_id", 'student.profile.needs_review', affected."student_id",
      'profile_version', affected."id"::text, 'allowed', gen_random_uuid(),
      jsonb_build_object('cause', 'evidence_superseded', 'evidenceObjectId', NEW."supersedes_id"),
      NEW."created_at"
    );
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "profile_invalidate_from_evidence_supersession"
AFTER INSERT ON "evidence_object"
FOR EACH ROW EXECUTE FUNCTION "mark_profiles_from_evidence_supersession"();
--> statement-breakpoint
CREATE FUNCTION "mark_profiles_from_fact_change"() RETURNS trigger AS $$
DECLARE affected record;
DECLARE reason_text text := 'fact_superseded:' || OLD."id"::text;
BEGIN
  IF NOT (
    OLD."confirmation_status" = 'confirmed'
    AND (NEW."confirmation_status" = 'superseded' OR NEW."valid_to" IS NOT NULL)
  ) THEN RETURN NEW; END IF;
  FOR affected IN
    UPDATE "profile_version" version
      SET "status" = 'needs_review', "invalidation_reason" = reason_text, "updated_at" = NEW."updated_at"
    WHERE version."status" = 'approved'
      AND EXISTS (
        SELECT 1 FROM "profile_input_snapshot_fact" snapshot_fact
        WHERE snapshot_fact."snapshot_id" = version."input_snapshot_id"
          AND snapshot_fact."student_fact_id" = OLD."id"
      )
    RETURNING version."id", version."student_id"
  LOOP
    INSERT INTO "profile_review_record" (
      "profile_version_id", "action", "from_status", "to_status", "actor_type", "reason", "created_at"
    ) VALUES (
      affected."id", 'invalidated', 'approved', 'needs_review', 'service', reason_text, NEW."updated_at"
    );
    INSERT INTO "audit_event" (
      "actor_type", "action", "student_id", "object_type", "object_id", "result",
      "request_correlation_id", "details", "created_at"
    ) VALUES (
      'service', 'student.profile.needs_review', affected."student_id", 'profile_version',
      affected."id"::text, 'allowed', gen_random_uuid(),
      jsonb_build_object('cause', 'fact_superseded', 'studentFactId', OLD."id"), NEW."updated_at"
    );
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "profile_invalidate_from_fact_change"
AFTER UPDATE ON "student_fact"
FOR EACH ROW EXECUTE FUNCTION "mark_profiles_from_fact_change"();
