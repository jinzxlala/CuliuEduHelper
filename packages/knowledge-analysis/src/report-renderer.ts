import { createHash } from "node:crypto";

import { z } from "zod";

import {
  AnalysisReportSpecSchema,
  KnowledgeSourceReferenceSchema,
  type AnalysisReportSpec,
  type KnowledgeCitation,
} from "./contracts.js";

export const ANALYSIS_REPORT_TEMPLATE_VERSION = "knowledge-analysis-report-html.v4" as const;
export const ANALYSIS_REPORT_MAX_BYTES = 2 * 1024 * 1024;

const ReportCitationPresentationSchema = z
  .array(
    z
      .object({
        publicDescription: z.string().trim().max(200),
        publicLabel: z.string().trim().min(1).max(120),
        source: KnowledgeSourceReferenceSchema,
      })
      .strict(),
  )
  .max(100)
  .superRefine((items, context) => {
    const identities = new Set<string>();
    items.forEach((item, index) => {
      const identity = citationIdentity(item.source);
      if (identities.has(identity))
        context.addIssue({
          code: "custom",
          message: "Citation presentation sources must be unique.",
          path: [index, "source"],
        });
      identities.add(identity);
    });
  });
export type ReportCitationPresentation = z.infer<typeof ReportCitationPresentationSchema>[number];

const INTERACTION_SCRIPT = `(()=>{"use strict";const d=document,r=d.documentElement,q=s=>d.querySelector(s),qa=s=>[...d.querySelectorAll(s)];let zoom=100,focus=null,series=null;const apply=()=>{r.style.setProperty('--report-zoom',String(zoom/100));qa('[data-section]').forEach(e=>e.classList.toggle('focus-hidden',focus!==null&&e.id!==focus));qa('[data-series-value]').forEach(e=>e.classList.toggle('series-muted',series!==null&&e.dataset.seriesValue!==series));q('[data-action="focus"]').classList.toggle('is-active',focus!==null);q('[data-action="focus"]').setAttribute('aria-pressed',String(focus!==null));qa('[data-series]').forEach(b=>b.setAttribute('aria-pressed',String(series===b.dataset.series)))};q('[data-action="zoom-in"]').addEventListener('click',()=>{zoom=Math.min(200,zoom+25);apply()});q('[data-action="zoom-out"]').addEventListener('click',()=>{zoom=Math.max(75,zoom-25);apply()});q('[data-action="focus"]').addEventListener('click',()=>{const e=d.querySelector('[data-section].selected');focus=focus===e?.id?null:e?.id||null;apply()});q('[data-action="reset"]').addEventListener('click',()=>{zoom=100;focus=null;series=null;qa('.selected,.search-hit,.collapsed').forEach(e=>e.classList.remove('selected','search-hit','collapsed'));qa('[data-action="collapse"]').forEach(b=>{b.textContent='− 收起内容';b.setAttribute('aria-expanded','true')});apply()});q('#report-search').addEventListener('input',e=>{const v=e.target.value.trim().toLocaleLowerCase();qa('[data-searchable]').forEach(x=>x.classList.toggle('search-hit',v!==''&&x.textContent.toLocaleLowerCase().includes(v))) });qa('[data-section]').forEach(e=>e.addEventListener('click',x=>{if(x.target.closest('button,input,a'))return;qa('[data-section]').forEach(s=>s.classList.remove('selected'));e.classList.add('selected')}));qa('[data-action="collapse"]').forEach(b=>b.addEventListener('click',()=>{const e=b.closest('[data-section]'),collapsed=e.classList.toggle('collapsed');b.textContent=collapsed?'＋ 展开内容':'− 收起内容';b.setAttribute('aria-expanded',String(!collapsed))}));qa('[data-series]').forEach(b=>b.addEventListener('click',()=>{series=series===b.dataset.series?null:b.dataset.series;apply()}));apply()})();`;

const STYLE = `:root{--ink:#112f48;--accent:#f45b16;--accent-dark:#c9430d;--accent-soft:#fff0e8;--paper:#fffdf8;--muted:#62717d;--line:#d9e1e5;--report-zoom:1}*{box-sizing:border-box}body{margin:0;background:#f3efe7;color:var(--ink);font-family:"Microsoft YaHei",system-ui,sans-serif}.toolbar{position:sticky;top:0;z-index:5;display:flex;gap:.65rem;align-items:center;flex-wrap:wrap;padding:.9rem 1.2rem;background:#112f48;border-bottom:3px solid var(--accent);color:#fff;box-shadow:0 8px 24px #071c2d33}.toolbar button,.toolbar input{min-height:2.75rem;font:inherit;border-radius:.7rem;transition:border-color .16s ease,background .16s ease,color .16s ease,box-shadow .16s ease,transform .16s ease}.toolbar button{appearance:none;border:1px solid #d8e4ec;background:#fff;color:var(--ink);font-weight:700;padding:.55rem .9rem;cursor:pointer;box-shadow:0 2px 0 #071c2d40}.toolbar button:hover{border-color:var(--accent);color:var(--accent-dark);transform:translateY(-1px);box-shadow:0 5px 14px #071c2d45}.toolbar button:active{transform:translateY(0);box-shadow:none}.toolbar button:focus-visible,.toolbar input:focus-visible,.section-toggle:focus-visible,.legend button:focus-visible{outline:3px solid #ffb58f;outline-offset:2px}.toolbar button[data-action="focus"]{border-color:var(--accent);background:var(--accent);color:#fff}.toolbar button[data-action="focus"]:hover,.toolbar button[data-action="focus"].is-active{background:var(--accent-dark);border-color:var(--accent-dark);color:#fff}.toolbar button[data-action="reset"]{border-color:#668198;background:transparent;color:#fff;box-shadow:none}.toolbar button[data-action="reset"]:hover{border-color:#fff;background:#ffffff14;color:#fff}.toolbar input{flex:1 1 16rem;min-width:15rem;border:1px solid #adc4d4;background:#f8fbfd;color:var(--ink);padding:.55rem .85rem;box-shadow:inset 0 1px 2px #071c2d12}.toolbar input::placeholder{color:#748593}.report{width:min(1080px,calc(100% - 2rem));margin:1.5rem auto;padding:2rem;background:var(--paper);transform-origin:top center;font-size:calc(1rem * var(--report-zoom));box-shadow:0 12px 36px #112f4820}.report-header{border-top:6px solid var(--accent);padding-top:1rem}.eyebrow{color:var(--accent);font-weight:700;letter-spacing:.08em}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:.8rem}.metric,.section{border:1px solid var(--line);border-radius:.8rem;padding:1rem}.metric strong{font-size:1.7em;display:block}.section{margin-top:1rem;transition:opacity .2s ease,background .2s ease,outline-color .2s ease}.section.selected{outline:4px solid #f45b1660}.section.search-hit{background:#fff1a8}.section.collapsed .section-body{display:none}.section h2{margin:0}.section-head{display:flex;justify-content:space-between;align-items:center;gap:1rem}.section-toggle{appearance:none;flex:0 0 auto;min-height:2.5rem;border:1px solid #f7ad88;border-radius:999px;background:var(--accent-soft);color:var(--accent-dark);font:inherit;font-weight:700;padding:.45rem .85rem;cursor:pointer;transition:background .16s ease,color .16s ease,border-color .16s ease,transform .16s ease}.section-toggle:hover{border-color:var(--accent);background:var(--accent);color:#fff;transform:translateY(-1px)}.section-toggle:active{transform:translateY(0)}.chart{display:grid;gap:.5rem;margin:1rem 0}.bar-row{display:grid;grid-template-columns:minmax(7rem,14rem) 1fr 4rem;align-items:center;gap:.6rem}.bar-track{height:1rem;background:#e8edf0;border-radius:999px;overflow:hidden}.bar{height:100%;background:var(--accent)}.legend{display:flex;flex-wrap:wrap;gap:.5rem}.legend button{appearance:none;border:1px solid var(--line);background:#fff;border-radius:999px;color:var(--ink);font:inherit;font-weight:600;padding:.38rem .75rem;cursor:pointer;transition:background .16s ease,color .16s ease,border-color .16s ease}.legend button:hover,.legend button[aria-pressed="true"]{border-color:var(--accent);background:var(--accent-soft);color:var(--accent-dark)}.focus-hidden,.series-muted{opacity:.16}.citations{display:grid;gap:.65rem;margin:1rem 0 0;padding:1rem 1rem 1rem 2.7rem;border-radius:.7rem;background:#f4f7f8;color:var(--muted);font-size:.9em}.citation-claim{display:block;color:var(--ink)}.citation-public-source{display:block;margin-top:.25rem;color:var(--accent-dark);font-weight:700}.report-footer{margin-top:2rem;padding-top:1rem;border-top:1px solid var(--line);color:var(--muted);font-size:.85em}@media(max-width:640px){.toolbar{gap:.5rem;padding:.75rem}.toolbar input{order:-1;flex-basis:100%;min-width:0}.toolbar button{flex:1 1 calc(50% - .5rem)}.toolbar button[data-action="focus"]{flex-basis:100%}.report{width:100%;margin:0;padding:1rem}.section-head{align-items:flex-start;flex-direction:column}.section-toggle{align-self:flex-end}.bar-row{grid-template-columns:7rem 1fr 3rem}}@media print{.toolbar{display:none}.report{box-shadow:none;width:100%;margin:0}.focus-hidden,.series-muted{opacity:1}}`;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function citationIdentity(source: KnowledgeCitation["source"]): string {
  return `${source.batchId}:${source.contentHash}:${source.sourceType}:${source.sourceId}`;
}

function fallbackCitationPresentation(spec: AnalysisReportSpec): ReportCitationPresentation[] {
  const output: ReportCitationPresentation[] = [];
  const seen = new Set<string>();
  const counters = { case: 0, lecture: 0 };
  for (const citation of spec.sections.flatMap((section) => section.citations)) {
    const identity = citationIdentity(citation.source);
    if (seen.has(identity)) continue;
    seen.add(identity);
    counters[citation.source.sourceType] += 1;
    output.push({
      publicDescription: "",
      publicLabel:
        citation.source.sourceType === "case"
          ? `匿名案例 ${String(counters.case).padStart(2, "0")}`
          : `讲座资料 ${String(counters.lecture).padStart(2, "0")}`,
      source: citation.source,
    });
  }
  return output;
}

function sanitizePublicText(
  value: string,
  presentations: ReadonlyMap<string, ReportCitationPresentation>,
): string {
  let output = value;
  const batchIds = new Set<string>();
  for (const presentation of presentations.values()) {
    batchIds.add(presentation.source.batchId);
    output = output.replaceAll(presentation.source.sourceId, presentation.publicLabel);
    output = output.replaceAll(presentation.source.contentHash, "内部版本");
    output = output.replaceAll(presentation.source.contentHash.slice(0, 12), "内部版本");
  }
  for (const batchId of batchIds) output = output.replaceAll(batchId, "资料批次");
  return output
    .replace(/\b(?:case|lecture)[_:][a-z0-9_-]+\b/giu, "内部资料")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/giu, "内部引用")
    .replace(/\b[0-9a-f]{16,}\b/giu, "内部版本");
}

function sanitizeReportSpec(
  spec: AnalysisReportSpec,
  presentations: ReadonlyMap<string, ReportCitationPresentation>,
): AnalysisReportSpec {
  const sanitize = (value: string): string => sanitizePublicText(value, presentations);
  return {
    executiveSummary: sanitize(spec.executiveSummary),
    metrics: spec.metrics.map((metric) => ({
      detail: sanitize(metric.detail),
      label: sanitize(metric.label),
      value: sanitize(metric.value),
    })),
    sections: spec.sections.map((section) => ({
      ...section,
      chart:
        section.chart === null
          ? null
          : {
              ...section.chart,
              points: section.chart.points.map((point) => ({
                ...point,
                label: sanitize(point.label),
              })),
              title: sanitize(section.chart.title),
            },
      citations: section.citations.map((citation) => ({
        ...citation,
        claim: sanitize(citation.claim),
      })),
      paragraphs: section.paragraphs.map(sanitize),
      title: sanitize(section.title),
    })),
    title: sanitize(spec.title),
  };
}

function renderCitation(
  citation: KnowledgeCitation,
  presentations: ReadonlyMap<string, ReportCitationPresentation>,
): string {
  const presentation = presentations.get(citationIdentity(citation.source));
  if (presentation === undefined) throw new Error("report_citation_presentation_missing");
  const publicDescription = sanitizePublicText(presentation.publicDescription, presentations);
  const publicReference =
    publicDescription === ""
      ? presentation.publicLabel
      : `${presentation.publicLabel}：${publicDescription}`;
  return `<li><span class="citation-claim">${escapeHtml(citation.claim)}</span><span class="citation-public-source">【${escapeHtml(publicReference)}】</span></li>`;
}

function scriptHashes(): { base64: string; hex: string } {
  const digest = createHash("sha256").update(INTERACTION_SCRIPT, "utf8");
  return {
    base64: digest.digest("base64"),
    hex: createHash("sha256").update(INTERACTION_SCRIPT, "utf8").digest("hex"),
  };
}

function renderChart(chart: NonNullable<AnalysisReportSpec["sections"][number]["chart"]>): string {
  const maximum = Math.max(...chart.points.map((point) => Math.abs(point.value)), 1);
  const rows = chart.points
    .map(
      (point) =>
        `<div class="bar-row" data-searchable data-series-value="${escapeHtml(point.label)}"><span>${escapeHtml(point.label)}</span><div class="bar-track"><div class="bar" style="width:${String(Math.max(0, Math.min(100, Math.round((Math.abs(point.value) / maximum) * 100))))}%"></div></div><strong>${escapeHtml(String(point.value))}</strong></div>`,
    )
    .join("");
  const legend = chart.points
    .map(
      (point) =>
        `<button type="button" aria-pressed="false" data-series="${escapeHtml(point.label)}">${escapeHtml(point.label)}</button>`,
    )
    .join("");
  return `<figure class="chart"><figcaption><strong>${escapeHtml(chart.title)}</strong></figcaption>${rows}<div class="legend">${legend}</div></figure>`;
}

function renderBody(
  spec: AnalysisReportSpec,
  interactive: boolean,
  presentations: ReadonlyMap<string, ReportCitationPresentation>,
): string {
  const metrics = spec.metrics
    .map((metric) => {
      const detail =
        metric.label === "资料"
          ? "本次分析采用的资料总数"
          : metric.label === "讲座"
            ? "本次分析采用的讲座资料"
            : metric.label === "案例"
              ? "本次分析采用的匿名案例"
              : metric.detail;
      return `<article class="metric" data-searchable><span>${escapeHtml(metric.label)}</span><strong>${escapeHtml(metric.value)}</strong><small>${escapeHtml(detail)}</small></article>`;
    })
    .join("");
  const sections = spec.sections
    .map(
      (section) =>
        `<section class="section" id="${escapeHtml(section.id)}" data-section data-searchable><div class="section-head"><h2>${escapeHtml(section.title)}</h2>${interactive ? '<button class="section-toggle" type="button" aria-expanded="true" data-action="collapse">− 收起内容</button>' : ""}</div><div class="section-body">${section.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("")}${section.chart === null ? "" : renderChart(section.chart)}${section.citations.length === 0 ? "" : `<ol class="citations">${section.citations.map((citation) => renderCitation(citation, presentations)).join("")}</ol>`}</div></section>`,
    )
    .join("");
  return `<main class="report"><header class="report-header" data-searchable><p class="eyebrow">醋溜教育 · 分析报告</p><h1>${escapeHtml(spec.title)}</h1><p>${escapeHtml(spec.executiveSummary)}</p></header><section class="metrics">${metrics}</section>${sections}<footer class="report-footer">本报告基于所选资料与当前分析快照生成；统计采用一致口径计算，引用不会因页面交互而改变。</footer></main>`;
}

function validateHtml(html: string, interactive: boolean, expectedBase64Hash: string): void {
  if (Buffer.byteLength(html, "utf8") > ANALYSIS_REPORT_MAX_BYTES)
    throw new Error("report_html_too_large");
  const forbidden = [
    /https?:\/\//iu,
    /<[^>]+\son[a-z]+\s*=/iu,
    /<(?:iframe|object|embed|form|svg)\b/iu,
    /url\s*\(/iu,
    /eval\s*\(/iu,
    /new\s+Function/iu,
  ];
  if (forbidden.some((pattern) => pattern.test(html))) throw new Error("unsafe_report_html");
  if (interactive) {
    if (
      !html.includes(`script-src 'sha256-${expectedBase64Hash}'`) ||
      (html.match(/<script>/gu)?.length ?? 0) !== 1 ||
      !html.includes(INTERACTION_SCRIPT)
    )
      throw new Error("report_script_integrity_failed");
  } else if (/<script\b/iu.test(html)) throw new Error("static_report_contains_script");
}

function validatePublicReferenceSafety(
  html: string,
  presentations: ReportCitationPresentation[],
): void {
  for (const presentation of presentations) {
    if (
      html.includes(presentation.source.batchId) ||
      html.includes(presentation.source.sourceId) ||
      html.includes(presentation.source.contentHash) ||
      html.includes(presentation.source.contentHash.slice(0, 12))
    )
      throw new Error("public_report_contains_internal_reference");
  }
  if (/\b(?:case|lecture)[_:][a-z0-9_-]+\b/iu.test(html))
    throw new Error("public_report_contains_internal_reference");
}

export function renderAnalysisReport(
  untrustedSpec: unknown,
  untrustedPresentations?: unknown,
): {
  interactive: Uint8Array;
  scriptHash: string;
  static: Uint8Array;
} {
  const spec = AnalysisReportSpecSchema.parse(untrustedSpec);
  const presentationList = ReportCitationPresentationSchema.parse(
    untrustedPresentations ?? fallbackCitationPresentation(spec),
  );
  const presentations = new Map(
    presentationList.map((presentation) => [citationIdentity(presentation.source), presentation]),
  );
  for (const citation of spec.sections.flatMap((section) => section.citations))
    if (!presentations.has(citationIdentity(citation.source)))
      throw new Error("report_citation_presentation_missing");
  const publicSpec = sanitizeReportSpec(spec, presentations);
  const hashes = scriptHashes();
  const staticCsp =
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'";
  const interactiveCsp = `${staticCsp}; script-src 'sha256-${hashes.base64}'`;
  const build = (interactive: boolean): string =>
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${interactive ? interactiveCsp : staticCsp}"><title>${escapeHtml(publicSpec.title)}</title><style>${STYLE}</style></head><body>${interactive ? '<nav class="toolbar" aria-label="报告查看工具"><button type="button" aria-label="缩小报告" data-action="zoom-out">− 缩小</button><button type="button" aria-label="放大报告" data-action="zoom-in">＋ 放大</button><button type="button" aria-pressed="false" data-action="focus">◎ 专注选中</button><input id="report-search" type="search" aria-label="页内搜索" placeholder="搜索报告内容"><button type="button" data-action="reset">↺ 重置</button></nav>' : ""}${renderBody(publicSpec, interactive, presentations)}${interactive ? `<script>${INTERACTION_SCRIPT}</script>` : ""}</body></html>`;
  const interactiveHtml = build(true);
  const staticHtml = build(false);
  validateHtml(interactiveHtml, true, hashes.base64);
  validateHtml(staticHtml, false, hashes.base64);
  validatePublicReferenceSafety(interactiveHtml, presentationList);
  validatePublicReferenceSafety(staticHtml, presentationList);
  return {
    interactive: Buffer.from(interactiveHtml, "utf8"),
    scriptHash: hashes.hex,
    static: Buffer.from(staticHtml, "utf8"),
  };
}
