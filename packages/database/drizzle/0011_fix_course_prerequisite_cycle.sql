CREATE OR REPLACE FUNCTION "validate_approved_course_rule"() RETURNS trigger AS $$
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
    SELECT EXISTS(
      SELECT 1 FROM reach
      JOIN edges ON edges.subject_id = reach.node_id
      WHERE edges.required_id = NEW."subject_course_id"
    ) INTO has_cycle;
    IF has_cycle THEN
      RAISE EXCEPTION 'prerequisite rules cannot contain a cycle';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
