import { randomUUID } from "node:crypto";

import { MeilisearchApiError } from "meilisearch";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMeilisearchClient, parseMeilisearchAdminConfig } from "./config.js";
import type { KnowledgeDocumentSet } from "./documents.js";
import { KnowledgeIndexManager } from "./index-manager.js";
import { KNOWLEDGE_INDEX_DEFINITIONS, type KnowledgeIndexNames } from "./index-definitions.js";
import { EvidenceNotFoundError, KnowledgeSearchService } from "./service.js";

const suffix = randomUUID().replaceAll("-", "");
const indexNames: KnowledgeIndexNames = {
  cases: `test_cases_${suffix}`,
  lectures: `test_lectures_${suffix}`,
  transcriptSegments: `test_transcripts_${suffix}`,
};

const documents: KnowledgeDocumentSet = {
  cases: [
    {
      academic_label: "数学与哲学",
      activity_types: ["社区活动"],
      admission_result: "虚构录取结果",
      ai_depth: "method",
      ai_domains: ["NLP"],
      background: "使用NLP分析公共文本，但未披露数据规模。",
      case_id: "case_demo_001",
      case_type: "student_admission",
      confidence: "medium",
      core_projects: [],
      core_strengths: [],
      curriculum_system: "AP",
      development_path: [],
      evidence_boundary: "未披露样本规模，不得推断录取因果。",
      evidence_points: [],
      advisor_insights: [],
      application_strategy: [],
      interpretations: [],
      lecture_id: "lecture_demo_001",
      major: "数学",
      missing_information: [],
      profile_summary: "一名匿名学生使用NLP分析公共文本。",
      research_methods: ["文本分析"],
      schools: ["布朗大学"],
      timestamp_refs: [
        {
          end_seconds: 20,
          segment_id: "segment_demo_001",
          source_path: "2026/lecture_demo/transcript.srt",
          start_seconds: 10,
        },
      ],
      verified_facts: [],
    },
  ],
  lectures: [
    {
      ai_cross_disciplinary_text: "AI与人文学科交叉。",
      date: "2026-07-01",
      failure_text: "未披露样本规模。",
      lecture_id: "lecture_demo_001",
      majors: ["数学", "哲学"],
      organization: "虚构教育机构",
      schools: ["布朗大学"],
      source_path: "2026/lecture_demo/analysis.md",
      speakers: ["匿名讲者"],
      summary: "讲座讨论跨学科申请规划。",
      title: "跨学科申请规划",
      trend_text: "重视长期投入。",
    },
  ],
  transcriptSegments: [
    {
      case_ids: ["case_demo_001"],
      end_seconds: 20,
      lecture_id: "lecture_demo_001",
      section: "案例",
      segment_id: "segment_demo_001",
      source_path: "2026/lecture_demo/transcript.srt",
      start_seconds: 10,
      text: "学生通过长期规划完成研究与社区活动的衔接。",
    },
  ],
};

const client = createMeilisearchClient(parseMeilisearchAdminConfig());
const manager = new KnowledgeIndexManager({ client, indexNames });
const service = new KnowledgeSearchService({ client, indexNames });

async function deleteIndexIfPresent(uid: string): Promise<void> {
  try {
    const task = await client.deleteIndex(uid);
    await client.tasks.waitForTask(task.taskUid, { interval: 50, timeout: 30_000 });
  } catch (error) {
    if (!(error instanceof MeilisearchApiError && error.cause?.code === "index_not_found")) {
      throw error;
    }
  }
}

beforeAll(async () => {
  await manager.rebuildKnowledgeIndexes(documents);
}, 180_000);

afterAll(async () => {
  const cleanupResults = await Promise.allSettled(
    Object.values(indexNames).map(async (uid) => deleteIndexIfPresent(uid)),
  );
  const cleanupErrors: Error[] = [];
  for (const result of cleanupResults) {
    if (result.status === "rejected") {
      const reason: unknown = result.reason;
      cleanupErrors.push(reason instanceof Error ? reason : new Error("Unknown cleanup failure."));
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      "Failed to remove one or more integration-test indexes.",
    );
  }
}, 180_000);

describe("knowledge search service", () => {
  it("keeps index initialization idempotent and applies canonical settings", async () => {
    await manager.ensureKnowledgeIndexes();
    await manager.ensureKnowledgeIndexes();

    const targets = [
      { definition: KNOWLEDGE_INDEX_DEFINITIONS.lectures, uid: indexNames.lectures },
      { definition: KNOWLEDGE_INDEX_DEFINITIONS.cases, uid: indexNames.cases },
      {
        definition: KNOWLEDGE_INDEX_DEFINITIONS.transcriptSegments,
        uid: indexNames.transcriptSegments,
      },
    ];
    for (const target of targets) {
      const settings = await client.index(target.uid).getSettings();
      expect(settings.searchableAttributes).toEqual(target.definition.searchableAttributes);
      expect(new Set(settings.filterableAttributes ?? [])).toEqual(
        new Set(target.definition.filterableAttributes),
      );
      expect(new Set(settings.sortableAttributes ?? [])).toEqual(
        new Set(target.definition.sortableAttributes),
      );
      if (target.definition.embedder !== undefined) {
        expect(settings.embedders?.knowledge_zh_v1).toMatchObject({
          model: "BAAI/bge-small-zh-v1.5",
          revision: "7999e1d3359715c523056ef9478215996d62a620",
          source: "huggingFace",
        });
      } else {
        expect(settings.embedders ?? {}).toEqual({});
      }
    }
  });

  it("searches and filters lectures with safe highlight markers and facets", async () => {
    const result = await service.searchLectures({
      facets: ["schools"],
      filters: { schools: ["布朗大学"] },
      query: "跨学科",
    });

    expect(result.estimatedTotalHits).toBe(1);
    expect(result.hits[0]?.document.lecture_id).toBe("lecture_demo_001");
    expect(result.hits[0]?.formatted.title).toContain("\uE000");
    expect(result.facetDistribution.schools?.["布朗大学"]).toBe(1);
  });

  it("can require every unquoted query term without changing the default relaxed strategy", async () => {
    const relaxed = await service.searchLectures({ query: "跨学科 不存在" });
    const strict = await service.searchLectures({
      matchingStrategy: "all",
      query: "跨学科 不存在",
    });

    expect(relaxed.estimatedTotalHits).toBe(1);
    expect(strict.estimatedTotalHits).toBe(0);
  });

  it("runs a pinned local Chinese hybrid query without changing keyword defaults", async () => {
    const result = await service.searchLectures({
      hybrid: { embedder: "knowledge_zh_v1", semanticRatio: 0.5 },
      query: "跨学科申请",
    });
    expect(result.hits[0]?.document.lecture_id).toBe("lecture_demo_001");
  });

  it("applies hard case filters", async () => {
    const matching = await service.searchCases({
      filters: { aiDomains: ["NLP"], confidence: ["medium"] },
      query: "未披露数据规模",
    });
    const excluded = await service.searchCases({
      filters: { confidence: ["high"] },
      query: "NLP",
    });

    expect(matching.hits.map((hit) => hit.document.case_id)).toEqual(["case_demo_001"]);
    expect(excluded.estimatedTotalHits).toBe(0);
  });

  it("finds exact transcript phrases and resolves timestamp evidence", async () => {
    const result = await service.searchTranscriptSegments({
      filters: { lectureIds: ["lecture_demo_001"] },
      query: '"长期规划"',
      sort: "start_seconds:asc",
    });
    const evidence = await service.getEvidence({
      kind: "transcript_segment",
      segment_id: "segment_demo_001",
    });

    expect(result.hits[0]?.document.start_seconds).toBe(10);
    expect(evidence).toMatchObject({ segment_id: "segment_demo_001", start_seconds: 10 });
  });

  it("returns a typed not-found error without leaking query details", async () => {
    await expect(
      service.getEvidence({ kind: "case", case_id: "case_missing_001" }),
    ).rejects.toBeInstanceOf(EvidenceNotFoundError);
  });

  it("atomically replaces all three index contents", async () => {
    const lectureDocument = documents.lectures[0];
    if (lectureDocument === undefined) {
      throw new Error("The integration fixture must contain one lecture.");
    }
    const replacement: KnowledgeDocumentSet = {
      cases: [],
      lectures: [
        {
          ...lectureDocument,
          ai_cross_disciplinary_text: "",
          failure_text: "",
          lecture_id: "lecture_demo_002",
          summary: "全新主题内容。",
          title: "全新讲座",
          trend_text: "",
        },
      ],
      transcriptSegments: [],
    };
    const rebuild = await manager.rebuildKnowledgeIndexes(replacement);
    const oldResult = await service.searchLectures({ query: "跨学科" });
    const newResult = await service.searchLectures({ query: "全新讲座" });
    const remainingCases = await service.searchCases({});
    const remainingSegments = await service.searchTranscriptSegments({});

    expect(rebuild.documentCounts).toEqual({ cases: 0, lectures: 1, transcriptSegments: 0 });
    expect(rebuild.orphanedIndexes).toEqual([]);
    expect(oldResult.estimatedTotalHits).toBe(0);
    expect(newResult.hits[0]?.document.lecture_id).toBe("lecture_demo_002");
    expect(remainingCases.estimatedTotalHits).toBe(0);
    expect(remainingSegments.estimatedTotalHits).toBe(0);
  });
});
