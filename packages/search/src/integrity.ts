import {
  KnowledgeDocumentSetSchema,
  type CaseDocument,
  type KnowledgeDocumentSet,
  type TranscriptSegmentDocument,
} from "./documents.js";

export class KnowledgeDocumentIntegrityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "KnowledgeDocumentIntegrityError";
  }
}

function assertUniqueIds<TDocument>(
  documents: readonly TDocument[],
  idOf: (document: TDocument) => string,
  label: string,
): void {
  const ids = new Set<string>();
  for (const document of documents) {
    const id = idOf(document);
    if (ids.has(id)) {
      throw new KnowledgeDocumentIntegrityError(`Duplicate ${label} identifier: ${id}`);
    }
    ids.add(id);
  }
}

function validateCaseReferences(
  caseDocument: CaseDocument,
  lectureIds: ReadonlySet<string>,
  segmentById: ReadonlyMap<string, TranscriptSegmentDocument>,
): void {
  if (!lectureIds.has(caseDocument.lecture_id)) {
    throw new KnowledgeDocumentIntegrityError(
      `Case ${caseDocument.case_id} references missing lecture ${caseDocument.lecture_id}.`,
    );
  }

  for (const reference of caseDocument.timestamp_refs) {
    const segment = segmentById.get(reference.segment_id);
    if (segment === undefined) {
      throw new KnowledgeDocumentIntegrityError(
        `Case ${caseDocument.case_id} references missing segment ${reference.segment_id}.`,
      );
    }
    if (
      segment.lecture_id !== caseDocument.lecture_id ||
      segment.source_path !== reference.source_path ||
      !segment.case_ids.includes(caseDocument.case_id) ||
      reference.start_seconds < segment.start_seconds ||
      reference.end_seconds > segment.end_seconds
    ) {
      throw new KnowledgeDocumentIntegrityError(
        `Case ${caseDocument.case_id} has a timestamp outside its referenced segment.`,
      );
    }
  }
}

export function validateKnowledgeDocumentSet(untrustedInput: unknown): KnowledgeDocumentSet {
  const documents = KnowledgeDocumentSetSchema.parse(untrustedInput);

  assertUniqueIds(documents.lectures, (document) => document.lecture_id, "lecture");
  assertUniqueIds(documents.cases, (document) => document.case_id, "case");
  assertUniqueIds(
    documents.transcriptSegments,
    (document) => document.segment_id,
    "transcript segment",
  );

  const lectureIds = new Set(documents.lectures.map((document) => document.lecture_id));
  const caseById = new Map(documents.cases.map((document) => [document.case_id, document]));
  const segmentById = new Map(
    documents.transcriptSegments.map((document) => [document.segment_id, document]),
  );

  for (const caseDocument of documents.cases) {
    validateCaseReferences(caseDocument, lectureIds, segmentById);
  }

  for (const segment of documents.transcriptSegments) {
    if (!lectureIds.has(segment.lecture_id)) {
      throw new KnowledgeDocumentIntegrityError(
        `Segment ${segment.segment_id} references missing lecture ${segment.lecture_id}.`,
      );
    }
    for (const caseId of segment.case_ids) {
      const caseDocument = caseById.get(caseId);
      const caseLinksBackToSegment = caseDocument?.timestamp_refs.some(
        (reference) => reference.segment_id === segment.segment_id,
      );
      if (
        caseDocument === undefined ||
        caseDocument.lecture_id !== segment.lecture_id ||
        caseLinksBackToSegment !== true
      ) {
        throw new KnowledgeDocumentIntegrityError(
          `Segment ${segment.segment_id} has an invalid or one-way case reference ${caseId}.`,
        );
      }
    }
  }

  return documents;
}
