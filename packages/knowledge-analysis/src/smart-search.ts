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
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import {
  KNOWLEDGE_SMART_SEARCH_MAX_CANDIDATES,
  KNOWLEDGE_SMART_SEARCH_MAX_PLANS,
  CreateSmartSearchInputSchema,
  SmartSearchQueryPlanSchema,
  SmartSearchResultSchema,
  type KnowledgeSourceReference,
  type SmartSearchQueryPlan,
  type SmartSearchResult,
} from "./contracts.js";

export const KNOWLEDGE_SMART_SEARCH_PROMPT_VERSION = "knowledge-smart-search.v2" as const;
export const KNOWLEDGE_SMART_SEARCH_SCHEMA_VERSION = "knowledge-smart-search-output.v1" as const;
export const KNOWLEDGE_SMART_SEARCH_RETRIEVAL_VERSION = "knowledge-hybrid.v2" as const;
export const KNOWLEDGE_SMART_SEARCH_DEFAULT_SEMANTIC_RATIO = 0.5;

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
): Promise<{
  candidateReferences: unknown[];
  completedAt: Date | null;
  createdAt: Date;
  id: string;
  prompt: string;
  progressStage: string;
  queryPlan: Record<string, unknown> | null;
  resultReferences: unknown[];
  safeErrorCode: string | null;
  safeErrorSummary: string | null;
  status: "queued" | "running" | "succeeded" | "failed";
  summary: string | null;
}> {
  const rows = await database
    .select({
      candidateReferences: knowledgeSmartSearchRuns.candidateReferences,
      completedAt: knowledgeSmartSearchRuns.completedAt,
      createdAt: knowledgeSmartSearchRuns.createdAt,
      id: knowledgeSmartSearchRuns.id,
      prompt: knowledgeSmartSearchRuns.prompt,
      progressStage: knowledgeSmartSearchRuns.progressStage,
      queryPlan: knowledgeSmartSearchRuns.queryPlan,
      resultReferences: knowledgeSmartSearchRuns.resultReferences,
      safeErrorCode: knowledgeSmartSearchRuns.safeErrorCode,
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
  return row;
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
      resultReferences: knowledgeSmartSearchRuns.resultReferences,
      status: knowledgeSmartSearchRuns.status,
      summary: knowledgeSmartSearchRuns.summary,
    })
    .from(knowledgeSmartSearchRuns)
    .where(eq(knowledgeSmartSearchRuns.createdByUserId, actorUserId))
    .orderBy(desc(knowledgeSmartSearchRuns.createdAt))
    .limit(safeLimit);
  return rows.map(({ resultReferences, ...row }) => ({
    ...row,
    resultCount: Array.isArray(resultReferences) ? resultReferences.length : 0,
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

export function normalizeSmartSearchPlannerOutput(value: unknown): {
  json: unknown;
  warnings: string[];
} {
  if (!isRecord(value) || !Array.isArray(value.queries)) return { json: value, warnings: [] };
  const allowed = new Set<string>(KNOWLEDGE_SMART_SEARCH_CASE_TYPES);
  const dropped = new Set<string>();
  const rawQueries: unknown[] = value.queries;
  const normalized = {
    ...value,
    queries: rawQueries.map((query): unknown => {
      if (!isRecord(query) || !isRecord(query.filters) || !Array.isArray(query.filters.caseTypes)) {
        return query;
      }
      const rawCaseTypes: unknown[] = query.filters.caseTypes;
      if (rawCaseTypes.some((item) => typeof item !== "string")) return query;
      const caseTypes = rawCaseTypes.flatMap<string>((item) => {
        if (typeof item !== "string") return [];
        const trimmed = item.trim();
        const mapped = CASE_TYPE_ALIASES.get(trimmed) ?? trimmed;
        if (allowed.has(mapped)) return [mapped];
        if (trimmed.length > 0) dropped.add(trimmed);
        return [];
      });
      return { ...query, filters: { ...query.filters, caseTypes: [...new Set(caseTypes)] } };
    }),
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
    "每个查询必须包含 target、query、keywords、matchingStrategy 和完整 filters。",
    "lectures 只能使用日期、机构、学校、专业筛选；cases 只能使用案例类型、可信度、学校、专业筛选。",
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
      interpretation: "string",
      queries: [
        {
          filters: {
            caseTypes: [],
            confidences: [],
            dateFrom: null,
            dateTo: null,
            majors: [],
            organizations: [],
            schools: [],
          },
          keywords: ["string"],
          matchingStrategy: "last|all",
          query: "string",
          target: "lectures|cases",
        },
      ],
      round: input.round,
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

function lectureInput(
  plan: SmartSearchQueryPlan["queries"][number],
  hybrid: boolean,
  semanticRatio: number,
): LectureSearchInput {
  return {
    filters: {
      dateFrom: plan.filters.dateFrom ?? undefined,
      dateTo: plan.filters.dateTo ?? undefined,
      majors: plan.filters.majors,
      organizations: plan.filters.organizations,
      schools: plan.filters.schools,
    },
    ...(hybrid ? { hybrid: { embedder: "knowledge_zh_v1", semanticRatio } } : {}),
    limit: 10,
    matchingStrategy: plan.matchingStrategy,
    offset: 0,
    query: plan.query,
  };
}

function caseInput(
  plan: SmartSearchQueryPlan["queries"][number],
  hybrid: boolean,
  semanticRatio: number,
): CaseSearchInput {
  return {
    filters: {
      caseTypes: plan.filters.caseTypes,
      confidence: plan.filters.confidences,
      majors: plan.filters.majors,
      schools: plan.filters.schools,
    },
    ...(hybrid ? { hybrid: { embedder: "knowledge_zh_v1", semanticRatio } } : {}),
    limit: 10,
    matchingStrategy: plan.matchingStrategy,
    offset: 0,
    query: plan.query,
  };
}

async function executePlan(
  search: SearchReader,
  plan: SmartSearchQueryPlan["queries"][number],
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
  try {
    if ((await currentPublishedBatchId(database)) !== run.knowledgeBatchId) {
      throw new Error("knowledge_batch_changed");
    }
    const plans: SmartSearchQueryPlan[] = [];
    const candidates = new Map<string, Candidate>();
    const normalizationWarnings: string[] = [];
    let hybridFailed = false;

    for (let round = 1; round <= 2; round += 1) {
      const remainingPlans =
        KNOWLEDGE_SMART_SEARCH_MAX_PLANS - plans.flatMap((item) => item.queries).length;
      if (remainingPlans <= 0 || (round === 2 && candidates.size >= 10)) break;
      await database
        .update(knowledgeSmartSearchRuns)
        .set({ progressStage: "planning" })
        .where(eq(knowledgeSmartSearchRuns.id, run.id));
      const planned = await provider.generateJson({
        systemPrompt: plannerSystemPrompt(),
        userPrompt: plannerUserPrompt({
          candidateCount: candidates.size,
          previousPlans: plans,
          prompt: run.prompt,
          remainingPlans,
          round,
        }),
      });
      usage = addUsage(usage, planned.usage);
      const normalizedPlan = normalizeSmartSearchPlannerOutput(planned.json);
      normalizationWarnings.push(...normalizedPlan.warnings);
      const plan = SmartSearchQueryPlanSchema.parse(normalizedPlan.json);
      if (plan.round !== round || plan.queries.length > remainingPlans) {
        throw new Error("smart_search_plan_limit_exceeded");
      }
      plans.push(plan);
      await database
        .update(knowledgeSmartSearchRuns)
        .set({
          progressStage: "retrieving",
          queryPlan: {
            normalizationWarnings: [...new Set(normalizationWarnings)],
            rounds: plans,
            semanticRatio,
          },
        })
        .where(eq(knowledgeSmartSearchRuns.id, run.id));

      const planOffset = plans.slice(0, -1).flatMap((item) => item.queries).length;
      for (const [localIndex, query] of plan.queries.entries()) {
        const retrieval = await executePlan(search, query, semanticRatio);
        hybridFailed ||= retrieval.hybridFailed;
        const planIndex = planOffset + localIndex;
        for (const page of retrieval.pages) {
          for (const hit of page.hits) {
            const sourceId =
              query.target === "lectures"
                ? (hit.document as LectureDocument).lecture_id
                : (hit.document as CaseDocument).case_id;
            const key = `${query.target === "lectures" ? "lecture" : "case"}:${sourceId}`;
            const existing = candidates.get(key);
            if (existing !== undefined) {
              if (!existing.matchedPlanIndexes.includes(planIndex)) {
                existing.matchedPlanIndexes.push(planIndex);
              }
            } else if (candidates.size < KNOWLEDGE_SMART_SEARCH_MAX_CANDIDATES) {
              candidates.set(key, {
                document: hit.document,
                matchedPlanIndexes: [planIndex],
                reference: {
                  batchId: run.knowledgeBatchId,
                  contentHash: "0".repeat(64),
                  sourceId,
                  sourceType: query.target === "lectures" ? "lecture" : "case",
                },
              });
            }
          }
        }
      }
    }

    const candidateList = [...candidates.values()];
    const references = await sourceReferences(
      database,
      run.knowledgeBatchId,
      candidateList
        .filter((item) => item.reference.sourceType === "lecture")
        .map((item) => item.reference.sourceId),
      candidateList
        .filter((item) => item.reference.sourceType === "case")
        .map((item) => item.reference.sourceId),
    );
    for (const candidate of candidateList) {
      const reference = references.get(
        `${candidate.reference.sourceType}:${candidate.reference.sourceId}`,
      );
      if (reference === undefined) throw new Error("knowledge_batch_changed");
      candidate.reference = reference;
    }
    await database
      .update(knowledgeSmartSearchRuns)
      .set({
        candidateReferences: candidateList.map((item) => ({
          ...item.reference,
          matchedPlanIndexes: item.matchedPlanIndexes,
        })),
        progressStage: "reranking",
      })
      .where(eq(knowledgeSmartSearchRuns.id, run.id));

    if (candidateList.length === 0) {
      if ((await currentPublishedBatchId(database)) !== run.knowledgeBatchId) {
        throw new Error("knowledge_batch_changed");
      }
      const result = SmartSearchResultSchema.parse({
        limitations: [
          ...new Set([
            ...normalizationWarnings,
            ...(hybridFailed ? ["本次混合检索不可用，结果仅来自关键词召回。"] : []),
            "已完成关键词与语义召回，但没有找到可供筛选的候选资料。",
          ]),
        ].slice(0, 10),
        results: [],
        summary: "未在当前知识库中找到满足条件的讲座或案例。",
      });
      const completedAt = new Date();
      await database
        .update(knowledgeSmartSearchRuns)
        .set({
          completedAt,
          completionTokens: usage.completionTokens,
          costMicrounits: estimateCostMicrounits(usage),
          progressStage: "succeeded",
          promptTokens: usage.promptTokens,
          resultReferences: [],
          status: "succeeded",
          summary: result.summary,
          totalTokens: usage.totalTokens,
        })
        .where(eq(knowledgeSmartSearchRuns.id, run.id));
      return result;
    }

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
    let output = RerankOutputSchema.parse(reranked.json);
    let results: SmartSearchResult["results"];
    try {
      results = validateRerankReferences(output, candidateList);
    } catch (error) {
      if (!isCorrectableRerankError(error)) throw error;
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
      limitations: [
        ...normalizationWarnings,
        ...(hybridFailed ? ["本次混合检索不可用，结果仅来自关键词召回。"] : []),
        ...output.limitations,
      ]
        .filter((item, index, all) => all.indexOf(item) === index)
        .slice(0, 10),
      results,
      summary: output.summary,
    });
    if ((await currentPublishedBatchId(database)) !== run.knowledgeBatchId) {
      throw new Error("knowledge_batch_changed");
    }
    const completedAt = new Date();
    await database
      .update(knowledgeSmartSearchRuns)
      .set({
        completedAt,
        completionTokens: usage.completionTokens,
        costMicrounits: estimateCostMicrounits(usage),
        progressStage: "succeeded",
        promptTokens: usage.promptTokens,
        resultReferences: result.results,
        status: "succeeded",
        summary: result.summary,
        totalTokens: usage.totalTokens,
      })
      .where(eq(knowledgeSmartSearchRuns.id, run.id));
    return result;
  } catch (error) {
    const safe = safeError(error);
    await database
      .update(knowledgeSmartSearchRuns)
      .set({
        completedAt: new Date(),
        progressStage: "failed",
        safeErrorCode: safe.code,
        safeErrorSummary: safe.summary,
        status: "failed",
      })
      .where(eq(knowledgeSmartSearchRuns.id, run.id));
    throw error;
  }
}
