import { describe, expect, it } from "vitest";

import type { AnalysisReportSpec } from "./contracts.js";
import { renderAnalysisReport } from "./report-renderer.js";

function reportSpec(): AnalysisReportSpec {
  return {
    executiveSummary: "基于冻结资料生成的摘要。",
    metrics: [{ detail: "工作区冻结资料总数", label: "资料", value: "2" }],
    sections: [
      {
        chart: {
          points: [{ label: "讲座", sourceIds: ["lecture:1"], value: 1 }],
          title: "资料类型",
          type: "bar",
        },
        citations: [
          {
            claim: "该判断来自讲座。",
            source: {
              batchId: "00000000-0000-4000-8000-000000000001",
              contentHash: "a".repeat(64),
              sourceId: "lecture:1",
              sourceType: "lecture",
            },
          },
        ],
        id: "overview",
        paragraphs: ["报告正文。"],
        title: "概览",
      },
    ],
    title: "合成分析报告",
  } as const;
}

describe("analysis report renderer", () => {
  it("renders controlled interactions with a matching CSP hash and a script-free archive", () => {
    const spec = reportSpec();
    const source = spec.sections[0]?.citations[0]?.source;
    if (source === undefined) throw new Error("test fixture citation missing");
    const rendered = renderAnalysisReport(spec, [
      {
        publicDescription: "跨学科项目",
        publicLabel: "讲座资料 01",
        source,
      },
    ]);
    const interactive = Buffer.from(rendered.interactive).toString("utf8");
    const staticHtml = Buffer.from(rendered.static).toString("utf8");
    expect(interactive).toContain('data-action="zoom-in"');
    expect(interactive).toContain('data-action="focus"');
    expect(interactive).toContain('id="report-search"');
    expect(interactive).toContain('data-action="collapse"');
    expect(interactive).toContain('class="section-toggle"');
    expect(interactive).toContain('aria-expanded="true"');
    expect(interactive).toContain("− 收起内容");
    expect(interactive).toContain('data-series="讲座"');
    expect(interactive).toContain('aria-pressed="false"');
    expect(interactive).toContain("搜索报告内容");
    expect(interactive).toContain("【讲座资料 01：跨学科项目】");
    expect(interactive).toContain("醋溜教育 · 分析报告");
    expect(interactive).toContain("本次分析采用的资料总数");
    expect(interactive).not.toContain("内部分析报告");
    expect(interactive).not.toContain("工作区冻结资料总数");
    expect(interactive).not.toContain("lecture:1");
    expect(interactive).not.toContain("a".repeat(12));
    expect(interactive).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/u);
    expect(rendered.scriptHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(staticHtml).not.toContain("<script");
    expect(staticHtml).not.toContain('class="toolbar"');
    expect(staticHtml).toContain("报告正文");
  });

  it("escapes model-provided markup instead of making it executable", () => {
    const input = reportSpec();
    const rendered = renderAnalysisReport({
      ...input,
      executiveSummary: '<img src=x onerror="alert(1)">',
    });
    const html = Buffer.from(rendered.interactive).toString("utf8");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).not.toContain("<img src=x");
  });

  it("uses deterministic public aliases when no presentation catalog is supplied", () => {
    const html = Buffer.from(renderAnalysisReport(reportSpec()).static).toString("utf8");
    expect(html).toContain("【讲座资料 01】");
    expect(html).not.toContain("lecture:1");
    expect(html).not.toContain("a".repeat(12));
  });

  it("removes internal references even when the model repeats them outside citation metadata", () => {
    const input = reportSpec();
    const source = input.sections[0]?.citations[0]?.source;
    if (source === undefined) throw new Error("test fixture citation missing");
    const rendered = renderAnalysisReport(
      {
        ...input,
        executiveSummary: `来自 ${source.batchId} 的摘要`,
        sections: input.sections.map((section) => ({
          ...section,
          citations: section.citations.map((citation) => ({
            ...citation,
            claim: `引用 ${source.sourceId}`,
          })),
          paragraphs: [`版本 ${source.contentHash.slice(0, 12)}`],
        })),
        title: `关于 ${source.sourceId} 的分析`,
      },
      [{ publicDescription: "跨学科项目", publicLabel: "讲座资料 01", source }],
    );
    const html = Buffer.from(rendered.static).toString("utf8");
    expect(html).toContain("关于 讲座资料 01 的分析");
    expect(html).toContain("来自 资料批次 的摘要");
    expect(html).toContain("版本 内部版本");
    expect(html).not.toContain(source.batchId);
    expect(html).not.toContain(source.sourceId);
    expect(html).not.toContain(source.contentHash.slice(0, 12));
  });
});
