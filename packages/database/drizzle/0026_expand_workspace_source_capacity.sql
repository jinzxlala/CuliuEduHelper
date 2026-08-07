CREATE OR REPLACE FUNCTION "validate_knowledge_analysis_source"() RETURNS trigger AS $$
DECLARE
  source_count integer;
  batch_status knowledge_import_status;
  expected_content_hash text;
  prior_source knowledge_analysis_source%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id::text, 0));
  SELECT status INTO batch_status
  FROM knowledge_import_batch
  WHERE id = NEW.knowledge_batch_id;
  IF batch_status IS DISTINCT FROM 'published' THEN
    RAISE EXCEPTION 'knowledge workspace sources must use a published batch';
  END IF;

  IF NEW.source_type = 'lecture' THEN
    SELECT d.content_hash INTO expected_content_hash
    FROM knowledge_lecture_version v
    JOIN source_document d ON d.id = v.source_document_id
    WHERE v.batch_id = NEW.knowledge_batch_id AND v.lecture_id = NEW.source_id;
  ELSE
    SELECT d.content_hash INTO expected_content_hash
    FROM knowledge_case_version v
    JOIN source_document d ON d.id = v.source_document_id
    WHERE v.batch_id = NEW.knowledge_batch_id AND v.case_id = NEW.source_id;
  END IF;
  IF expected_content_hash IS NULL OR expected_content_hash <> NEW.content_hash THEN
    RAISE EXCEPTION 'knowledge workspace source content hash is invalid';
  END IF;

  IF NEW.supersedes_source_id IS NOT NULL THEN
    SELECT * INTO prior_source
    FROM knowledge_analysis_source
    WHERE id = NEW.supersedes_source_id;
    IF prior_source.id IS NULL OR prior_source.workspace_id <> NEW.workspace_id OR
       prior_source.source_type <> NEW.source_type OR prior_source.source_id <> NEW.source_id OR
       prior_source.removed_at IS NULL THEN
      RAISE EXCEPTION 'knowledge workspace source revision is invalid';
    END IF;
  END IF;

  SELECT count(*) INTO source_count
  FROM knowledge_analysis_source
  WHERE workspace_id = NEW.workspace_id AND removed_at IS NULL;
  IF source_count >= 500 THEN
    RAISE EXCEPTION 'knowledge workspace source limit exceeded';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
