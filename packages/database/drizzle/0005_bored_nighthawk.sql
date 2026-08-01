CREATE TABLE "evidence_invalidation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"evidence_object_id" uuid NOT NULL,
	"reason" varchar(512) NOT NULL,
	"invalidated_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_invalidation_reason_check" CHECK (char_length(trim("evidence_invalidation"."reason")) > 0)
);
--> statement-breakpoint
ALTER TABLE "evidence_object" ADD COLUMN "original_file_name" varchar(255) DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence_object" ADD COLUMN "mime_type" varchar(255) DEFAULT 'application/octet-stream' NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence_object" ADD COLUMN "byte_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence_object" ADD COLUMN "supersedes_id" uuid;--> statement-breakpoint
ALTER TABLE "student_fact" ADD COLUMN "access_level" "access_level" DEFAULT 'sensitive' NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence_invalidation" ADD CONSTRAINT "evidence_invalidation_evidence_object_id_evidence_object_id_fk" FOREIGN KEY ("evidence_object_id") REFERENCES "public"."evidence_object"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_invalidation" ADD CONSTRAINT "evidence_invalidation_invalidated_by_user_id_app_user_id_fk" FOREIGN KEY ("invalidated_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_invalidation_object_unique" ON "evidence_invalidation" USING btree ("evidence_object_id");--> statement-breakpoint
CREATE INDEX "evidence_invalidation_created_idx" ON "evidence_invalidation" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "evidence_object" ADD CONSTRAINT "evidence_object_supersedes_id_evidence_object_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."evidence_object"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evidence_object_student_created_idx" ON "evidence_object" USING btree ("student_id","created_at");--> statement-breakpoint
ALTER TABLE "evidence_object" ADD CONSTRAINT "evidence_object_byte_count_check" CHECK ("evidence_object"."byte_count" >= 0);--> statement-breakpoint
ALTER TABLE "evidence_object" ADD CONSTRAINT "evidence_object_not_self_superseding" CHECK ("evidence_object"."supersedes_id" is null or "evidence_object"."supersedes_id" <> "evidence_object"."id");
--> statement-breakpoint
CREATE TRIGGER "evidence_invalidation_immutable"
	BEFORE UPDATE OR DELETE ON "evidence_invalidation"
	FOR EACH ROW EXECUTE FUNCTION "prevent_immutable_record_mutation"();
--> statement-breakpoint
CREATE TRIGGER "fact_evidence_immutable"
	BEFORE UPDATE OR DELETE ON "fact_evidence"
	FOR EACH ROW EXECUTE FUNCTION "prevent_immutable_record_mutation"();
--> statement-breakpoint
CREATE FUNCTION "validate_evidence_invalidation_scope"() RETURNS trigger AS $$
DECLARE
	evidence_domain "data_domain";
BEGIN
	SELECT "data_domain" INTO evidence_domain
	FROM "evidence_object"
	WHERE "id" = NEW."evidence_object_id";

	IF evidence_domain IS DISTINCT FROM 'student'::"data_domain" THEN
		RAISE EXCEPTION 'only student evidence uses student evidence invalidation'
			USING ERRCODE = '23514';
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "evidence_invalidation_scope"
	BEFORE INSERT ON "evidence_invalidation"
	FOR EACH ROW EXECUTE FUNCTION "validate_evidence_invalidation_scope"();
--> statement-breakpoint
CREATE FUNCTION "validate_evidence_object_supersedes_scope"() RETURNS trigger AS $$
DECLARE
	previous_student_id uuid;
	previous_domain "data_domain";
	previous_version integer;
	previous_access_level "access_level";
BEGIN
	IF NEW."supersedes_id" IS NULL THEN
		IF NEW."version" <> 1 THEN
			RAISE EXCEPTION 'an initial evidence object must have version 1'
				USING ERRCODE = '23514';
		END IF;
		RETURN NEW;
	END IF;

	SELECT "student_id", "data_domain", "version", "access_level"
	INTO previous_student_id, previous_domain, previous_version, previous_access_level
	FROM "evidence_object"
	WHERE "id" = NEW."supersedes_id";

	IF previous_domain IS NULL
		OR previous_domain IS DISTINCT FROM NEW."data_domain"
		OR previous_student_id IS DISTINCT FROM NEW."student_id"
		OR NEW."version" <> previous_version + 1
		OR NEW."access_level" < previous_access_level THEN
		RAISE EXCEPTION 'evidence may supersede only the immediately prior version in the same scope without lowering access'
			USING ERRCODE = '23514';
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "evidence_object_supersedes_scope"
	BEFORE INSERT ON "evidence_object"
	FOR EACH ROW EXECUTE FUNCTION "validate_evidence_object_supersedes_scope"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "validate_student_fact_supersedes_scope"() RETURNS trigger AS $$
DECLARE
	previous_student_id uuid;
	previous_field_key varchar(128);
	previous_access_level "access_level";
BEGIN
	IF NEW."supersedes_id" IS NULL THEN
		RETURN NEW;
	END IF;

	SELECT "student_id", "field_key", "access_level"
	INTO previous_student_id, previous_field_key, previous_access_level
	FROM "student_fact"
	WHERE "id" = NEW."supersedes_id";

	IF previous_student_id IS NULL
		OR previous_student_id <> NEW."student_id"
		OR previous_field_key <> NEW."field_key"
		OR NEW."access_level" < previous_access_level THEN
		RAISE EXCEPTION 'student fact may supersede only the same field for the same student without lowering access'
			USING ERRCODE = '23514';
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "protect_student_fact_version"() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'student fact versions cannot be deleted'
			USING ERRCODE = '55000';
	END IF;

	IF NEW."student_id" IS DISTINCT FROM OLD."student_id"
		OR NEW."field_key" IS DISTINCT FROM OLD."field_key"
		OR NEW."value" IS DISTINCT FROM OLD."value"
		OR NEW."access_level" IS DISTINCT FROM OLD."access_level"
		OR NEW."source_type" IS DISTINCT FROM OLD."source_type"
		OR NEW."valid_from" IS DISTINCT FROM OLD."valid_from"
		OR NEW."supersedes_id" IS DISTINCT FROM OLD."supersedes_id"
		OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
		RAISE EXCEPTION 'student fact version content is immutable'
			USING ERRCODE = '55000';
	END IF;

	IF OLD."confirmation_status" = 'superseded'
		OR OLD."valid_to" IS NOT NULL
		OR NOT (
			NEW."confirmation_status" = OLD."confirmation_status"
			OR (OLD."confirmation_status" = 'unconfirmed' AND NEW."confirmation_status" IN ('confirmed', 'rejected', 'superseded'))
			OR (OLD."confirmation_status" IN ('confirmed', 'rejected') AND NEW."confirmation_status" = 'superseded')
		)
		OR (NEW."confirmation_status" = 'superseded' AND NEW."valid_to" IS NULL)
		OR (NEW."confirmation_status" <> 'superseded' AND NEW."valid_to" IS NOT NULL) THEN
		RAISE EXCEPTION 'invalid student fact status transition'
			USING ERRCODE = '23514';
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "student_fact_version_protection"
	BEFORE UPDATE OR DELETE ON "student_fact"
	FOR EACH ROW EXECUTE FUNCTION "protect_student_fact_version"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "validate_fact_evidence_scope"() RETURNS trigger AS $$
DECLARE
	fact_student_id uuid;
	fact_access_level "access_level";
	evidence_student_id uuid;
	evidence_domain "data_domain";
	evidence_access_level "access_level";
	target_evidence_object_id uuid;
BEGIN
	SELECT "student_id", "access_level"
	INTO fact_student_id, fact_access_level
	FROM "student_fact"
	WHERE "id" = NEW."student_fact_id";

	SELECT object."id", object."student_id", object."data_domain", object."access_level"
	INTO target_evidence_object_id, evidence_student_id, evidence_domain, evidence_access_level
	FROM "evidence_locator" locator
	JOIN "evidence_object" object ON object."id" = locator."evidence_object_id"
	WHERE locator."id" = NEW."evidence_locator_id";

	IF fact_student_id IS NULL
		OR evidence_domain IS DISTINCT FROM 'student'::"data_domain"
		OR evidence_student_id IS DISTINCT FROM fact_student_id
		OR evidence_access_level > fact_access_level
		OR EXISTS (
			SELECT 1 FROM "evidence_invalidation" invalidation
			WHERE invalidation."evidence_object_id" = target_evidence_object_id
		)
		OR EXISTS (
			SELECT 1 FROM "evidence_object" newer_evidence
			WHERE newer_evidence."supersedes_id" = target_evidence_object_id
		) THEN
		RAISE EXCEPTION 'student fact evidence must be current, valid, accessible, and belong to the same student data domain'
			USING ERRCODE = '23514';
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
