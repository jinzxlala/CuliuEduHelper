import { createHash } from "node:crypto";

import { DEEPSEEK_PROFILE_MODEL, type JsonModelProvider, type JsonModelResult } from "@culiu/ai";
import { z } from "zod";

export const KNOWLEDGE_EXTRACTION_MODEL = DEEPSEEK_PROFILE_MODEL;
export const KNOWLEDGE_EXTRACTION_PROMPT_VERSION = "knowledge-transcript-extraction.v3";
export const KNOWLEDGE_EXTRACTION_SCHEMA_VERSION = "knowledge-analysis-markdown.v3";
export const KNOWLEDGE_EXTRACTION_REDACTION_VERSION = "knowledge-transcript-outbound.v1";

function normalizeText(value: unknown): unknown {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    const parts = value.map((item) => item.trim()).filter((item) => item !== "");
    return parts.length === 0 ? "未披露" : parts.join("\n");
  }
  if (typeof value === "string" && value.trim() === "") return "未披露";
  return value;
}

function normalizedTextSchema(maxLength: number): z.ZodType<string> {
  return z.preprocess(normalizeText, z.string().trim().min(1).max(maxLength));
}

function knowledgeListSchema(maxItems: number, maxItemLength = 256): z.ZodType<string[]> {
  return z.preprocess(
    (value) => {
      if (typeof value === "string") {
        const trimmed = value.trim();
        return trimmed === "" || trimmed === "未披露" ? [] : [trimmed];
      }
      return Array.isArray(value) ? value.slice(0, maxItems) : value;
    },
    z.array(z.string().trim().min(1).max(maxItemLength)).max(maxItems),
  );
}

const QUOTE_TEXT_KEYS = [
  "quote",
  "quoteText",
  "quotation",
  "verbatim",
  "text",
  "content",
  "original",
  "originalText",
  "原话",
  "原文",
  "内容",
] as const;

function normalizeQuoteItem(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (value === null || Array.isArray(value) || typeof value !== "object") return value;

  const record = value as Readonly<Record<string, unknown>>;
  for (const key of QUOTE_TEXT_KEYS) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
  }
  return value;
}

function quoteListSchema(maxItems: number, maxItemLength = 4_000): z.ZodType<string[]> {
  return z.preprocess(
    (value) => {
      if (typeof value === "string") {
        const trimmed = value.trim();
        return trimmed === "" || trimmed === "未披露" ? [] : [trimmed];
      }
      if (!Array.isArray(value)) return value;
      return value.map(normalizeQuoteItem).slice(0, maxItems);
    },
    z.array(z.string().trim().min(1).max(maxItemLength)).max(maxItems),
  );
}

const NonEmptyTextSchema = normalizedTextSchema(20_000);
const OptionalKnowledgeTextSchema = normalizedTextSchema(4_000);

const ExtractedCaseSchema = z
  .object({
    academicLabel: OptionalKnowledgeTextSchema,
    activityTypes: knowledgeListSchema(20),
    admissionResult: OptionalKnowledgeTextSchema,
    aiDepth: OptionalKnowledgeTextSchema,
    aiDomains: knowledgeListSchema(20),
    background: OptionalKnowledgeTextSchema,
    caseType: OptionalKnowledgeTextSchema,
    confidence: z.preprocess(
      (value) => (value === "未披露" ? "未知" : value),
      z.enum(["高", "中", "低", "未知"]),
    ),
    curriculumSystem: OptionalKnowledgeTextSchema,
    evidenceBoundary: OptionalKnowledgeTextSchema,
    heading: normalizedTextSchema(512),
    major: OptionalKnowledgeTextSchema,
    researchMethods: knowledgeListSchema(20),
    schools: knowledgeListSchema(20),
  })
  .strict();

export const KnowledgeExtractionOutputSchema = z
  .object({
    actions: NonEmptyTextSchema,
    aiCrossDisciplinary: NonEmptyTextSchema,
    cases: z.array(ExtractedCaseSchema).max(50),
    evidenceBoundary: NonEmptyTextSchema,
    failures: NonEmptyTextSchema,
    majors: knowledgeListSchema(50),
    organization: OptionalKnowledgeTextSchema,
    quotes: quoteListSchema(30),
    schemaVersion: z.literal(KNOWLEDGE_EXTRACTION_SCHEMA_VERSION),
    schools: knowledgeListSchema(50),
    speakers: knowledgeListSchema(20),
    summary: NonEmptyTextSchema,
    trends: knowledgeListSchema(30, 4_000),
  })
  .strict();
export type KnowledgeExtractionOutput = z.infer<typeof KnowledgeExtractionOutputSchema>;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function knowledgeExtractionSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const KNOWLEDGE_EXTRACTION_SCHEMA_DESCRIPTOR = {
  exactTopLevelKeys: [
    "schemaVersion",
    "organization",
    "speakers",
    "schools",
    "majors",
    "summary",
    "trends",
    "cases",
    "aiCrossDisciplinary",
    "failures",
    "quotes",
    "actions",
    "evidenceBoundary",
  ],
  caseExactKeys: [
    "heading",
    "caseType",
    "background",
    "curriculumSystem",
    "schools",
    "admissionResult",
    "major",
    "researchMethods",
    "activityTypes",
    "aiDomains",
    "aiDepth",
    "academicLabel",
    "confidence",
    "evidenceBoundary",
  ],
  caseFieldTypes: {
    academicLabel: "string",
    activityTypes: "string[]",
    admissionResult: "string",
    aiDepth: "string",
    aiDomains: "string[]",
    background: "string",
    caseType: "string",
    confidence: "高|中|低|未知",
    curriculumSystem: "string",
    evidenceBoundary: "string",
    heading: "string",
    major: "string",
    researchMethods: "string[]",
    schools: "string[]",
  },
  confidenceValues: ["高", "中", "低", "未知"],
  listLimits: {
    cases: 50,
    majors: 50,
    quotes: 30,
    schools: 50,
    speakers: 20,
    trends: 30,
  },
  missingValue: "未披露",
  schemaVersion: KNOWLEDGE_EXTRACTION_SCHEMA_VERSION,
  topLevelFieldTypes: {
    actions: "string",
    aiCrossDisciplinary: "string",
    cases: "case[]",
    evidenceBoundary: "string",
    failures: "string",
    majors: "string[]",
    organization: "string",
    quotes: "string[]",
    schemaVersion: `literal:${KNOWLEDGE_EXTRACTION_SCHEMA_VERSION}`,
    schools: "string[]",
    speakers: "string[]",
    summary: "string",
    trends: "string[]",
  },
};

export const KNOWLEDGE_EXTRACTION_SYSTEM_PROMPT = `你是一名严谨的教育研究资料分析员。只依据逐字稿生成结构化JSON，不得补充外部知识、猜测事实、编造数字、编造学生身份或编造时间戳。学生姓名一律改为“学生A”“学生B”等匿名称呼。缺失的字符串字段写“未披露”，缺失的数组字段写空数组[]；逐字稿没有案例时cases必须为[]，不得虚构案例。案例的录取结果不等于录取因果。quotes只能使用逐字稿中确实出现的原话，并且每一项必须是纯字符串，不得输出包含speaker、context、timestamp等字段的对象；没有可靠原话时quotes必须为[]，没有可靠时间戳时不要添加时间。所有数组不得超过listLimits声明的最大项数。输出必须严格符合以下字段、类型、数量和取值描述，不得增加字段：${stableJson(KNOWLEDGE_EXTRACTION_SCHEMA_DESCRIPTOR)}`;

export const KNOWLEDGE_EXTRACTION_PROMPT_HASH = knowledgeExtractionSha256(
  KNOWLEDGE_EXTRACTION_SYSTEM_PROMPT,
);
export const KNOWLEDGE_EXTRACTION_SCHEMA_HASH = knowledgeExtractionSha256(
  stableJson(KNOWLEDGE_EXTRACTION_SCHEMA_DESCRIPTOR),
);

export function sanitizeKnowledgeTranscriptForModel(value: string): string {
  return value
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gu, "[REDACTED_EMAIL]")
    .replace(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/gu, "[REDACTED_PHONE]")
    .replace(/(?<!\d)\d{15,18}[0-9Xx]?(?!\d)/gu, "[REDACTED_IDENTIFIER]")
    .trim();
}

export function buildKnowledgeExtractionUserPrompt(input: {
  readonly sourceKey: string;
  readonly title: string;
  readonly transcriptText: string;
}): string {
  return `讲座来源键：${input.sourceKey}\n讲座标题：${input.title}\n\n仅依据以下逐字稿生成JSON：\n<transcript>\n${input.transcriptText}\n</transcript>`;
}

function displayList(values: readonly string[]): string {
  return values.length === 0 ? "未披露" : values.join("；");
}

function markdownList(values: readonly string[]): string {
  return values.length === 0
    ? "- 未披露"
    : values.map((item) => `- ${safeMarkdownText(item)}`).join("\n");
}

function safeMarkdownText(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/^#{1,6}\s+/gmu, "")
    .trim();
}

export function renderKnowledgeAnalysisMarkdown(title: string, untrustedOutput: unknown): string {
  const output = KnowledgeExtractionOutputSchema.parse(untrustedOutput);
  const caseBlocks = output.cases.map(
    (item, index) => `### ${safeMarkdownText(item.heading) || `匿名案例${String(index + 1)}`}

- 卡片性质：${safeMarkdownText(item.caseType)}
- 背景：${safeMarkdownText(item.background)}
- 课程体系：${safeMarkdownText(item.curriculumSystem)}
- 学校：${displayList(item.schools)}
- 申请方向/结果：${safeMarkdownText(item.admissionResult)}
- 专业方向：${safeMarkdownText(item.major)}
- 研究方法：${displayList(item.researchMethods)}
- 活动类型：${displayList(item.activityTypes)}
- AI领域：${displayList(item.aiDomains)}
- AI使用深度：${safeMarkdownText(item.aiDepth)}
- 一句话学术标签：${safeMarkdownText(item.academicLabel)}
- 可信度：${item.confidence}
- 证据边界：${safeMarkdownText(item.evidenceBoundary)}`,
  );
  return `# ${safeMarkdownText(title)}

## 基础信息

- 主办机构：${safeMarkdownText(output.organization)}
- 主讲人：${displayList(output.speakers)}
- 学校：${displayList(output.schools)}
- 专业：${displayList(output.majors)}

## 摘要

${safeMarkdownText(output.summary)}

## 趋势

${markdownList(output.trends)}

## 案例卡片

${caseBlocks.length === 0 ? "未披露" : caseBlocks.join("\n\n")}

## AI+与跨学科

${safeMarkdownText(output.aiCrossDisciplinary)}

## 失败与反例

${safeMarkdownText(output.failures)}

## 关键原话

${markdownList(output.quotes)}

## 醋溜科技行动建议

${safeMarkdownText(output.actions)}

## 证据边界

${safeMarkdownText(output.evidenceBoundary)}
`;
}

export function createDeterministicMockKnowledgeExtractionProvider(): JsonModelProvider {
  return {
    generateJson(): Promise<JsonModelResult> {
      const output: KnowledgeExtractionOutput = {
        actions: "仅用于自动化测试，需人工核对。",
        aiCrossDisciplinary: "逐字稿未披露可验证的AI深度。",
        cases: [
          {
            academicLabel: "虚构测试主线",
            activityTypes: ["项目"],
            admissionResult: "未披露",
            aiDepth: "未披露",
            aiDomains: [],
            background: "匿名虚构测试背景",
            caseType: "知识案例卡",
            confidence: "低",
            curriculumSystem: "未披露",
            evidenceBoundary: "仅用于自动化测试。",
            heading: "匿名虚构案例",
            major: "未披露",
            researchMethods: [],
            schools: [],
          },
        ],
        evidenceBoundary: "全部内容均为虚构自动化测试结果。",
        failures: "没有可验证的失败信息。",
        majors: [],
        organization: "虚构机构",
        quotes: ["虚构测试原话。"],
        schemaVersion: KNOWLEDGE_EXTRACTION_SCHEMA_VERSION,
        schools: [],
        speakers: ["匿名讲者"],
        summary: "这是一份虚构的逐字稿提取结果。",
        trends: ["跨学科探索。"],
      };
      return Promise.resolve({
        json: output,
        model: KNOWLEDGE_EXTRACTION_MODEL,
        providerRequestId: "mock-knowledge-extraction",
        usage: {
          completionTokens: 20,
          promptCacheHitTokens: 0,
          promptCacheMissTokens: 20,
          promptTokens: 20,
          totalTokens: 40,
        },
      });
    },
  };
}
