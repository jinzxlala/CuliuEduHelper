ALTER TABLE "background_job" DROP CONSTRAINT "background_job_state_time_check";--> statement-breakpoint
ALTER TABLE "background_job" ADD COLUMN "claim_token" uuid;--> statement-breakpoint
ALTER TABLE "background_job" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
UPDATE "background_job"
   SET "status" = 'failed',
       "error_code" = 'migration_running_job_expired',
       "completed_at" = now()
 WHERE "status" = 'running';--> statement-breakpoint
CREATE INDEX "background_job_lease_idx" ON "background_job" USING btree ("status","lease_expires_at");--> statement-breakpoint
ALTER TABLE "background_job" ADD CONSTRAINT "background_job_state_time_check" CHECK (("background_job"."status" = 'queued' and "background_job"."started_at" is null and "background_job"."completed_at" is null and "background_job"."claim_token" is null and "background_job"."lease_expires_at" is null) or ("background_job"."status" = 'running' and "background_job"."started_at" is not null and "background_job"."completed_at" is null and "background_job"."claim_token" is not null and "background_job"."lease_expires_at" is not null) or ("background_job"."status" in ('succeeded', 'failed', 'canceled') and "background_job"."completed_at" is not null and "background_job"."claim_token" is null and "background_job"."lease_expires_at" is null));--> statement-breakpoint
CREATE FUNCTION "prevent_published_knowledge_batch_mutation"() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'DELETE' AND OLD.status = 'published' THEN
		RAISE EXCEPTION 'published knowledge batch cannot be deleted: %', OLD.id
			USING ERRCODE = '55000';
	END IF;

	IF TG_OP = 'UPDATE' AND OLD.status = 'published' THEN
		IF NEW.id IS DISTINCT FROM OLD.id
			OR NEW.corpus_id IS DISTINCT FROM OLD.corpus_id
			OR NEW.corpus_hash IS DISTINCT FROM OLD.corpus_hash
			OR NEW.manifest_version IS DISTINCT FROM OLD.manifest_version
			OR NEW.mapping_version IS DISTINCT FROM OLD.mapping_version
			OR NEW.status IS DISTINCT FROM OLD.status
			OR NEW.expected_lecture_count IS DISTINCT FROM OLD.expected_lecture_count
			OR NEW.lecture_count IS DISTINCT FROM OLD.lecture_count
			OR NEW.case_count IS DISTINCT FROM OLD.case_count
			OR NEW.transcript_segment_count IS DISTINCT FROM OLD.transcript_segment_count
			OR NEW.transcript_publication_approved IS DISTINCT FROM OLD.transcript_publication_approved
			OR NEW.created_at IS DISTINCT FROM OLD.created_at
			OR NEW.published_at IS DISTINCT FROM OLD.published_at
			OR (OLD.is_current = false AND NEW.is_current = true)
		THEN
			RAISE EXCEPTION 'published knowledge batch is immutable: %', OLD.id
				USING ERRCODE = '55000';
		END IF;
	END IF;

	IF TG_OP = 'DELETE' THEN
		RETURN OLD;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "knowledge_import_batch_published_immutable"
	BEFORE UPDATE OR DELETE ON "knowledge_import_batch"
	FOR EACH ROW EXECUTE FUNCTION "prevent_published_knowledge_batch_mutation"();
