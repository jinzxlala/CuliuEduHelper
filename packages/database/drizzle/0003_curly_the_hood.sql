ALTER TABLE "knowledge_case_version" DROP CONSTRAINT "knowledge_case_version_source_document_id_source_document_id_fk";
--> statement-breakpoint
ALTER TABLE "knowledge_import_source" DROP CONSTRAINT "knowledge_import_source_source_document_id_source_document_id_fk";
--> statement-breakpoint
ALTER TABLE "knowledge_import_source" DROP CONSTRAINT "knowledge_import_source_evidence_object_id_evidence_object_id_fk";
--> statement-breakpoint
ALTER TABLE "knowledge_lecture_version" DROP CONSTRAINT "knowledge_lecture_version_source_document_id_source_document_id_fk";
--> statement-breakpoint
DROP INDEX "knowledge_import_batch_identity_unique";--> statement-breakpoint
ALTER TABLE "knowledge_case_version" ADD COLUMN "data_domain" "data_domain" DEFAULT 'knowledge' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_import_source" ADD COLUMN "data_domain" "data_domain" DEFAULT 'knowledge' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_lecture_version" ADD COLUMN "data_domain" "data_domain" DEFAULT 'knowledge' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_object_id_domain_unique" ON "evidence_object" USING btree ("id","data_domain");--> statement-breakpoint
CREATE UNIQUE INDEX "source_document_id_domain_unique" ON "source_document" USING btree ("id","data_domain");--> statement-breakpoint
ALTER TABLE "knowledge_case_version" ADD CONSTRAINT "knowledge_case_version_source_domain_fk" FOREIGN KEY ("source_document_id","data_domain") REFERENCES "public"."source_document"("id","data_domain") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_import_source" ADD CONSTRAINT "knowledge_import_source_document_domain_fk" FOREIGN KEY ("source_document_id","data_domain") REFERENCES "public"."source_document"("id","data_domain") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_import_source" ADD CONSTRAINT "knowledge_import_source_evidence_domain_fk" FOREIGN KEY ("evidence_object_id","data_domain") REFERENCES "public"."evidence_object"("id","data_domain") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_lecture_version" ADD CONSTRAINT "knowledge_lecture_version_source_domain_fk" FOREIGN KEY ("source_document_id","data_domain") REFERENCES "public"."source_document"("id","data_domain") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_import_batch_identity_unique" ON "knowledge_import_batch" USING btree ("corpus_id","corpus_hash","mapping_version","manifest_version");--> statement-breakpoint
ALTER TABLE "knowledge_case_version" ADD CONSTRAINT "knowledge_case_version_domain_check" CHECK ("knowledge_case_version"."data_domain" = 'knowledge');--> statement-breakpoint
ALTER TABLE "knowledge_import_source" ADD CONSTRAINT "knowledge_import_source_domain_check" CHECK ("knowledge_import_source"."data_domain" = 'knowledge');--> statement-breakpoint
ALTER TABLE "knowledge_lecture_version" ADD CONSTRAINT "knowledge_lecture_version_domain_check" CHECK ("knowledge_lecture_version"."data_domain" = 'knowledge');--> statement-breakpoint
CREATE FUNCTION "prevent_published_knowledge_mutation"() RETURNS trigger AS $$
DECLARE
	protected_batch_id uuid;
BEGIN
	IF TG_OP = 'INSERT' THEN
		protected_batch_id := NEW.batch_id;
	ELSIF TG_OP = 'DELETE' THEN
		protected_batch_id := OLD.batch_id;
	ELSE
		IF NEW.batch_id <> OLD.batch_id AND EXISTS (
			SELECT 1 FROM knowledge_import_batch
			WHERE id = NEW.batch_id AND status IN ('publishing', 'published')
		) THEN
			RAISE EXCEPTION 'published knowledge record cannot be moved into batch %', NEW.batch_id
				USING ERRCODE = '55000';
		END IF;
		protected_batch_id := OLD.batch_id;
	END IF;

	IF EXISTS (
		SELECT 1 FROM knowledge_import_batch
		WHERE id = protected_batch_id AND status IN ('publishing', 'published')
	) THEN
		RAISE EXCEPTION 'published knowledge record cannot be % in batch %', lower(TG_OP), protected_batch_id
			USING ERRCODE = '55000';
	END IF;

	IF TG_OP = 'DELETE' THEN
		RETURN OLD;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "knowledge_import_source_published_immutable"
	BEFORE INSERT OR UPDATE OR DELETE ON "knowledge_import_source"
	FOR EACH ROW EXECUTE FUNCTION "prevent_published_knowledge_mutation"();--> statement-breakpoint
CREATE TRIGGER "knowledge_lecture_version_published_immutable"
	BEFORE INSERT OR UPDATE OR DELETE ON "knowledge_lecture_version"
	FOR EACH ROW EXECUTE FUNCTION "prevent_published_knowledge_mutation"();--> statement-breakpoint
CREATE TRIGGER "knowledge_case_version_published_immutable"
	BEFORE INSERT OR UPDATE OR DELETE ON "knowledge_case_version"
	FOR EACH ROW EXECUTE FUNCTION "prevent_published_knowledge_mutation"();
