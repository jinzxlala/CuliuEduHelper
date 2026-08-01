import type { DatabaseClient } from "@culiu/database";
import type { KnowledgeDocumentSet } from "@culiu/search";
import { describe, expect, it, vi } from "vitest";

import { KnowledgeImporter, type KnowledgeIndexPublisher } from "./importer.js";

function buildImporter(options: {
  readonly batchId?: string;
  readonly publish: (documents: KnowledgeDocumentSet) => Promise<void>;
}): KnowledgeImporter {
  const connection = {
    query: vi.fn((sql: string) => {
      if (sql.includes("from knowledge_import_batch")) {
        return Promise.resolve({
          rows: options.batchId === undefined ? [] : [{ id: options.batchId }],
        });
      }
      if (sql.includes("from knowledge_lecture_version")) {
        return Promise.resolve({
          rows: [
            {
              ai_cross_disciplinary_text: "AI跨学科",
              failure_text: "失败边界",
              lecture_date: new Date("2026-07-01T00:00:00.000Z"),
              lecture_id: "lecture_001",
              majors: ["计算机科学"],
              organization: "示例机构",
              schools: ["示例大学"],
              source_path: "analysis/lecture_001.md",
              speakers: ["匿名讲者"],
              summary: "讲座摘要",
              title: "示例讲座",
              trend_text: "趋势",
            },
          ],
        });
      }
      if (sql.includes("from knowledge_case_version")) {
        return Promise.resolve({
          rows: [
            {
              academic_label: "学术标签",
              activity_types: ["研究"],
              admission_result: "示例录取结果",
              ai_depth: "应用",
              ai_domains: ["教育"],
              background: "匿名背景",
              case_id: "case_001",
              case_type: "录取案例",
              confidence: "high",
              curriculum_system: "AP",
              evidence_boundary: "仅作知识参考",
              lecture_id: "lecture_001",
              major: "计算机科学",
              research_methods: ["访谈"],
              schools: ["示例大学"],
              timestamp_refs: [],
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    }),
    release: vi.fn(),
  };
  const databaseClient = {
    pool: { connect: () => Promise.resolve(connection) },
  } as unknown as DatabaseClient;
  const indexPublisher: KnowledgeIndexPublisher = {
    rebuildKnowledgeIndexes: async (documents) => {
      await options.publish(documents);
      return {
        documentCounts: {
          cases: documents.cases.length,
          lectures: documents.lectures.length,
          transcriptSegments: documents.transcriptSegments.length,
        },
        orphanedIndexes: [],
      };
    },
  };

  return new KnowledgeImporter({
    databaseClient,
    indexPublisher,
    manifestPath: "C:/unused/manifest.json",
    objectStore: {
      read: () => Promise.reject(new Error("not used by reconciliation")),
      store: () => Promise.reject(new Error("not used by reconciliation")),
    },
    sourceRoots: {},
  });
}

describe("KnowledgeImporter publication reconciliation", () => {
  it("rebuilds search from the current published database version", async () => {
    const publish = vi.fn<(documents: KnowledgeDocumentSet) => Promise<void>>(() =>
      Promise.resolve(),
    );
    const importer = buildImporter({ batchId: "batch-001", publish });

    await importer.reconcileCurrentPublication();

    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0]?.[0]).toMatchObject({
      cases: [{ case_id: "case_001", lecture_id: "lecture_001" }],
      lectures: [{ date: "2026-07-01", lecture_id: "lecture_001", title: "示例讲座" }],
      transcriptSegments: [],
    });
  });

  it("publishes empty indexes when no current database version exists", async () => {
    const publish = vi.fn<(documents: KnowledgeDocumentSet) => Promise<void>>(() =>
      Promise.resolve(),
    );
    const importer = buildImporter({ publish });

    await importer.reconcileCurrentPublication();

    expect(publish).toHaveBeenCalledWith({ cases: [], lectures: [], transcriptSegments: [] });
  });
});
