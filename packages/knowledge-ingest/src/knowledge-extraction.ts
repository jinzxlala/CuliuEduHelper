import { createHash } from "node:crypto";

import { DEEPSEEK_PROFILE_MODEL, type JsonModelProvider, type JsonModelResult } from "@culiu/ai";
import { z } from "zod";

export const KNOWLEDGE_EXTRACTION_MODEL = DEEPSEEK_PROFILE_MODEL;
export const KNOWLEDGE_EXTRACTION_PROMPT_VERSION = "knowledge-transcript-extraction.v5";
export const KNOWLEDGE_EXTRACTION_SCHEMA_VERSION = "knowledge-analysis-markdown.v5";
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

function normalizeLectureDate(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed === "" || /^(?:未披露|未知|无法确定|不确定)$/u.test(trimmed) ? null : trimmed;
}

export const ExtractedLectureMetadataSchema = z
  .object({
    date: z.preprocess(normalizeLectureDate, z.iso.date().nullable()),
    dateConfidence: z.enum(["高", "中", "低", "未知"]),
    dateEvidence: normalizedTextSchema(1_000),
    title: normalizedTextSchema(512),
    titleConfidence: z.enum(["高", "中", "低", "未知"]),
    titleEvidence: normalizedTextSchema(1_000),
  })
  .strict();

const ExtractedProjectSchema = z
  .object({
    actions: knowledgeListSchema(8, 1_000),
    impact: OptionalKnowledgeTextSchema,
    methods: knowledgeListSchema(8, 512),
    name: normalizedTextSchema(512),
    outputs: knowledgeListSchema(8, 1_000),
    role: OptionalKnowledgeTextSchema,
  })
  .strict();

const ExtractedEvidencePointSchema = z
  .object({
    claim: normalizedTextSchema(2_000),
    confidence: z.enum(["高", "中", "低", "未知"]),
    evidence: normalizedTextSchema(2_000),
    sourceLocator: normalizedTextSchema(512),
  })
  .strict();

const extractedCaseTypeValues = [
  "学生录取案例",
  "科研与竞赛案例",
  "跨学科案例",
  "成长路径案例",
  "活动与影响力案例",
  "失败与反例",
  "诚信风险案例",
  "证据与资源卡",
] as const;

function normalizeExtractedCaseType(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (/诚信/u.test(value)) return "诚信风险案例";
  if (/证据、机制|学校资源|资源卡/u.test(value)) return "证据与资源卡";
  if (/失败|反例|风险/u.test(value)) return "失败与反例";
  if (/跨学科|交叉学科/u.test(value)) return "跨学科案例";
  if (/科研|研究|竞赛|ISEF/iu.test(value)) return "科研与竞赛案例";
  if (/公益|社会实践|社区|活动与影响/u.test(value)) return "活动与影响力案例";
  if (/成长|长期|逆袭|转学|转轨|迁徙|兴趣驱动|短期提升|规划型/u.test(value)) {
    return "成长路径案例";
  }
  if (/录取|学生|申请|美高|陆高|IB|ED|RD/u.test(value)) return "学生录取案例";
  return value;
}

export const ExtractedCaseTypeSchema = z.preprocess(
  normalizeExtractedCaseType,
  z.enum(extractedCaseTypeValues),
);

export const ExtractedCaseSchema = z
  .object({
    academicLabel: OptionalKnowledgeTextSchema,
    activityTypes: knowledgeListSchema(20),
    admissionResult: OptionalKnowledgeTextSchema,
    aiDepth: OptionalKnowledgeTextSchema,
    aiDomains: knowledgeListSchema(20),
    background: OptionalKnowledgeTextSchema,
    caseType: ExtractedCaseTypeSchema,
    confidence: z.preprocess(
      (value) => (value === "未披露" ? "未知" : value),
      z.enum(["高", "中", "低", "未知"]),
    ),
    curriculumSystem: OptionalKnowledgeTextSchema,
    coreProjects: z.array(ExtractedProjectSchema).max(12),
    coreStrengths: knowledgeListSchema(12, 1_000),
    developmentPath: knowledgeListSchema(12, 2_000),
    evidenceBoundary: OptionalKnowledgeTextSchema,
    evidencePoints: z.array(ExtractedEvidencePointSchema).min(2).max(30),
    heading: normalizedTextSchema(512),
    advisorInsights: knowledgeListSchema(12, 2_000),
    applicationStrategy: knowledgeListSchema(12, 2_000),
    interpretations: knowledgeListSchema(12, 2_000),
    major: OptionalKnowledgeTextSchema,
    missingInformation: knowledgeListSchema(12, 1_000),
    profileSummary: normalizedTextSchema(4_000),
    researchMethods: knowledgeListSchema(20),
    schools: knowledgeListSchema(20),
    verifiedFacts: knowledgeListSchema(20, 2_000),
  })
  .strict();

export const KnowledgeExtractionOutputSchema = z
  .object({
    actions: NonEmptyTextSchema,
    aiCrossDisciplinary: NonEmptyTextSchema,
    cases: z.array(ExtractedCaseSchema).max(30),
    evidenceBoundary: NonEmptyTextSchema,
    failures: NonEmptyTextSchema,
    lecture: ExtractedLectureMetadataSchema,
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

export const KNOWLEDGE_CASE_REBUILD_SCHEMA_VERSION = "knowledge-case-rebuild.v1";
export const KnowledgeCaseRebuildOutputSchema = z.preprocess(
  (value) => {
    if (value === null || Array.isArray(value) || typeof value !== "object") return value;
    const record = value as Readonly<Record<string, unknown>>;
    if (!Array.isArray(record.cases)) return value;
    return {
      ...record,
      cases: record.cases.filter((item) => {
        if (item === null || Array.isArray(item) || typeof item !== "object") return true;
        const points = (item as Readonly<Record<string, unknown>>).evidencePoints;
        return Array.isArray(points) && points.length >= 2;
      }),
    };
  },
  z
    .object({
      cases: z.array(ExtractedCaseSchema).max(30),
      schemaVersion: z.literal(KNOWLEDGE_CASE_REBUILD_SCHEMA_VERSION),
    })
    .strict(),
);
export type KnowledgeCaseRebuildOutput = z.infer<typeof KnowledgeCaseRebuildOutputSchema>;

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
    "profileSummary",
    "developmentPath",
    "coreProjects",
    "coreStrengths",
    "applicationStrategy",
    "advisorInsights",
    "verifiedFacts",
    "interpretations",
    "missingInformation",
    "evidencePoints",
  ],
  caseFieldTypes: {
    academicLabel: "string",
    activityTypes: "string[]",
    admissionResult: "string",
    aiDepth: "string",
    aiDomains: "string[]",
    background: "string",
    caseType:
      "学生录取案例|科研与竞赛案例|跨学科案例|成长路径案例|活动与影响力案例|失败与反例|诚信风险案例|证据与资源卡",
    confidence: "高|中|低|未知",
    coreProjects:
      "{name:string,role:string,actions:string[],methods:string[],outputs:string[],impact:string}[]",
    coreStrengths: "string[]",
    curriculumSystem: "string",
    developmentPath: "string[]",
    evidenceBoundary: "string",
    evidencePoints:
      "{claim:string,evidence:string,sourceLocator:string,confidence:高|中|低|未知}[]; min 2",
    heading: "string",
    advisorInsights: "string[]",
    applicationStrategy: "string[]",
    interpretations: "string[]",
    major: "string",
    missingInformation: "string[]",
    profileSummary: "string",
    researchMethods: "string[]",
    schools: "string[]",
    verifiedFacts: "string[]",
  },
  confidenceValues: ["高", "中", "低", "未知"],
  listLimits: {
    cases: 30,
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
    lecture:
      "{date:YYYY-MM-DD|null,dateConfidence:高|中|低|未知,dateEvidence:string,title:string,titleConfidence:高|中|低|未知,titleEvidence:string}",
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

export const KNOWLEDGE_EXTRACTION_SYSTEM_PROMPT = `你是一名严谨的教育研究资料分析员。只依据逐字稿生成结构化JSON，不得补充外部知识、猜测事实、编造数字、编造学生身份或编造时间戳。

讲座元数据识别规则：
1. lecture.title和lecture.date必须综合原始文件名与逐字稿正文判断。文件名只是线索，不是已确认事实；“原文”“逐字稿”“0401”这类名称不能直接作为正式主题或完整日期。
2. 标题应概括讲座的主要主题。文件名和正文一致时可提高置信度；冲突时以正文中明确的讲座标题、开场介绍和持续讨论主题为主要依据，并在titleEvidence说明。
3. 日期必须输出YYYY-MM-DD或null。正文明确年月日时优先采用；文件名只有月日时，只有正文能够确定年份才可组合；文件名含完整日期但正文冲突时不得静默采用文件名。
4. 无法从文件名和正文可靠确定完整年月日时，date必须为null、dateConfidence必须为“未知”或“低”，dateEvidence说明缺少什么；绝对不得用上传日期、当前日期或常识补齐年份。
5. titleEvidence和dateEvidence只能写简短依据，不复制敏感正文。置信度必须反映证据充分程度。

案例提取标准：
1. cases只收录逐字稿中具有连贯个人经历链的匿名学生案例，至少包含同一人的两个可定位证据点。学校介绍、项目榜单、泛化建议、单个零散例子、机构录取统计和无法确认属于同一人的拼接信息都不得生成案例。
2. 学生姓名、昵称、联系方式和可识别身份一律改为“学生A”“学生B”等，并在同一份输出中保持代号一致。不得把不同学生经历合并成一张卡。
3. profileSummary用2至4句概括起点、关键行动、发展结果和证据边界；developmentPath按时间或能力发展顺序记录，不得写空泛赞美。
4. coreProjects逐项说明项目名称或主题、学生角色、实际行动、方法工具、可核实产出和影响。逐字稿未说明的字段写“未披露”或空数组，不得补齐。
5. verifiedFacts只能写逐字稿直接陈述的事实；interpretations只能写由多条事实支持的分析性判断，并显式使用“可见/反映/可能说明”等审慎表达；advisorInsights是可迁移的顾问观察，不得把相关性写成录取因果。
6. evidencePoints每张案例至少2项且来源定位不得重复。claim写被支持的主张，evidence写简短原话或忠实转述，sourceLocator必须使用逐字稿实际出现的时间范围，如“00:31:20-00:31:45”；没有可靠时间定位就不得生成该案例。只要填写了录取结果，就必须有一条证据点直接支持该录取结果。confidence按证据充分度选择。
7. missingInformation主动列出逐字稿没有说明、但顾问判断案例时需要核实的信息；evidenceBoundary解释哪些结论不能从当前材料得出。
8. heading使用“录取方向或结果｜核心项目主线”这类事实性标题；academicLabel必须用一句短语概括“方法/能力如何作用于具体议题”，例如“用数据分析研究城市公共问题”，不得只写学校、专业、GPA、托福、SAT、IB或AP分数。aiDepth只有逐字稿明确描述AI使用时才能填写，否则写“未披露”。
9. caseType只能从以下八项中选择：学生录取案例、科研与竞赛案例、跨学科案例、成长路径案例、活动与影响力案例、失败与反例、诚信风险案例、证据与资源卡。

通用规则：缺失的字符串字段写“未披露”，缺失的数组字段写空数组[]；逐字稿没有达到上述门槛的案例时cases必须为[]。案例的录取结果不等于录取因果。quotes只能使用逐字稿中确实出现的原话，并且每一项必须是纯字符串；没有可靠原话时quotes必须为[]。所有数组不得超过listLimits声明的最大项数。输出必须严格符合以下字段、类型、数量和取值描述，不得增加字段：${stableJson(KNOWLEDGE_EXTRACTION_SCHEMA_DESCRIPTOR)}`;

export const KNOWLEDGE_EXTRACTION_PROMPT_HASH = knowledgeExtractionSha256(
  KNOWLEDGE_EXTRACTION_SYSTEM_PROMPT,
);
export const KNOWLEDGE_EXTRACTION_SCHEMA_HASH = knowledgeExtractionSha256(
  stableJson(KNOWLEDGE_EXTRACTION_SCHEMA_DESCRIPTOR),
);

export const KNOWLEDGE_CASE_REBUILD_SYSTEM_PROMPT = `你是一名严谨的教育研究资料分析员。你的唯一任务是从带时间戳的讲座逐字稿证据窗口中提取高信息强度的匿名学生案例。

仅收录能够确认属于同一位学生、且至少有两个不同时间定位支持的连贯经历。每张卡必须覆盖：案例概览、直接核实事实、发展路径、核心项目或活动、核心优势、申请策略、顾问启示、分析性判断、待核实信息和证据边界。学校介绍、项目推荐、机构录取数字、泛化建议和孤立片段不得生成案例。不同学生不得拼接。

学生姓名、昵称、联系方式及其他可识别信息统一改为“学生A”“学生B”等。verifiedFacts只写逐字稿直接陈述；interpretations必须使用“可见/反映/可能说明”等审慎表达，禁止出现“录取得益于、成功关键、打动招生官、因此被录取”等因果化判断。录取结果不得被写成某项活动的单一因果。heading使用“录取方向或结果｜核心项目主线”这类事实性标题，不使用“逆袭”“打动招生官”等营销化措辞；academicLabel必须概括“方法/能力如何作用于具体议题”，不得只写学校、专业或分数。aiDepth只有逐字稿明确描述AI使用时才能填写，否则写“未披露”。evidencePoints至少2项且来源定位不得重复，sourceLocator必须照录输入中的真实时间范围，evidence使用短原话或忠实转述。只要填写录取结果，就必须有一条证据点直接支持该结果。没有达到门槛时cases返回[]，不得凑数。

根对象只能包含schemaVersion和cases两个字段。cases必须是JSON数组，最多30项；每项只能包含下列case字段。输出必须是严格JSON，不得把字段说明、caseExactKeys或caseLimit作为输出字段：${stableJson(
  {
    cases: [KNOWLEDGE_EXTRACTION_SCHEMA_DESCRIPTOR.caseFieldTypes],
    schemaVersion: KNOWLEDGE_CASE_REBUILD_SCHEMA_VERSION,
  },
)}`;

export function buildKnowledgeCaseRebuildUserPrompt(input: {
  readonly evidenceText: string;
  readonly sourceKey: string;
  readonly title: string;
}): string {
  return `讲座来源键：${input.sourceKey}\n讲座标题：${input.title}\n\n以下内容是从原始逐字稿中确定性选出的候选证据窗口；窗口之间的省略不代表经历连续，不得跨窗口拼接不同学生：\n<evidence-windows>\n${input.evidenceText}\n</evidence-windows>`;
}

export function sanitizeKnowledgeTranscriptForModel(value: string): string {
  return value
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gu, "[REDACTED_EMAIL]")
    .replace(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/gu, "[REDACTED_PHONE]")
    .replace(/(?<!\d)\d{15,18}[0-9Xx]?(?!\d)/gu, "[REDACTED_IDENTIFIER]")
    .trim();
}

export function buildKnowledgeExtractionUserPrompt(input: {
  readonly originalFileName: string;
  readonly titleHint: string;
  readonly transcriptText: string;
}): string {
  return `原始文件名（仅作线索）：${input.originalFileName}\n文件名主题线索（未经确认）：${input.titleHint}\n\n请综合文件名线索和逐字稿正文识别讲座日期与主题，并仅依据以下逐字稿生成JSON：\n<transcript>\n${input.transcriptText}\n</transcript>`;
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

function markdownSubsection(title: string, values: readonly string[]): string {
  return `#### ${title}\n\n${markdownList(values)}`;
}

function renderProject(
  project: KnowledgeExtractionOutput["cases"][number]["coreProjects"][number],
  index: number,
): string {
  return `##### ${safeMarkdownText(project.name) || `项目${String(index + 1)}`}

- 学生角色：${safeMarkdownText(project.role)}
- 实际行动：${displayList(project.actions)}
- 方法与工具：${displayList(project.methods)}
- 可核实产出：${displayList(project.outputs)}
- 影响与结果：${safeMarkdownText(project.impact)}`;
}

function renderEvidencePoint(
  point: KnowledgeExtractionOutput["cases"][number]["evidencePoints"][number],
  index: number,
): string {
  return `##### 证据${String(index + 1)}

- 主张：${safeMarkdownText(point.claim)}
- 逐字稿依据：${safeMarkdownText(point.evidence)}
- 来源定位：${safeMarkdownText(point.sourceLocator)}
- 证据可信度：${point.confidence}`;
}

export function renderKnowledgeCaseBlocks(untrustedCases: unknown): string {
  const cases = z.array(ExtractedCaseSchema).max(30).parse(untrustedCases);
  const caseBlocks = cases.map(
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
- 案例概览：${safeMarkdownText(item.profileSummary)}

${markdownSubsection("核实事实", item.verifiedFacts)}

${markdownSubsection("发展路径", item.developmentPath)}

#### 核心项目与活动

${item.coreProjects.length === 0 ? "- 未披露" : item.coreProjects.map(renderProject).join("\n\n")}

${markdownSubsection("核心优势", item.coreStrengths)}

${markdownSubsection("申请策略", item.applicationStrategy)}

${markdownSubsection("顾问启示", item.advisorInsights)}

${markdownSubsection("分析性判断", item.interpretations)}

${markdownSubsection("待核实信息", item.missingInformation)}

#### 证据对照

${item.evidencePoints.map(renderEvidencePoint).join("\n\n")}

#### 证据边界

${safeMarkdownText(item.evidenceBoundary)}`,
  );
  return caseBlocks.length === 0 ? "未披露" : caseBlocks.join("\n\n");
}

export function renderKnowledgeAnalysisMarkdown(title: string, untrustedOutput: unknown): string {
  const output = KnowledgeExtractionOutputSchema.parse(untrustedOutput);
  return `# ${safeMarkdownText(output.lecture.title || title)}

## 基础信息

- 讲座日期：${output.lecture.date ?? "待人工确认"}
- 日期识别置信度：${output.lecture.dateConfidence}
- 日期识别依据：${safeMarkdownText(output.lecture.dateEvidence)}
- 主题识别置信度：${output.lecture.titleConfidence}
- 主题识别依据：${safeMarkdownText(output.lecture.titleEvidence)}
- 主办机构：${safeMarkdownText(output.organization)}
- 主讲人：${displayList(output.speakers)}
- 学校：${displayList(output.schools)}
- 专业：${displayList(output.majors)}

## 摘要

${safeMarkdownText(output.summary)}

## 趋势

${markdownList(output.trends)}

## 案例卡片

${renderKnowledgeCaseBlocks(output.cases)}

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
            caseType: "科研与竞赛案例",
            confidence: "低",
            coreProjects: [
              {
                actions: ["完成一次虚构测试实现"],
                impact: "仅用于验证结构。",
                methods: ["访谈"],
                name: "虚构测试项目",
                outputs: ["测试报告"],
                role: "匿名测试参与者",
              },
            ],
            coreStrengths: ["能把问题转化为可执行任务"],
            curriculumSystem: "未披露",
            developmentPath: ["识别问题", "完成项目"],
            evidenceBoundary: "仅用于自动化测试。",
            evidencePoints: [
              {
                claim: "完成了虚构项目",
                confidence: "低",
                evidence: "虚构测试原话一。",
                sourceLocator: "00:00:01-00:00:02",
              },
              {
                claim: "形成了测试报告",
                confidence: "低",
                evidence: "虚构测试原话二。",
                sourceLocator: "00:00:03-00:00:04",
              },
            ],
            heading: "匿名虚构案例",
            advisorInsights: ["测试结果必须人工核对"],
            applicationStrategy: ["以可验证产出说明能力"],
            interpretations: ["两条测试事实可能说明其具备执行能力"],
            major: "未披露",
            missingInformation: ["真实项目背景未披露"],
            profileSummary: "匿名学生从识别问题到完成虚构项目，仅用于验证新版案例结构。",
            researchMethods: [],
            schools: [],
            verifiedFacts: ["逐字稿陈述其完成了虚构项目", "逐字稿陈述其形成了测试报告"],
          },
        ],
        evidenceBoundary: "全部内容均为虚构自动化测试结果。",
        failures: "没有可验证的失败信息。",
        lecture: {
          date: "2026-08-02",
          dateConfidence: "高",
          dateEvidence: "文件名与逐字稿开场均明确日期。",
          title: "虚构跨学科讲座",
          titleConfidence: "高",
          titleEvidence: "逐字稿开场明确说明讲座主题。",
        },
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
