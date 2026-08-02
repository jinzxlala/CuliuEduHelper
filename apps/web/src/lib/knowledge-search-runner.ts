import type {
  CaseDocument,
  KnowledgeSearchService,
  LectureDocument,
  SearchPage,
  TranscriptSegmentDocument,
} from "@culiu/search";

import { SEARCH_PAGE_SIZE, type SearchPageState } from "./search-page-state";

export interface KnowledgeSearchResult {
  cases?: SearchPage<CaseDocument>;
  lectures?: SearchPage<LectureDocument>;
  transcripts?: SearchPage<TranscriptSegmentDocument>;
}

export async function runKnowledgeSearch(
  reader: Pick<
    KnowledgeSearchService,
    "searchCases" | "searchLectures" | "searchTranscriptSegments"
  >,
  state: SearchPageState,
): Promise<KnowledgeSearchResult> {
  const offset = (state.page - 1) * SEARCH_PAGE_SIZE;
  const matchingStrategy = state.matchMode === "all" ? "all" : "last";
  switch (state.target) {
    case "lectures":
      return {
        lectures: await reader.searchLectures({
          facets: ["organization", "schools", "majors"],
          filters: {
            ...(state.dateFrom === undefined ? {} : { dateFrom: state.dateFrom }),
            ...(state.dateTo === undefined ? {} : { dateTo: state.dateTo }),
            majors: state.majors,
            organizations: state.organizations,
            schools: state.schools,
          },
          limit: SEARCH_PAGE_SIZE,
          matchingStrategy,
          offset,
          query: state.query,
          ...(state.sort === undefined ? {} : { sort: state.sort }),
        }),
      };
    case "cases":
      return {
        cases: await reader.searchCases({
          facets: [
            "lecture_id",
            "case_type",
            "curriculum_system",
            "schools",
            "major",
            "ai_depth",
            "confidence",
          ],
          filters: {
            aiDepth: state.aiDepth,
            caseTypes: state.caseTypes,
            confidence: state.confidence,
            curriculumSystems: state.curriculumSystems,
            lectureIds: state.lectureIds,
            majors: state.majors,
            schools: state.schools,
          },
          limit: SEARCH_PAGE_SIZE,
          matchingStrategy,
          offset,
          query: state.query,
        }),
      };
    case "transcripts":
      return {
        transcripts: await reader.searchTranscriptSegments({
          facets: ["lecture_id", "section"],
          filters: {
            lectureIds: state.lectureIds,
            sections: state.sections,
          },
          limit: SEARCH_PAGE_SIZE,
          matchingStrategy,
          offset,
          query: state.query,
          sort: "start_seconds:asc",
        }),
      };
  }
}
