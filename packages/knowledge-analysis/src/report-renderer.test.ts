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
    const rendered = renderAnalysisReport(reportSpec());
    const interactive = Buffer.from(rendered.interactive).toString("utf8");
    const staticHtml = Buffer.from(rendered.static).toString("utf8");
    expect(interactive).toContain('data-action="zoom-in"');
    expect(interactive).toContain('data-action="focus"');
    expect(interactive).toContain('id="report-search"');
    expect(interactive).toContain('data-action="collapse"');
    expect(interactive).toContain('data-series="讲座"');
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
});
