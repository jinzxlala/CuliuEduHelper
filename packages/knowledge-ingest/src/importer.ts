import type { DatabaseClient, DatabaseConnection } from "@culiu/database";
import {
  KnowledgeDocumentSetSchema,
  type CaseDocument,
  type KnowledgeDocumentSet,
  type KnowledgeIndexRebuildResult,
  type LectureDocument,
} from "@culiu/search";
import type { ImmutableObjectStore, StoredObjectReference } from "@culiu/storage";

import type { SourceFile } from "./contracts.js";
import {
  describeImportFailure,
  KnowledgeImportError,
  type KnowledgeImportStage,
} from "./import-errors.js";
import { policyForRole } from "./mappings.js";
import {
  loadKnowledgeImport,
  type LoadedKnowledgeImport,
  type LoadedKnowledgeSource,
  type SourceRootMap,
} from "./source-loader.js";

export interface KnowledgeIndexPublisher {
  rebuildKnowledgeIndexes(documents: KnowledgeDocumentSet): Promise<KnowledgeIndexRebuildResult>;
}

export interface KnowledgeImportRequest {
  readonly actorUserId: string;
  readonly backgroundJobId?: string;
  readonly corpusHash: string;
  readonly corpusId: string;
  readonly manifestVersion: string;
  readonly mappingVersion: string;
  readonly expectedLectureCount?: number;
  readonly publicationMode?: "replace" | "upsert";
}

export interface KnowledgeImporterOptions {
  readonly databaseClient: DatabaseClient;
  readonly indexPublisher: KnowledgeIndexPublisher;
  readonly loadImport?: typeof loadKnowledgeImport;
  readonly manifestPath: string;
  readonly objectStore: ImmutableObjectStore;
  readonly sourceRoots: SourceRootMap;
}

export interface KnowledgeImportResult {
  readonly batchId: string;
  readonly documentCounts: {
    readonly cases: number;
    readonly lectures: number;
    readonly transcriptSegments: 0;
  };
  readonly status: "already_imported" | "published";
}

interface BatchRow {
  readonly case_count: number;
  readonly id: string;
  readonly is_current: boolean;
  readonly lecture_count: number;
  readonly status: "failed" | "published" | "publishing" | "staging";
  readonly transcript_segment_count: number;
}

interface AttemptRow {
  readonly attempt_number: number;
  readonly id: string;
}

interface StoredSource {
  readonly loaded: LoadedKnowledgeSource;
  readonly reference: StoredObjectReference;
}

interface SourceRecordRow {
  readonly content_hash: string;
  readonly document_type: string;
  readonly id: string;
  readonly mime_type: string;
}

interface EvidenceRecordRow {
  readonly content_hash: string;
  readonly id: string;
  readonly storage_key: string;
}

interface StagedAttempt {
  readonly attemptId: string;
  readonly batchId: string;
  readonly documentCounts: KnowledgeImportResult["documentCounts"];
  readonly noOp: boolean;
}

interface PublishedLectureRow {
  readonly ai_cross_disciplinary_text: string;
  readonly failure_text: string;
  readonly lecture_date: Date | string | null;
  readonly lecture_id: string;
  readonly majors: string[];
  readonly organization: string | null;
  readonly schools: string[];
  readonly source_path: string;
  readonly speakers: string[];
  readonly summary: string;
  readonly title: string;
  readonly trend_text: string;
}

function publishedDate(value: Date | string | null): string | null {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value;
}

interface PublishedCaseRow {
  readonly academic_label: string;
  readonly activity_types: string[];
  readonly admission_result: string;
  readonly ai_depth: string | null;
  readonly ai_domains: string[];
  readonly background: string;
  readonly case_id: string;
  readonly case_type: string;
  readonly confidence: CaseDocument["confidence"];
  readonly curriculum_system: string | null;
  readonly evidence_boundary: string;
  readonly lecture_id: string;
  readonly major: string | null;
  readonly research_methods: string[];
  readonly schools: string[];
  readonly timestamp_refs: CaseDocument["timestamp_refs"];
}

async function transaction<T>(connection: DatabaseConnection, work: () => Promise<T>): Promise<T> {
  await connection.query("begin");
  try {
    const result = await work();
    await connection.query("commit");
    return result;
  } catch (error) {
    await connection.query("rollback");
    throw error;
  }
}

function lockKey(): string {
  return "knowledge-import:publication";
}

async function loadCurrentPublishedDocuments(
  connection: DatabaseConnection,
): Promise<KnowledgeDocumentSet> {
  const batchResult = await connection.query<{ id: string }>(
    `select id from knowledge_import_batch
      where is_current = true and status = 'published'
      limit 1`,
  );
  const batchId = batchResult.rows[0]?.id;
  if (batchId === undefined) {
    return { cases: [], lectures: [], transcriptSegments: [] };
  }

  const lectureResult = await connection.query<PublishedLectureRow>(
    `select lecture_id, title, summary, trend_text, ai_cross_disciplinary_text,
            failure_text, lecture_date, organization, speakers, schools, majors, source_path
       from knowledge_lecture_version
      where batch_id = $1
      order by lecture_id`,
    [batchId],
  );
  const caseResult = await connection.query<PublishedCaseRow>(
    `select case_id, lecture_id, case_type, curriculum_system, academic_label,
            background, admission_result, schools, major, research_methods,
            activity_types, ai_domains, ai_depth, confidence, evidence_boundary,
            timestamp_refs
       from knowledge_case_version
      where batch_id = $1
      order by case_id`,
    [batchId],
  );

  return {
    cases: caseResult.rows.map((row) => ({
      academic_label: row.academic_label,
      activity_types: row.activity_types,
      admission_result: row.admission_result,
      ai_depth: row.ai_depth,
      ai_domains: row.ai_domains,
      background: row.background,
      case_id: row.case_id,
      case_type: row.case_type,
      confidence: row.confidence,
      curriculum_system: row.curriculum_system,
      evidence_boundary: row.evidence_boundary,
      lecture_id: row.lecture_id,
      major: row.major,
      research_methods: row.research_methods,
      schools: row.schools,
      timestamp_refs: row.timestamp_refs,
    })),
    lectures: lectureResult.rows.map((row) => ({
      ai_cross_disciplinary_text: row.ai_cross_disciplinary_text,
      date: publishedDate(row.lecture_date),
      failure_text: row.failure_text,
      lecture_id: row.lecture_id,
      majors: row.majors,
      organization: row.organization,
      schools: row.schools,
      source_path: row.source_path,
      speakers: row.speakers,
      summary: row.summary,
      title: row.title,
      trend_text: row.trend_text,
    })),
    transcriptSegments: [],
  };
}

async function beginAttempt(
  connection: DatabaseConnection,
  request: KnowledgeImportRequest,
): Promise<StagedAttempt> {
  return transaction(connection, async () => {
    const actor = await connection.query<{ id: string }>(
      `select id from app_user
        where id = $1 and active = true and role in ('admin', 'service')`,
      [request.actorUserId],
    );
    if (actor.rowCount !== 1) {
      throw new KnowledgeImportError(
        "authorization_denied",
        "authorization",
        "Knowledge import actor must be an active admin or service identity.",
      );
    }
    await connection.query(
      `insert into knowledge_import_batch
        (corpus_id, corpus_hash, manifest_version, mapping_version, expected_lecture_count)
       values ($1, $2, $3, $4, $5)
       on conflict (corpus_id, corpus_hash, mapping_version, manifest_version) do nothing`,
      [
        request.corpusId,
        request.corpusHash,
        request.manifestVersion,
        request.mappingVersion,
        request.expectedLectureCount ?? 1,
      ],
    );
    const batchResult = await connection.query<BatchRow>(
      `select id, status, is_current, lecture_count, case_count, transcript_segment_count
         from knowledge_import_batch
        where corpus_id = $1 and corpus_hash = $2 and mapping_version = $3
          and manifest_version = $4
         for update`,
      [request.corpusId, request.corpusHash, request.mappingVersion, request.manifestVersion],
    );
    const batch = batchResult.rows[0];
    if (batch === undefined) {
      throw new KnowledgeImportError(
        "database_failed",
        "database",
        "Import batch could not be created or selected.",
      );
    }
    if (batch.status === "published") {
      if (batch.transcript_segment_count !== 0) {
        throw new KnowledgeImportError(
          "database_failed",
          "database",
          "Published import violates the transcript privacy gate.",
        );
      }
      return {
        attemptId: "",
        batchId: batch.id,
        documentCounts: {
          cases: batch.case_count,
          lectures: batch.lecture_count,
          transcriptSegments: 0,
        },
        noOp: true,
      };
    }

    await connection.query(
      `update knowledge_import_attempt
          set status = 'failed',
              stage = 'database',
              error_code = 'retry_superseded',
              failure_summary = 'Previous running attempt was superseded by a controlled retry.',
              completed_at = now()
        where batch_id = $1 and status = 'running'`,
      [batch.id],
    );
    const attemptResult = await connection.query<AttemptRow>(
      `insert into knowledge_import_attempt
        (batch_id, background_job_id, attempt_number)
       select $1, $2, coalesce(max(attempt_number), 0) + 1
         from knowledge_import_attempt
        where batch_id = $1
       returning id, attempt_number`,
      [batch.id, request.backgroundJobId ?? null],
    );
    const attempt = attemptResult.rows[0];
    if (attempt === undefined) {
      throw new KnowledgeImportError(
        "database_failed",
        "database",
        "Import attempt could not be created.",
      );
    }
    await connection.query(
      `update knowledge_import_batch
          set status = 'staging', is_current = false, published_at = null, updated_at = now()
        where id = $1`,
      [batch.id],
    );
    return {
      attemptId: attempt.id,
      batchId: batch.id,
      documentCounts: { cases: 0, lectures: 0, transcriptSegments: 0 },
      noOp: false,
    };
  });
}

async function updateAttemptStage(
  connection: DatabaseConnection,
  attemptId: string,
  stage: KnowledgeImportStage,
): Promise<void> {
  await connection.query(
    `update knowledge_import_attempt set stage = $2 where id = $1 and status = 'running'`,
    [attemptId, stage],
  );
}

async function recordFailure(
  connection: DatabaseConnection,
  batchId: string,
  attemptId: string,
  error: unknown,
  fallbackStage: KnowledgeImportStage,
): Promise<void> {
  const failure = describeImportFailure(error, fallbackStage);
  await transaction(connection, async () => {
    const attemptResult = await connection.query(
      `update knowledge_import_attempt
          set status = 'failed', stage = $2, error_code = $3, error_source_key = $4,
              error_source_role = $5, failure_summary = $6, completed_at = now()
        where id = $1 and status = 'running'`,
      [
        attemptId,
        failure.stage,
        failure.code,
        failure.sourceKey ?? null,
        failure.sourceRole ?? null,
        failure.summary,
      ],
    );
    if (attemptResult.rowCount !== 1) {
      throw new KnowledgeImportError(
        "database_failed",
        "database",
        "Import failure could not be attached to its running attempt.",
      );
    }
    await connection.query(
      `update knowledge_import_batch
          set status = 'failed', is_current = false, published_at = null, updated_at = now()
        where id = $1 and status <> 'published'`,
      [batchId],
    );
  });
}

async function storeSources(
  loaded: LoadedKnowledgeImport,
  objectStore: ImmutableObjectStore,
): Promise<StoredSource[]> {
  const stored: StoredSource[] = [];
  for (const source of loaded.sources) {
    let reference: StoredObjectReference;
    try {
      reference = await objectStore.store({
        content: new Uint8Array(source.bytes),
        domain: "knowledge",
      });
    } catch (error) {
      throw new KnowledgeImportError(
        "storage_failed",
        "storage",
        `${source.descriptor.logical_path}: immutable object storage failed.`,
        {
          cause: error,
          sourceKey: source.bundle.source_key,
          sourceRole: source.descriptor.role,
        },
      );
    }
    if (
      reference.sha256 !== source.descriptor.content_sha256 ||
      reference.size !== source.descriptor.bytes
    ) {
      throw new KnowledgeImportError(
        "storage_failed",
        "storage",
        `${source.descriptor.logical_path}: stored object reference failed integrity comparison.`,
        { sourceKey: source.bundle.source_key, sourceRole: source.descriptor.role },
      );
    }
    stored.push({ loaded: source, reference });
  }
  return stored;
}

async function sourceDocumentId(
  connection: DatabaseConnection,
  descriptor: SourceFile,
): Promise<string> {
  const policy = policyForRole(descriptor.role);
  await connection.query(
    `insert into source_document
      (data_domain, source_path, content_hash, document_type, mime_type)
     values ('knowledge', $1, $2, $3, $4)
     on conflict (data_domain, content_hash, version) do nothing`,
    [
      descriptor.logical_path,
      descriptor.content_sha256,
      policy.database_document_type,
      descriptor.mime_type,
    ],
  );
  const result = await connection.query<SourceRecordRow>(
    `select id, content_hash, document_type, mime_type
       from source_document
      where data_domain = 'knowledge' and content_hash = $1 and version = 1`,
    [descriptor.content_sha256],
  );
  const row = result.rows[0];
  if (
    row === undefined ||
    row.content_hash !== descriptor.content_sha256 ||
    row.document_type !== policy.database_document_type ||
    row.mime_type !== descriptor.mime_type
  ) {
    throw new KnowledgeImportError(
      "database_failed",
      "database",
      `${descriptor.logical_path}: immutable source metadata collision.`,
      { sourceRole: descriptor.role },
    );
  }
  return row.id;
}

async function evidenceObjectId(
  connection: DatabaseConnection,
  descriptor: SourceFile,
  reference: StoredObjectReference,
  actorUserId: string,
): Promise<string> {
  const accessLevel = descriptor.role === "analysis_markdown" ? "internal" : "restricted";
  await connection.query(
    `insert into evidence_object
      (data_domain, content_hash, storage_key, uploaded_by_user_id, access_level)
     values ('knowledge', $1, $2, $3, $4)
     on conflict (storage_key, version) do nothing`,
    [reference.sha256, reference.key, actorUserId, accessLevel],
  );
  const result = await connection.query<EvidenceRecordRow>(
    `select id, content_hash, storage_key
       from evidence_object
      where storage_key = $1 and version = 1`,
    [reference.key],
  );
  const row = result.rows[0];
  if (
    row === undefined ||
    row.content_hash !== reference.sha256 ||
    row.storage_key !== reference.key
  ) {
    throw new KnowledgeImportError(
      "database_failed",
      "database",
      `${descriptor.logical_path}: immutable evidence metadata collision.`,
      { sourceRole: descriptor.role },
    );
  }
  return row.id;
}

async function insertLecture(
  connection: DatabaseConnection,
  batchId: string,
  sourceId: string,
  document: LectureDocument,
): Promise<void> {
  await connection.query(
    `insert into knowledge_lecture_version
      (batch_id, lecture_id, source_document_id, title, summary, trend_text,
       ai_cross_disciplinary_text, failure_text, lecture_date, organization, speakers,
       schools, majors, source_path)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      batchId,
      document.lecture_id,
      sourceId,
      document.title,
      document.summary,
      document.trend_text,
      document.ai_cross_disciplinary_text,
      document.failure_text,
      document.date,
      document.organization,
      document.speakers,
      document.schools,
      document.majors,
      document.source_path,
    ],
  );
}

async function insertCase(
  connection: DatabaseConnection,
  batchId: string,
  sourceId: string,
  document: CaseDocument,
): Promise<void> {
  await connection.query(
    `insert into knowledge_case_version
      (batch_id, case_id, lecture_id, source_document_id, case_type, curriculum_system,
       academic_label, background, admission_result, schools, major, research_methods,
       activity_types, ai_domains, ai_depth, confidence, evidence_boundary, timestamp_refs)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
    [
      batchId,
      document.case_id,
      document.lecture_id,
      sourceId,
      document.case_type,
      document.curriculum_system,
      document.academic_label,
      document.background,
      document.admission_result,
      document.schools,
      document.major,
      document.research_methods,
      document.activity_types,
      document.ai_domains,
      document.ai_depth,
      document.confidence,
      document.evidence_boundary,
      JSON.stringify(document.timestamp_refs),
    ],
  );
}

async function persistStagedImport(
  connection: DatabaseConnection,
  batchId: string,
  actorUserId: string,
  loaded: LoadedKnowledgeImport,
  storedSources: readonly StoredSource[],
  publishedDocuments: KnowledgeDocumentSet,
  options: { currentBatchId?: string; publicationMode: "replace" | "upsert" },
): Promise<void> {
  await transaction(connection, async () => {
    await connection.query("delete from knowledge_case_version where batch_id = $1", [batchId]);
    await connection.query("delete from knowledge_lecture_version where batch_id = $1", [batchId]);
    await connection.query("delete from knowledge_import_source where batch_id = $1", [batchId]);

    const incomingLectureIds = loaded.documents.lectures.map((lecture) => lecture.lecture_id);
    const incomingLogicalPaths = loaded.sources.map((source) => source.descriptor.logical_path);
    if (options.publicationMode === "upsert" && options.currentBatchId !== undefined) {
      await connection.query(
        `insert into knowledge_import_source
          (batch_id, data_domain, lecture_id, source_role, source_document_id,
           evidence_object_id, source_key, logical_path, root_id, byte_count)
         select $1, data_domain, lecture_id, source_role, source_document_id,
                evidence_object_id, source_key, logical_path, root_id, byte_count
           from knowledge_import_source
          where batch_id = $2 and not (logical_path = any($3::text[]))`,
        [batchId, options.currentBatchId, incomingLogicalPaths],
      );
      await connection.query(
        `insert into knowledge_lecture_version
          (batch_id, data_domain, lecture_id, source_document_id, title, summary, trend_text,
           ai_cross_disciplinary_text, failure_text, lecture_date, organization, speakers,
           schools, majors, source_path)
         select $1, data_domain, lecture_id, source_document_id, title, summary, trend_text,
                ai_cross_disciplinary_text, failure_text, lecture_date, organization, speakers,
                schools, majors, source_path
           from knowledge_lecture_version
          where batch_id = $2 and not (lecture_id = any($3::text[]))`,
        [batchId, options.currentBatchId, incomingLectureIds],
      );
      await connection.query(
        `insert into knowledge_case_version
          (batch_id, data_domain, case_id, lecture_id, source_document_id, case_type,
           curriculum_system, academic_label, background, admission_result, schools, major,
           research_methods, activity_types, ai_domains, ai_depth, confidence,
           evidence_boundary, timestamp_refs)
         select $1, data_domain, case_id, lecture_id, source_document_id, case_type,
                curriculum_system, academic_label, background, admission_result, schools, major,
                research_methods, activity_types, ai_domains, ai_depth, confidence,
                evidence_boundary, timestamp_refs
           from knowledge_case_version
          where batch_id = $2 and not (lecture_id = any($3::text[]))`,
        [batchId, options.currentBatchId, incomingLectureIds],
      );
    }

    const analysisSourceByLecture = new Map<string, string>();
    for (const source of storedSources) {
      const descriptor = source.loaded.descriptor;
      const sourceId = await sourceDocumentId(connection, descriptor);
      const evidenceId = await evidenceObjectId(
        connection,
        descriptor,
        source.reference,
        actorUserId,
      );
      await connection.query(
        `insert into knowledge_import_source
          (batch_id, lecture_id, source_role, source_document_id, evidence_object_id,
           source_key, logical_path, root_id, byte_count)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          batchId,
          source.loaded.bundle.lecture_id,
          descriptor.role,
          sourceId,
          evidenceId,
          source.loaded.bundle.source_key,
          descriptor.logical_path,
          descriptor.root_id,
          descriptor.bytes,
        ],
      );
      if (descriptor.role === "analysis_markdown") {
        analysisSourceByLecture.set(source.loaded.bundle.lecture_id, sourceId);
      }
    }

    for (const lecture of loaded.documents.lectures) {
      const sourceId = analysisSourceByLecture.get(lecture.lecture_id);
      if (sourceId === undefined) {
        throw new KnowledgeImportError(
          "database_failed",
          "database",
          `${lecture.lecture_id}: analysis source relation is missing.`,
        );
      }
      await insertLecture(connection, batchId, sourceId, lecture);
    }
    for (const caseDocument of loaded.documents.cases) {
      const sourceId = analysisSourceByLecture.get(caseDocument.lecture_id);
      if (sourceId === undefined) {
        throw new KnowledgeImportError(
          "database_failed",
          "database",
          `${caseDocument.case_id}: analysis source relation is missing.`,
        );
      }
      await insertCase(connection, batchId, sourceId, caseDocument);
    }

    await connection.query(
      `update knowledge_import_batch
          set status = 'publishing', expected_lecture_count = $2,
              lecture_count = $2, case_count = $3,
              transcript_segment_count = 0, transcript_publication_approved = false,
              updated_at = now()
        where id = $1`,
      [batchId, publishedDocuments.lectures.length, publishedDocuments.cases.length],
    );
  });
}

function mergeKnowledgeDocuments(
  current: KnowledgeDocumentSet,
  incoming: KnowledgeDocumentSet,
): KnowledgeDocumentSet {
  const replacedLectureIds = new Set(incoming.lectures.map((lecture) => lecture.lecture_id));
  return KnowledgeDocumentSetSchema.parse({
    cases: [
      ...current.cases.filter((item) => !replacedLectureIds.has(item.lecture_id)),
      ...incoming.cases,
    ],
    lectures: [
      ...current.lectures.filter((item) => !replacedLectureIds.has(item.lecture_id)),
      ...incoming.lectures,
    ],
    transcriptSegments: [],
  });
}

async function finalizeImport(
  connection: DatabaseConnection,
  batchId: string,
  attemptId: string,
): Promise<void> {
  await transaction(connection, async () => {
    await connection.query(
      "update knowledge_import_batch set is_current = false, updated_at = now() where is_current = true and id <> $1",
      [batchId],
    );
    const result = await connection.query(
      `update knowledge_import_batch
          set status = 'published', is_current = true, published_at = now(), updated_at = now()
        where id = $1 and status = 'publishing'`,
      [batchId],
    );
    if (result.rowCount !== 1) {
      throw new KnowledgeImportError(
        "database_failed",
        "finalize",
        "Import batch was not in the publishing state during finalization.",
      );
    }
    const completedAttempt = await connection.query(
      `update knowledge_import_attempt
          set status = 'succeeded', stage = 'complete', completed_at = now()
        where id = $1 and status = 'running'`,
      [attemptId],
    );
    if (completedAttempt.rowCount !== 1) {
      throw new KnowledgeImportError(
        "database_failed",
        "finalize",
        "Import attempt was not running during finalization.",
      );
    }
  });
}

function publishedResult(batchId: string, documents: KnowledgeDocumentSet): KnowledgeImportResult {
  return {
    batchId,
    documentCounts: {
      cases: documents.cases.length,
      lectures: documents.lectures.length,
      transcriptSegments: 0,
    },
    status: "published",
  };
}

export class KnowledgeImporter {
  readonly #databaseClient: DatabaseClient;
  readonly #indexPublisher: KnowledgeIndexPublisher;
  readonly #loadImport: typeof loadKnowledgeImport;
  readonly #manifestPath: string;
  readonly #objectStore: ImmutableObjectStore;
  readonly #sourceRoots: SourceRootMap;

  public constructor(options: KnowledgeImporterOptions) {
    this.#databaseClient = options.databaseClient;
    this.#indexPublisher = options.indexPublisher;
    this.#loadImport = options.loadImport ?? loadKnowledgeImport;
    this.#manifestPath = options.manifestPath;
    this.#objectStore = options.objectStore;
    this.#sourceRoots = options.sourceRoots;
  }

  async #reconcileCurrentPublication(connection: DatabaseConnection): Promise<void> {
    const documents = await loadCurrentPublishedDocuments(connection);
    await this.#indexPublisher.rebuildKnowledgeIndexes(documents);
  }

  public async reconcileCurrentPublication(): Promise<void> {
    const connection = await this.#databaseClient.pool.connect();
    try {
      await connection.query("select pg_advisory_lock(hashtext($1))", [lockKey()]);
      await this.#reconcileCurrentPublication(connection);
    } finally {
      await connection
        .query("select pg_advisory_unlock(hashtext($1))", [lockKey()])
        .catch(() => undefined);
      connection.release();
    }
  }

  public async import(request: KnowledgeImportRequest): Promise<KnowledgeImportResult> {
    return this.#executeImport(request, () =>
      this.#loadImport({
        expectedCorpusHash: request.corpusHash,
        expectedCorpusId: request.corpusId,
        expectedManifestVersion: request.manifestVersion,
        expectedMappingVersion: request.mappingVersion,
        manifestPath: this.#manifestPath,
        sourceRoots: this.#sourceRoots,
      }),
    );
  }

  public async importLoaded(
    request: KnowledgeImportRequest,
    loaded: LoadedKnowledgeImport,
  ): Promise<KnowledgeImportResult> {
    return this.#executeImport(request, () => Promise.resolve(loaded));
  }

  async #executeImport(
    request: KnowledgeImportRequest,
    load: () => Promise<LoadedKnowledgeImport>,
  ): Promise<KnowledgeImportResult> {
    const connection = await this.#databaseClient.pool.connect();
    let searchPublished = false;
    let staged: StagedAttempt | undefined;
    let stage: KnowledgeImportStage = "database";
    try {
      await connection.query("select pg_advisory_lock(hashtext($1))", [lockKey()]);
      staged = await beginAttempt(connection, request);
      if (staged.noOp) {
        return {
          batchId: staged.batchId,
          documentCounts: staged.documentCounts,
          status: "already_imported",
        };
      }

      stage = "validation";
      await updateAttemptStage(connection, staged.attemptId, stage);
      const loaded = await load();
      const publicationMode = request.publicationMode ?? "replace";
      const currentBatch = await connection.query<{ id: string }>(
        "select id from knowledge_import_batch where is_current = true and status = 'published' limit 1",
      );
      const currentBatchId = currentBatch.rows[0]?.id;
      const publishedDocuments =
        publicationMode === "upsert"
          ? mergeKnowledgeDocuments(
              await loadCurrentPublishedDocuments(connection),
              loaded.documents,
            )
          : loaded.documents;

      stage = "storage";
      await updateAttemptStage(connection, staged.attemptId, stage);
      const storedSources = await storeSources(loaded, this.#objectStore);

      stage = "database";
      await updateAttemptStage(connection, staged.attemptId, stage);
      await persistStagedImport(
        connection,
        staged.batchId,
        request.actorUserId,
        loaded,
        storedSources,
        publishedDocuments,
        {
          ...(currentBatchId === undefined ? {} : { currentBatchId }),
          publicationMode,
        },
      );

      stage = "search";
      await updateAttemptStage(connection, staged.attemptId, stage);
      try {
        await this.#indexPublisher.rebuildKnowledgeIndexes(publishedDocuments);
        searchPublished = true;
      } catch (error) {
        throw new KnowledgeImportError(
          "search_publication_failed",
          "search",
          "Atomic Meilisearch knowledge publication failed.",
          { cause: error },
        );
      }

      stage = "finalize";
      await updateAttemptStage(connection, staged.attemptId, stage);
      await finalizeImport(connection, staged.batchId, staged.attemptId);
      return publishedResult(staged.batchId, publishedDocuments);
    } catch (error) {
      if (staged !== undefined && !staged.noOp) {
        await recordFailure(connection, staged.batchId, staged.attemptId, error, stage).catch(
          () => undefined,
        );
      }
      if (searchPublished) {
        try {
          await this.#reconcileCurrentPublication(connection);
        } catch (reconciliationError) {
          throw new KnowledgeImportError(
            "search_publication_failed",
            "search",
            "Search publication rollback failed; startup reconciliation is required.",
            { cause: new AggregateError([error, reconciliationError]) },
          );
        }
      }
      throw error;
    } finally {
      await connection
        .query("select pg_advisory_unlock(hashtext($1))", [lockKey()])
        .catch(() => undefined);
      connection.release();
    }
  }
}
