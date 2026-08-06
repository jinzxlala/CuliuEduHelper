import { ModelGatewayError, type JsonModelProvider, type JsonModelResult } from "@culiu/ai";
import { describe, expect, it } from "vitest";

import { buildKnowledgeSubmission } from "./submission.js";
import {
  createDeterministicMockKnowledgeExtractionProvider,
  ExtractedCaseTypeSchema,
  generateKnowledgeExtractionWithRepair,
  KNOWLEDGE_EXTRACTION_MAX_MODEL_ATTEMPTS,
  KNOWLEDGE_EXTRACTION_SYSTEM_PROMPT,
  renderKnowledgeAnalysisMarkdown,
  sanitizeKnowledgeTranscriptForModel,
} from "./knowledge-extraction.js";

describe("knowledge transcript extraction", () => {
  it("normalizes bounded legacy case type wording", () => {
    expect(ExtractedCaseTypeSchema.parse("科研竞赛型申请")).toBe("科研与竞赛案例");
    expect(() => ExtractedCaseTypeSchema.parse("随意分类")).toThrow();
  });

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
    expect(submission.documents.cases[0]).toMatchObject({
      core_projects: [{ name: "虚构测试项目" }],
      development_path: ["识别问题", "完成项目"],
      evidence_points: [
        { source_locator: "00:00:01-00:00:02" },
        { source_locator: "00:00:03-00:00:04" },
      ],
      verified_facts: ["逐字稿陈述其完成了虚构项目", "逐字稿陈述其形成了测试报告"],
    });
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
      lecture: {
        date: null,
        dateConfidence: "未知",
        dateEvidence: "文件名只有月日，正文未说明年份。",
        title: "跨学科学习讲座",
        titleConfidence: "中",
        titleEvidence: "根据逐字稿持续讨论主题概括。",
      },
      majors: [],
      organization: "未披露",
      quotes: [],
      schemaVersion: "knowledge-analysis-markdown.v6",
      schools: [],
      speakers: [],
      summary: "讲座讨论跨学科学习。",
      trends: [],
    });

    expect(markdown).toContain("先确认兴趣\n再完成小型项目");
    expect(markdown).toContain("## 案例卡片\n\n未披露");
    expect(markdown).toContain("## 关键原话\n\n- 未披露");
    expect(markdown).toContain("- 讲座日期：待人工确认");
    expect(markdown).toContain("# 跨学科学习讲座");
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
      lecture: {
        date: "2026-08-02",
        dateConfidence: "高",
        dateEvidence: "文件名和正文日期一致。",
        title: "虚构讲座",
        titleConfidence: "高",
        titleEvidence: "正文开场明确主题。",
      },
      majors: [],
      organization: "未披露",
      quotes,
      schemaVersion: "knowledge-analysis-markdown.v6",
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

  it("declares lecture as an exact required top-level field", () => {
    expect(KNOWLEDGE_EXTRACTION_SYSTEM_PROMPT).toContain('"exactTopLevelKeys"');
    expect(KNOWLEDGE_EXTRACTION_SYSTEM_PROMPT).toMatch(/"exactTopLevelKeys":\[[^\]]*"lecture"/u);
  });

  it("repairs a schema-invalid lecture response without exposing model content", async () => {
    const validProvider = createDeterministicMockKnowledgeExtractionProvider();
    const valid = await validProvider.generateJson({ systemPrompt: "test", userPrompt: "test" });
    const requests: string[] = [];
    const responses: JsonModelResult[] = [
      { ...valid, json: { ...(valid.json as Record<string, unknown>), lecture: "错误类型" } },
      valid,
    ];
    const provider: JsonModelProvider = {
      generateJson(request) {
        requests.push(request.userPrompt);
        const response = responses.shift();
        if (response === undefined) throw new Error("Unexpected model call.");
        return Promise.resolve(response);
      },
    };

    const generated = await generateKnowledgeExtractionWithRepair(provider, {
      systemPrompt: KNOWLEDGE_EXTRACTION_SYSTEM_PROMPT,
      userPrompt: "虚构逐字稿",
    });

    expect(generated.output.lecture.title).toBe("虚构跨学科讲座");
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain("lecture");
    expect(requests[1]).toContain("根对象必须完整包含exactTopLevelKeys");
    expect(requests[1]).not.toContain("错误类型");
  });

  it("retries truncated output with deterministic compact limits", async () => {
    const validProvider = createDeterministicMockKnowledgeExtractionProvider();
    const valid = await validProvider.generateJson({ systemPrompt: "test", userPrompt: "test" });
    const requests: string[] = [];
    let call = 0;
    const provider: JsonModelProvider = {
      generateJson(request) {
        requests.push(request.userPrompt);
        call += 1;
        if (call === 1) {
          return Promise.reject(
            new ModelGatewayError("invalid_output", "Synthetic truncation.", {
              detailCode: "output_truncated",
              retryable: true,
            }),
          );
        }
        return Promise.resolve(valid);
      },
    };

    await expect(
      generateKnowledgeExtractionWithRepair(provider, {
        systemPrompt: KNOWLEDGE_EXTRACTION_SYSTEM_PROMPT,
        userPrompt: "虚构逐字稿",
      }),
    ).resolves.toMatchObject({ output: { schemaVersion: "knowledge-analysis-markdown.v6" } });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain("最多保留8张证据最强的案例");
    expect(requests[1]).toContain("绝不能截断JSON");
  });

  it("stops after the bounded number of compact retries", async () => {
    let calls = 0;
    const provider: JsonModelProvider = {
      generateJson() {
        calls += 1;
        return Promise.reject(
          new ModelGatewayError("invalid_output", "Synthetic truncation.", {
            detailCode: "output_truncated",
            retryable: true,
          }),
        );
      },
    };

    await expect(
      generateKnowledgeExtractionWithRepair(provider, {
        systemPrompt: KNOWLEDGE_EXTRACTION_SYSTEM_PROMPT,
        userPrompt: "虚构逐字稿",
      }),
    ).rejects.toMatchObject({ detailCode: "output_truncated" });
    expect(calls).toBe(KNOWLEDGE_EXTRACTION_MAX_MODEL_ATTEMPTS);
  });
});
