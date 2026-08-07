import { describe, expect, it } from "vitest";

import {
  AddKnowledgeWorkspaceSourcesInputSchema,
  AnalysisReportSpecSchema,
  CreateKnowledgeConversationInputSchema,
  KnowledgeAssistantMessageSchema,
  SmartSearchQueryPlanSchema,
  SmartSearchResultSchema,
} from "./contracts.js";
import { normalizeSmartSearchPlannerOutput } from "./smart-search.js";

const source = {
  batchId: "11111111-1111-4111-8111-111111111111",
  contentHash: "a".repeat(64),
  sourceId: "lecture:synthetic",
  sourceType: "lecture" as const,
};

describe("knowledge analysis contracts", () => {
  it("creates nameless conversations with a safe placeholder and requires a model topic", () => {
    expect(CreateKnowledgeConversationInputSchema.parse({}).title).toBe("新对话");
    expect(() =>
      KnowledgeAssistantMessageSchema.parse({
        answerMarkdown: "Synthetic answer.",
        citations: [],
        suggestedFollowUps: [],
        uncertainties: [],
      }),
    ).toThrow();
    expect(
      KnowledgeAssistantMessageSchema.parse({
        answerMarkdown: "Synthetic answer.",
        citations: [],
        conversationTopic: "跨学科案例比较",
        suggestedFollowUps: [],
        uncertainties: [],
      }).conversationTopic,
    ).toBe("跨学科案例比较");
  });

  it("accepts a bounded smart-search plan and rejects excessive plans", () => {
    const item = {
      filters: {
        dateBefore: null,
        dateFrom: null,
        majors: [],
        organizations: [],
        schools: [],
        speakers: [],
      },
      keywords: ["跨学科", "项目"],
      matchingStrategy: "last" as const,
      query: "跨学科 项目",
      target: "lectures" as const,
    };
    expect(
      SmartSearchQueryPlanSchema.parse({
        intent: "semantic_search",
        interpretation: "Find synthetic cross-disciplinary evidence.",
        queries: [item],
        round: 1,
        targets: ["lectures"],
      }).queries,
    ).toHaveLength(1);
    expect(() =>
      SmartSearchQueryPlanSchema.parse({
        intent: "semantic_search",
        interpretation: "Too many plans.",
        queries: Array.from({ length: 7 }, () => item),
        round: 1,
        targets: ["lectures"],
      }),
    ).toThrow();
  });

  it("rejects duplicate frozen sources and model-created result fields", () => {
    expect(() =>
      AddKnowledgeWorkspaceSourcesInputSchema.parse({ sources: [source, source] }),
    ).toThrow();
    expect(() =>
      SmartSearchResultSchema.parse({
        appliedConditions: [],
        caseCount: 0,
        exactTotal: null,
        intent: "semantic_search",
        lectureCount: 1,
        limitations: [],
        results: [
          {
            ...source,
            inventedSourceId: "not-allowed",
            matchedTerms: ["项目"],
            rationale: "Synthetic rationale.",
          },
        ],
        summary: "Synthetic result.",
      }),
    ).toThrow();
  });

  it("allows a complete bounded source library while keeping a hard capacity", () => {
    const sources = Array.from({ length: 500 }, (_, index) => ({
      ...source,
      sourceId: `lecture:${String(index)}`,
    }));
    expect(AddKnowledgeWorkspaceSourcesInputSchema.parse({ sources }).sources).toHaveLength(500);
    expect(() =>
      AddKnowledgeWorkspaceSourcesInputSchema.parse({
        sources: [...sources, { ...source, sourceId: "lecture:overflow" }],
      }),
    ).toThrow();
  });

  it("accepts deterministic report content and rejects duplicate block IDs", () => {
    const section = {
      chart: {
        points: [{ label: "A", sourceIds: [source.sourceId], value: 2 }],
        title: "Synthetic distribution",
        type: "bar" as const,
      },
      citations: [{ claim: "Synthetic claim", source }],
      id: "synthetic-section",
      paragraphs: ["Synthetic paragraph."],
      title: "Synthetic section",
    };
    expect(
      AnalysisReportSpecSchema.parse({
        executiveSummary: "Synthetic summary.",
        metrics: [{ detail: "", label: "Count", value: "2" }],
        sections: [section],
        title: "Synthetic report",
      }).sections,
    ).toHaveLength(1);
    expect(() =>
      AnalysisReportSpecSchema.parse({
        executiveSummary: "Synthetic summary.",
        metrics: [],
        sections: [section, section],
        title: "Synthetic report",
      }),
    ).toThrow();
  });

  it("drops generic case labels and keeps only supported case-type filters", () => {
    const normalized = normalizeSmartSearchPlannerOutput({
      interpretation: "查找 AI 或人工智能相关学生项目。",
      queries: [
        {
          filters: {
            caseTypes: ["学生案例", "科研竞赛案例", "不存在的类型"],
            confidences: [],
            activityTypes: [],
            aiDepth: [],
            aiDomains: [],
            curriculumSystems: [],
            majors: [],
            researchMethods: [],
            schools: [],
            sourceDateBefore: null,
            sourceDateFrom: null,
          },
          keywords: ["AI", "人工智能", "项目"],
          matchingStrategy: "last",
          query: "AI 人工智能 项目",
          target: "cases",
        },
      ],
      round: 1,
    });
    const plan = SmartSearchQueryPlanSchema.parse(normalized.json);
    const query = plan.queries[0];
    expect(query?.target).toBe("cases");
    if (query?.target !== "cases") throw new Error("Expected a case query.");
    expect(query.filters.caseTypes).toEqual(["科研与竞赛案例"]);
    expect(normalized.warnings).toEqual([
      "检索规划中的“学生案例”是泛称，已取消该案例类型限制。",
      "检索规划中的未知案例类型“不存在的类型”已被忽略。",
    ]);
  });

  it("routes the five stage-four acceptance prompts and derives safe year filters", () => {
    const cases = [
      ["帮我检索所有2025年内的讲座", "catalog_browse", ["lectures"]],
      ["帮我检索所有2025年内的讲座和学生案例", "catalog_browse", ["lectures", "cases"]],
      ["查找AI与医疗相关的讲座和案例", "semantic_search", ["lectures", "cases"]],
      ["2025年共有多少场讲座", "count", ["lectures"]],
      ["AI案例占全部案例的比例", "analysis_required", ["cases"]],
    ] as const;
    for (const [prompt, intent, targets] of cases) {
      const normalized = normalizeSmartSearchPlannerOutput(
        {
          intent: "semantic_search",
          interpretation: prompt,
          queries: [],
          round: 9,
          targets: [],
        },
        prompt,
        1,
      );
      const parsed = SmartSearchQueryPlanSchema.parse(normalized.json);
      expect(parsed.intent).toBe(intent);
      expect(parsed.targets).toEqual(targets);
      expect(parsed.round).toBe(1);
      if (intent === "analysis_required") {
        expect(parsed.queries).toEqual([]);
      } else {
        expect(parsed.queries).toHaveLength(targets.length);
      }
      for (const query of parsed.queries) {
        if (prompt.includes("2025") && query.target === "lectures") {
          expect(query.filters).toMatchObject({
            dateBefore: "2026-01-01",
            dateFrom: "2025-01-01",
          });
        }
        if (prompt.includes("2025") && query.target === "cases") {
          expect(query.filters).toMatchObject({
            sourceDateBefore: "2026-01-01",
            sourceDateFrom: "2025-01-01",
          });
        }
      }
    }
  });
});
