import { describe, expect, it } from "vitest";

import type { LectureSourceBundle } from "./contracts.js";
import { contentSha256, parseAnalysisDocuments } from "./analysis-documents.js";

const hash = "a".repeat(64);

const bundle: LectureSourceBundle = {
  analysis_sections: {
    actions: "8. 行动建议",
    ai_cross_disciplinary: "5. AI+与跨学科",
    basics: "1. 基础信息",
    cases: "4. 学校与案例卡片",
    evidence: "9. 证据质量",
    failures: "6. 失败与反例",
    quotes: "7. 关键原话",
    summary: "2. 摘要",
    trends: "3. 趋势清单",
  },
  bundle_hash: hash,
  lecture_date: "2026-03-14",
  lecture_id: "lecture_20260314_aaaaaaaaaaaa",
  source_key: "2026-03-14_测试讲座",
  sources: [
    {
      bytes: 10,
      content_sha256: hash,
      logical_path: "knowledge/analysis/2026-03-14_测试讲座.md",
      mime_type: "text/markdown",
      relative_path: "2026-03-14_测试讲座.md",
      role: "analysis_markdown",
      root_id: "analysis",
    },
    {
      bytes: 10,
      content_sha256: hash,
      logical_path: "knowledge/transcripts/2026/2026-03-14_测试讲座.json",
      mime_type: "application/json",
      relative_path: "2026-03-14_测试讲座.json",
      role: "transcript_json",
      root_id: "transcripts_2026",
    },
    {
      bytes: 10,
      content_sha256: hash,
      logical_path: "knowledge/transcripts/2026/2026-03-14_测试讲座.qa.json",
      mime_type: "application/json",
      relative_path: "2026-03-14_测试讲座.qa.json",
      role: "transcript_qa",
      root_id: "transcripts_2026",
    },
    {
      bytes: 10,
      content_sha256: hash,
      logical_path: "knowledge/transcripts/2026/2026-03-14_测试讲座.srt",
      mime_type: "application/x-subrip",
      relative_path: "2026-03-14_测试讲座.srt",
      role: "transcript_srt",
      root_id: "transcripts_2026",
    },
    {
      bytes: 10,
      content_sha256: hash,
      logical_path: "knowledge/transcripts/2026/2026-03-14_测试讲座.txt",
      mime_type: "text/plain",
      relative_path: "2026-03-14_测试讲座.txt",
      role: "transcript_text",
      root_id: "transcripts_2026",
    },
  ],
  title: "测试讲座",
  transcript_validation: {
    changed_sentence_count: 0,
    duration_seconds: 1,
    sentence_count: 1,
    srt_cue_count: 1,
    text_line_count: 1,
  },
};

const markdown = `# 测试讲座

## 1. 基础信息

| 字段 | 提取结果 | 标签 |
| --- | --- | --- |
| 机构 | EduKnow；合作学校 | 事实 |
| 主讲人 | Alice；Bob | 事实 |
| 学校 | Yale、Stanford；MIT | 事实 |
| 专业 | 经济学；计算机科学 | 事实 |

## 2. 摘要

这是一个保守摘要。

## 3. 趋势清单

- 趋势：重视长期主线。

## 4. 学校与案例卡片

### 学生画像卡A：气候经济——UChicago

- **基础背景：** 女生；其他信息未披露。
- **申请方向／结果：** 经济学方向，获 UChicago 录取。
- **一句话学术标签：** 用经济学研究气候行为。
- **研究方法：** 文献分析；问卷调查。
- **社会实践：** 公益讲座。
- **证据缺口：** 样本与导师未披露。
- **卡片性质：** 学生录取案例。

### 失败证据卡B：漂亮活动列表

- **风险：** 活动无法核验。
- **卡片性质：** 诚信与外部验证风险案例。

## 5. AI+与跨学科

使用 AI 工具辅助资料整理，不代表建立了模型。

## 6. 失败与反例

- 不能把单一活动写成录取原因。

## 7. 关键原话

原话。

## 8. 行动建议

建议。

## 9. 证据质量

需核验。
`;

describe("analysis document parser", () => {
  it("maps only explicit Markdown fields and keeps transcript references blocked", () => {
    const parsed = parseAnalysisDocuments(markdown, bundle, "fixture.md");

    expect(parsed.lecture).toMatchObject({
      lecture_id: bundle.lecture_id,
      organization: "EduKnow",
      speakers: ["Alice", "Bob"],
      schools: ["Yale", "Stanford", "MIT"],
      majors: ["经济学", "计算机科学"],
      summary: "这是一个保守摘要。",
    });
    expect(parsed.cases).toHaveLength(2);
    expect(parsed.cases[0]).toMatchObject({
      activity_types: ["研究", "活动"],
      admission_result: "经济学方向，获 UChicago 录取。",
      case_id: "case_20260314_aaaaaaaaaaaa_001",
      case_type: "学生录取案例",
      confidence: "unknown",
      schools: ["UChicago"],
      timestamp_refs: [],
    });
    expect(parsed.cases[1]).toMatchObject({
      case_id: "case_20260314_aaaaaaaaaaaa_002",
      case_type: "诚信风险案例",
      timestamp_refs: [],
    });
  });

  it("rejects a case section without level-three cards", () => {
    expect(() =>
      parseAnalysisDocuments(
        markdown.replace(/### /gu, "#### "),
        bundle,
        "fixture-without-cards.md",
      ),
    ).toThrow(/case section has no cards/u);
  });

  it("accepts an explicitly undisclosed case section without inventing a case card", () => {
    const withoutCases = markdown.replace(
      /## 4\. 学校与案例卡片[\s\S]*?## 5\. AI\+与跨学科/u,
      "## 4. 学校与案例卡片\n\n未披露\n\n## 5. AI+与跨学科",
    );
    const parsed = parseAnalysisDocuments(withoutCases, bundle, "fixture-without-cases.md");

    expect(parsed.cases).toHaveLength(0);
  });

  it("computes a deterministic byte digest", () => {
    expect(contentSha256(Buffer.from("abc", "utf8"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
