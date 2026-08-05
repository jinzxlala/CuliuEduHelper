import { MeilisearchApiError, type Meilisearch, type SearchParams } from "meilisearch";
import type { z } from "zod";

import {
  CaseDocumentSchema,
  EvidenceReferenceSchema,
  LectureDocumentSchema,
  TranscriptSegmentDocumentSchema,
  type CaseDocument,
  type EvidenceDocument,
  type EvidenceReference,
  type LectureDocument,
  type TranscriptSegmentDocument,
} from "./documents.js";
import {
  DEFAULT_KNOWLEDGE_INDEX_NAMES,
  KnowledgeIndexNamesSchema,
  type KnowledgeIndexNames,
} from "./index-definitions.js";
import {
  CaseSearchInputSchema,
  LectureSearchInputSchema,
  TranscriptSearchInputSchema,
  type CaseSearchInput,
  type LectureSearchInput,
  type SearchHit,
  type SearchPage,
  type TranscriptSearchInput,
} from "./search-contracts.js";

export const SEARCH_HIGHLIGHT_START = "\uE000";
export const SEARCH_HIGHLIGHT_END = "\uE001";

export class EvidenceNotFoundError extends Error {
  public constructor(reference: EvidenceReference) {
    super(`Evidence was not found for reference kind: ${reference.kind}.`);
    this.name = "EvidenceNotFoundError";
  }
}

function quoteFilterValue(value: string): string {
  return JSON.stringify(value);
}

type FilterList = Array<string | string[]>;

function addFacetFilter(
  filters: FilterList,
  field: string,
  values: readonly string[] | undefined,
): void {
  if (values === undefined || values.length === 0) {
    return;
  }

  const expressions = values.map((value) => `${field} = ${quoteFilterValue(value)}`);
  const [firstExpression, ...remainingExpressions] = expressions;
  if (firstExpression !== undefined) {
    filters.push(remainingExpressions.length === 0 ? firstExpression : expressions);
  }
}

function createBaseSearchParams(input: {
  facets: readonly string[];
  hybrid?: { embedder: "knowledge_zh_v1"; semanticRatio: number } | undefined;
  limit: number;
  matchingStrategy: "all" | "last";
  offset: number;
  sort?: string | undefined;
}): SearchParams {
  return {
    attributesToHighlight: ["*"],
    highlightPostTag: SEARCH_HIGHLIGHT_END,
    highlightPreTag: SEARCH_HIGHLIGHT_START,
    limit: input.limit,
    ...(input.hybrid === undefined ? {} : { hybrid: input.hybrid }),
    matchingStrategy: input.matchingStrategy,
    offset: input.offset,
    ...(input.facets.length === 0 ? {} : { facets: [...input.facets] }),
    ...(input.sort === undefined ? {} : { sort: [input.sort] }),
  };
}

function parseSearchHit<TDocument extends Record<string, unknown>>(
  schema: z.ZodType<TDocument>,
  hit: TDocument & { _formatted?: Partial<TDocument> },
): SearchHit<TDocument> {
  const documentCandidate = Object.fromEntries(
    Object.entries(hit).filter(([field]) => !field.startsWith("_")),
  );
  return {
    document: schema.parse(documentCandidate),
    formatted: hit._formatted ?? {},
  };
}

function createSearchPage<TDocument extends Record<string, unknown>>(
  schema: z.ZodType<TDocument>,
  response: {
    estimatedTotalHits: number;
    facetDistribution?: Record<string, Record<string, number>>;
    hits: Array<TDocument & { _formatted?: Partial<TDocument> }>;
    limit: number;
    offset: number;
    processingTimeMs: number;
    query: string;
  },
): SearchPage<TDocument> {
  return {
    estimatedTotalHits: response.estimatedTotalHits,
    facetDistribution: response.facetDistribution ?? {},
    hits: response.hits.map((hit) => parseSearchHit(schema, hit)),
    limit: response.limit,
    offset: response.offset,
    processingTimeMs: response.processingTimeMs,
    query: response.query,
  };
}

function isNotFoundError(error: unknown): boolean {
  return (
    error instanceof MeilisearchApiError &&
    (error.cause?.code === "document_not_found" || error.cause?.code === "index_not_found")
  );
}

export interface KnowledgeSearchServiceOptions {
  client: Meilisearch;
  indexNames?: KnowledgeIndexNames;
}

export class KnowledgeSearchService {
  readonly #client: Meilisearch;
  readonly #indexNames: KnowledgeIndexNames;

  public constructor(options: KnowledgeSearchServiceOptions) {
    this.#client = options.client;
    this.#indexNames = KnowledgeIndexNamesSchema.parse(
      options.indexNames ?? DEFAULT_KNOWLEDGE_INDEX_NAMES,
    );
  }

  public async searchLectures(input: LectureSearchInput): Promise<SearchPage<LectureDocument>> {
    const parsed = LectureSearchInputSchema.parse(input);
    const filter: FilterList = [];
    addFacetFilter(filter, "organization", parsed.filters.organizations);
    addFacetFilter(filter, "speakers", parsed.filters.speakers);
    addFacetFilter(filter, "schools", parsed.filters.schools);
    addFacetFilter(filter, "majors", parsed.filters.majors);
    if (parsed.filters.dateFrom !== undefined) {
      filter.push(`date >= ${quoteFilterValue(parsed.filters.dateFrom)}`);
    }
    if (parsed.filters.dateTo !== undefined) {
      filter.push(`date <= ${quoteFilterValue(parsed.filters.dateTo)}`);
    }

    const response = await this.#client
      .index<LectureDocument>(this.#indexNames.lectures)
      .search(parsed.query, {
        ...createBaseSearchParams(parsed),
        ...(filter.length === 0 ? {} : { filter }),
      });
    return createSearchPage(LectureDocumentSchema, response);
  }

  public async searchCases(input: CaseSearchInput): Promise<SearchPage<CaseDocument>> {
    const parsed = CaseSearchInputSchema.parse(input);
    const filter: FilterList = [];
    addFacetFilter(filter, "lecture_id", parsed.filters.lectureIds);
    addFacetFilter(filter, "case_type", parsed.filters.caseTypes);
    addFacetFilter(filter, "curriculum_system", parsed.filters.curriculumSystems);
    addFacetFilter(filter, "schools", parsed.filters.schools);
    addFacetFilter(filter, "major", parsed.filters.majors);
    addFacetFilter(filter, "research_methods", parsed.filters.researchMethods);
    addFacetFilter(filter, "activity_types", parsed.filters.activityTypes);
    addFacetFilter(filter, "ai_domains", parsed.filters.aiDomains);
    addFacetFilter(filter, "ai_depth", parsed.filters.aiDepth);
    addFacetFilter(filter, "confidence", parsed.filters.confidence);

    const response = await this.#client
      .index<CaseDocument>(this.#indexNames.cases)
      .search(parsed.query, {
        ...createBaseSearchParams(parsed),
        ...(filter.length === 0 ? {} : { filter }),
      });
    return createSearchPage(CaseDocumentSchema, response);
  }

  public async searchTranscriptSegments(
    input: TranscriptSearchInput,
  ): Promise<SearchPage<TranscriptSegmentDocument>> {
    const parsed = TranscriptSearchInputSchema.parse(input);
    const filter: FilterList = [];
    addFacetFilter(filter, "lecture_id", parsed.filters.lectureIds);
    addFacetFilter(filter, "section", parsed.filters.sections);
    addFacetFilter(filter, "case_ids", parsed.filters.caseIds);

    const response = await this.#client
      .index<TranscriptSegmentDocument>(this.#indexNames.transcriptSegments)
      .search(parsed.query, {
        ...createBaseSearchParams(parsed),
        ...(filter.length === 0 ? {} : { filter }),
      });
    return createSearchPage(TranscriptSegmentDocumentSchema, response);
  }

  public async getEvidence(untrustedReference: EvidenceReference): Promise<EvidenceDocument> {
    const reference = EvidenceReferenceSchema.parse(untrustedReference);
    try {
      switch (reference.kind) {
        case "lecture":
          return LectureDocumentSchema.parse(
            await this.#client
              .index<LectureDocument>(this.#indexNames.lectures)
              .getDocument(reference.lecture_id),
          );
        case "case":
          return CaseDocumentSchema.parse(
            await this.#client
              .index<CaseDocument>(this.#indexNames.cases)
              .getDocument(reference.case_id),
          );
        case "transcript_segment":
          return TranscriptSegmentDocumentSchema.parse(
            await this.#client
              .index<TranscriptSegmentDocument>(this.#indexNames.transcriptSegments)
              .getDocument(reference.segment_id),
          );
      }
    } catch (error) {
      if (isNotFoundError(error)) {
        throw new EvidenceNotFoundError(reference);
      }
      throw error;
    }
  }
}
