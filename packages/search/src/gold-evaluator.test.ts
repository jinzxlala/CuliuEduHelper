import { describe, expect, it } from "vitest";

import type { LectureDocument } from "./documents.js";
import { evaluateSearchGoldSet, type GoldSearchService } from "./gold-evaluator.js";
import { parseSearchGoldSet, type SearchGoldSet } from "./gold-set.js";
import type { SearchPage } from "./search-contracts.js";

const lecture: LectureDocument = {
  ai_cross_disciplinary_text: "",
  date: "2026-06-28",
  failure_text: "",
  lecture_id: "lecture_demo_expected",
  majors: ["数学"],
  organization: "测试机构",
  schools: ["测试大学"],
  source_path: "fixture/analysis.md",
  speakers: ["匿名讲者"],
  summary: "测试摘要",
  title: "测试讲座",
  trend_text: "",
};

function page(documents: readonly LectureDocument[], query: string): SearchPage<LectureDocument> {
  return {
    estimatedTotalHits: documents.length,
    facetDistribution: {},
    hits: documents.map((document) => ({ document, formatted: {} })),
    limit: 5,
    offset: 0,
    processingTimeMs: 1,
    query,
  };
}

function fixture(options?: {
  approval?: "approved" | "draft";
  missCritical?: boolean;
  wrongFilter?: boolean;
}): SearchGoldSet {
  const approval = options?.approval ?? "draft";
  return parseSearchGoldSet({
    approval:
      approval === "approved"
        ? {
            reviewed_at: "2026-08-02T01:00:00+08:00",
            reviewed_by: "integration reviewer",
            status: "approved",
          }
        : { reviewed_at: null, reviewed_by: null, status: "draft" },
    corpus: {
      corpus_hash: "a".repeat(64),
      corpus_id: "fixture",
      manifest_version: "1.0.0",
      mapping_version: "1.0.0",
    },
    drafted_at: "2026-08-02T00:00:00+08:00",
    drafted_by: "Code Agent",
    fixture_id: "fixture_gold_set",
    fixture_version: "1.0.0",
    queries: Array.from({ length: 50 }, (_, index) => ({
      critical: index === 0,
      description: `测试查询 ${String(index + 1)}`,
      expected_hit_ids: ["lecture_demo_expected"],
      ...(index === 2 ? { forbidden_hit_ids: ["lecture_demo_forbidden"] } : {}),
      id: `gold_lecture_${String(index + 1).padStart(3, "0")}`,
      input: {
        filters:
          index === 1
            ? { schools: ["测试大学"] }
            : options?.wrongFilter === true && index === 3
              ? { schools: ["不匹配大学"] }
              : index === 4
                ? { schools: [] }
                : {},
        query: options?.missCritical === true && index === 0 ? "miss" : `query-${String(index)}`,
      },
      tags:
        index === 1 || (options?.wrongFilter === true && index === 3)
          ? ["hard_filter"]
          : ["chinese_tokenization"],
      target: "lectures",
    })),
    schema_version: "1.0.0",
    thresholds: {
      critical_hit_rate_min: 1,
      filter_accuracy_min: 1,
      p95_latency_ms_max: 500,
      top_5_hit_rate_min: 0.85,
    },
  });
}

function service(options?: { forbidden?: boolean; missCritical?: boolean }): GoldSearchService {
  return {
    searchCases() {
      return Promise.reject(new Error("Unexpected case search."));
    },
    searchLectures(input) {
      if (options?.missCritical === true && input.query === "miss") {
        return Promise.resolve(page([], input.query ?? ""));
      }
      const documents = [
        lecture,
        ...(options?.forbidden === true
          ? [{ ...lecture, lecture_id: "lecture_demo_forbidden" }]
          : []),
      ];
      return Promise.resolve(page(documents, input.query ?? ""));
    },
    searchTranscriptSegments() {
      return Promise.reject(new Error("Unexpected transcript search."));
    },
  };
}

describe("evaluateSearchGoldSet", () => {
  it("passes the technical gate but keeps a draft outside the release gate", async () => {
    const report = await evaluateSearchGoldSet(fixture(), service());

    expect(report.technical_gate_passed).toBe(true);
    expect(report.release_gate_passed).toBe(false);
    expect(report.metrics).toMatchObject({
      critical_hit_rate: 1,
      filter_accuracy: 1,
      forbidden_check_rate: 1,
      query_count: 50,
      top_5_hit_rate: 1,
    });
  });

  it("passes the release gate only for an approved fixture", async () => {
    const report = await evaluateSearchGoldSet(fixture({ approval: "approved" }), service());

    expect(report.release_gate_passed).toBe(true);
  });

  it("fails when a critical expected result is absent", async () => {
    const report = await evaluateSearchGoldSet(
      fixture({ missCritical: true }),
      service({ missCritical: true }),
    );

    expect(report.metrics.top_5_hit_rate).toBe(0.98);
    expect(report.metrics.critical_hit_rate).toBe(0);
    expect(report.technical_gate_passed).toBe(false);
  });

  it("fails hard-filter and forbidden-result checks independently of recall", async () => {
    const report = await evaluateSearchGoldSet(
      fixture({ wrongFilter: true }),
      service({ forbidden: true }),
    );

    expect(report.metrics.top_5_hit_rate).toBe(1);
    expect(report.metrics.filter_accuracy).toBe(0.5);
    expect(report.metrics.forbidden_check_rate).toBe(0.98);
    expect(report.technical_gate_passed).toBe(false);
  });
});
