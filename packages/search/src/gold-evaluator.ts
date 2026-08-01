import { performance } from "node:perf_hooks";

import type { CaseDocument, LectureDocument, TranscriptSegmentDocument } from "./documents.js";
import type { SearchGoldQuery, SearchGoldSet } from "./gold-set.js";
import type {
  CaseSearchInput,
  LectureSearchInput,
  SearchPage,
  TranscriptSearchInput,
} from "./search-contracts.js";

const GOLD_TOP_K = 5;

export interface GoldSearchService {
  searchCases(input: CaseSearchInput): Promise<SearchPage<CaseDocument>>;
  searchLectures(input: LectureSearchInput): Promise<SearchPage<LectureDocument>>;
  searchTranscriptSegments(
    input: TranscriptSearchInput,
  ): Promise<SearchPage<TranscriptSegmentDocument>>;
}

export interface GoldQueryEvaluation {
  critical: boolean;
  duration_ms: number;
  engine_processing_ms: number;
  expected_hit_ids: string[];
  expected_hits: string[];
  filter_check_applicable: boolean;
  filter_passed: boolean;
  filter_violation_ids: string[];
  forbidden_hit_ids: string[];
  forbidden_hits: string[];
  hit_passed: boolean;
  id: string;
  passed: boolean;
  returned_ids: string[];
  target: SearchGoldQuery["target"];
}

export interface GoldEvaluationReport {
  approval_status: SearchGoldSet["approval"]["status"];
  corpus: SearchGoldSet["corpus"];
  evaluated_at: string;
  fixture_id: string;
  fixture_version: string;
  metrics: {
    critical_hit_rate: number;
    filter_accuracy: number;
    forbidden_check_rate: number;
    p95_latency_ms: number;
    query_count: number;
    top_5_hit_rate: number;
  };
  queries: GoldQueryEvaluation[];
  release_gate_passed: boolean;
  thresholds: SearchGoldSet["thresholds"];
  technical_gate_passed: boolean;
}

function hasAnyFilter(filters: Readonly<Record<string, unknown>>): boolean {
  return Object.values(filters).some((value) =>
    Array.isArray(value) ? value.length > 0 : value !== undefined,
  );
}

function matchesOptionalFacet(
  documentValues: readonly string[],
  filterValues: readonly string[] | undefined,
): boolean {
  return (
    filterValues === undefined ||
    filterValues.length === 0 ||
    filterValues.some((value) => documentValues.includes(value))
  );
}

function matchesOptionalScalarFacet(
  documentValue: string | null,
  filterValues: readonly string[] | undefined,
): boolean {
  return (
    filterValues === undefined ||
    filterValues.length === 0 ||
    (documentValue !== null && filterValues.includes(documentValue))
  );
}

function matchesLectureFilters(
  document: LectureDocument,
  filters: NonNullable<LectureSearchInput["filters"]>,
): boolean {
  return (
    (filters.dateFrom === undefined ||
      (document.date !== null && document.date >= filters.dateFrom)) &&
    (filters.dateTo === undefined || (document.date !== null && document.date <= filters.dateTo)) &&
    matchesOptionalScalarFacet(document.organization, filters.organizations) &&
    matchesOptionalFacet(document.speakers, filters.speakers) &&
    matchesOptionalFacet(document.schools, filters.schools) &&
    matchesOptionalFacet(document.majors, filters.majors)
  );
}

function matchesCaseFilters(
  document: CaseDocument,
  filters: NonNullable<CaseSearchInput["filters"]>,
): boolean {
  return (
    matchesOptionalFacet([document.lecture_id], filters.lectureIds) &&
    matchesOptionalFacet([document.case_type], filters.caseTypes) &&
    matchesOptionalScalarFacet(document.curriculum_system, filters.curriculumSystems) &&
    matchesOptionalFacet(document.schools, filters.schools) &&
    matchesOptionalScalarFacet(document.major, filters.majors) &&
    matchesOptionalFacet(document.research_methods, filters.researchMethods) &&
    matchesOptionalFacet(document.activity_types, filters.activityTypes) &&
    matchesOptionalFacet(document.ai_domains, filters.aiDomains) &&
    matchesOptionalScalarFacet(document.ai_depth, filters.aiDepth) &&
    (filters.confidence === undefined || filters.confidence.includes(document.confidence))
  );
}

function matchesTranscriptFilters(
  document: TranscriptSegmentDocument,
  filters: NonNullable<TranscriptSearchInput["filters"]>,
): boolean {
  return (
    matchesOptionalFacet([document.lecture_id], filters.lectureIds) &&
    matchesOptionalScalarFacet(document.section, filters.sections) &&
    matchesOptionalFacet(document.case_ids, filters.caseIds)
  );
}

function percentile95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function rate(passed: number, total: number): number {
  return total === 0 ? 1 : passed / total;
}

interface RawQueryResult {
  filterCheckApplicable: boolean;
  filterViolationIds: string[];
  processingTimeMs: number;
  returnedIds: string[];
}

async function runQuery(
  query: SearchGoldQuery,
  service: GoldSearchService,
): Promise<RawQueryResult> {
  switch (query.target) {
    case "lectures": {
      const page = await service.searchLectures({
        ...query.input,
        limit: GOLD_TOP_K,
        offset: 0,
      });
      const documents = page.hits.map((hit) => hit.document);
      return {
        filterCheckApplicable: hasAnyFilter(query.input.filters),
        filterViolationIds: documents
          .filter((document) => !matchesLectureFilters(document, query.input.filters))
          .map((document) => document.lecture_id),
        processingTimeMs: page.processingTimeMs,
        returnedIds: documents.map((document) => document.lecture_id),
      };
    }
    case "cases": {
      const page = await service.searchCases({
        ...query.input,
        limit: GOLD_TOP_K,
        offset: 0,
      });
      const documents = page.hits.map((hit) => hit.document);
      return {
        filterCheckApplicable: hasAnyFilter(query.input.filters),
        filterViolationIds: documents
          .filter((document) => !matchesCaseFilters(document, query.input.filters))
          .map((document) => document.case_id),
        processingTimeMs: page.processingTimeMs,
        returnedIds: documents.map((document) => document.case_id),
      };
    }
    case "transcript_segments": {
      const page = await service.searchTranscriptSegments({
        ...query.input,
        limit: GOLD_TOP_K,
        offset: 0,
      });
      const documents = page.hits.map((hit) => hit.document);
      return {
        filterCheckApplicable: hasAnyFilter(query.input.filters),
        filterViolationIds: documents
          .filter((document) => !matchesTranscriptFilters(document, query.input.filters))
          .map((document) => document.segment_id),
        processingTimeMs: page.processingTimeMs,
        returnedIds: documents.map((document) => document.segment_id),
      };
    }
  }
}

export async function evaluateSearchGoldSet(
  goldSet: SearchGoldSet,
  service: GoldSearchService,
): Promise<GoldEvaluationReport> {
  const queryReports: GoldQueryEvaluation[] = [];
  for (const query of goldSet.queries) {
    const startedAt = performance.now();
    const result = await runQuery(query, service);
    const durationMs = performance.now() - startedAt;
    const expectedHits = query.expected_hit_ids.filter((id) => result.returnedIds.includes(id));
    const forbiddenHits = query.forbidden_hit_ids.filter((id) => result.returnedIds.includes(id));
    const hitPassed = expectedHits.length >= query.minimum_expected_hits;
    const filterPassed = result.filterViolationIds.length === 0;
    const forbiddenPassed = forbiddenHits.length === 0;
    queryReports.push({
      critical: query.critical,
      duration_ms: durationMs,
      engine_processing_ms: result.processingTimeMs,
      expected_hit_ids: [...query.expected_hit_ids],
      expected_hits: expectedHits,
      filter_check_applicable: result.filterCheckApplicable,
      filter_passed: filterPassed,
      filter_violation_ids: result.filterViolationIds,
      forbidden_hit_ids: [...query.forbidden_hit_ids],
      forbidden_hits: forbiddenHits,
      hit_passed: hitPassed,
      id: query.id,
      passed: hitPassed && filterPassed && forbiddenPassed,
      returned_ids: result.returnedIds,
      target: query.target,
    });
  }

  const critical = queryReports.filter((query) => query.critical);
  const filtered = queryReports.filter((query) => query.filter_check_applicable);
  const metrics = {
    critical_hit_rate: rate(critical.filter((query) => query.hit_passed).length, critical.length),
    filter_accuracy: rate(filtered.filter((query) => query.filter_passed).length, filtered.length),
    forbidden_check_rate: rate(
      queryReports.filter((query) => query.forbidden_hits.length === 0).length,
      queryReports.length,
    ),
    p95_latency_ms: percentile95(queryReports.map((query) => query.duration_ms)),
    query_count: queryReports.length,
    top_5_hit_rate: rate(
      queryReports.filter((query) => query.hit_passed).length,
      queryReports.length,
    ),
  };
  const technicalGatePassed =
    metrics.top_5_hit_rate >= goldSet.thresholds.top_5_hit_rate_min &&
    metrics.critical_hit_rate >= goldSet.thresholds.critical_hit_rate_min &&
    metrics.filter_accuracy >= goldSet.thresholds.filter_accuracy_min &&
    metrics.forbidden_check_rate === 1 &&
    metrics.p95_latency_ms <= goldSet.thresholds.p95_latency_ms_max;

  return {
    approval_status: goldSet.approval.status,
    corpus: goldSet.corpus,
    evaluated_at: new Date().toISOString(),
    fixture_id: goldSet.fixture_id,
    fixture_version: goldSet.fixture_version,
    metrics,
    queries: queryReports,
    release_gate_passed: technicalGatePassed && goldSet.approval.status === "approved",
    thresholds: goldSet.thresholds,
    technical_gate_passed: technicalGatePassed,
  };
}
