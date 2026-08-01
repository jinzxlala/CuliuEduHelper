import { describe, expect, it } from "vitest";

import { KnowledgeDocumentIntegrityError, validateKnowledgeDocumentSet } from "./integrity.js";

const documents = {
  cases: [
    {
      academic_label: "数学与哲学",
      activity_types: ["社区活动"],
      admission_result: "虚构录取结果",
      ai_depth: "method",
      ai_domains: ["NLP"],
      background: "虚构案例背景。",
      case_id: "case_demo_001",
      case_type: "student_admission",
      confidence: "medium",
      curriculum_system: "AP",
      evidence_boundary: "未披露样本规模。",
      lecture_id: "lecture_demo_001",
      major: "数学",
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
      summary: "虚构讲座摘要。",
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
} as const;

describe("validateKnowledgeDocumentSet", () => {
  it("accepts same-lecture evidence references", () => {
    expect(validateKnowledgeDocumentSet(documents)).toEqual(documents);
  });

  it("rejects duplicate identifiers", () => {
    expect(() =>
      validateKnowledgeDocumentSet({
        ...documents,
        lectures: [documents.lectures[0], documents.lectures[0]],
      }),
    ).toThrow(KnowledgeDocumentIntegrityError);
  });

  it("rejects a missing transcript segment reference", () => {
    expect(() =>
      validateKnowledgeDocumentSet({
        ...documents,
        cases: [
          {
            ...documents.cases[0],
            timestamp_refs: [
              { ...documents.cases[0].timestamp_refs[0], segment_id: "segment_missing" },
            ],
          },
        ],
      }),
    ).toThrow(KnowledgeDocumentIntegrityError);
  });

  it("rejects cross-lecture case references", () => {
    expect(() =>
      validateKnowledgeDocumentSet({
        ...documents,
        lectures: [
          ...documents.lectures,
          { ...documents.lectures[0], lecture_id: "lecture_demo_002" },
        ],
        transcriptSegments: [
          { ...documents.transcriptSegments[0], lecture_id: "lecture_demo_002" },
        ],
      }),
    ).toThrow(KnowledgeDocumentIntegrityError);
  });

  it("rejects one-way case and transcript associations", () => {
    expect(() =>
      validateKnowledgeDocumentSet({
        ...documents,
        transcriptSegments: [{ ...documents.transcriptSegments[0], case_ids: [] }],
      }),
    ).toThrow(KnowledgeDocumentIntegrityError);

    expect(() =>
      validateKnowledgeDocumentSet({
        ...documents,
        cases: [{ ...documents.cases[0], timestamp_refs: [] }],
      }),
    ).toThrow(KnowledgeDocumentIntegrityError);
  });
});
