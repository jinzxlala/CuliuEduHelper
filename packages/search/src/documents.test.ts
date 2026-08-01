import { describe, expect, it } from "vitest";

import {
  CaseDocumentSchema,
  LectureDocumentSchema,
  TranscriptSegmentDocumentSchema,
} from "./documents.js";

const lecture = {
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
};

describe("knowledge document schemas", () => {
  it("accepts a strictly shaped lecture document", () => {
    expect(LectureDocumentSchema.parse(lecture)).toEqual(lecture);
  });

  it("rejects absolute and traversing source paths", () => {
    expect(() =>
      LectureDocumentSchema.parse({ ...lecture, source_path: "D:/private/raw.md" }),
    ).toThrow();
    expect(() => LectureDocumentSchema.parse({ ...lecture, source_path: "../raw.md" })).toThrow();
    expect(() =>
      LectureDocumentSchema.parse({ ...lecture, source_path: "2026\\lecture_demo\\analysis.md" }),
    ).toThrow();
  });

  it("rejects unknown fields instead of silently indexing them", () => {
    expect(() => LectureDocumentSchema.parse({ ...lecture, student_name: "禁止字段" })).toThrow();
  });

  it("rejects reversed transcript and case timestamp ranges", () => {
    expect(() =>
      TranscriptSegmentDocumentSchema.parse({
        case_ids: [],
        end_seconds: 10,
        lecture_id: "lecture_demo_001",
        section: "案例",
        segment_id: "segment_demo_001",
        source_path: "2026/lecture_demo/transcript.srt",
        start_seconds: 20,
        text: "虚构逐字稿。",
      }),
    ).toThrow();

    expect(() =>
      CaseDocumentSchema.parse({
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
            end_seconds: 10,
            segment_id: "segment_demo_001",
            source_path: "2026/lecture_demo/transcript.srt",
            start_seconds: 20,
          },
        ],
      }),
    ).toThrow();
  });
});
