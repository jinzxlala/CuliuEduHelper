import { describe, expect, it } from "vitest";

import {
  buildKnowledgeSubmission,
  buildKnowledgeSubmissionBatch,
  type SubmittedKnowledgeFile,
} from "./submission.js";

const encoder = new TextEncoder();
const sourceKey = "2026-08-02_synthetic_lecture";

function file(suffix: string, content: string): SubmittedKnowledgeFile {
  return { bytes: encoder.encode(content), fileName: `${sourceKey}${suffix}` };
}

function analysis(): SubmittedKnowledgeFile {
  return file(
    ".md",
    `# 虚构讲座

## 基础信息
- 主办机构：虚构机构
- 主讲人：匿名讲者

## 摘要
这是一场用于测试的虚构讲座。

## 趋势
跨学科探索。

## 案例卡片
### 虚构案例
- 背景：匿名测试背景
- 申请方向/结果：虚构结果
- 可信度：低
- 证据边界：仅用于自动化测试

## AI+与跨学科
未披露。

## 失败与反例
未披露。

## 关键原话
“虚构测试原话。”

## 醋溜科技行动建议
仅用于验证。

## 证据边界
全部内容均为虚构测试数据。
`,
  );
}

function transcriptJson(): SubmittedKnowledgeFile {
  return file(
    ".json",
    JSON.stringify({
      complete: true,
      duration_seconds: 2,
      forced_aligner: "synthetic",
      generated_at: "2026-08-02T00:00:00+08:00",
      language: "Chinese",
      method: "synthetic",
      model: "synthetic",
      sentence_count: 1,
      sentences: [
        { changes: [], end: 1.5, original_text: "虚构内容。", start: 0.1, text: "虚构内容。" },
      ],
      source: "redacted.mp4",
      source_json: "redacted.json",
      tokens: [],
      transcribed_until_seconds: 2,
      version: "synthetic-v1",
    }),
  );
}

function qa(): SubmittedKnowledgeFile {
  return file(
    ".qa.json",
    JSON.stringify({
      changed_sentence_count: 0,
      complete: true,
      method: "synthetic",
      rule_counts: {},
      sentence_count: 1,
      source_json: "redacted.json",
      source_sha256: "0".repeat(64),
      version: "synthetic-v1",
    }),
  );
}

describe("knowledge submissions", () => {
  it("builds an analysis-only single-lecture import", () => {
    const loaded = buildKnowledgeSubmission({ analysis: analysis() });
    expect(loaded.manifest.lecture_count).toBe(1);
    expect(loaded.sources.map((item) => item.descriptor.role)).toEqual(["analysis_markdown"]);
    expect(loaded.documents.lectures[0]?.title).toBe("虚构讲座");
    expect(loaded.documents.cases).toHaveLength(1);
  });

  it("validates and builds a complete evidence package", () => {
    const loaded = buildKnowledgeSubmission({
      analysis: analysis(),
      transcriptJson: transcriptJson(),
      transcriptQa: qa(),
      transcriptSrt: file(".srt", "1\n00:00:00,100 --> 00:00:01,500\n虚构内容。\n"),
      transcriptText: file(".txt", "[00:00:00.100 - 00:00:01.500] 虚构内容。\n"),
    });
    expect(loaded.sources).toHaveLength(5);
    expect(loaded.manifest.lectures[0]?.transcript_validation?.sentence_count).toBe(1);
    expect(loaded.documents.transcriptSegments).toEqual([]);
  });

  it("publishes an analysis with its single uploaded transcript document", () => {
    const transcriptDocument = {
      bytes: encoder.encode("synthetic-docx-bytes"),
      fileName: "0401_原文.docx",
    };
    const loaded = buildKnowledgeSubmission({ analysis: analysis(), transcriptDocument });

    expect(loaded.sources.map((item) => item.descriptor.role)).toEqual([
      "analysis_markdown",
      "transcript_text",
    ]);
    expect(loaded.sources[1]?.descriptor.mime_type).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(loaded.documents.transcriptSegments).toEqual([]);
  });

  it("combines multiple reviewed submissions into one deterministic import", () => {
    const secondAnalysis = analysis();
    const loaded = buildKnowledgeSubmissionBatch([
      {
        analysis: {
          bytes: encoder.encode(
            new TextDecoder().decode(secondAnalysis.bytes).replace("虚构讲座", "第二场虚构讲座"),
          ),
          fileName: "2026-08-03_second_synthetic_lecture.md",
        },
      },
      { analysis: analysis() },
    ]);

    expect(loaded.manifest.lecture_count).toBe(2);
    expect(loaded.manifest.expected_lecture_count).toBe(2);
    expect(loaded.manifest.lectures.map((item) => item.source_key)).toEqual([
      "2026-08-02_synthetic_lecture",
      "2026-08-03_second_synthetic_lecture",
    ]);
    expect(loaded.documents.lectures).toHaveLength(2);
    expect(loaded.documents.cases).toHaveLength(2);
    expect(loaded.sources).toHaveLength(2);
  });

  it("rejects duplicate lectures inside one publication batch", () => {
    expect(() =>
      buildKnowledgeSubmissionBatch([{ analysis: analysis() }, { analysis: analysis() }]),
    ).toThrow(/must be unique/u);
  });

  it("rejects mixing a single transcript document with the legacy evidence package", () => {
    expect(() =>
      buildKnowledgeSubmission({
        analysis: analysis(),
        transcriptDocument: file(".md", "虚构逐字稿"),
        transcriptJson: transcriptJson(),
        transcriptQa: qa(),
        transcriptSrt: file(".srt", "synthetic"),
        transcriptText: file(".txt", "synthetic"),
      }),
    ).toThrow(/cannot be combined/u);
  });

  it("rejects incomplete evidence packages", () => {
    expect(() =>
      buildKnowledgeSubmission({ analysis: analysis(), transcriptJson: transcriptJson() }),
    ).toThrow(/complete evidence package/u);
  });

  it("rejects mismatched evidence file base names", () => {
    expect(() =>
      buildKnowledgeSubmission({
        analysis: analysis(),
        transcriptJson: { ...transcriptJson(), fileName: "2026-08-02_other.json" },
        transcriptQa: qa(),
        transcriptSrt: file(".srt", "1\n00:00:00,100 --> 00:00:01,500\n虚构内容。\n"),
        transcriptText: file(".txt", "[00:00:00.100 - 00:00:01.500] 虚构内容。\n"),
      }),
    ).toThrow(/must be named/u);
  });
});
