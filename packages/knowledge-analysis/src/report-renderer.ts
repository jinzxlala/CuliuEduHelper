import { createHash } from "node:crypto";

import { AnalysisReportSpecSchema, type AnalysisReportSpec } from "./contracts.js";

export const ANALYSIS_REPORT_TEMPLATE_VERSION = "knowledge-analysis-report-html.v1" as const;
export const ANALYSIS_REPORT_MAX_BYTES = 2 * 1024 * 1024;

const INTERACTION_SCRIPT = `(()=>{"use strict";const d=document,r=d.documentElement,q=s=>d.querySelector(s),qa=s=>[...d.querySelectorAll(s)];let zoom=100,focus=null,series=null;const apply=()=>{r.style.setProperty('--report-zoom',String(zoom/100));qa('[data-section]').forEach(e=>e.classList.toggle('focus-hidden',focus!==null&&e.id!==focus));qa('[data-series-value]').forEach(e=>e.classList.toggle('series-muted',series!==null&&e.dataset.seriesValue!==series))};q('[data-action="zoom-in"]').addEventListener('click',()=>{zoom=Math.min(200,zoom+25);apply()});q('[data-action="zoom-out"]').addEventListener('click',()=>{zoom=Math.max(75,zoom-25);apply()});q('[data-action="focus"]').addEventListener('click',()=>{const e=d.querySelector('[data-section].selected');focus=focus===e?.id?null:e?.id||null;apply()});q('[data-action="reset"]').addEventListener('click',()=>{zoom=100;focus=null;series=null;qa('.selected,.search-hit,.collapsed').forEach(e=>e.classList.remove('selected','search-hit','collapsed'));apply()});q('#report-search').addEventListener('input',e=>{const v=e.target.value.trim().toLocaleLowerCase();qa('[data-searchable]').forEach(x=>x.classList.toggle('search-hit',v!==''&&x.textContent.toLocaleLowerCase().includes(v))) });qa('[data-section]').forEach(e=>e.addEventListener('click',x=>{if(x.target.closest('button,input,a'))return;qa('[data-section]').forEach(s=>s.classList.remove('selected'));e.classList.add('selected')}));qa('[data-action="collapse"]').forEach(b=>b.addEventListener('click',()=>b.closest('[data-section]').classList.toggle('collapsed')));qa('[data-series]').forEach(b=>b.addEventListener('click',()=>{series=series===b.dataset.series?null:b.dataset.series;apply()}));})();`;

const STYLE = `:root{--ink:#112f48;--accent:#f45b16;--paper:#fffdf8;--muted:#62717d;--report-zoom:1}*{box-sizing:border-box}body{margin:0;background:#f3efe7;color:var(--ink);font-family:"Microsoft YaHei",system-ui,sans-serif}.toolbar{position:sticky;top:0;z-index:5;display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;padding:.8rem 1.2rem;background:#112f48;color:#fff}.toolbar button,.toolbar input{font:inherit;border:1px solid #adc4d4;border-radius:.45rem;padding:.45rem .7rem}.toolbar button{cursor:pointer;background:#fff;color:#112f48}.toolbar input{min-width:15rem}.report{width:min(1080px,calc(100% - 2rem));margin:1.5rem auto;padding:2rem;background:var(--paper);transform-origin:top center;font-size:calc(1rem * var(--report-zoom));box-shadow:0 12px 36px #112f4820}.report-header{border-top:6px solid var(--accent);padding-top:1rem}.eyebrow{color:var(--accent);font-weight:700;letter-spacing:.08em}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:.8rem}.metric,.section{border:1px solid #d9e1e5;border-radius:.8rem;padding:1rem}.metric strong{font-size:1.7em;display:block}.section{margin-top:1rem;transition:.2s}.section.selected{outline:4px solid #f45b1660}.section.search-hit{background:#fff1a8}.section.collapsed .section-body{display:none}.section h2{margin-top:0}.section-head{display:flex;justify-content:space-between;gap:1rem}.chart{display:grid;gap:.5rem;margin:1rem 0}.bar-row{display:grid;grid-template-columns:minmax(7rem,14rem) 1fr 4rem;align-items:center;gap:.6rem}.bar-track{height:1rem;background:#e8edf0;border-radius:999px;overflow:hidden}.bar{height:100%;background:var(--accent)}.legend{display:flex;flex-wrap:wrap;gap:.45rem}.legend button{border:1px solid #d9e1e5;background:#fff;border-radius:999px;padding:.3rem .6rem}.focus-hidden,.series-muted{opacity:.16}.citations{font-size:.9em;color:var(--muted)}.report-footer{margin-top:2rem;padding-top:1rem;border-top:1px solid #d9e1e5;color:var(--muted);font-size:.85em}@media(max-width:640px){.report{width:100%;margin:0;padding:1rem}.toolbar input{min-width:10rem;flex:1}.bar-row{grid-template-columns:7rem 1fr 3rem}}@media print{.toolbar{display:none}.report{box-shadow:none;width:100%;margin:0}.focus-hidden,.series-muted{opacity:1}}`;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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
        `<button type="button" data-series="${escapeHtml(point.label)}">${escapeHtml(point.label)}</button>`,
    )
    .join("");
  return `<figure class="chart"><figcaption><strong>${escapeHtml(chart.title)}</strong></figcaption>${rows}<div class="legend">${legend}</div></figure>`;
}

function renderBody(spec: AnalysisReportSpec, interactive: boolean): string {
  const metrics = spec.metrics
    .map(
      (metric) =>
        `<article class="metric" data-searchable><span>${escapeHtml(metric.label)}</span><strong>${escapeHtml(metric.value)}</strong><small>${escapeHtml(metric.detail)}</small></article>`,
    )
    .join("");
  const sections = spec.sections
    .map(
      (section) =>
        `<section class="section" id="${escapeHtml(section.id)}" data-section data-searchable><div class="section-head"><h2>${escapeHtml(section.title)}</h2>${interactive ? '<button type="button" data-action="collapse">展开／折叠</button>' : ""}</div><div class="section-body">${section.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("")}${section.chart === null ? "" : renderChart(section.chart)}${section.citations.length === 0 ? "" : `<ol class="citations">${section.citations.map((citation) => `<li>${escapeHtml(citation.claim)} · ${escapeHtml(citation.source.sourceType)} / ${escapeHtml(citation.source.sourceId)} / ${escapeHtml(citation.source.contentHash.slice(0, 12))}</li>`).join("")}</ol>`}</div></section>`,
    )
    .join("");
  return `<main class="report"><header class="report-header" data-searchable><p class="eyebrow">醋溜教育 · 内部分析报告</p><h1>${escapeHtml(spec.title)}</h1><p>${escapeHtml(spec.executiveSummary)}</p></header><section class="metrics">${metrics}</section>${sections}<footer class="report-footer">本报告由冻结的工作区资料与当前对话快照生成；统计由服务端确定性计算，引用不可在页面交互中修改。</footer></main>`;
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

export function renderAnalysisReport(untrustedSpec: unknown): {
  interactive: Uint8Array;
  scriptHash: string;
  static: Uint8Array;
} {
  const spec = AnalysisReportSpecSchema.parse(untrustedSpec);
  const hashes = scriptHashes();
  const staticCsp =
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'";
  const interactiveCsp = `${staticCsp}; script-src 'sha256-${hashes.base64}'`;
  const build = (interactive: boolean): string =>
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${interactive ? interactiveCsp : staticCsp}"><title>${escapeHtml(spec.title)}</title><style>${STYLE}</style></head><body>${interactive ? '<nav class="toolbar" aria-label="报告查看工具"><button type="button" data-action="zoom-out">缩小</button><button type="button" data-action="zoom-in">放大</button><button type="button" data-action="focus">专注选中</button><input id="report-search" type="search" placeholder="页内搜索"><button type="button" data-action="reset">重置</button></nav>' : ""}${renderBody(spec, interactive)}${interactive ? `<script>${INTERACTION_SCRIPT}</script>` : ""}</body></html>`;
  const interactiveHtml = build(true);
  const staticHtml = build(false);
  validateHtml(interactiveHtml, true, hashes.base64);
  validateHtml(staticHtml, false, hashes.base64);
  return {
    interactive: Buffer.from(interactiveHtml, "utf8"),
    scriptHash: hashes.hex,
    static: Buffer.from(staticHtml, "utf8"),
  };
}
