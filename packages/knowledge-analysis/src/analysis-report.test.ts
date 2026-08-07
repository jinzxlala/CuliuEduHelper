import { randomUUID } from "node:crypto";

import { ModelGatewayError, type JsonModelProvider, type JsonModelResult } from "@culiu/ai";
import { describe, expect, it } from "vitest";

import {
  ANALYSIS_REPORT_MODEL_INPUT_MAX_CHARS,
  classifyAnalysisReportFailure,
  generateAnalysisReportNarrative,
  type LoadedReportSource,
} from "./analysis-report.js";

const batchId = "00000000-0000-4000-8000-000000000101";

function source(index: number, bodyLength = 20): LoadedReportSource {
  return {
    content: {
      academicLabel: `合成案例 ${String(index)}`,
      background: "合成背景".repeat(bodyLength),
      caseType: "student_admission",
      confidence: "high",
      major: index % 2 === 0 ? "计算机科学" : "经济学",
    },
    reference: {
      batchId,
      contentHash: index.toString(16).padStart(64, "0"),
      sourceId: `case_synthetic_${String(index).padStart(3, "0")}`,
      sourceType: "case",
    },
    title: `合成案例 ${String(index)}`,
  };
}

function result(json: unknown): JsonModelResult {
  return {
    json,
    model: "deepseek-v4-flash",
    providerRequestId: randomUUID(),
    usage: {
      completionTokens: 5,
      promptCacheHitTokens: 0,
      promptCacheMissTokens: 10,
      promptTokens: 10,
      totalTokens: 15,
    },
  };
}

function narrative(reference: LoadedReportSource["reference"]): Record<string, unknown> {
  return {
    executiveSummary: "合成资料已完成分批归纳。",
    sections: [
      {
        chartKey: "source_type",
        citations: [{ claim: "合成资料支持该判断。", source: reference }],
        id: "overview",
        paragraphs: ["这里只使用冻结资料和确定性统计。"],
        title: "资料概览",
      },
    ],
    title: "合成分析报告",
  };
}

describe("analysis report model pipeline", () => {
  it("keeps small reports on the direct one-call path", async () => {
    const item = source(1);
    let calls = 0;
    const provider: JsonModelProvider = {
      generateJson(request) {
        calls += 1;
        const input = JSON.parse(request.userPrompt) as { sources: Array<{ reference: unknown }> };
        expect(input.sources).toHaveLength(1);
        return Promise.resolve(result(narrative(item.reference)));
      },
    };

    const generated = await generateAnalysisReportNarrative({
      conversation: [{ citations: [], contentMarkdown: "请生成报告。", role: "user", sequence: 1 }],
      model: "deepseek-v4-flash",
      provider,
      requirements: "保持证据边界。",
      sources: [item],
    });

    expect(generated.mode).toBe("direct");
    expect(generated.modelCallCount).toBe(1);
    expect(generated.usage.totalTokens).toBe(15);
    expect(calls).toBe(1);
  });

  it("summarizes 200 large sources in bounded batches before final synthesis", async () => {
    const sources = Array.from({ length: 200 }, (_, index) => source(index + 1, 300));
    const promptLengths: number[] = [];
    const provider: JsonModelProvider = {
      generateJson(request) {
        promptLengths.push(request.userPrompt.length);
        const input = JSON.parse(request.userPrompt) as Record<string, unknown>;
        if (Array.isArray(input.sources)) {
          const first = input.sources[0] as { reference: LoadedReportSource["reference"] };
          return Promise.resolve(
            result({
              citations: [{ claim: "该批资料包含可用合成证据。", source: first.reference }],
              limitations: ["仅代表当前批次。"],
              summary: "当前批次已归纳。",
            }),
          );
        }
        if (Array.isArray(input.digests)) {
          const first = input.digests[0] as {
            citations: Array<{ source: LoadedReportSource["reference"] }>;
          };
          return Promise.resolve(
            result({
              citations: [
                { claim: "合并后的批次证据仍可追溯。", source: first.citations[0]?.source },
              ],
              limitations: ["这是压缩后的证据摘要。"],
              summary: "多个批次摘要已合并。",
            }),
          );
        }
        const digests = input.evidenceDigests as Array<{
          citations: Array<{ source: LoadedReportSource["reference"] }>;
        }>;
        const reference = digests[0]?.citations[0]?.source;
        if (reference === undefined) throw new Error("missing synthetic digest citation");
        return Promise.resolve(result(narrative(reference)));
      },
    };

    const generated = await generateAnalysisReportNarrative({
      conversation: [
        { citations: [], contentMarkdown: "分析全部资料。", role: "user", sequence: 1 },
      ],
      model: "deepseek-v4-flash",
      provider,
      requirements: "比较主要方向并说明样本边界。",
      sources,
    });

    expect(generated.mode).toBe("batched");
    expect(generated.modelCallCount).toBeGreaterThan(2);
    expect(generated.usage.totalTokens).toBe(generated.modelCallCount * 15);
    expect(Math.max(...promptLengths)).toBeLessThanOrEqual(ANALYSIS_REPORT_MODEL_INPUT_MAX_CHARS);
    expect(generated.charts.source_type[1]).toMatchObject({ label: "案例", value: 200 });
    expect(generated.charts.source_type[1]?.sourceIds).toHaveLength(100);
  });

  it("classifies deterministic limits and model gateway failures safely", () => {
    expect(classifyAnalysisReportFailure(new Error("report_context_limit_exceeded"))).toEqual({
      code: "report_context_limit_exceeded",
      summary: "工作区资料规模超过自动分批处理上限，请减少资料后重新生成。",
    });
    expect(
      classifyAnalysisReportFailure(
        new ModelGatewayError("invalid_output", "truncated", {
          detailCode: "output_truncated",
        }),
      ),
    ).toEqual({
      code: "model_output_truncated",
      summary: "DeepSeek 输出达到上限，报告内容被截断，请重新生成。",
    });
  });
});
