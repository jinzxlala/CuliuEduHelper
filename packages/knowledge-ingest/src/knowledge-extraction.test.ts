import { describe, expect, it } from "vitest";

import { buildKnowledgeSubmission } from "./submission.js";
import {
  createDeterministicMockKnowledgeExtractionProvider,
  renderKnowledgeAnalysisMarkdown,
  sanitizeKnowledgeTranscriptForModel,
} from "./knowledge-extraction.js";

describe("knowledge transcript extraction", () => {
  it("redacts common outbound identifiers before a model request", () => {
    const sanitized = sanitizeKnowledgeTranscriptForModel(
      "邮箱 student@example.com，手机 13800138000，编号 110101199901011234。",
    );

    expect(sanitized).toContain("[REDACTED_EMAIL]");
    expect(sanitized).toContain("[REDACTED_PHONE]");
    expect(sanitized).toContain("[REDACTED_IDENTIFIER]");
    expect(sanitized).not.toContain("student@example.com");
    expect(sanitized).not.toContain("13800138000");
  });

  it("turns strict model JSON into a publishable nine-section analysis", async () => {
    const provider = createDeterministicMockKnowledgeExtractionProvider();
    const result = await provider.generateJson({ systemPrompt: "test", userPrompt: "test" });
    const markdown = renderKnowledgeAnalysisMarkdown("虚构讲座", result.json);

    for (const heading of [
      "基础信息",
      "摘要",
      "趋势",
      "案例卡片",
      "AI+与跨学科",
      "失败与反例",
      "关键原话",
      "醋溜科技行动建议",
      "证据边界",
    ]) {
      expect(markdown).toContain(`## ${heading}`);
    }
    const submission = buildKnowledgeSubmission({
      analysis: {
        bytes: Buffer.from(markdown, "utf8"),
        fileName: "2026-08-02_虚构讲座.md",
      },
      transcriptDocument: {
        bytes: Buffer.from("虚构逐字稿", "utf8"),
        fileName: "2026-08-02_虚构讲座.md",
      },
    });
    expect(submission.documents.lectures).toHaveLength(1);
    expect(submission.documents.cases).toHaveLength(1);
  });

  it("rejects model output that does not match the extraction schema", () => {
    expect(() => renderKnowledgeAnalysisMarkdown("虚构讲座", { summary: "不完整" })).toThrow();
  });

  it("normalizes DeepSeek list-shaped narratives and preserves genuinely missing evidence", () => {
    const markdown = renderKnowledgeAnalysisMarkdown("虚构讲座", {
      actions: ["先确认兴趣", "再完成小型项目"],
      aiCrossDisciplinary: [],
      cases: [],
      evidenceBoundary: "仅依据虚构逐字稿。",
      failures: [],
      majors: [],
      organization: "未披露",
      quotes: [],
      schemaVersion: "knowledge-analysis-markdown.v3",
      schools: [],
      speakers: [],
      summary: "讲座讨论跨学科学习。",
      trends: [],
    });

    expect(markdown).toContain("先确认兴趣\n再完成小型项目");
    expect(markdown).toContain("## 案例卡片\n\n未披露");
    expect(markdown).toContain("## 关键原话\n\n- 未披露");
    const submission = buildKnowledgeSubmission({
      analysis: {
        bytes: Buffer.from(markdown, "utf8"),
        fileName: "2026-08-02_虚构讲座.md",
      },
    });
    expect(submission.documents.cases).toHaveLength(0);
  });

  it("normalizes quote objects and deterministically limits long quote lists", () => {
    const quotes = Array.from({ length: 35 }, (_, index) =>
      index === 0
        ? { context: "不应进入原话", quote: "这是一句虚构原话。", speaker: "匿名讲者" }
        : `虚构原话 ${String(index + 1)}`,
    );
    const markdown = renderKnowledgeAnalysisMarkdown("虚构讲座", {
      actions: "未披露",
      aiCrossDisciplinary: "未披露",
      cases: [],
      evidenceBoundary: "仅依据虚构逐字稿。",
      failures: "未披露",
      majors: [],
      organization: "未披露",
      quotes,
      schemaVersion: "knowledge-analysis-markdown.v3",
      schools: [],
      speakers: [],
      summary: "虚构摘要。",
      trends: [],
    });

    expect(markdown).toContain("- 这是一句虚构原话。");
    expect(markdown).not.toContain("不应进入原话");
    expect(markdown).toContain("虚构原话 30");
    expect(markdown).not.toContain("虚构原话 31");
  });
});
