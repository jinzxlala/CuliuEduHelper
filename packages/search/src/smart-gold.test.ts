import { describe, expect, it } from "vitest";

import {
  evaluateSmartSearchRatios,
  SmartSearchGoldSetSchema,
  type SmartSearchGoldSet,
} from "./smart-gold.js";

function fixture(): SmartSearchGoldSet {
  return SmartSearchGoldSetSchema.parse({
    approval: { reviewed_at: null, reviewed_by: null, status: "draft" },
    corpus: {
      corpus_hash: "a".repeat(64),
      corpus_id: "synthetic",
      manifest_version: "1.0.0",
      mapping_version: "1.0.0",
    },
    drafted_at: "2026-08-05T00:00:00+08:00",
    drafted_by: "Code Agent",
    fixture_id: "eduknow_smart_search_gold_v1",
    fixture_version: "1.0.0",
    queries: Array.from({ length: 30 }, (_, index) => ({
      expected_hit_ids: [`lecture_${String(index).padStart(3, "0")}`],
      id: `smart_${String(index + 1).padStart(3, "0")}`,
      prompt: `请查找第 ${String(index + 1)} 个自然语言主题的相关讲座。`,
      retrieval_query: `主题 ${String(index + 1)}`,
      target: "lectures",
    })),
    schema_version: "1.0.0",
    thresholds: { candidate_recall_at_30_min: 0.9 },
  });
}

describe("smart-search gold evaluation", () => {
  it("compares all three ratios and keeps draft approval from passing release", async () => {
    const report = await evaluateSmartSearchRatios(fixture(), {
      searchCases: () => Promise.reject(new Error("not used")),
      searchLectures: (input) => {
        const query = input.query ?? "";
        return Promise.resolve({
          estimatedTotalHits: 1,
          facetDistribution: {},
          hits: [
            {
              document: {
                ai_cross_disciplinary_text: "",
                date: null,
                failure_text: "",
                lecture_id: `lecture_${String(Number(query.split(" ")[1]) - 1).padStart(3, "0")}`,
                majors: [],
                organization: null,
                schools: [],
                source_path: "knowledge/analysis/test.md",
                speakers: [],
                summary: "",
                title: "",
                trend_text: "",
              },
              formatted: {},
            },
          ],
          limit: 30,
          offset: 0,
          processingTimeMs: 1,
          query,
        });
      },
    });
    expect(report.results.map((result) => result.ratio)).toEqual([0.25, 0.5, 0.75]);
    expect(report.recommended_ratio).toBe(0.5);
    expect(report.technical_gate_passed).toBe(true);
    expect(report.release_gate_passed).toBe(false);
  });
});
