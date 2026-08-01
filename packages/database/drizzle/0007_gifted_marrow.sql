CREATE TYPE "public"."confidence_level" AS ENUM('high', 'medium', 'low', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."information_nature" AS ENUM('fact', 'inference', 'missing', 'advisor_judgment');--> statement-breakpoint
CREATE TYPE "public"."profile_claim_category" AS ENUM('academic_foundation', 'interest_thread', 'experience_connections', 'responsibility_impact', 'interdisciplinary_ai_depth', 'behavioral_evidence', 'gaps_contradictions_risks', 'one_sentence_label');--> statement-breakpoint
CREATE TYPE "public"."profile_status" AS ENUM('draft', 'in_review', 'approved', 'needs_review', 'archived');--> statement-breakpoint
CREATE TABLE "claim_evidence" (
	"profile_claim_id" uuid NOT NULL,
	"evidence_locator_id" uuid NOT NULL,
	"relation" "evidence_relation" NOT NULL,
	"validation_status" "validation_status" DEFAULT 'valid' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claim_evidence_profile_claim_id_evidence_locator_id_pk" PRIMARY KEY("profile_claim_id","evidence_locator_id")
);
--> statement-breakpoint
CREATE TABLE "model_task_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"background_job_id" uuid NOT NULL,
	"task_type" varchar(64) NOT NULL,
	"authorization_context_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"input_snapshot_id" uuid NOT NULL,
	"input_snapshot_hash" varchar(64) NOT NULL,
	"provider" varchar(64) NOT NULL,
	"model" varchar(128) NOT NULL,
	"prompt_version" varchar(64) NOT NULL,
	"prompt_hash" varchar(64) NOT NULL,
	"schema_version" varchar(64) NOT NULL,
	"schema_hash" varchar(64) NOT NULL,
	"redaction_version" varchar(64) NOT NULL,
	"git_commit_sha" varchar(40) NOT NULL,
	"pricing_version" varchar(64) NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"prompt_tokens" integer,
	"prompt_cache_hit_tokens" integer,
	"prompt_cache_miss_tokens" integer,
	"completion_tokens" integer,
	"total_tokens" integer,
	"estimated_cost_micros_cny" integer,
	"provider_request_id" varchar(256),
	"output_hash" varchar(64),
	"error_code" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "model_task_run_type_check" CHECK ("model_task_run"."task_type" = 'profile.draft'),
	CONSTRAINT "model_task_run_hashes_check" CHECK ("model_task_run"."input_snapshot_hash" ~ '^[0-9a-f]{64}$' and "model_task_run"."prompt_hash" ~ '^[0-9a-f]{64}$' and "model_task_run"."schema_hash" ~ '^[0-9a-f]{64}$' and ("model_task_run"."output_hash" is null or "model_task_run"."output_hash" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "model_task_run_git_sha_check" CHECK ("model_task_run"."git_commit_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "model_task_run_attempt_check" CHECK ("model_task_run"."attempt_count" between 0 and 3),
	CONSTRAINT "model_task_run_usage_check" CHECK (("model_task_run"."prompt_tokens" is null and "model_task_run"."prompt_cache_hit_tokens" is null and "model_task_run"."prompt_cache_miss_tokens" is null and "model_task_run"."completion_tokens" is null and "model_task_run"."total_tokens" is null and "model_task_run"."estimated_cost_micros_cny" is null) or ("model_task_run"."prompt_tokens" >= 0 and "model_task_run"."prompt_cache_hit_tokens" >= 0 and "model_task_run"."prompt_cache_miss_tokens" >= 0 and "model_task_run"."completion_tokens" >= 0 and "model_task_run"."total_tokens" >= 0 and "model_task_run"."estimated_cost_micros_cny" >= 0 and "model_task_run"."prompt_cache_hit_tokens" + "model_task_run"."prompt_cache_miss_tokens" = "model_task_run"."prompt_tokens" and "model_task_run"."prompt_tokens" + "model_task_run"."completion_tokens" = "model_task_run"."total_tokens")),
	CONSTRAINT "model_task_run_state_check" CHECK (("model_task_run"."status" = 'queued' and "model_task_run"."started_at" is null and "model_task_run"."completed_at" is null and "model_task_run"."output_hash" is null and "model_task_run"."error_code" is null) or ("model_task_run"."status" = 'running' and "model_task_run"."started_at" is not null and "model_task_run"."completed_at" is null and "model_task_run"."output_hash" is null and "model_task_run"."error_code" is null) or ("model_task_run"."status" = 'succeeded' and "model_task_run"."started_at" is not null and "model_task_run"."completed_at" is not null and "model_task_run"."output_hash" is not null and "model_task_run"."error_code" is null and "model_task_run"."total_tokens" is not null) or ("model_task_run"."status" in ('failed', 'canceled') and "model_task_run"."started_at" is not null and "model_task_run"."completed_at" is not null and "model_task_run"."output_hash" is null and "model_task_run"."error_code" is not null))
);
--> statement-breakpoint
CREATE TABLE "profile_claim" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_version_id" uuid NOT NULL,
	"category" "profile_claim_category" NOT NULL,
	"statement" text NOT NULL,
	"information_nature" "information_nature" NOT NULL,
	"confidence" "confidence_level" NOT NULL,
	"evidence_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_claim_statement_check" CHECK (char_length(trim("profile_claim"."statement")) between 1 and 1200),
	CONSTRAINT "profile_claim_evidence_count_check" CHECK (("profile_claim"."information_nature" = 'missing' and "profile_claim"."evidence_count" = 0 and "profile_claim"."confidence" = 'unknown') or ("profile_claim"."information_nature" <> 'missing' and "profile_claim"."evidence_count" between 1 and 10 and "profile_claim"."confidence" <> 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "profile_input_snapshot_evidence" (
	"snapshot_id" uuid NOT NULL,
	"evidence_locator_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_input_snapshot_evidence_snapshot_id_evidence_locator_id_pk" PRIMARY KEY("snapshot_id","evidence_locator_id")
);
--> statement-breakpoint
CREATE TABLE "profile_input_snapshot_fact" (
	"snapshot_id" uuid NOT NULL,
	"student_fact_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_input_snapshot_fact_snapshot_id_student_fact_id_pk" PRIMARY KEY("snapshot_id","student_fact_id")
);
--> statement-breakpoint
CREATE TABLE "profile_input_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" uuid NOT NULL,
	"authorization_context_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"snapshot_hash" varchar(64) NOT NULL,
	"redaction_version" varchar(64) NOT NULL,
	"fact_count" integer NOT NULL,
	"evidence_locator_count" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_input_snapshot_hash_check" CHECK ("profile_input_snapshot"."snapshot_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "profile_input_snapshot_counts_check" CHECK ("profile_input_snapshot"."fact_count" > 0 and "profile_input_snapshot"."evidence_locator_count" > 0),
	CONSTRAINT "profile_input_snapshot_redaction_check" CHECK (char_length(trim("profile_input_snapshot"."redaction_version")) > 0)
);
--> statement-breakpoint
CREATE TABLE "profile_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "profile_status" DEFAULT 'draft' NOT NULL,
	"input_snapshot_id" uuid NOT NULL,
	"input_snapshot_hash" varchar(64) NOT NULL,
	"model_task_run_id" uuid NOT NULL,
	"questions_to_confirm" jsonb NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"invalidation_reason" varchar(512),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_version_version_check" CHECK ("profile_version"."version" > 0),
	CONSTRAINT "profile_version_hash_check" CHECK ("profile_version"."input_snapshot_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "profile_version_state_check" CHECK (("profile_version"."status" in ('draft', 'in_review') and "profile_version"."approved_by_user_id" is null and "profile_version"."approved_at" is null and "profile_version"."invalidation_reason" is null) or ("profile_version"."status" = 'approved' and "profile_version"."approved_by_user_id" is not null and "profile_version"."approved_at" is not null and "profile_version"."invalidation_reason" is null) or ("profile_version"."status" in ('needs_review', 'archived') and "profile_version"."invalidation_reason" is not null))
);
--> statement-breakpoint
ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_profile_claim_id_profile_claim_id_fk" FOREIGN KEY ("profile_claim_id") REFERENCES "public"."profile_claim"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_evidence_locator_id_evidence_locator_id_fk" FOREIGN KEY ("evidence_locator_id") REFERENCES "public"."evidence_locator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_input_snapshot" ADD CONSTRAINT "profile_input_snapshot_id_student_constraint" UNIQUE ("id", "student_id");--> statement-breakpoint
ALTER TABLE "model_task_run" ADD CONSTRAINT "model_task_run_background_job_id_background_job_id_fk" FOREIGN KEY ("background_job_id") REFERENCES "public"."background_job"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_task_run" ADD CONSTRAINT "model_task_run_authorization_context_id_authorization_context_snapshot_id_fk" FOREIGN KEY ("authorization_context_id") REFERENCES "public"."authorization_context_snapshot"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_task_run" ADD CONSTRAINT "model_task_run_snapshot_student_fk" FOREIGN KEY ("input_snapshot_id","student_id") REFERENCES "public"."profile_input_snapshot"("id","student_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_claim" ADD CONSTRAINT "profile_claim_profile_version_id_profile_version_id_fk" FOREIGN KEY ("profile_version_id") REFERENCES "public"."profile_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_input_snapshot_evidence" ADD CONSTRAINT "profile_input_snapshot_evidence_snapshot_id_profile_input_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."profile_input_snapshot"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_input_snapshot_evidence" ADD CONSTRAINT "profile_input_snapshot_evidence_evidence_locator_id_evidence_locator_id_fk" FOREIGN KEY ("evidence_locator_id") REFERENCES "public"."evidence_locator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_input_snapshot_fact" ADD CONSTRAINT "profile_input_snapshot_fact_snapshot_id_profile_input_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."profile_input_snapshot"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_input_snapshot_fact" ADD CONSTRAINT "profile_input_snapshot_fact_student_fact_id_student_fact_id_fk" FOREIGN KEY ("student_fact_id") REFERENCES "public"."student_fact"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_input_snapshot" ADD CONSTRAINT "profile_input_snapshot_student_id_student_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."student"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_input_snapshot" ADD CONSTRAINT "profile_input_snapshot_authorization_context_id_authorization_context_snapshot_id_fk" FOREIGN KEY ("authorization_context_id") REFERENCES "public"."authorization_context_snapshot"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_input_snapshot" ADD CONSTRAINT "profile_input_snapshot_created_by_user_id_app_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_version" ADD CONSTRAINT "profile_version_student_id_student_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."student"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_version" ADD CONSTRAINT "profile_version_input_snapshot_id_profile_input_snapshot_id_fk" FOREIGN KEY ("input_snapshot_id") REFERENCES "public"."profile_input_snapshot"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_version" ADD CONSTRAINT "profile_version_model_task_run_id_model_task_run_id_fk" FOREIGN KEY ("model_task_run_id") REFERENCES "public"."model_task_run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_version" ADD CONSTRAINT "profile_version_created_by_user_id_app_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_version" ADD CONSTRAINT "profile_version_approved_by_user_id_app_user_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "model_task_run_background_job_unique" ON "model_task_run" USING btree ("background_job_id");--> statement-breakpoint
CREATE INDEX "model_task_run_student_created_idx" ON "model_task_run" USING btree ("student_id","created_at");--> statement-breakpoint
CREATE INDEX "profile_claim_version_category_idx" ON "profile_claim" USING btree ("profile_version_id","category");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_input_snapshot_actor_hash_unique" ON "profile_input_snapshot" USING btree ("student_id","created_by_user_id","snapshot_hash","redaction_version");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_input_snapshot_id_student_unique" ON "profile_input_snapshot" USING btree ("id","student_id");--> statement-breakpoint
CREATE INDEX "profile_input_snapshot_student_created_idx" ON "profile_input_snapshot" USING btree ("student_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_version_student_version_unique" ON "profile_version" USING btree ("student_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_version_model_task_unique" ON "profile_version" USING btree ("model_task_run_id");--> statement-breakpoint
CREATE INDEX "profile_version_student_created_idx" ON "profile_version" USING btree ("student_id","created_at");
--> statement-breakpoint
CREATE FUNCTION "validate_profile_snapshot_fact"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "profile_input_snapshot" s
    JOIN "student_fact" f ON f."id" = NEW."student_fact_id"
    WHERE s."id" = NEW."snapshot_id"
      AND f."student_id" = s."student_id"
      AND f."confirmation_status" = 'confirmed'
      AND f."valid_to" IS NULL
      AND f."access_level" IN ('internal', 'sensitive')
      AND NOT EXISTS (SELECT 1 FROM "student_fact" child WHERE child."supersedes_id" = f."id")
  ) THEN
    RAISE EXCEPTION 'profile snapshot fact is not current confirmed student data';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "profile_snapshot_fact_validate"
BEFORE INSERT ON "profile_input_snapshot_fact"
FOR EACH ROW EXECUTE FUNCTION "validate_profile_snapshot_fact"();
--> statement-breakpoint
CREATE FUNCTION "validate_profile_snapshot_evidence"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "profile_input_snapshot" s
    JOIN "evidence_locator" l ON l."id" = NEW."evidence_locator_id"
    JOIN "evidence_object" e ON e."id" = l."evidence_object_id"
    WHERE s."id" = NEW."snapshot_id"
      AND e."student_id" = s."student_id"
      AND e."data_domain" = 'student'
      AND e."access_level" IN ('internal', 'sensitive')
      AND NOT EXISTS (SELECT 1 FROM "evidence_invalidation" i WHERE i."evidence_object_id" = e."id")
      AND NOT EXISTS (SELECT 1 FROM "evidence_object" child WHERE child."supersedes_id" = e."id")
  ) THEN
    RAISE EXCEPTION 'profile snapshot evidence is not current student evidence';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "profile_snapshot_evidence_validate"
BEFORE INSERT ON "profile_input_snapshot_evidence"
FOR EACH ROW EXECUTE FUNCTION "validate_profile_snapshot_evidence"();
--> statement-breakpoint
CREATE FUNCTION "validate_model_task_run_scope"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "profile_input_snapshot" s
    JOIN "background_job" b ON b."id" = NEW."background_job_id"
    WHERE s."id" = NEW."input_snapshot_id"
      AND s."student_id" = NEW."student_id"
      AND s."snapshot_hash" = NEW."input_snapshot_hash"
      AND s."authorization_context_id" = NEW."authorization_context_id"
      AND b."authorization_context_id" = NEW."authorization_context_id"
      AND b."task_name" = 'profile.draft'
  ) THEN
    RAISE EXCEPTION 'model task scope does not match its frozen snapshot';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "model_task_run_scope_validate"
BEFORE INSERT ON "model_task_run"
FOR EACH ROW EXECUTE FUNCTION "validate_model_task_run_scope"();
--> statement-breakpoint
CREATE FUNCTION "validate_profile_version_scope"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "profile_input_snapshot" s
    JOIN "model_task_run" r ON r."id" = NEW."model_task_run_id"
    WHERE s."id" = NEW."input_snapshot_id"
      AND s."student_id" = NEW."student_id"
      AND s."snapshot_hash" = NEW."input_snapshot_hash"
      AND s."created_by_user_id" = NEW."created_by_user_id"
      AND r."student_id" = NEW."student_id"
      AND r."input_snapshot_id" = NEW."input_snapshot_id"
      AND r."input_snapshot_hash" = NEW."input_snapshot_hash"
      AND r."status" IN ('running', 'succeeded')
  ) THEN
    RAISE EXCEPTION 'profile version does not match its model run and snapshot';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "profile_version_scope_validate"
BEFORE INSERT ON "profile_version"
FOR EACH ROW EXECUTE FUNCTION "validate_profile_version_scope"();
--> statement-breakpoint
CREATE FUNCTION "validate_claim_evidence_scope"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "profile_claim" c
    JOIN "profile_version" v ON v."id" = c."profile_version_id"
    JOIN "profile_input_snapshot_evidence" se
      ON se."snapshot_id" = v."input_snapshot_id"
     AND se."evidence_locator_id" = NEW."evidence_locator_id"
    WHERE c."id" = NEW."profile_claim_id"
  ) THEN
    RAISE EXCEPTION 'claim evidence is outside the frozen input snapshot';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "claim_evidence_scope_validate"
BEFORE INSERT ON "claim_evidence"
FOR EACH ROW EXECUTE FUNCTION "validate_claim_evidence_scope"();
--> statement-breakpoint
CREATE FUNCTION "check_profile_snapshot_counts"() RETURNS trigger AS $$
DECLARE target_id uuid;
DECLARE expected_facts integer;
DECLARE expected_evidence integer;
BEGIN
  IF TG_TABLE_NAME = 'profile_input_snapshot' THEN
    target_id := COALESCE(NEW."id", OLD."id");
  ELSE
    target_id := COALESCE(NEW."snapshot_id", OLD."snapshot_id");
  END IF;
  SELECT "fact_count", "evidence_locator_count"
    INTO expected_facts, expected_evidence
    FROM "profile_input_snapshot" WHERE "id" = target_id;
  IF FOUND AND (
    expected_facts <> (SELECT count(*) FROM "profile_input_snapshot_fact" WHERE "snapshot_id" = target_id)
    OR expected_evidence <> (SELECT count(*) FROM "profile_input_snapshot_evidence" WHERE "snapshot_id" = target_id)
  ) THEN
    RAISE EXCEPTION 'profile snapshot counts do not match frozen references';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "profile_snapshot_count_from_snapshot"
AFTER INSERT ON "profile_input_snapshot" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "check_profile_snapshot_counts"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "profile_snapshot_count_from_fact"
AFTER INSERT OR DELETE ON "profile_input_snapshot_fact" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "check_profile_snapshot_counts"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "profile_snapshot_count_from_evidence"
AFTER INSERT OR DELETE ON "profile_input_snapshot_evidence" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "check_profile_snapshot_counts"();
--> statement-breakpoint
CREATE FUNCTION "check_profile_claim_evidence_count"() RETURNS trigger AS $$
DECLARE target_id uuid;
DECLARE expected integer;
BEGIN
  IF TG_TABLE_NAME = 'profile_claim' THEN
    target_id := COALESCE(NEW."id", OLD."id");
  ELSE
    target_id := COALESCE(NEW."profile_claim_id", OLD."profile_claim_id");
  END IF;
  SELECT "evidence_count" INTO expected FROM "profile_claim" WHERE "id" = target_id;
  IF FOUND AND expected <> (SELECT count(*) FROM "claim_evidence" WHERE "profile_claim_id" = target_id) THEN
    RAISE EXCEPTION 'profile claim evidence count mismatch';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "profile_claim_count_from_claim"
AFTER INSERT ON "profile_claim" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "check_profile_claim_evidence_count"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "profile_claim_count_from_evidence"
AFTER INSERT OR DELETE ON "claim_evidence" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "check_profile_claim_evidence_count"();
--> statement-breakpoint
CREATE FUNCTION "reject_profile_immutable_change"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'profile source and output rows are immutable';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "profile_input_snapshot_immutable" BEFORE UPDATE OR DELETE ON "profile_input_snapshot"
FOR EACH ROW EXECUTE FUNCTION "reject_profile_immutable_change"();
--> statement-breakpoint
CREATE TRIGGER "profile_input_snapshot_fact_immutable" BEFORE UPDATE OR DELETE ON "profile_input_snapshot_fact"
FOR EACH ROW EXECUTE FUNCTION "reject_profile_immutable_change"();
--> statement-breakpoint
CREATE TRIGGER "profile_input_snapshot_evidence_immutable" BEFORE UPDATE OR DELETE ON "profile_input_snapshot_evidence"
FOR EACH ROW EXECUTE FUNCTION "reject_profile_immutable_change"();
--> statement-breakpoint
CREATE TRIGGER "profile_claim_immutable" BEFORE UPDATE OR DELETE ON "profile_claim"
FOR EACH ROW EXECUTE FUNCTION "reject_profile_immutable_change"();
--> statement-breakpoint
CREATE TRIGGER "claim_evidence_immutable" BEFORE UPDATE OR DELETE ON "claim_evidence"
FOR EACH ROW EXECUTE FUNCTION "reject_profile_immutable_change"();
--> statement-breakpoint
CREATE FUNCTION "protect_model_task_identity"() RETURNS trigger AS $$
BEGIN
  IF NEW."id" <> OLD."id"
    OR NEW."background_job_id" <> OLD."background_job_id"
    OR NEW."task_type" <> OLD."task_type"
    OR NEW."request_correlation_id" <> OLD."request_correlation_id"
    OR NEW."authorization_context_id" <> OLD."authorization_context_id"
    OR NEW."student_id" <> OLD."student_id"
    OR NEW."input_snapshot_id" <> OLD."input_snapshot_id"
    OR NEW."input_snapshot_hash" <> OLD."input_snapshot_hash"
    OR NEW."provider" <> OLD."provider"
    OR NEW."model" <> OLD."model"
    OR NEW."prompt_version" <> OLD."prompt_version"
    OR NEW."prompt_hash" <> OLD."prompt_hash"
    OR NEW."schema_version" <> OLD."schema_version"
    OR NEW."schema_hash" <> OLD."schema_hash"
    OR NEW."redaction_version" <> OLD."redaction_version"
    OR NEW."git_commit_sha" <> OLD."git_commit_sha"
    OR NEW."pricing_version" <> OLD."pricing_version"
    OR NEW."created_at" <> OLD."created_at"
  THEN
    RAISE EXCEPTION 'model task identity and configuration are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "model_task_identity_protect" BEFORE UPDATE ON "model_task_run"
FOR EACH ROW EXECUTE FUNCTION "protect_model_task_identity"();
--> statement-breakpoint
CREATE FUNCTION "protect_profile_version_content"() RETURNS trigger AS $$
BEGIN
  IF NEW."id" <> OLD."id"
    OR NEW."student_id" <> OLD."student_id"
    OR NEW."version" <> OLD."version"
    OR NEW."input_snapshot_id" <> OLD."input_snapshot_id"
    OR NEW."input_snapshot_hash" <> OLD."input_snapshot_hash"
    OR NEW."model_task_run_id" <> OLD."model_task_run_id"
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
CREATE TRIGGER "profile_version_content_protect" BEFORE UPDATE ON "profile_version"
FOR EACH ROW EXECUTE FUNCTION "protect_profile_version_content"();
