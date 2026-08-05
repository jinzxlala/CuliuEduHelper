import { createHash } from "node:crypto";

import {
  CaseDocumentSchema,
  KnowledgeDocumentSetSchema,
  LectureDocumentSchema,
  type CaseDocument,
  type KnowledgeDocumentSet,
  type LectureDocument,
} from "@culiu/search";

import type { AnalysisSections, LectureSourceBundle } from "./contracts.js";
import { KnowledgeSourceError } from "./errors.js";

interface MarkdownField {
  readonly label: string;
  readonly value: string;
}

interface MarkdownCard {
  readonly bodyLines: readonly string[];
  readonly heading: string;
  readonly ordinal: number;
}

interface MarkdownSubcard {
  readonly bodyLines: readonly string[];
  readonly heading: string;
}

export interface ParsedAnalysisDocuments {
  readonly cases: readonly CaseDocument[];
  readonly lecture: LectureDocument;
}

const UNKNOWN_VALUE_PATTERN = /(?:未披露|未说明|不详|未知|无法确认|没有披露)/u;
const EXPLICIT_UNKNOWN_VALUE_PATTERN =
  /^(?:未披露|未说明|不详|未知|无法确认|没有披露)(?:[，,；;：:。.\s].*)?$/u;

function isExplicitUnknownValue(value: string): boolean {
  return EXPLICIT_UNKNOWN_VALUE_PATTERN.test(value.trim());
}

function normalizeMarkdown(markdown: string): string {
  return markdown.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
}

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/[*_`~]/gu, "")
    .replace(/<br\s*\/?\s*>/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function isTableSeparator(line: string): boolean {
  const body = line.trim().replace(/^\|/u, "").replace(/\|$/u, "").replace(/\s+/gu, "");
  return body.length > 0 && /^[|:-]+$/u.test(body);
}

function markdownLinesToText(lines: readonly string[]): string {
  return lines
    .flatMap((line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0 || isTableSeparator(trimmed)) {
        return [];
      }
      if (trimmed.startsWith("|")) {
        const cells = trimmed
          .replace(/^\|/u, "")
          .replace(/\|$/u, "")
          .split("|")
          .map(stripInlineMarkdown)
          .filter((cell) => cell.length > 0);
        return cells.length > 0 ? [cells.join("：")] : [];
      }
      const text = stripInlineMarkdown(
        trimmed
          .replace(/^#{1,6}\s+/u, "")
          .replace(/^[-*+]\s+/u, "")
          .replace(/^>\s?/u, ""),
      );
      return text.length > 0 ? [text] : [];
    })
    .join("\n");
}

function findH2Section(markdown: string, exactHeading: string, label: string): string[] {
  const lines = normalizeMarkdown(markdown).split("\n");
  const heading = `## ${exactHeading}`;
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) {
    throw new KnowledgeSourceError(
      "invalid_analysis",
      `${label}: missing expected section ${exactHeading}`,
    );
  }
  const next = lines.findIndex((line, index) => index > start && /^##\s+/u.test(line.trim()));
  return lines.slice(start + 1, next === -1 ? undefined : next);
}

function parseFields(lines: readonly string[]): MarkdownField[] {
  const fields: MarkdownField[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("|") && !isTableSeparator(trimmed)) {
      const cells = trimmed
        .replace(/^\|/u, "")
        .replace(/\|$/u, "")
        .split("|")
        .map(stripInlineMarkdown);
      const fieldLabel = cells[0];
      const fieldValue = cells[1];
      if (
        fieldLabel !== undefined &&
        fieldValue !== undefined &&
        fieldLabel !== "字段" &&
        fieldLabel.length > 0 &&
        fieldValue.length > 0
      ) {
        fields.push({ label: fieldLabel, value: fieldValue });
      }
      continue;
    }

    const bullet = trimmed.replace(/^[-*+]\s+/u, "");
    const match = /^(?:\*\*)?([^：:]{1,80})[：:](?:\*\*)?\s*(.+)$/u.exec(bullet);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      const fieldLabel = stripInlineMarkdown(match[1]);
      const fieldValue = stripInlineMarkdown(match[2]);
      if (fieldLabel.length > 0 && fieldValue.length > 0) {
        fields.push({ label: fieldLabel, value: fieldValue });
      }
    }
  }
  return fields;
}

function subsectionLines(lines: readonly string[], heading: string): string[] {
  const marker = `#### ${heading}`;
  const start = lines.findIndex((line) => line.trim() === marker);
  if (start === -1) return [];
  const end = lines.findIndex((line, index) => index > start && /^####\s+/u.test(line.trim()));
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

function subsectionList(lines: readonly string[], heading: string): string[] {
  return subsectionLines(lines, heading)
    .filter((line) => /^[-*+]\s+/u.test(line.trim()))
    .map((line) => stripInlineMarkdown(line.trim().replace(/^[-*+]\s+/u, "")))
    .filter((line) => line !== "" && !isExplicitUnknownValue(line));
}

function parseSubcards(lines: readonly string[]): MarkdownSubcard[] {
  const cards: MarkdownSubcard[] = [];
  let heading: string | undefined;
  let bodyLines: string[] = [];
  const flush = (): void => {
    if (heading !== undefined) cards.push({ bodyLines, heading });
  };
  for (const line of lines) {
    const match = /^#####\s+(.+?)\s*$/u.exec(line.trim());
    if (match?.[1] !== undefined) {
      flush();
      heading = stripInlineMarkdown(match[1]);
      bodyLines = [];
    } else if (heading !== undefined) {
      bodyLines.push(line);
    }
  }
  flush();
  return cards;
}

function fieldValues(fields: readonly MarkdownField[], pattern: RegExp): string[] {
  return fields.filter((field) => pattern.test(field.label)).map((field) => field.value);
}

function firstKnownField(fields: readonly MarkdownField[], pattern: RegExp): string | undefined {
  return fieldValues(fields, pattern).find((value) => !isExplicitUnknownValue(value));
}

function explicitFacetValues(value: string | undefined): string[] {
  if (value === undefined || isExplicitUnknownValue(value)) {
    return [];
  }
  return [...new Set(value.split(/[；;、]/u).map(stripInlineMarkdown))].filter(
    (item) => item.length > 0 && item.length <= 512,
  );
}

function parseCards(sectionLines: readonly string[], label: string): MarkdownCard[] {
  const cards: MarkdownCard[] = [];
  let currentHeading: string | undefined;
  let currentLines: string[] = [];

  const flush = (): void => {
    if (currentHeading !== undefined) {
      cards.push({
        bodyLines: currentLines,
        heading: currentHeading,
        ordinal: cards.length + 1,
      });
    }
  };

  for (const line of sectionLines) {
    const headingMatch = /^###\s+(.+?)\s*$/u.exec(line.trim());
    if (headingMatch?.[1] !== undefined) {
      flush();
      currentHeading = stripInlineMarkdown(headingMatch[1]);
      currentLines = [];
    } else if (currentHeading !== undefined) {
      currentLines.push(line);
    }
  }
  flush();

  if (cards.length === 0) {
    const meaningfulLines = sectionLines
      .map((line) => stripInlineMarkdown(line))
      .filter((line) => line !== "");
    const explicitMissing =
      meaningfulLines.length > 0 &&
      meaningfulLines.every((line) => UNKNOWN_VALUE_PATTERN.test(line));
    if (explicitMissing) return [];
    throw new KnowledgeSourceError("invalid_analysis", `${label}: case section has no cards`);
  }
  return cards;
}

function caseType(fields: readonly MarkdownField[], heading: string): string {
  const explicit = firstKnownField(fields, /^卡片性质$/u);
  const source = explicit ?? heading;
  if (/诚信/u.test(source)) {
    return "诚信风险案例";
  }
  if (/证据、机制|学校资源|资源卡/u.test(source)) {
    return "证据与资源卡";
  }
  if (/失败|反例|风险/u.test(source)) {
    return "失败与反例";
  }
  if (/跨学科|交叉学科/u.test(source)) {
    return "跨学科案例";
  }
  if (/科研|研究|竞赛|ISEF/iu.test(source)) {
    return "科研与竞赛案例";
  }
  if (/公益|社会实践|社区|活动与影响/u.test(source)) {
    return "活动与影响力案例";
  }
  if (/成长|长期|逆袭|转学|转轨|迁徙|兴趣驱动|短期提升|规划型/u.test(source)) {
    return "成长路径案例";
  }
  if (/录取|学生|申请|美高|陆高|IB|ED|RD/u.test(source)) {
    return "学生录取案例";
  }
  return "知识案例卡";
}

function caseSchools(fields: readonly MarkdownField[], heading: string): string[] {
  const explicit = explicitFacetValues(firstKnownField(fields, /^(学校|录取学校)$/u));
  if (explicit.length > 0) {
    return explicit;
  }
  const headingResult = /——(.+)$/u.exec(heading)?.[1];
  return explicitFacetValues(headingResult);
}

function activityTypes(fields: readonly MarkdownField[]): string[] {
  const types = new Set<string>();
  for (const field of fields) {
    if (/科研|研究/u.test(field.label)) types.add("研究");
    if (/活动|社会实践|志愿|公益/u.test(field.label)) types.add("活动");
    if (/竞赛|奖项/u.test(field.label)) types.add("竞赛");
    if (/体育|运动/u.test(field.label)) types.add("体育");
    if (/艺术|作品/u.test(field.label)) types.add("艺术");
    if (/开发|产品|项目/u.test(field.label)) types.add("项目");
  }
  return [...types];
}

function confidence(fields: readonly MarkdownField[]): CaseDocument["confidence"] {
  const explicit = firstKnownField(fields, /^(可信度|置信度|证据等级)$/u);
  if (explicit === undefined) return "unknown";
  if (/高/u.test(explicit)) return "high";
  if (/中/u.test(explicit)) return "medium";
  if (/低/u.test(explicit)) return "low";
  return "unknown";
}

function evidenceBoundary(fields: readonly MarkdownField[]): string {
  return fields
    .filter((field) => /边界|缺失|缺口|不可得结论|风险/u.test(field.label))
    .map((field) => `${field.label}：${field.value}`)
    .join("\n");
}

function richEvidenceBoundary(card: MarkdownCard, fields: readonly MarkdownField[]): string {
  const section = markdownLinesToText(subsectionLines(card.bodyLines, "证据边界"));
  return section || evidenceBoundary(fields);
}

function structuredProjects(card: MarkdownCard): CaseDocument["core_projects"] {
  return parseSubcards(subsectionLines(card.bodyLines, "核心项目与活动")).map((project) => {
    const fields = parseFields(project.bodyLines);
    return {
      actions: explicitFacetValues(firstKnownField(fields, /^实际行动$/u)),
      impact: firstKnownField(fields, /^影响与结果$/u) ?? "",
      methods: explicitFacetValues(firstKnownField(fields, /^方法与工具$/u)),
      name: project.heading,
      outputs: explicitFacetValues(firstKnownField(fields, /^可核实产出$/u)),
      role: firstKnownField(fields, /^学生角色$/u) ?? "",
    };
  });
}

function structuredEvidencePoints(card: MarkdownCard): CaseDocument["evidence_points"] {
  return parseSubcards(subsectionLines(card.bodyLines, "证据对照")).flatMap((point) => {
    const fields = parseFields(point.bodyLines);
    const claim = firstKnownField(fields, /^主张$/u);
    const evidence = firstKnownField(fields, /^逐字稿依据$/u);
    if (claim === undefined || evidence === undefined) return [];
    const rawConfidence = firstKnownField(fields, /^证据可信度$/u) ?? "未知";
    return [
      {
        claim,
        confidence: /高/u.test(rawConfidence)
          ? ("high" as const)
          : /中/u.test(rawConfidence)
            ? ("medium" as const)
            : /低/u.test(rawConfidence)
              ? ("low" as const)
              : ("unknown" as const),
        evidence,
        source_locator: firstKnownField(fields, /^来源定位$/u) ?? "",
      },
    ];
  });
}

function caseId(lectureId: string, ordinal: number): string {
  return `case_${lectureId.replace(/^lecture_/u, "")}_${String(ordinal).padStart(3, "0")}`;
}

function parseCase(lectureId: string, card: MarkdownCard): CaseDocument {
  const fields = parseFields(card.bodyLines);
  const academicLabel =
    firstKnownField(fields, /^(一句话学术标签|学术标签|学术主线|核心问题|价值)$/u) ?? card.heading;
  const researchMethods = fieldValues(fields, /^(研究方法|方法)$/u)
    .filter((value) => !isExplicitUnknownValue(value))
    .flatMap(explicitFacetValues);
  const aiValues = fieldValues(fields, /AI|人工智能/iu)
    .filter((value) => !isExplicitUnknownValue(value))
    .flatMap(explicitFacetValues);

  return CaseDocumentSchema.parse({
    academic_label: academicLabel,
    activity_types: activityTypes(fields),
    admission_result: firstKnownField(fields, /^(申请方向[／/]结果|录取结果|结果)$/u) ?? "",
    ai_depth: firstKnownField(fields, /^AI(?:使用)?深度$/iu) ?? null,
    ai_domains: [...new Set(aiValues)],
    background: firstKnownField(fields, /^(基础背景|学生背景|背景|画像)$/u) ?? "",
    case_id: caseId(lectureId, card.ordinal),
    case_type: caseType(fields, card.heading),
    confidence: confidence(fields),
    core_projects: structuredProjects(card),
    core_strengths: subsectionList(card.bodyLines, "核心优势"),
    curriculum_system: firstKnownField(fields, /^(课程体系|课程背景)$/u) ?? null,
    development_path: subsectionList(card.bodyLines, "发展路径"),
    evidence_boundary: richEvidenceBoundary(card, fields),
    evidence_points: structuredEvidencePoints(card),
    advisor_insights: subsectionList(card.bodyLines, "顾问启示"),
    application_strategy: subsectionList(card.bodyLines, "申请策略"),
    interpretations: subsectionList(card.bodyLines, "分析性判断"),
    lecture_id: lectureId,
    major: firstKnownField(fields, /^(申请专业|专业方向|申请方向)$/u) ?? null,
    missing_information: subsectionList(card.bodyLines, "待核实信息"),
    profile_summary: firstKnownField(fields, /^案例概览$/u) ?? "",
    research_methods: [...new Set(researchMethods)],
    schools: caseSchools(fields, card.heading),
    timestamp_refs: [],
    verified_facts: subsectionList(card.bodyLines, "核实事实"),
  });
}

function sourcePath(bundle: LectureSourceBundle): string {
  const source = bundle.sources.find((candidate) => candidate.role === "analysis_markdown");
  if (source === undefined) {
    throw new KnowledgeSourceError(
      "missing_source",
      `${bundle.source_key}: analysis source disappeared from bundle`,
    );
  }
  return source.logical_path;
}

function lectureDocument(
  markdown: string,
  bundle: LectureSourceBundle,
  sections: AnalysisSections,
  label: string,
): LectureDocument {
  const basics = findH2Section(markdown, sections.basics, label);
  const fields = parseFields(basics);
  return LectureDocumentSchema.parse({
    ai_cross_disciplinary_text: markdownLinesToText(
      findH2Section(markdown, sections.ai_cross_disciplinary, label),
    ),
    date: bundle.lecture_date,
    failure_text: markdownLinesToText(findH2Section(markdown, sections.failures, label)),
    lecture_id: bundle.lecture_id,
    majors: explicitFacetValues(firstKnownField(fields, /^专业$/u)),
    organization:
      explicitFacetValues(firstKnownField(fields, /^(机构|主办机构|主办)$/u))[0] ?? null,
    schools: explicitFacetValues(firstKnownField(fields, /^学校$/u)),
    source_path: sourcePath(bundle),
    speakers: explicitFacetValues(firstKnownField(fields, /^(主讲人|讲者|嘉宾)$/u)),
    summary: markdownLinesToText(findH2Section(markdown, sections.summary, label)),
    title: bundle.title,
    trend_text: markdownLinesToText(findH2Section(markdown, sections.trends, label)),
  });
}

export function parseAnalysisDocuments(
  markdown: string,
  bundle: LectureSourceBundle,
  label: string,
): ParsedAnalysisDocuments {
  const lecture = lectureDocument(markdown, bundle, bundle.analysis_sections, label);
  const cards = parseCards(findH2Section(markdown, bundle.analysis_sections.cases, label), label);
  return {
    cases: cards.map((card) => parseCase(bundle.lecture_id, card)),
    lecture,
  };
}

export function buildKnowledgeDocumentSet(
  parsed: readonly ParsedAnalysisDocuments[],
): KnowledgeDocumentSet {
  return KnowledgeDocumentSetSchema.parse({
    cases: parsed.flatMap((item) => item.cases),
    lectures: parsed.map((item) => item.lecture),
    transcriptSegments: [],
  });
}

export function contentSha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}
