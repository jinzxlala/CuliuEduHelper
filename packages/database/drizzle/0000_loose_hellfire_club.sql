CREATE TYPE "public"."access_level" AS ENUM('internal', 'sensitive', 'restricted');--> statement-breakpoint
CREATE TYPE "public"."actor_type" AS ENUM('user', 'service');--> statement-breakpoint
CREATE TYPE "public"."confirmation_status" AS ENUM('unconfirmed', 'confirmed', 'rejected', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."data_domain" AS ENUM('knowledge', 'student');--> statement-breakpoint
CREATE TYPE "public"."evidence_relation" AS ENUM('supports', 'contradicts', 'partially_supports');--> statement-breakpoint
CREATE TYPE "public"."fact_source_type" AS ENUM('advisor', 'student', 'parent', 'evidence', 'import');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."locator_type" AS ENUM('page', 'paragraph', 'character_range', 'cell', 'timestamp', 'record_field');--> statement-breakpoint
CREATE TYPE "public"."source_document_type" AS ENUM('analysis_markdown', 'transcript_srt', 'transcript_json', 'attachment', 'export');--> statement-breakpoint
CREATE TYPE "public"."student_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'advisor', 'auditor', 'service');--> statement-breakpoint
CREATE TYPE "public"."validation_status" AS ENUM('pending', 'valid', 'invalid');--> statement-breakpoint
CREATE TABLE "app_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text,
	"role" "user_role" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_user_id" uuid,
	"action" varchar(128) NOT NULL,
	"student_id" uuid,
	"object_type" varchar(128) NOT NULL,
	"object_id" text NOT NULL,
	"result" varchar(64) NOT NULL,
	"request_correlation_id" uuid NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_event_actor_check" CHECK (("audit_event"."actor_type" = 'user' and "audit_event"."actor_user_id" is not null) or ("audit_event"."actor_type" = 'service'))
);
--> statement-breakpoint
CREATE TABLE "authorization_context_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"student_id" uuid,
	"allowed_actions" text[] NOT NULL,
	"max_access_level" "access_level" NOT NULL,
	"context_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "authorization_context_hash_check" CHECK ("authorization_context_snapshot"."context_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "authorization_context_actions_check" CHECK (cardinality("authorization_context_snapshot"."allowed_actions") > 0),
	CONSTRAINT "authorization_context_expiry_check" CHECK ("authorization_context_snapshot"."expires_at" > "authorization_context_snapshot"."created_at")
);
--> statement-breakpoint
CREATE TABLE "background_job" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_name" varchar(128) NOT NULL,
	"authorization_context_id" uuid NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"result_reference" jsonb,
	"error_code" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "background_job_attempts_check" CHECK ("background_job"."attempts" >= 0 and "background_job"."attempts" <= "background_job"."max_attempts"),
	CONSTRAINT "background_job_max_attempts_check" CHECK ("background_job"."max_attempts" between 1 and 10),
	CONSTRAINT "background_job_idempotency_key_check" CHECK ("background_job"."idempotency_key" ~ '^[A-Za-z0-9_-]+$'),
	CONSTRAINT "background_job_state_time_check" CHECK (("background_job"."status" = 'queued' and "background_job"."started_at" is null and "background_job"."completed_at" is null) or ("background_job"."status" = 'running' and "background_job"."started_at" is not null and "background_job"."completed_at" is null) or ("background_job"."status" in ('succeeded', 'failed', 'canceled') and "background_job"."completed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "evidence_locator" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"evidence_object_id" uuid NOT NULL,
	"locator_type" "locator_type" NOT NULL,
	"locator" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence_object" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"data_domain" "data_domain" NOT NULL,
	"student_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"storage_key" text NOT NULL,
	"uploaded_by_user_id" uuid NOT NULL,
	"access_level" "access_level" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_object_hash_check" CHECK ("evidence_object"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "evidence_object_version_check" CHECK ("evidence_object"."version" > 0),
	CONSTRAINT "evidence_object_storage_key_check" CHECK (("evidence_object"."data_domain" = 'knowledge' and "evidence_object"."storage_key" like 'knowledge/%') or ("evidence_object"."data_domain" = 'student' and "evidence_object"."storage_key" like ('student/' || "evidence_object"."student_id"::text || '/%'))),
	CONSTRAINT "evidence_object_domain_student_check" CHECK (("evidence_object"."data_domain" = 'knowledge' and "evidence_object"."student_id" is null) or ("evidence_object"."data_domain" = 'student' and "evidence_object"."student_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "fact_evidence" (
	"student_fact_id" uuid NOT NULL,
	"evidence_locator_id" uuid NOT NULL,
	"relation" "evidence_relation" NOT NULL,
	"validation_status" "validation_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fact_evidence_student_fact_id_evidence_locator_id_pk" PRIMARY KEY("student_fact_id","evidence_locator_id")
);
--> statement-breakpoint
CREATE TABLE "source_document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"data_domain" "data_domain" NOT NULL,
	"student_id" uuid,
	"source_path" text NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"document_type" "source_document_type" NOT NULL,
	"mime_type" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"read_only" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_document_hash_check" CHECK ("source_document"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "source_document_version_check" CHECK ("source_document"."version" > 0),
	CONSTRAINT "source_document_read_only_check" CHECK ("source_document"."read_only" = true),
	CONSTRAINT "source_document_domain_student_check" CHECK (("source_document"."data_domain" = 'knowledge' and "source_document"."student_id" is null) or ("source_document"."data_domain" = 'student' and "source_document"."student_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "student_authorization" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"allowed_actions" text[] NOT NULL,
	"max_access_level" "access_level" NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"granted_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_authorization_expiry_check" CHECK ("student_authorization"."expires_at" is null or "student_authorization"."expires_at" > "student_authorization"."valid_from"),
	CONSTRAINT "student_authorization_actions_check" CHECK (cardinality("student_authorization"."allowed_actions") > 0)
);
--> statement-breakpoint
CREATE TABLE "student_fact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" uuid NOT NULL,
	"field_key" varchar(128) NOT NULL,
	"value" jsonb NOT NULL,
	"source_type" "fact_source_type" NOT NULL,
	"confirmation_status" "confirmation_status" DEFAULT 'unconfirmed' NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"supersedes_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_fact_validity_check" CHECK ("student_fact"."valid_to" is null or "student_fact"."valid_to" > "student_fact"."valid_from"),
	CONSTRAINT "student_fact_not_self_superseding" CHECK ("student_fact"."supersedes_id" is null or "student_fact"."supersedes_id" <> "student_fact"."id")
);
--> statement-breakpoint
CREATE TABLE "student" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_code" varchar(64) NOT NULL,
	"privacy_level" "access_level" DEFAULT 'sensitive' NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"status" "student_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_user_id_app_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_student_id_student_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."student"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorization_context_snapshot" ADD CONSTRAINT "authorization_context_snapshot_actor_user_id_app_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorization_context_snapshot" ADD CONSTRAINT "authorization_context_snapshot_student_id_student_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."student"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_job" ADD CONSTRAINT "background_job_authorization_context_id_authorization_context_snapshot_id_fk" FOREIGN KEY ("authorization_context_id") REFERENCES "public"."authorization_context_snapshot"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_locator" ADD CONSTRAINT "evidence_locator_evidence_object_id_evidence_object_id_fk" FOREIGN KEY ("evidence_object_id") REFERENCES "public"."evidence_object"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_object" ADD CONSTRAINT "evidence_object_student_id_student_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."student"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_object" ADD CONSTRAINT "evidence_object_uploaded_by_user_id_app_user_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_evidence" ADD CONSTRAINT "fact_evidence_student_fact_id_student_fact_id_fk" FOREIGN KEY ("student_fact_id") REFERENCES "public"."student_fact"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_evidence" ADD CONSTRAINT "fact_evidence_evidence_locator_id_evidence_locator_id_fk" FOREIGN KEY ("evidence_locator_id") REFERENCES "public"."evidence_locator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_document" ADD CONSTRAINT "source_document_student_id_student_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."student"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_authorization" ADD CONSTRAINT "student_authorization_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_authorization" ADD CONSTRAINT "student_authorization_student_id_student_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."student"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_authorization" ADD CONSTRAINT "student_authorization_granted_by_user_id_app_user_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_fact" ADD CONSTRAINT "student_fact_student_id_student_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."student"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_fact" ADD CONSTRAINT "student_fact_supersedes_id_student_fact_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."student_fact"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student" ADD CONSTRAINT "student_owner_user_id_app_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_user_email_unique" ON "app_user" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "audit_event_student_created_idx" ON "audit_event" USING btree ("student_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_event_request_idx" ON "audit_event" USING btree ("request_correlation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "authorization_context_hash_unique" ON "authorization_context_snapshot" USING btree ("context_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "background_job_idempotency_unique" ON "background_job" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "background_job_status_created_idx" ON "background_job" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "evidence_locator_object_idx" ON "evidence_locator" USING btree ("evidence_object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_object_storage_version_unique" ON "evidence_object" USING btree ("storage_key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "source_document_domain_hash_version_unique" ON "source_document" USING btree ("data_domain","content_hash","version");--> statement-breakpoint
CREATE UNIQUE INDEX "student_authorization_user_student_unique" ON "student_authorization" USING btree ("user_id","student_id");--> statement-breakpoint
CREATE INDEX "student_fact_student_field_idx" ON "student_fact" USING btree ("student_id","field_key");--> statement-breakpoint
CREATE UNIQUE INDEX "student_public_code_unique" ON "student" USING btree ("public_code");--> statement-breakpoint
CREATE INDEX "student_owner_user_idx" ON "student" USING btree ("owner_user_id");
--> statement-breakpoint
CREATE FUNCTION "prevent_immutable_record_mutation"() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'immutable record cannot be %: %', lower(TG_OP), TG_TABLE_NAME
		USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "authorization_context_snapshot_immutable"
	BEFORE UPDATE OR DELETE ON "authorization_context_snapshot"
	FOR EACH ROW EXECUTE FUNCTION "prevent_immutable_record_mutation"();
--> statement-breakpoint
CREATE TRIGGER "source_document_immutable"
	BEFORE UPDATE OR DELETE ON "source_document"
	FOR EACH ROW EXECUTE FUNCTION "prevent_immutable_record_mutation"();
--> statement-breakpoint
CREATE TRIGGER "evidence_object_immutable"
	BEFORE UPDATE OR DELETE ON "evidence_object"
	FOR EACH ROW EXECUTE FUNCTION "prevent_immutable_record_mutation"();
--> statement-breakpoint
CREATE TRIGGER "evidence_locator_immutable"
	BEFORE UPDATE OR DELETE ON "evidence_locator"
	FOR EACH ROW EXECUTE FUNCTION "prevent_immutable_record_mutation"();
--> statement-breakpoint
CREATE TRIGGER "audit_event_append_only"
	BEFORE UPDATE OR DELETE ON "audit_event"
	FOR EACH ROW EXECUTE FUNCTION "prevent_immutable_record_mutation"();
--> statement-breakpoint
CREATE FUNCTION "validate_student_fact_supersedes_scope"() RETURNS trigger AS $$
DECLARE
	previous_student_id uuid;
BEGIN
	IF NEW."supersedes_id" IS NULL THEN
		RETURN NEW;
	END IF;

	SELECT "student_id" INTO previous_student_id
	FROM "student_fact"
	WHERE "id" = NEW."supersedes_id";

	IF previous_student_id IS NULL OR previous_student_id <> NEW."student_id" THEN
		RAISE EXCEPTION 'student fact may supersede only a fact from the same student'
			USING ERRCODE = '23514';
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "student_fact_supersedes_scope"
	BEFORE INSERT OR UPDATE OF "student_id", "supersedes_id" ON "student_fact"
	FOR EACH ROW EXECUTE FUNCTION "validate_student_fact_supersedes_scope"();
--> statement-breakpoint
CREATE FUNCTION "validate_fact_evidence_scope"() RETURNS trigger AS $$
DECLARE
	fact_student_id uuid;
	evidence_student_id uuid;
	evidence_domain "data_domain";
BEGIN
	SELECT "student_id" INTO fact_student_id
	FROM "student_fact"
	WHERE "id" = NEW."student_fact_id";

	SELECT object."student_id", object."data_domain"
	INTO evidence_student_id, evidence_domain
	FROM "evidence_locator" locator
	JOIN "evidence_object" object ON object."id" = locator."evidence_object_id"
	WHERE locator."id" = NEW."evidence_locator_id";

	IF fact_student_id IS NULL
		OR evidence_domain IS DISTINCT FROM 'student'::"data_domain"
		OR evidence_student_id IS DISTINCT FROM fact_student_id THEN
		RAISE EXCEPTION 'student fact evidence must belong to the same student data domain'
			USING ERRCODE = '23514';
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "fact_evidence_scope"
	BEFORE INSERT OR UPDATE OF "student_fact_id", "evidence_locator_id" ON "fact_evidence"
	FOR EACH ROW EXECUTE FUNCTION "validate_fact_evidence_scope"();
