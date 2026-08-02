import type { KnowledgeSearchService, SearchPage } from "@culiu/search";
import { describe, expect, it, vi } from "vitest";

import { runKnowledgeSearch } from "./knowledge-search-runner";
import { parseSearchPageState } from "./search-page-state";

function emptyPage(): SearchPage<never> {
  return {
    estimatedTotalHits: 0,
    facetDistribution: {},
    hits: [],
    limit: 10,
    offset: 0,
    processingTimeMs: 1,
    query: "",
  };
}

describe("runKnowledgeSearch", () => {
  it("maps lecture URL state to the stable server-side contract", async () => {
    const searchLectures = vi.fn().mockResolvedValue(emptyPage());
    const reader = {
      searchCases: vi.fn(),
      searchLectures,
      searchTranscriptSegments: vi.fn(),
    } as unknown as Pick<
      KnowledgeSearchService,
      "searchCases" | "searchLectures" | "searchTranscriptSegments"
    >;

    await runKnowledgeSearch(
      reader,
      parseSearchPageState({
        from: "2025-01-01",
        major: ["计算机科学", "教育学"],
        page: "2",
        q: "人工智能",
        school: "MIT",
        sort: "date:desc",
      }),
    );

    expect(searchLectures).toHaveBeenCalledWith({
      facets: ["organization", "schools", "majors"],
      filters: {
        dateFrom: "2025-01-01",
        majors: ["计算机科学", "教育学"],
        organizations: [],
        schools: ["MIT"],
      },
      limit: 10,
      matchingStrategy: "last",
      offset: 10,
      query: "人工智能",
      sort: "date:desc",
    });
    expect(reader.searchCases).not.toHaveBeenCalled();
  });

  it("keeps transcript search inside the gated empty index", async () => {
    const searchTranscriptSegments = vi.fn().mockResolvedValue(emptyPage());
    const reader = {
      searchCases: vi.fn(),
      searchLectures: vi.fn(),
      searchTranscriptSegments,
    } as unknown as Pick<
      KnowledgeSearchService,
      "searchCases" | "searchLectures" | "searchTranscriptSegments"
    >;

    await runKnowledgeSearch(
      reader,
      parseSearchPageState({ lecture: "lecture_2026", type: "transcripts" }),
    );

    expect(searchTranscriptSegments).toHaveBeenCalledWith({
      facets: ["lecture_id", "section"],
      filters: { lectureIds: ["lecture_2026"], sections: [] },
      limit: 10,
      matchingStrategy: "last",
      offset: 0,
      query: "",
      sort: "start_seconds:asc",
    });
  });

  it("keeps the source lecture as a hard case filter", async () => {
    const searchCases = vi.fn().mockResolvedValue(emptyPage());
    const reader = {
      searchCases,
      searchLectures: vi.fn(),
      searchTranscriptSegments: vi.fn(),
    } as unknown as Pick<
      KnowledgeSearchService,
      "searchCases" | "searchLectures" | "searchTranscriptSegments"
    >;

    await runKnowledgeSearch(
      reader,
      parseSearchPageState({ lecture: "lecture_2026", type: "cases" }),
    );

    expect(searchCases).toHaveBeenCalledWith({
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
        aiDepth: [],
        caseTypes: [],
        confidence: [],
        curriculumSystems: [],
        lectureIds: ["lecture_2026"],
        majors: [],
        schools: [],
      },
      limit: 10,
      matchingStrategy: "last",
      offset: 0,
      query: "",
    });
  });

  it("maps the all-keywords URL mode to every-term matching", async () => {
    const searchCases = vi.fn().mockResolvedValue(emptyPage());
    const reader = {
      searchCases,
      searchLectures: vi.fn(),
      searchTranscriptSegments: vi.fn(),
    } as unknown as Pick<
      KnowledgeSearchService,
      "searchCases" | "searchLectures" | "searchTranscriptSegments"
    >;

    await runKnowledgeSearch(
      reader,
      parseSearchPageState({ match: "all", q: "AI 教育", type: "cases" }),
    );

    expect(searchCases).toHaveBeenCalledWith(
      expect.objectContaining({ matchingStrategy: "all", query: "AI 教育" }),
    );
  });
});
