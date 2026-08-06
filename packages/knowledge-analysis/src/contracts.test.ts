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
        caseTypes: [],
        confidences: [],
        dateFrom: null,
        dateTo: null,
        majors: [],
        organizations: [],
        schools: [],
      },
      keywords: ["跨学科", "项目"],
      matchingStrategy: "last" as const,
      query: "跨学科 项目",
      target: "lectures" as const,
    };
    expect(
      SmartSearchQueryPlanSchema.parse({
        interpretation: "Find synthetic cross-disciplinary evidence.",
        queries: [item],
        round: 1,
      }).queries,
    ).toHaveLength(1);
    expect(() =>
      SmartSearchQueryPlanSchema.parse({
        interpretation: "Too many plans.",
        queries: Array.from({ length: 7 }, () => item),
        round: 1,
      }),
    ).toThrow();
  });

  it("rejects duplicate frozen sources and model-created result fields", () => {
    expect(() =>
      AddKnowledgeWorkspaceSourcesInputSchema.parse({ sources: [source, source] }),
    ).toThrow();
    expect(() =>
      SmartSearchResultSchema.parse({
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
            dateFrom: null,
            dateTo: null,
            majors: [],
            organizations: [],
            schools: [],
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
    expect(plan.queries[0]?.filters.caseTypes).toEqual(["科研与竞赛案例"]);
    expect(normalized.warnings).toEqual([
      "检索规划中的“学生案例”是泛称，已取消该案例类型限制。",
      "检索规划中的未知案例类型“不存在的类型”已被忽略。",
    ]);
  });
});
