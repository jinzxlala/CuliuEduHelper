CREATE FUNCTION "validate_catalog_version_initial_state"() RETURNS trigger AS $$
BEGIN
  IF NEW."status" <> 'draft'
    OR NEW."approved_by_user_id" IS NOT NULL
    OR NEW."approved_at" IS NOT NULL
    OR NEW."invalidation_reason" IS NOT NULL
  THEN
    RAISE EXCEPTION 'new course catalog versions must begin as drafts';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "course_version_initial_state_validate"
BEFORE INSERT ON "course_version"
FOR EACH ROW EXECUTE FUNCTION "validate_catalog_version_initial_state"();
--> statement-breakpoint
CREATE TRIGGER "course_rule_version_initial_state_validate"
BEFORE INSERT ON "course_rule_version"
FOR EACH ROW EXECUTE FUNCTION "validate_catalog_version_initial_state"();
--> statement-breakpoint
CREATE FUNCTION "validate_catalog_approval_metadata"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'draft' AND NEW."status" = 'archived'
    AND (NEW."approved_by_user_id" IS NOT NULL OR NEW."approved_at" IS NOT NULL)
  THEN
    RAISE EXCEPTION 'an unapproved draft cannot gain approval metadata while being archived';
  END IF;
  IF OLD."status" = 'approved' AND (
    NEW."approved_by_user_id" IS DISTINCT FROM OLD."approved_by_user_id"
    OR NEW."approved_at" IS DISTINCT FROM OLD."approved_at"
  ) THEN
    RAISE EXCEPTION 'approval metadata is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "course_version_approval_metadata_validate"
BEFORE UPDATE ON "course_version"
FOR EACH ROW EXECUTE FUNCTION "validate_catalog_approval_metadata"();
--> statement-breakpoint
CREATE TRIGGER "course_rule_version_approval_metadata_validate"
BEFORE UPDATE ON "course_rule_version"
FOR EACH ROW EXECUTE FUNCTION "validate_catalog_approval_metadata"();
--> statement-breakpoint
CREATE FUNCTION "reject_catalog_version_delete"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'course catalog versions cannot be deleted';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "course_version_delete_reject"
BEFORE DELETE ON "course_version"
FOR EACH ROW EXECUTE FUNCTION "reject_catalog_version_delete"();
--> statement-breakpoint
CREATE TRIGGER "course_rule_version_delete_reject"
BEFORE DELETE ON "course_rule_version"
FOR EACH ROW EXECUTE FUNCTION "reject_catalog_version_delete"();
