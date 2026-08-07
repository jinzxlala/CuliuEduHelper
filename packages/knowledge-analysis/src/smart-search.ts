import { createHash, randomUUID } from "node:crypto";

import {
  assertAuthorizationContext,
  loadAuthorizationContext,
  type AuthorizationContext,
} from "@culiu/authorization";
import { ModelGatewayError, type JsonModelProvider, type JsonModelUsage } from "@culiu/ai";
import {
  knowledgeCaseVersions,
  knowledgeImportBatches,
  knowledgeLectureVersions,
  knowledgeSmartSearchResults,
  knowledgeSmartSearchRuns,
  sourceDocuments,
  type Database,
} from "@culiu/database/runtime";
import type {
  CaseDocument,
  CaseSearchInput,
  KnowledgeSearchService,
  LectureDocument,
  LectureSearchInput,
  SearchPage,
} from "@culiu/search";
import type { KnowledgeSmartSearchTask } from "@culiu/tasks";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import {
  KNOWLEDGE_SMART_SEARCH_MAX_CANDIDATES,
  KNOWLEDGE_SMART_SEARCH_MAX_FROZEN_RESULTS,
  KNOWLEDGE_SMART_SEARCH_MAX_PLANS,
  KNOWLEDGE_SMART_SEARCH_MAX_RESULTS,
  KNOWLEDGE_SMART_SEARCH_MAX_ROUNDS,
  CreateSmartSearchInputSchema,
  SmartSearchQueryPlanSchema,
  SmartSearchResultSchema,
  type KnowledgeSourceReference,
  type SmartSearchIntent,
  type SmartSearchQueryPlan,
  type SmartSearchResult,
} from "./contracts.js";

export const KNOWLEDGE_SMART_SEARCH_PROMPT_VERSION = "knowledge-smart-search.v3" as const;
export const KNOWLEDGE_SMART_SEARCH_SCHEMA_VERSION = "knowledge-smart-search-output.v2" as const;
export const KNOWLEDGE_SMART_SEARCH_RETRIEVAL_VERSION = "knowledge-intent-search.v1" as const;
export const KNOWLEDGE_SMART_SEARCH_DEFAULT_SEMANTIC_RATIO = 0.5;
export const KNOWLEDGE_SMART_SEARCH_DEFAULT_PAGE_SIZE = 20;
export const KNOWLEDGE_SMART_SEARCH_MAX_PAGE_SIZE = 50;
export const KNOWLEDGE_SMART_SEARCH_CATALOG_LIMIT = KNOWLEDGE_SMART_SEARCH_MAX_FROZEN_RESULTS;

export const KNOWLEDGE_SMART_SEARCH_CASE_TYPES = [
  "学生录取案例",
  "科研与竞赛案例",
  "跨学科案例",
  "成长路径案例",
  "活动与影响力案例",
  "失败与反例",
  "诚信风险案例",
  "证据与资源卡",
  "知识案例卡",
] as const;

const CASE_TYPE_ALIASES = new Map<string, string>([
  ["科研竞赛案例", "科研与竞赛案例"],
  ["跨学科", "跨学科案例"],
  ["成长路径", "成长路径案例"],
  ["活动影响力案例", "活动与影响力案例"],
  ["知识案例", "知识案例卡"],
]);

const GENERIC_CASE_TYPE_LABELS = new Set(["案例", "学生案例", "学生案例卡"]);

export async function prepareKnowledgeSmartSearch(
  database: Database,
  authorization: AuthorizationContext,
  untrustedInput: unknown,
  gitCommitSha: string,
): Promise<{ runId: string; task: KnowledgeSmartSearchTask }> {
  const input = CreateSmartSearchInputSchema.parse(untrustedInput);
  assertAuthorizationContext(authorization, {
    action: "knowledge:search:smart",
    accessLevel: "internal",
    actorUserId: authorization.actorUserId,
    studentId: null,
  });
  if (!/^[0-9a-f]{40}$/u.test(gitCommitSha)) throw new Error("invalid_git_commit_sha");
  const knowledgeBatchId = await currentPublishedBatchId(database);
  if (knowledgeBatchId === null) throw new Error("knowledge_batch_unavailable");
  const runId = randomUUID();
  const taskId = randomUUID();
  await database.insert(knowledgeSmartSearchRuns).values({
    authorizationContextId: authorization.id,
    createdByUserId: authorization.actorUserId,
    gitCommitSha,
    id: runId,
    knowledgeBatchId,
    model: "deepseek-v4-flash",
    prompt: input.prompt,
    promptHash: sha256(input.prompt),
    promptVersion: KNOWLEDGE_SMART_SEARCH_PROMPT_VERSION,
    retrievalVersion: KNOWLEDGE_SMART_SEARCH_RETRIEVAL_VERSION,
    schemaVersion: KNOWLEDGE_SMART_SEARCH_SCHEMA_VERSION,
  });
  return {
    runId,
    task: {
      authorization: { contextHash: authorization.contextHash, contextId: authorization.id },
      idempotencyKey: `knowledge_smart_${sha256(`${runId}:${knowledgeBatchId}`)}`,
      payload: {
        correlationId: randomUUID(),
        gitCommitSha,
        model: "deepseek-v4-flash",
        promptVersion: KNOWLEDGE_SMART_SEARCH_PROMPT_VERSION,
        retrievalVersion: KNOWLEDGE_SMART_SEARCH_RETRIEVAL_VERSION,
        runId,
        schemaVersion: KNOWLEDGE_SMART_SEARCH_SCHEMA_VERSION,
      },
      taskId,
      taskName: "knowledge.smart-search",
    },
  };
}

export async function markKnowledgeSmartSearchEnqueueFailure(
  database: Database,
  runId: string,
): Promise<void> {
  const now = new Date();
  await database
    .update(knowledgeSmartSearchRuns)
    .set({
      completedAt: now,
      progressStage: "failed",
      safeErrorCode: "queue_unavailable",
      safeErrorSummary: "智能搜索任务暂时无法进入队列，请稍后重试。",
      startedAt: now,
      status: "failed",
    })
    .where(
      and(eq(knowledgeSmartSearchRuns.id, runId), eq(knowledgeSmartSearchRuns.status, "queued")),
    );
}

export async function readKnowledgeSmartSearch(
  database: Database,
  actorUserId: string,
  runId: string,
  page = 1,
  pageSize = KNOWLEDGE_SMART_SEARCH_DEFAULT_PAGE_SIZE,
): Promise<{
  appliedConditions: string[];
  caseCount: number | null;
  candidateReferences: unknown[];
  completedAt: Date | null;
  createdAt: Date;
  exactTotal: number | null;
  id: string;
  intent: SmartSearchIntent | null;
  lectureCount: number | null;
  legacyResult: boolean;
  limitations: string[];
  page: number;
  pageSize: number;
  prompt: string;
  progressStage: string;
  queryPlan: Record<string, unknown> | null;
  resultReferences: unknown[];
  safeErrorStage: string | null;
  safeErrorCode: string | null;
  safeErrorSummary: string | null;
  status: "queued" | "running" | "succeeded" | "failed";
  summary: string | null;
  totalPages: number;
}> {
  const safePage = Math.max(1, Math.trunc(page));
  const safePageSize = Math.max(
    1,
    Math.min(KNOWLEDGE_SMART_SEARCH_MAX_PAGE_SIZE, Math.trunc(pageSize)),
  );
  const rows = await database
    .select({
      appliedConditions: knowledgeSmartSearchRuns.appliedConditions,
      caseCount: knowledgeSmartSearchRuns.caseCount,
      candidateReferences: knowledgeSmartSearchRuns.candidateReferences,
      completedAt: knowledgeSmartSearchRuns.completedAt,
      createdAt: knowledgeSmartSearchRuns.createdAt,
      exactTotal: knowledgeSmartSearchRuns.exactTotal,
      id: knowledgeSmartSearchRuns.id,
      intent: knowledgeSmartSearchRuns.intent,
      lectureCount: knowledgeSmartSearchRuns.lectureCount,
      limitations: knowledgeSmartSearchRuns.limitations,
      prompt: knowledgeSmartSearchRuns.prompt,
      progressStage: knowledgeSmartSearchRuns.progressStage,
      queryPlan: knowledgeSmartSearchRuns.queryPlan,
      resultReferences: knowledgeSmartSearchRuns.resultReferences,
      safeErrorCode: knowledgeSmartSearchRuns.safeErrorCode,
      safeErrorStage: knowledgeSmartSearchRuns.safeErrorStage,
      safeErrorSummary: knowledgeSmartSearchRuns.safeErrorSummary,
      status: knowledgeSmartSearchRuns.status,
      summary: knowledgeSmartSearchRuns.summary,
    })
    .from(knowledgeSmartSearchRuns)
    .where(
      and(
        eq(knowledgeSmartSearchRuns.id, runId),
        eq(knowledgeSmartSearchRuns.createdByUserId, actorUserId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (row === undefined) throw new Error("smart_search_not_found");
  const frozenRows = await database
    .select({
      batchId: knowledgeSmartSearchResults.knowledgeBatchId,
      contentHash: knowledgeSmartSearchResults.contentHash,
      displaySummary: knowledgeSmartSearchResults.displaySummary,
      displayTitle: knowledgeSmartSearchResults.displayTitle,
      matchedTerms: knowledgeSmartSearchResults.matchedTerms,
      rationale: knowledgeSmartSearchResults.rationale,
      sourceDate: knowledgeSmartSearchResults.sourceDate,
      sourceId: knowledgeSmartSearchResults.sourceId,
      sourceType: knowledgeSmartSearchResults.sourceType,
    })
    .from(knowledgeSmartSearchResults)
    .where(eq(knowledgeSmartSearchResults.runId, runId))
    .orderBy(asc(knowledgeSmartSearchResults.ordinal))
    .limit(safePageSize)
    .offset((safePage - 1) * safePageSize);
  const legacyResult = frozenRows.length === 0 && row.resultReferences.length > 0;
  const resultReferences =
    frozenRows.length > 0
      ? frozenRows
      : safePage === 1
        ? row.resultReferences.slice(0, safePageSize)
        : [];
  const resultTotal =
    row.intent === "count" || row.intent === "analysis_required"
      ? 0
      : legacyResult
        ? row.resultReferences.length
        : (row.exactTotal ?? row.resultReferences.length);
  return {
    ...row,
    intent: row.intent as SmartSearchIntent | null,
    legacyResult,
    page: safePage,
    pageSize: safePageSize,
    resultReferences,
    totalPages: Math.max(1, Math.ceil(resultTotal / safePageSize)),
  };
}

export async function listKnowledgeSmartSearches(
  database: Database,
  actorUserId: string,
  limit = 20,
): Promise<
  Array<{
    completedAt: Date | null;
    createdAt: Date;
    id: string;
    progressStage: string;
    prompt: string;
    resultCount: number;
    status: "queued" | "running" | "succeeded" | "failed";
    summary: string | null;
  }>
> {
  const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
  const rows = await database
    .select({
      completedAt: knowledgeSmartSearchRuns.completedAt,
      createdAt: knowledgeSmartSearchRuns.createdAt,
      id: knowledgeSmartSearchRuns.id,
      progressStage: knowledgeSmartSearchRuns.progressStage,
      prompt: knowledgeSmartSearchRuns.prompt,
      exactTotal: knowledgeSmartSearchRuns.exactTotal,
      resultReferences: knowledgeSmartSearchRuns.resultReferences,
      status: knowledgeSmartSearchRuns.status,
      summary: knowledgeSmartSearchRuns.summary,
    })
    .from(knowledgeSmartSearchRuns)
    .where(eq(knowledgeSmartSearchRuns.createdByUserId, actorUserId))
    .orderBy(desc(knowledgeSmartSearchRuns.createdAt))
    .limit(safeLimit);
  return rows.map(({ exactTotal, resultReferences, ...row }) => ({
    ...row,
    resultCount: exactTotal ?? (Array.isArray(resultReferences) ? resultReferences.length : 0),
  }));
}

const RerankOutputSchema = z
  .object({
    limitations: z.array(z.string().trim().min(1).max(500)).max(10),
    results: z
      .array(
        z
          .object({
            matchedTerms: z.array(z.string().trim().min(1).max(80)).max(20),
            rationale: z.string().trim().min(1).max(1_500),
            sourceId: z.string().trim().min(1).max(511),
            sourceType: z.enum(["lecture", "case"]),
          })
          .strict(),
      )
      .max(20),
    summary: z.string().trim().min(1).max(3_000),
  })
  .strict();

type RerankOutput = z.infer<typeof RerankOutputSchema>;

type SearchReader = Pick<KnowledgeSearchService, "searchCases" | "searchLectures">;

interface Candidate {
  document: CaseDocument | LectureDocument;
  matchedPlanIndexes: number[];
  reference: KnowledgeSourceReference;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inferExplicitIntent(prompt: string): SmartSearchIntent | null {
  if (/比例|占比|趋势|比较|对比|相关性|原因|为什么|影响/u.test(prompt)) {
    return "analysis_required";
  }
  if (/多少|几场|几条|数量|总数/u.test(prompt)) return "count";
  if (/所有|全部|完整|目录|清单|年内/u.test(prompt)) return "catalog_browse";
  return null;
}

function inferIntent(prompt: string): SmartSearchIntent {
  return inferExplicitIntent(prompt) ?? "semantic_search";
}

function inferTargets(prompt: string): Array<"lectures" | "cases"> {
  const lectures = /讲座|报告/u.test(prompt);
  const cases = /案例|学生案例/u.test(prompt);
  if (lectures && !cases) return ["lectures"];
  if (cases && !lectures) return ["cases"];
  return ["lectures", "cases"];
}

function inferExplicitTargets(prompt: string): Array<"lectures" | "cases"> | null {
  const lectures = /讲座|报告/u.test(prompt);
  const cases = /案例|学生案例/u.test(prompt);
  if (!lectures && !cases) return null;
  return [...(lectures ? (["lectures"] as const) : []), ...(cases ? (["cases"] as const) : [])];
}

function inferredYearRange(prompt: string): { dateBefore: string; dateFrom: string } | null {
  const match = /(?<!\d)(20\d{2})\s*年/u.exec(prompt);
  if (match?.[1] === undefined) return null;
  const year = Number(match[1]);
  return {
    dateBefore: `${String(year + 1)}-01-01`,
    dateFrom: `${match[1]}-01-01`,
  };
}

export function normalizeSmartSearchPlannerOutput(
  value: unknown,
  prompt = "",
  expectedRound = 1,
): {
  json: unknown;
  warnings: string[];
} {
  if (!isRecord(value) || !Array.isArray(value.queries)) return { json: value, warnings: [] };
  const allowed = new Set<string>(KNOWLEDGE_SMART_SEARCH_CASE_TYPES);
  const dropped = new Set<string>();
  const rawQueries: unknown[] = value.queries;
  const explicitIntent = inferExplicitIntent(prompt);
  const intent =
    explicitIntent ??
    (typeof value.intent === "string" &&
    ["semantic_search", "catalog_browse", "count", "analysis_required"].includes(value.intent)
      ? value.intent
      : inferIntent(prompt));
  const yearRange = inferredYearRange(prompt);
  const normalizedQueries = rawQueries.map((query): unknown => {
    if (!isRecord(query) || (query.target !== "lectures" && query.target !== "cases")) {
      return query;
    }
    const rawFilters = isRecord(query.filters) ? query.filters : {};
    const common = {
      keywords: Array.isArray(query.keywords) ? query.keywords : [],
      matchingStrategy: query.matchingStrategy === "all" ? "all" : "last",
      query: typeof query.query === "string" ? query.query : "",
      target: query.target,
    };
    if (query.target === "lectures") {
      return {
        ...common,
        filters: {
          dateBefore:
            typeof rawFilters.dateBefore === "string"
              ? rawFilters.dateBefore
              : (yearRange?.dateBefore ?? null),
          dateFrom:
            typeof rawFilters.dateFrom === "string"
              ? rawFilters.dateFrom
              : (yearRange?.dateFrom ?? null),
          majors: Array.isArray(rawFilters.majors) ? rawFilters.majors : [],
          organizations: Array.isArray(rawFilters.organizations) ? rawFilters.organizations : [],
          schools: Array.isArray(rawFilters.schools) ? rawFilters.schools : [],
          speakers: Array.isArray(rawFilters.speakers) ? rawFilters.speakers : [],
        },
      };
    }
    const rawCaseTypes = Array.isArray(rawFilters.caseTypes) ? rawFilters.caseTypes : [];
    const caseTypes = rawCaseTypes.flatMap<string>((item) => {
      if (typeof item !== "string") return [];
      const trimmed = item.trim();
      const mapped = CASE_TYPE_ALIASES.get(trimmed) ?? trimmed;
      if (allowed.has(mapped)) return [mapped];
      if (trimmed.length > 0) dropped.add(trimmed);
      return [];
    });
    return {
      ...common,
      filters: {
        activityTypes: Array.isArray(rawFilters.activityTypes) ? rawFilters.activityTypes : [],
        aiDepth: Array.isArray(rawFilters.aiDepth) ? rawFilters.aiDepth : [],
        aiDomains: Array.isArray(rawFilters.aiDomains) ? rawFilters.aiDomains : [],
        caseTypes: [...new Set(caseTypes)],
        confidences: Array.isArray(rawFilters.confidences) ? rawFilters.confidences : [],
        curriculumSystems: Array.isArray(rawFilters.curriculumSystems)
          ? rawFilters.curriculumSystems
          : [],
        majors: Array.isArray(rawFilters.majors) ? rawFilters.majors : [],
        researchMethods: Array.isArray(rawFilters.researchMethods)
          ? rawFilters.researchMethods
          : [],
        schools: Array.isArray(rawFilters.schools) ? rawFilters.schools : [],
        sourceDateBefore:
          typeof rawFilters.sourceDateBefore === "string"
            ? rawFilters.sourceDateBefore
            : (yearRange?.dateBefore ?? null),
        sourceDateFrom:
          typeof rawFilters.sourceDateFrom === "string"
            ? rawFilters.sourceDateFrom
            : (yearRange?.dateFrom ?? null),
      },
    };
  });
  const explicitTargets = inferExplicitTargets(prompt);
  const targets = [
    ...new Set(
      normalizedQueries.flatMap((query) =>
        isRecord(query) && (query.target === "lectures" || query.target === "cases")
          ? [query.target]
          : [],
      ),
    ),
  ];
  if (intent !== "analysis_required" && explicitTargets !== null) {
    const present = new Set(targets);
    const firstQuery = normalizedQueries.find(isRecord);
    const semanticQuery =
      intent === "semantic_search" && typeof firstQuery?.query === "string"
        ? firstQuery.query
        : intent === "semantic_search"
          ? prompt
          : "";
    const semanticKeywords =
      intent === "semantic_search" && Array.isArray(firstQuery?.keywords)
        ? firstQuery.keywords
        : [];
    for (const target of explicitTargets) {
      if (present.has(target)) continue;
      normalizedQueries.push(
        target === "lectures"
          ? {
              filters: {
                dateBefore: yearRange?.dateBefore ?? null,
                dateFrom: yearRange?.dateFrom ?? null,
                majors: [],
                organizations: [],
                schools: [],
                speakers: [],
              },
              keywords: semanticKeywords,
              matchingStrategy: "last",
              query: semanticQuery,
              target,
            }
          : {
              filters: {
                activityTypes: [],
                aiDepth: [],
                aiDomains: [],
                caseTypes: [],
                confidences: [],
                curriculumSystems: [],
                majors: [],
                researchMethods: [],
                schools: [],
                sourceDateBefore: yearRange?.dateBefore ?? null,
                sourceDateFrom: yearRange?.dateFrom ?? null,
              },
              keywords: semanticKeywords,
              matchingStrategy: "last",
              query: semanticQuery,
              target,
            },
      );
    }
  }
  const normalized = {
    ...value,
    intent,
    queries: intent === "analysis_required" ? [] : normalizedQueries,
    round: expectedRound,
    targets: explicitTargets ?? (targets.length > 0 ? targets : inferTargets(prompt)),
  };
  const warnings = [...dropped].map((item) =>
    GENERIC_CASE_TYPE_LABELS.has(item)
      ? `检索规划中的“${item}”是泛称，已取消该案例类型限制。`
      : `检索规划中的未知案例类型“${item}”已被忽略。`,
  );
  return { json: normalized, warnings };
}

function addUsage(left: JsonModelUsage, right: JsonModelUsage): JsonModelUsage {
  return {
    completionTokens: left.completionTokens + right.completionTokens,
    promptCacheHitTokens: left.promptCacheHitTokens + right.promptCacheHitTokens,
    promptCacheMissTokens: left.promptCacheMissTokens + right.promptCacheMissTokens,
    promptTokens: left.promptTokens + right.promptTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

function emptyUsage(): JsonModelUsage {
  return {
    completionTokens: 0,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: 0,
    promptTokens: 0,
    totalTokens: 0,
  };
}

function estimateCostMicrounits(usage: JsonModelUsage): number {
  return Math.ceil(
    usage.promptCacheHitTokens * 0.02 +
      usage.promptCacheMissTokens * 1 +
      usage.completionTokens * 2,
  );
}

function plannerSystemPrompt(): string {
  return [
    "你是醋溜教育内部知识库的检索规划器。只输出 JSON。",
    "只能使用 lectures 或 cases；不得生成其他索引、字段、SQL、代码或虚构 ID。",
    "先把需求分类为 semantic_search、catalog_browse、count 或 analysis_required。",
    "所有/全部/目录型需求使用 catalog_browse；多少/数量使用 count；比例、趋势、比较、相关性或原因使用 analysis_required；其他主题相关性查询使用 semantic_search。",
    "每个查询必须包含 target、query、keywords、matchingStrategy 和该 target 的完整 filters。纯筛选查询允许 query 为空且 keywords 为空。",
    "lectures 只能使用 dateFrom、dateBefore、机构、讲者、学校、专业筛选；cases 只能使用来源讲座日期、案例类型、可信度、课程体系、学校、专业、研究方法、活动、AI方向和AI深度筛选。",
    "年份必须使用左闭右开的日期范围，例如 2025 年是 dateFrom/sourceDateFrom=2025-01-01，dateBefore/sourceDateBefore=2026-01-01。案例年份指来源讲座日期。",
    "analysis_required 的 queries 必须为空；其他意图至少生成一个查询。",
    `cases 的 caseTypes 只能从以下值选择：${KNOWLEDGE_SMART_SEARCH_CASE_TYPES.join("、")}。`,
    "“案例”“学生案例”“学生案例卡”只是泛称，不是案例类型；遇到泛称时 caseTypes 必须为空数组。",
    "AI 与人工智能视为同一概念；为提高召回可以规划互补查询，但不要在 matchingStrategy=all 的同一查询中强制二者同时出现。",
    "matchingStrategy 为 last（宽松）或 all（保留全部关键词）。",
    "总查询数不得超过服务器告知的剩余额度。",
  ].join("\n");
}

function plannerUserPrompt(input: {
  candidateCount: number;
  previousPlans: SmartSearchQueryPlan[];
  prompt: string;
  remainingPlans: number;
  round: number;
}): string {
  return stableJson({
    candidateCount: input.candidateCount,
    instruction:
      input.round === 1
        ? "把自然语言需求转换为互补的中文检索计划。"
        : "现有候选不足，请在不重复已有查询的前提下扩大召回。",
    outputShape: {
      intent: "semantic_search|catalog_browse|count|analysis_required",
      interpretation: "string",
      queries: [
        {
          filters: "使用目标资料类型对应的完整筛选对象",
          keywords: ["string"],
          matchingStrategy: "last|all",
          query: "string",
          target: "lectures|cases",
        },
      ],
      round: input.round,
      targets: ["lectures|cases"],
    },
    previousPlans: input.previousPlans,
    remainingPlans: input.remainingPlans,
    userRequest: input.prompt,
  });
}

function compactDocument(candidate: Candidate): Record<string, unknown> {
  if (candidate.reference.sourceType === "lecture") {
    const document = candidate.document as LectureDocument;
    return {
      aiCrossDisciplinary: document.ai_cross_disciplinary_text.slice(0, 1_000),
      date: document.date,
      failureRisk: document.failure_text.slice(0, 700),
      majors: document.majors,
      organization: document.organization,
      schools: document.schools,
      summary: document.summary.slice(0, 1_500),
      title: document.title,
      trend: document.trend_text.slice(0, 1_000),
    };
  }
  const document = candidate.document as CaseDocument;
  return {
    advisorInsights: document.advisor_insights.slice(0, 6),
    applicationStrategy: document.application_strategy.slice(0, 6),
    background: document.background.slice(0, 1_000),
    caseType: document.case_type,
    confidence: document.confidence,
    coreProjects: document.core_projects.slice(0, 4),
    major: document.major,
    profileSummary: document.profile_summary.slice(0, 1_500),
    schools: document.schools,
    verifiedFacts: document.verified_facts.slice(0, 10),
  };
}

function rerankSystemPrompt(): string {
  return [
    "你是醋溜教育内部知识库的候选筛选器。只输出 JSON。",
    "只能返回 candidateSet 中已有的 sourceType + sourceId，不能创造、改写或补全 ID。",
    "sourceId 必须逐字复制 candidateSet 中的值；不得返回重复的 sourceType + sourceId。",
    "按用户需求和候选正文进行保守排序；区分核实事实、分析判断和资料缺失。",
    "rationale 必须说明匹配原因，不能把分析判断描述成逐字稿直接证据。",
    "结果最多 20 条；没有足够依据时返回更少结果并写入 limitations。",
  ].join("\n");
}

function validateRerankReferences(
  output: RerankOutput,
  candidateList: Candidate[],
): SmartSearchResult["results"] {
  const allowed = new Map(
    candidateList.map((item) => [
      `${item.reference.sourceType}:${item.reference.sourceId}`,
      item.reference,
    ]),
  );
  const seen = new Set<string>();
  return output.results.map((item) => {
    const key = `${item.sourceType}:${item.sourceId}`;
    const reference = allowed.get(key);
    if (reference === undefined) throw new Error("smart_search_result_outside_candidates");
    if (seen.has(key)) throw new Error("smart_search_result_duplicate");
    seen.add(key);
    return { ...reference, matchedTerms: item.matchedTerms, rationale: item.rationale };
  });
}

function isCorrectableRerankError(error: unknown): boolean {
  return (
    error instanceof Error &&
    ["smart_search_result_duplicate", "smart_search_result_outside_candidates"].includes(
      error.message,
    )
  );
}

function safeError(error: unknown): { code: string; summary: string } {
  if (error instanceof z.ZodError) {
    return { code: "model_output_invalid", summary: "模型返回结构未通过安全校验。" };
  }
  if (error instanceof Error && error.name === "AuthorizationDeniedError") {
    return { code: "authorization_denied", summary: "运行授权已失效或不满足要求。" };
  }
  if (error instanceof Error && error.message === "knowledge_batch_changed") {
    return { code: "knowledge_batch_changed", summary: "知识版本已变化，请重新发起智能搜索。" };
  }
  if (error instanceof Error && error.message === "smart_search_catalog_limit_exceeded") {
    return {
      code: "catalog_limit_exceeded",
      summary:
        "符合条件的资料超过 10,000 条安全遍历上限，系统未用局部结果冒充精确总数。请增加年份、学校、专业或资料类型条件后重试。",
    };
  }
  if (
    error instanceof Error &&
    ["smart_search_intent_changed_between_rounds", "smart_search_plan_limit_exceeded"].includes(
      error.message,
    )
  ) {
    return {
      code: "model_plan_invalid",
      summary: "模型生成的搜索计划前后不一致，系统已停止执行。请重新提交或改用普通关键词搜索。",
    };
  }
  if (error instanceof Error && error.message === "smart_search_result_outside_candidates") {
    return {
      code: "rerank_reference_invalid",
      summary: "模型两次返回了候选范围之外的资料，系统已拒绝不可靠结果，请重试智能搜索。",
    };
  }
  if (error instanceof Error && error.message === "smart_search_result_duplicate") {
    return {
      code: "rerank_reference_duplicate",
      summary: "模型两次返回了重复资料，系统已拒绝不可靠结果，请重试智能搜索。",
    };
  }
  if (error instanceof ModelGatewayError) {
    return { code: "model_unavailable", summary: "模型服务暂时未能完成智能搜索，请稍后重试。" };
  }
  return { code: "smart_search_failed", summary: "智能搜索未能安全完成，请改用普通关键词搜索。" };
}

async function currentPublishedBatchId(database: Database): Promise<string | null> {
  const rows = await database
    .select({ id: knowledgeImportBatches.id })
    .from(knowledgeImportBatches)
    .where(eq(knowledgeImportBatches.status, "published"))
    .orderBy(desc(knowledgeImportBatches.publishedAt))
    .limit(1);
  return rows[0]?.id ?? null;
}

async function sourceReferences(
  database: Database,
  batchId: string,
  lectureIds: string[],
  caseIds: string[],
): Promise<Map<string, KnowledgeSourceReference>> {
  const output = new Map<string, KnowledgeSourceReference>();
  if (lectureIds.length > 0) {
    const rows = await database
      .select({
        contentHash: sourceDocuments.contentHash,
        sourceId: knowledgeLectureVersions.lectureId,
      })
      .from(knowledgeLectureVersions)
      .innerJoin(sourceDocuments, eq(sourceDocuments.id, knowledgeLectureVersions.sourceDocumentId))
      .where(
        and(
          eq(knowledgeLectureVersions.batchId, batchId),
          inArray(knowledgeLectureVersions.lectureId, lectureIds),
        ),
      );
    for (const row of rows) {
      output.set(`lecture:${row.sourceId}`, {
        batchId,
        contentHash: row.contentHash,
        sourceId: row.sourceId,
        sourceType: "lecture",
      });
    }
  }
  if (caseIds.length > 0) {
    const rows = await database
      .select({ contentHash: sourceDocuments.contentHash, sourceId: knowledgeCaseVersions.caseId })
      .from(knowledgeCaseVersions)
      .innerJoin(sourceDocuments, eq(sourceDocuments.id, knowledgeCaseVersions.sourceDocumentId))
      .where(
        and(
          eq(knowledgeCaseVersions.batchId, batchId),
          inArray(knowledgeCaseVersions.caseId, caseIds),
        ),
      );
    for (const row of rows) {
      output.set(`case:${row.sourceId}`, {
        batchId,
        contentHash: row.contentHash,
        sourceId: row.sourceId,
        sourceType: "case",
      });
    }
  }
  return output;
}

type SmartSearchPlanItem = SmartSearchQueryPlan["queries"][number];
type LecturePlanItem = Extract<SmartSearchPlanItem, { target: "lectures" }>;
type CasePlanItem = Extract<SmartSearchPlanItem, { target: "cases" }>;

function lectureInput(
  plan: LecturePlanItem,
  hybrid: boolean,
  semanticRatio: number,
  limit = 10,
  offset = 0,
): LectureSearchInput {
  return {
    filters: {
      dateBefore: plan.filters.dateBefore ?? undefined,
      dateFrom: plan.filters.dateFrom ?? undefined,
      majors: plan.filters.majors,
      organizations: plan.filters.organizations,
      schools: plan.filters.schools,
      speakers: plan.filters.speakers,
    },
    ...(hybrid ? { hybrid: { embedder: "knowledge_zh_v1", semanticRatio } } : {}),
    limit,
    matchingStrategy: plan.matchingStrategy,
    offset,
    query: plan.query,
    sort: "date:desc",
  };
}

function caseInput(
  plan: CasePlanItem,
  hybrid: boolean,
  semanticRatio: number,
  limit = 10,
  offset = 0,
): CaseSearchInput {
  return {
    filters: {
      activityTypes: plan.filters.activityTypes,
      aiDepth: plan.filters.aiDepth,
      aiDomains: plan.filters.aiDomains,
      caseTypes: plan.filters.caseTypes,
      confidence: plan.filters.confidences,
      curriculumSystems: plan.filters.curriculumSystems,
      majors: plan.filters.majors,
      researchMethods: plan.filters.researchMethods,
      schools: plan.filters.schools,
      sourceDateBefore: plan.filters.sourceDateBefore ?? undefined,
      sourceDateFrom: plan.filters.sourceDateFrom ?? undefined,
    },
    ...(hybrid ? { hybrid: { embedder: "knowledge_zh_v1", semanticRatio } } : {}),
    limit,
    matchingStrategy: plan.matchingStrategy,
    offset,
    query: plan.query,
    sort: "source_date:desc",
  };
}

async function executePlan(
  search: SearchReader,
  plan: SmartSearchPlanItem,
  semanticRatio: number,
): Promise<{
  hybridFailed: boolean;
  pages: Array<SearchPage<CaseDocument> | SearchPage<LectureDocument>>;
}> {
  const keyword =
    plan.target === "lectures"
      ? search.searchLectures(lectureInput(plan, false, semanticRatio))
      : search.searchCases(caseInput(plan, false, semanticRatio));
  const hybrid =
    plan.target === "lectures"
      ? search.searchLectures(lectureInput(plan, true, semanticRatio))
      : search.searchCases(caseInput(plan, true, semanticRatio));
  const [keywordResult, hybridResult] = await Promise.allSettled([keyword, hybrid]);
  if (keywordResult.status === "rejected") throw keywordResult.reason;
  return {
    hybridFailed: hybridResult.status === "rejected",
    pages:
      hybridResult.status === "fulfilled"
        ? [keywordResult.value, hybridResult.value]
        : [keywordResult.value],
  };
}

function candidateKey(candidate: Candidate): string {
  return `${candidate.reference.sourceType}:${candidate.reference.sourceId}`;
}

function addCandidate(
  candidates: Map<string, Candidate>,
  document: CaseDocument | LectureDocument,
  planIndex: number,
  target: "lectures" | "cases",
): void {
  const sourceId =
    target === "lectures"
      ? (document as LectureDocument).lecture_id
      : (document as CaseDocument).case_id;
  const key = `${target === "lectures" ? "lecture" : "case"}:${sourceId}`;
  const existing = candidates.get(key);
  if (existing !== undefined) {
    if (!existing.matchedPlanIndexes.includes(planIndex))
      existing.matchedPlanIndexes.push(planIndex);
    return;
  }
  candidates.set(key, {
    document,
    matchedPlanIndexes: [planIndex],
    reference: {
      batchId: "00000000-0000-0000-0000-000000000000",
      contentHash: "0".repeat(64),
      sourceId,
      sourceType: target === "lectures" ? "lecture" : "case",
    },
  });
}

async function collectDeterministicCandidates(
  search: SearchReader,
  queries: SmartSearchPlanItem[],
  semanticRatio: number,
): Promise<Candidate[]> {
  const candidates = new Map<string, Candidate>();
  for (const [planIndex, plan] of queries.entries()) {
    let offset = 0;
    for (;;) {
      const page =
        plan.target === "lectures"
          ? await search.searchLectures(lectureInput(plan, false, semanticRatio, 50, offset))
          : await search.searchCases(caseInput(plan, false, semanticRatio, 50, offset));
      if (page.estimatedTotalHits > KNOWLEDGE_SMART_SEARCH_CATALOG_LIMIT) {
        throw new Error("smart_search_catalog_limit_exceeded");
      }
      for (const hit of page.hits) addCandidate(candidates, hit.document, planIndex, plan.target);
      offset += page.hits.length;
      if (page.hits.length === 0 || offset >= page.estimatedTotalHits) break;
      if (offset >= KNOWLEDGE_SMART_SEARCH_CATALOG_LIMIT) {
        throw new Error("smart_search_catalog_limit_exceeded");
      }
    }
  }
  if (candidates.size > KNOWLEDGE_SMART_SEARCH_CATALOG_LIMIT) {
    throw new Error("smart_search_catalog_limit_exceeded");
  }
  return [...candidates.values()];
}

function sourceDate(candidate: Candidate): string | null {
  return candidate.reference.sourceType === "lecture"
    ? (candidate.document as LectureDocument).date
    : (candidate.document as CaseDocument).source_date;
}

function displayTitle(candidate: Candidate): string {
  if (candidate.reference.sourceType === "lecture") {
    return (candidate.document as LectureDocument).title;
  }
  const document = candidate.document as CaseDocument;
  return document.profile_summary || document.academic_label || document.case_type;
}

function displaySummary(candidate: Candidate): string {
  if (candidate.reference.sourceType === "lecture") {
    return (candidate.document as LectureDocument).summary.slice(0, 1_500);
  }
  const document = candidate.document as CaseDocument;
  return (document.profile_summary || document.background || document.evidence_boundary).slice(
    0,
    1_500,
  );
}

function sortCatalogCandidates(candidates: Candidate[]): Candidate[] {
  return [...candidates].sort((left, right) => {
    const dateOrder = (sourceDate(right) ?? "").localeCompare(sourceDate(left) ?? "");
    if (dateOrder !== 0) return dateOrder;
    const typeOrder = left.reference.sourceType.localeCompare(right.reference.sourceType);
    if (typeOrder !== 0) return typeOrder;
    const titleOrder = displayTitle(left).localeCompare(displayTitle(right), "zh-CN");
    return titleOrder !== 0
      ? titleOrder
      : left.reference.sourceId.localeCompare(right.reference.sourceId);
  });
}

function appliedConditions(plan: SmartSearchQueryPlan): string[] {
  const conditions = [`搜索意图：${plan.intent}`, `资料类型：${plan.targets.join("、")}`];
  for (const query of plan.queries) {
    conditions.push(
      `${query.target === "lectures" ? "讲座" : "案例"}：${query.query || "不限定关键词"}`,
    );
    const filters = Object.entries(query.filters).flatMap(([key, value]) => {
      if (value === null) return [];
      if (Array.isArray(value) && value.length === 0) return [];
      return [`${key}=${Array.isArray(value) ? value.join("、") : value}`];
    });
    conditions.push(...filters);
  }
  return [...new Set(conditions)].slice(0, 30);
}

function deterministicSummary(input: {
  caseCount: number;
  intent: SmartSearchIntent;
  interpretation: string;
  lectureCount: number;
  resultCount: number;
}): string {
  if (input.intent === "analysis_required") {
    return `${input.interpretation} 这类问题需要基于冻结资料进行比例、趋势或比较分析，请进入分析工作区继续。`;
  }
  if (input.intent === "count") {
    return `${input.interpretation} 系统确定性计数为 ${String(input.lectureCount + input.caseCount)} 条，其中讲座 ${String(input.lectureCount)} 条、案例 ${String(input.caseCount)} 条。`;
  }
  if (input.intent === "catalog_browse") {
    return `${input.interpretation} 共找到 ${String(input.lectureCount + input.caseCount)} 条，其中讲座 ${String(input.lectureCount)} 条、案例 ${String(input.caseCount)} 条；结果支持稳定分页。`;
  }
  return `${input.interpretation} 从最多 ${String(KNOWLEDGE_SMART_SEARCH_MAX_CANDIDATES)} 条候选中筛选出 ${String(input.resultCount)} 条相关资料。`;
}

async function attachReferences(
  database: Database,
  batchId: string,
  candidateList: Candidate[],
): Promise<void> {
  const references = await sourceReferences(
    database,
    batchId,
    candidateList
      .filter((item) => item.reference.sourceType === "lecture")
      .map((item) => item.reference.sourceId),
    candidateList
      .filter((item) => item.reference.sourceType === "case")
      .map((item) => item.reference.sourceId),
  );
  for (const candidate of candidateList) {
    const reference = references.get(candidateKey(candidate));
    if (reference === undefined) throw new Error("knowledge_batch_changed");
    candidate.reference = reference;
  }
}

async function persistSuccessfulRun(
  database: Database,
  runId: string,
  result: SmartSearchResult,
  candidates: Candidate[],
  usage: JsonModelUsage,
): Promise<void> {
  const byKey = new Map(candidates.map((candidate) => [candidateKey(candidate), candidate]));
  await database.transaction(async (transaction) => {
    if (
      result.intent !== "count" &&
      result.intent !== "analysis_required" &&
      result.results.length > 0
    ) {
      await transaction.insert(knowledgeSmartSearchResults).values(
        result.results.map((item, ordinal) => {
          const candidate = byKey.get(`${item.sourceType}:${item.sourceId}`);
          if (candidate === undefined) throw new Error("knowledge_batch_changed");
          return {
            contentHash: item.contentHash,
            displaySummary: displaySummary(candidate),
            displayTitle: displayTitle(candidate),
            knowledgeBatchId: item.batchId,
            matchedTerms: item.matchedTerms,
            ordinal,
            rationale: item.rationale,
            runId,
            sourceDate: sourceDate(candidate),
            sourceId: item.sourceId,
            sourceType: item.sourceType,
          };
        }),
      );
    }
    await transaction
      .update(knowledgeSmartSearchRuns)
      .set({
        appliedConditions: result.appliedConditions,
        caseCount: result.caseCount,
        completedAt: new Date(),
        completionTokens: usage.completionTokens,
        costMicrounits: estimateCostMicrounits(usage),
        exactTotal: result.exactTotal,
        intent: result.intent,
        lectureCount: result.lectureCount,
        limitations: result.limitations,
        progressStage: "succeeded",
        promptTokens: usage.promptTokens,
        resultReferences: result.results.slice(0, KNOWLEDGE_SMART_SEARCH_MAX_RESULTS),
        status: "succeeded",
        summary: result.summary,
        totalTokens: usage.totalTokens,
      })
      .where(eq(knowledgeSmartSearchRuns.id, runId));
  });
}

export async function executeKnowledgeSmartSearch(
  database: Database,
  task: KnowledgeSmartSearchTask,
  provider: JsonModelProvider,
  search: SearchReader,
  semanticRatio = KNOWLEDGE_SMART_SEARCH_DEFAULT_SEMANTIC_RATIO,
): Promise<SmartSearchResult> {
  const runRows = await database
    .select()
    .from(knowledgeSmartSearchRuns)
    .where(eq(knowledgeSmartSearchRuns.id, task.payload.runId))
    .limit(1);
  const run = runRows[0];
  if (run === undefined || run.status !== "queued") throw new Error("smart_search_run_unavailable");
  if (
    run.authorizationContextId !== task.authorization.contextId ||
    run.gitCommitSha !== task.payload.gitCommitSha ||
    run.model !== task.payload.model ||
    run.promptVersion !== task.payload.promptVersion ||
    run.schemaVersion !== task.payload.schemaVersion ||
    run.retrievalVersion !== task.payload.retrievalVersion ||
    run.prompt.length > 1_000 ||
    sha256(run.prompt) !== run.promptHash
  ) {
    throw new Error("smart_search_task_mismatch");
  }
  const authorization = await loadAuthorizationContext(database, {
    actorUserId: run.createdByUserId,
    contextHash: task.authorization.contextHash,
    id: task.authorization.contextId,
  });
  assertAuthorizationContext(authorization, {
    action: "knowledge:search:smart",
    accessLevel: "internal",
    actorUserId: run.createdByUserId,
    studentId: null,
  });

  const startedAt = new Date();
  const claimed = await database
    .update(knowledgeSmartSearchRuns)
    .set({ progressStage: "planning", startedAt, status: "running" })
    .where(
      and(eq(knowledgeSmartSearchRuns.id, run.id), eq(knowledgeSmartSearchRuns.status, "queued")),
    )
    .returning({ id: knowledgeSmartSearchRuns.id });
  if (claimed.length !== 1) throw new Error("smart_search_run_unavailable");

  let usage = emptyUsage();
  let failureStage: "planning" | "retrieval" | "rerank" | "pagination" = "planning";
  try {
    if ((await currentPublishedBatchId(database)) !== run.knowledgeBatchId) {
      throw new Error("knowledge_batch_changed");
    }
    const plans: SmartSearchQueryPlan[] = [];
    const normalizationWarnings: string[] = [];

    const generatePlan = async (
      round: number,
      candidateCount: number,
    ): Promise<SmartSearchQueryPlan> => {
      const remainingPlans =
        KNOWLEDGE_SMART_SEARCH_MAX_PLANS - plans.flatMap((item) => item.queries).length;
      const request = {
        systemPrompt: plannerSystemPrompt(),
        userPrompt: plannerUserPrompt({
          candidateCount,
          previousPlans: plans,
          prompt: run.prompt,
          remainingPlans,
          round,
        }),
      };
      let generated = await provider.generateJson(request);
      usage = addUsage(usage, generated.usage);
      let normalized = normalizeSmartSearchPlannerOutput(generated.json, run.prompt, round);
      let parsed = SmartSearchQueryPlanSchema.safeParse(normalized.json);
      if (!parsed.success) {
        generated = await provider.generateJson({
          systemPrompt: [
            plannerSystemPrompt(),
            "上一次结构未通过校验。请根据用户原始需求重新输出完整 JSON，不要解释错误。",
          ].join("\n"),
          userPrompt: request.userPrompt,
        });
        usage = addUsage(usage, generated.usage);
        normalized = normalizeSmartSearchPlannerOutput(generated.json, run.prompt, round);
        parsed = SmartSearchQueryPlanSchema.safeParse(normalized.json);
      }
      if (!parsed.success) throw parsed.error;
      if (plans[0] !== undefined && parsed.data.intent !== plans[0].intent) {
        throw new Error("smart_search_intent_changed_between_rounds");
      }
      normalizationWarnings.push(...normalized.warnings);
      if (parsed.data.queries.length > remainingPlans) {
        throw new Error("smart_search_plan_limit_exceeded");
      }
      return parsed.data;
    };

    const firstPlan = await generatePlan(1, 0);
    plans.push(firstPlan);
    await database
      .update(knowledgeSmartSearchRuns)
      .set({
        intent: firstPlan.intent,
        queryPlan: {
          normalizationWarnings: [...new Set(normalizationWarnings)],
          rounds: plans,
          semanticRatio,
        },
      })
      .where(eq(knowledgeSmartSearchRuns.id, run.id));

    if (firstPlan.intent === "analysis_required") {
      const result = SmartSearchResultSchema.parse({
        appliedConditions: appliedConditions(firstPlan),
        caseCount: 0,
        exactTotal: null,
        intent: firstPlan.intent,
        lectureCount: 0,
        limitations: ["比例、趋势、比较、相关性和原因分析必须在冻结资料的工作区中完成。"],
        results: [],
        summary: deterministicSummary({
          caseCount: 0,
          intent: firstPlan.intent,
          interpretation: firstPlan.interpretation,
          lectureCount: 0,
          resultCount: 0,
        }),
      });
      await persistSuccessfulRun(database, run.id, result, [], usage);
      return result;
    }

    if (firstPlan.intent === "catalog_browse" || firstPlan.intent === "count") {
      failureStage = "retrieval";
      await database
        .update(knowledgeSmartSearchRuns)
        .set({ progressStage: "retrieving" })
        .where(eq(knowledgeSmartSearchRuns.id, run.id));
      let candidateList = await collectDeterministicCandidates(
        search,
        firstPlan.queries,
        semanticRatio,
      );
      await attachReferences(database, run.knowledgeBatchId, candidateList);
      candidateList = sortCatalogCandidates(candidateList);
      const lectureCount = candidateList.filter(
        (item) => item.reference.sourceType === "lecture",
      ).length;
      const caseCount = candidateList.length - lectureCount;
      const results =
        firstPlan.intent === "count"
          ? []
          : candidateList.map((candidate) => ({
              ...candidate.reference,
              matchedTerms: firstPlan.queries
                .filter((query) =>
                  candidate.matchedPlanIndexes.includes(firstPlan.queries.indexOf(query)),
                )
                .flatMap((query) => query.keywords)
                .filter((item, index, all) => all.indexOf(item) === index)
                .slice(0, 20),
              rationale: "符合本次目录浏览的确定性关键词与筛选条件。",
            }));
      const result = SmartSearchResultSchema.parse({
        appliedConditions: appliedConditions(firstPlan),
        caseCount,
        exactTotal: candidateList.length,
        intent: firstPlan.intent,
        lectureCount,
        limitations: [...new Set(normalizationWarnings)].slice(0, 10),
        results,
        summary: deterministicSummary({
          caseCount,
          intent: firstPlan.intent,
          interpretation: firstPlan.interpretation,
          lectureCount,
          resultCount: results.length,
        }),
      });
      failureStage = "pagination";
      if ((await currentPublishedBatchId(database)) !== run.knowledgeBatchId) {
        throw new Error("knowledge_batch_changed");
      }
      await persistSuccessfulRun(database, run.id, result, candidateList, usage);
      return result;
    }

    failureStage = "retrieval";
    const candidates = new Map<string, Candidate>();
    let hybridFailed = false;
    for (let round = 1; round <= KNOWLEDGE_SMART_SEARCH_MAX_ROUNDS; round += 1) {
      const plan = round === 1 ? firstPlan : await generatePlan(round, candidates.size);
      if (round > 1) plans.push(plan);
      const planOffset = plans.slice(0, -1).flatMap((item) => item.queries).length;
      for (const [localIndex, query] of plan.queries.entries()) {
        const retrieval = await executePlan(search, query, semanticRatio);
        hybridFailed ||= retrieval.hybridFailed;
        const planIndex = planOffset + localIndex;
        for (const page of retrieval.pages) {
          for (const hit of page.hits) {
            if (candidates.size >= KNOWLEDGE_SMART_SEARCH_MAX_CANDIDATES) break;
            addCandidate(candidates, hit.document, planIndex, query.target);
          }
        }
      }
      if (candidates.size >= 10 || candidates.size >= KNOWLEDGE_SMART_SEARCH_MAX_CANDIDATES) break;
    }
    const candidateList = [...candidates.values()];
    await attachReferences(database, run.knowledgeBatchId, candidateList);
    await database
      .update(knowledgeSmartSearchRuns)
      .set({
        candidateReferences: candidateList.map((item) => ({
          ...item.reference,
          matchedPlanIndexes: item.matchedPlanIndexes,
        })),
        progressStage: "reranking",
        queryPlan: {
          normalizationWarnings: [...new Set(normalizationWarnings)],
          rounds: plans,
          semanticRatio,
        },
      })
      .where(eq(knowledgeSmartSearchRuns.id, run.id));

    const lectureCount = candidateList.filter(
      (item) => item.reference.sourceType === "lecture",
    ).length;
    const caseCount = candidateList.length - lectureCount;
    if (candidateList.length === 0) {
      const result = SmartSearchResultSchema.parse({
        appliedConditions: appliedConditions(firstPlan),
        caseCount,
        exactTotal: null,
        intent: firstPlan.intent,
        lectureCount,
        limitations: [
          ...new Set([
            ...normalizationWarnings,
            ...(hybridFailed ? ["本次混合检索不可用，结果仅来自关键词召回。"] : []),
            "没有找到可供模型筛选的候选资料。",
          ]),
        ].slice(0, 10),
        results: [],
        summary: "未在当前知识库中找到满足条件的讲座或案例。",
      });
      await persistSuccessfulRun(database, run.id, result, [], usage);
      return result;
    }

    failureStage = "rerank";
    const rerankInput = {
      candidateSet: candidateList.map((item) => ({
        document: compactDocument(item),
        matchedPlanIndexes: item.matchedPlanIndexes,
        sourceId: item.reference.sourceId,
        sourceType: item.reference.sourceType,
      })),
      interpretation: plans.map((item) => item.interpretation),
      outputShape: {
        limitations: ["string"],
        results: [
          {
            matchedTerms: ["string"],
            rationale: "string",
            sourceId: "string",
            sourceType: "lecture|case",
          },
        ],
        summary: "string",
      },
      userRequest: run.prompt,
    };
    let reranked = await provider.generateJson({
      systemPrompt: rerankSystemPrompt(),
      userPrompt: stableJson(rerankInput),
    });
    usage = addUsage(usage, reranked.usage);
    let repairUsed = false;
    let parsedOutput = RerankOutputSchema.safeParse(reranked.json);
    if (!parsedOutput.success) {
      repairUsed = true;
      reranked = await provider.generateJson({
        systemPrompt: [
          rerankSystemPrompt(),
          "上一次输出结构未通过校验。请重新生成完整 JSON，不要解释错误。",
          "limitations 必须是字符串数组；results 必须是对象数组；只能复制 allowedReferences 中的引用。",
        ].join("\n"),
        userPrompt: stableJson({
          allowedReferences: candidateList.map((item) => ({
            sourceId: item.reference.sourceId,
            sourceType: item.reference.sourceType,
          })),
          ...rerankInput,
        }),
      });
      usage = addUsage(usage, reranked.usage);
      parsedOutput = RerankOutputSchema.safeParse(reranked.json);
    }
    if (!parsedOutput.success) throw parsedOutput.error;
    let output = parsedOutput.data;
    let results: SmartSearchResult["results"];
    try {
      results = validateRerankReferences(output, candidateList);
    } catch (error) {
      if (!isCorrectableRerankError(error) || repairUsed) throw error;
      repairUsed = true;
      reranked = await provider.generateJson({
        systemPrompt: [
          rerankSystemPrompt(),
          "上一次输出引用了候选范围之外或重复的资料。请重新生成完整结果。",
          "只能逐字复制 allowedReferences 中的 sourceType + sourceId；不得返回其他 ID。",
        ].join("\n"),
        userPrompt: stableJson({
          allowedReferences: candidateList.map((item) => ({
            sourceId: item.reference.sourceId,
            sourceType: item.reference.sourceType,
          })),
          ...rerankInput,
        }),
      });
      usage = addUsage(usage, reranked.usage);
      output = RerankOutputSchema.parse(reranked.json);
      results = validateRerankReferences(output, candidateList);
    }
    const result = SmartSearchResultSchema.parse({
      appliedConditions: appliedConditions(firstPlan),
      caseCount,
      exactTotal: null,
      intent: firstPlan.intent,
      lectureCount,
      limitations: [
        ...normalizationWarnings,
        ...(hybridFailed ? ["本次混合检索不可用，结果仅来自关键词召回。"] : []),
        ...output.limitations,
      ]
        .filter((item, index, all) => all.indexOf(item) === index)
        .slice(0, 10),
      results,
      summary: deterministicSummary({
        caseCount,
        intent: firstPlan.intent,
        interpretation: firstPlan.interpretation,
        lectureCount,
        resultCount: results.length,
      }),
    });
    if ((await currentPublishedBatchId(database)) !== run.knowledgeBatchId) {
      throw new Error("knowledge_batch_changed");
    }
    await persistSuccessfulRun(database, run.id, result, candidateList, usage);
    return result;
  } catch (error) {
    const safe = safeError(error);
    await database
      .update(knowledgeSmartSearchRuns)
      .set({
        completedAt: new Date(),
        progressStage: "failed",
        safeErrorCode: safe.code,
        safeErrorStage: typeof failureStage === "string" ? failureStage : "planning",
        safeErrorSummary: safe.summary,
        status: "failed",
      })
      .where(eq(knowledgeSmartSearchRuns.id, run.id));
    throw error;
  }
}
