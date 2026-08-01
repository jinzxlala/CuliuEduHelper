import { randomUUID } from "node:crypto";

import { MeilisearchApiError } from "meilisearch";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMeilisearchClient, parseMeilisearchAdminConfig } from "./config.js";
import type { KnowledgeDocumentSet } from "./documents.js";
import { evaluateSearchGoldSet } from "./gold-evaluator.js";
import { parseSearchGoldSet } from "./gold-set.js";
import { KnowledgeIndexManager } from "./index-manager.js";
import type { KnowledgeIndexNames } from "./index-definitions.js";
import { KnowledgeSearchService } from "./service.js";

const suffix = randomUUID().replaceAll("-", "");
const indexNames: KnowledgeIndexNames = {
  cases: `test_gold_cases_${suffix}`,
  lectures: `test_gold_lectures_${suffix}`,
  transcriptSegments: `test_gold_transcripts_${suffix}`,
};
const client = createMeilisearchClient(parseMeilisearchAdminConfig());
const manager = new KnowledgeIndexManager({ client, indexNames });
const service = new KnowledgeSearchService({ client, indexNames });

const documents: KnowledgeDocumentSet = {
  cases: [],
  lectures: [
    {
      ai_cross_disciplinary_text: "AI与人文学科交叉。",
      date: "2026-07-01",
      failure_text: "未披露样本规模。",
      lecture_id: "lecture_gold_demo_001",
      majors: ["数学", "哲学"],
      organization: "虚构教育机构",
      schools: ["布朗大学"],
      source_path: "fixture/analysis.md",
      speakers: ["匿名讲者"],
      summary: "讲座讨论跨学科申请规划。",
      title: "跨学科申请规划",
      trend_text: "重视长期投入。",
    },
  ],
  transcriptSegments: [],
};

const goldSet = parseSearchGoldSet({
  approval: {
    reviewed_at: "2026-08-02T01:00:00+08:00",
    reviewed_by: "integration reviewer",
    status: "approved",
  },
  corpus: {
    corpus_hash: "b".repeat(64),
    corpus_id: "integration_fixture",
    manifest_version: "1.0.0",
    mapping_version: "1.0.0",
  },
  drafted_at: "2026-08-02T00:00:00+08:00",
  drafted_by: "Code Agent",
  fixture_id: "integration_gold_set",
  fixture_version: "1.0.0",
  queries: Array.from({ length: 50 }, (_, index) => ({
    critical: index === 0,
    description: `真实Meilisearch评测查询 ${String(index + 1)}`,
    expected_hit_ids: ["lecture_gold_demo_001"],
    ...(index === 2 ? { forbidden_hit_ids: ["lecture_gold_forbidden"] } : {}),
    id: `gold_lecture_${String(index + 1).padStart(3, "0")}`,
    input: {
      filters: index === 1 ? { schools: ["布朗大学"] } : {},
      query: `跨学科 query${String(index + 1).padStart(3, "0")}`,
    },
    tags: index === 1 ? ["hard_filter"] : ["chinese_tokenization"],
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
});

afterAll(async () => {
  const cleanup = await Promise.allSettled(
    Object.values(indexNames).map(async (uid) => deleteIndexIfPresent(uid)),
  );
  const failures = cleanup.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) =>
        failure.reason instanceof Error ? failure.reason : new Error("Unknown cleanup failure."),
      ),
      "Failed to remove gold evaluator integration-test indexes.",
    );
  }
});

describe("search gold evaluator with Meilisearch", () => {
  it("evaluates all 50 queries, hard filters and latency against real search", async () => {
    const report = await evaluateSearchGoldSet(goldSet, service);

    expect(report.metrics.query_count).toBe(50);
    expect(report.metrics.top_5_hit_rate).toBe(1);
    expect(report.metrics.critical_hit_rate).toBe(1);
    expect(report.metrics.filter_accuracy).toBe(1);
    expect(report.metrics.p95_latency_ms).toBeLessThanOrEqual(500);
    expect(report.technical_gate_passed).toBe(true);
    expect(report.release_gate_passed).toBe(true);
  });
});
