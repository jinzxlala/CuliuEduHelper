import { createHash, randomUUID } from "node:crypto";

import {
  assertAuthorizationContext,
  loadAuthorizationContext,
  type AuthorizationContext,
} from "@culiu/authorization";
import {
  ModelGatewayError,
  type JsonModelProvider,
  type JsonModelRequest,
  type JsonModelResult,
  type JsonModelUsage,
} from "@culiu/ai";
import {
  knowledgeAgentRuns,
  knowledgeAnalysisConversationSummaries,
  knowledgeAnalysisConversations,
  knowledgeAnalysisMessages,
  knowledgeAnalysisSources,
  knowledgeCaseVersions,
  knowledgeLectureVersions,
  sourceDocuments,
  type Database,
} from "@culiu/database/runtime";
import type { KnowledgeSearchService } from "@culiu/search";
import type { KnowledgeAnalysisChatTask } from "@culiu/tasks";
import { and, asc, desc, eq, isNull, max, or, sql } from "drizzle-orm";
import { z } from "zod";

import {
  CreateKnowledgeMessageInputSchema,
  KnowledgeAssistantMessageSchema,
  KnowledgeCitationSchema,
  type KnowledgeCitation,
} from "./contracts.js";
import {
  assertKnowledgeWorkspacePermission,
  KnowledgeWorkspaceConflictError,
  KnowledgeWorkspaceNotFoundError,
} from "./workspace-service.js";

export const KNOWLEDGE_ANALYSIS_CHAT_PROMPT_VERSION = "knowledge-analysis-chat.v3" as const;
export const KNOWLEDGE_ANALYSIS_CHAT_SCHEMA_VERSION = "knowledge-analysis-chat-output.v2" as const;
export const KNOWLEDGE_ANALYSIS_CONTEXT_VERSION = "knowledge-analysis-context.v2" as const;
export const KNOWLEDGE_ANALYSIS_PRICING_VERSION = "deepseek-v4-flash-cny-2026-08-02" as const;

const CONTEXT_TOTAL_CHARACTER_LIMIT = 200_000;
const RECENT_MESSAGE_LIMIT = 12;
const MAX_EXPANDED_SOURCES = 20;
const EXPANDED_SOURCE_CHARACTER_LIMIT = 2_000;
const CATALOG_TITLE_CHARACTER_LIMIT = 80;
const NON_PRIORITY_HISTORY_CHARACTER_LIMIT = 1_000;

const SourceKeySchema = z.string().regex(/^[CL]\d{3}$/u);
const KnowledgeAssistantModelOutputSchema = z
  .object({
    answerMarkdown: z.string().trim().min(1).max(60_000),
    citations: z
      .array(
        z
          .object({
            claim: z.string().trim().min(1).max(1_000),
            sourceKeys: z.array(SourceKeySchema).min(1).max(20),
          })
          .strict(),
      )
      .max(100),
    conversationTopic: z.string().trim().min(1).max(80),
    suggestedFollowUps: z.array(z.string().trim().min(1).max(500)).max(8),
    uncertainties: z.array(z.string().trim().min(1).max(1_000)).max(20),
  })
  .strict()
  .superRefine((value, context) => {
    const resolvedCitationCount = value.citations.reduce(
      (count, citation) => count + citation.sourceKeys.length,
      0,
    );
    if (resolvedCitationCount > 100)
      context.addIssue({
        code: "custom",
        message: "Resolved citation count cannot exceed 100.",
        path: ["citations"],
      });
  });

const SummaryOutputSchema = z
  .object({ summaryMarkdown: z.string().trim().min(1).max(60_000) })
  .strict();

interface FrozenSource {
  content: Record<string, unknown>;
  reference: KnowledgeCitation["source"];
  title: string;
}

interface SourceAliases {
  byKey: ReadonlyMap<string, FrozenSource>;
  keyByReference: ReadonlyMap<string, string>;
}

class AnalysisChatValidationError extends Error {
  readonly safeCode: "citation_validation_failed" | "model_output_invalid";

  constructor(
    safeCode: AnalysisChatValidationError["safeCode"],
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AnalysisChatValidationError";
    this.safeCode = safeCode;
  }
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

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function estimateCost(usage: JsonModelUsage): number {
  return Math.ceil(
    usage.promptCacheHitTokens * 0.02 + usage.promptCacheMissTokens + usage.completionTokens * 2,
  );
}

function combineUsage(items: JsonModelUsage[]): JsonModelUsage {
  return items.reduce<JsonModelUsage>(
    (sum, item) => ({
      completionTokens: sum.completionTokens + item.completionTokens,
      promptCacheHitTokens: sum.promptCacheHitTokens + item.promptCacheHitTokens,
      promptCacheMissTokens: sum.promptCacheMissTokens + item.promptCacheMissTokens,
      promptTokens: sum.promptTokens + item.promptTokens,
      totalTokens: sum.totalTokens + item.totalTokens,
    }),
    {
      completionTokens: 0,
      promptCacheHitTokens: 0,
      promptCacheMissTokens: 0,
      promptTokens: 0,
      totalTokens: 0,
    },
  );
}

async function loadFrozenSources(database: Database, workspaceId: string): Promise<FrozenSource[]> {
  const lectureRows = await database
    .select({
      batchId: knowledgeAnalysisSources.knowledgeBatchId,
      contentHash: knowledgeAnalysisSources.contentHash,
      documentHash: sourceDocuments.contentHash,
      lecture: knowledgeLectureVersions,
      sourceId: knowledgeAnalysisSources.sourceId,
    })
    .from(knowledgeAnalysisSources)
    .innerJoin(
      knowledgeLectureVersions,
      and(
        eq(knowledgeLectureVersions.batchId, knowledgeAnalysisSources.knowledgeBatchId),
        eq(knowledgeLectureVersions.lectureId, knowledgeAnalysisSources.lectureId),
      ),
    )
    .innerJoin(sourceDocuments, eq(sourceDocuments.id, knowledgeLectureVersions.sourceDocumentId))
    .where(
      and(
        eq(knowledgeAnalysisSources.workspaceId, workspaceId),
        eq(knowledgeAnalysisSources.sourceType, "lecture"),
        isNull(knowledgeAnalysisSources.removedAt),
      ),
    );
  const caseRows = await database
    .select({
      batchId: knowledgeAnalysisSources.knowledgeBatchId,
      case: knowledgeCaseVersions,
      contentHash: knowledgeAnalysisSources.contentHash,
      documentHash: sourceDocuments.contentHash,
      sourceId: knowledgeAnalysisSources.sourceId,
    })
    .from(knowledgeAnalysisSources)
    .innerJoin(
      knowledgeCaseVersions,
      and(
        eq(knowledgeCaseVersions.batchId, knowledgeAnalysisSources.knowledgeBatchId),
        eq(knowledgeCaseVersions.caseId, knowledgeAnalysisSources.caseId),
      ),
    )
    .innerJoin(sourceDocuments, eq(sourceDocuments.id, knowledgeCaseVersions.sourceDocumentId))
    .where(
      and(
        eq(knowledgeAnalysisSources.workspaceId, workspaceId),
        eq(knowledgeAnalysisSources.sourceType, "case"),
        isNull(knowledgeAnalysisSources.removedAt),
      ),
    );
  const sources: FrozenSource[] = [];
  for (const row of lectureRows) {
    if (row.contentHash !== row.documentHash) throw new Error("frozen_source_hash_mismatch");
    sources.push({
      content: row.lecture,
      reference: {
        batchId: row.batchId,
        contentHash: row.contentHash,
        sourceId: row.sourceId,
        sourceType: "lecture",
      },
      title: row.lecture.title,
    });
  }
  for (const row of caseRows) {
    if (row.contentHash !== row.documentHash) throw new Error("frozen_source_hash_mismatch");
    sources.push({
      content: row.case,
      reference: {
        batchId: row.batchId,
        contentHash: row.contentHash,
        sourceId: row.sourceId,
        sourceType: "case",
      },
      title: row.case.profileSummary || row.case.academicLabel || row.case.caseId,
    });
  }
  return sources.sort((left, right) =>
    `${left.reference.sourceType}:${left.reference.sourceId}`.localeCompare(
      `${right.reference.sourceType}:${right.reference.sourceId}`,
    ),
  );
}

async function conversationMessages(
  database: Database,
  workspaceId: string,
  conversationId: string,
): Promise<Array<typeof knowledgeAnalysisMessages.$inferSelect>> {
  return database
    .select()
    .from(knowledgeAnalysisMessages)
    .where(
      and(
        eq(knowledgeAnalysisMessages.workspaceId, workspaceId),
        eq(knowledgeAnalysisMessages.conversationId, conversationId),
      ),
    )
    .orderBy(asc(knowledgeAnalysisMessages.sequence));
}

async function latestSummary(
  database: Database,
  workspaceId: string,
  conversationId: string,
): Promise<typeof knowledgeAnalysisConversationSummaries.$inferSelect | null> {
  const rows = await database
    .select()
    .from(knowledgeAnalysisConversationSummaries)
    .where(
      and(
        eq(knowledgeAnalysisConversationSummaries.workspaceId, workspaceId),
        eq(knowledgeAnalysisConversationSummaries.conversationId, conversationId),
      ),
    )
    .orderBy(desc(knowledgeAnalysisConversationSummaries.version))
    .limit(1);
  return rows[0] ?? null;
}

async function inputSnapshotHash(
  database: Database,
  workspaceId: string,
  conversationId: string,
): Promise<string> {
  const [sources, messages, summary] = await Promise.all([
    loadFrozenSources(database, workspaceId),
    conversationMessages(database, workspaceId, conversationId),
    latestSummary(database, workspaceId, conversationId),
  ]);
  return sha256(
    stableJson({
      messages: messages.map((message) => ({
        citations: message.citations,
        content: message.contentMarkdown,
        id: message.id,
        role: message.role,
        sequence: message.sequence,
      })),
      sources: sources.map((source) => source.reference),
      summary:
        summary === null
          ? null
          : {
              contentHash: summary.contentHash,
              throughSequence: summary.throughSequence,
              version: summary.version,
            },
    }),
  );
}

export async function prepareKnowledgeAnalysisMessage(
  database: Database,
  authorization: AuthorizationContext,
  workspaceId: string,
  conversationId: string,
  untrustedInput: unknown,
  gitCommitSha: string,
): Promise<{ runId: string; task: KnowledgeAnalysisChatTask; userMessageId: string }> {
  const input = CreateKnowledgeMessageInputSchema.parse(untrustedInput);
  assertAuthorizationContext(authorization, {
    action: "knowledge:analysis:write",
    accessLevel: "internal",
    actorUserId: authorization.actorUserId,
    studentId: null,
  });
  await assertKnowledgeWorkspacePermission(
    database,
    authorization.actorUserId,
    workspaceId,
    "send_message",
  );
  if (!/^[0-9a-f]{40}$/u.test(gitCommitSha)) throw new Error("invalid_git_commit_sha");
  const runId = randomUUID();
  const userMessageId = randomUUID();
  return database.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${conversationId}::text, 0))`,
    );
    const conversations = await transaction
      .select({ status: knowledgeAnalysisConversations.status })
      .from(knowledgeAnalysisConversations)
      .where(
        and(
          eq(knowledgeAnalysisConversations.id, conversationId),
          eq(knowledgeAnalysisConversations.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (conversations[0]?.status !== "active") throw new KnowledgeWorkspaceNotFoundError();
    const activeRuns = await transaction
      .select({ id: knowledgeAgentRuns.id })
      .from(knowledgeAgentRuns)
      .where(
        and(
          eq(knowledgeAgentRuns.conversationId, conversationId),
          eq(knowledgeAgentRuns.kind, "analysis_chat"),
          or(eq(knowledgeAgentRuns.status, "queued"), eq(knowledgeAgentRuns.status, "running")),
        ),
      )
      .limit(1);
    if (activeRuns.length > 0) {
      throw new KnowledgeWorkspaceConflictError("当前对话已有分析任务正在运行。");
    }
    const sequenceRows = await transaction
      .select({ value: max(knowledgeAnalysisMessages.sequence) })
      .from(knowledgeAnalysisMessages)
      .where(eq(knowledgeAnalysisMessages.conversationId, conversationId));
    const sequence = (sequenceRows[0]?.value ?? 0) + 1;
    await transaction.insert(knowledgeAnalysisMessages).values({
      contentMarkdown: input.content,
      conversationId,
      createdByUserId: authorization.actorUserId,
      id: userMessageId,
      role: "user",
      sequence,
      workspaceId,
    });
    const snapshotHash = await inputSnapshotHash(transaction, workspaceId, conversationId);
    await transaction.insert(knowledgeAgentRuns).values({
      authorizationContextId: authorization.id,
      contextVersion: KNOWLEDGE_ANALYSIS_CONTEXT_VERSION,
      conversationId,
      gitCommitSha,
      id: runId,
      inputSnapshotHash: snapshotHash,
      kind: "analysis_chat",
      model: "deepseek-v4-flash",
      pricingVersion: KNOWLEDGE_ANALYSIS_PRICING_VERSION,
      promptVersion: KNOWLEDGE_ANALYSIS_CHAT_PROMPT_VERSION,
      schemaVersion: KNOWLEDGE_ANALYSIS_CHAT_SCHEMA_VERSION,
      workspaceId,
    });
    return {
      runId,
      task: {
        authorization: { contextHash: authorization.contextHash, contextId: authorization.id },
        idempotencyKey: `knowledge_chat_${sha256(`${runId}:${snapshotHash}`)}`,
        payload: {
          contextVersion: KNOWLEDGE_ANALYSIS_CONTEXT_VERSION,
          conversationId,
          correlationId: randomUUID(),
          gitCommitSha,
          inputSnapshotHash: snapshotHash,
          model: "deepseek-v4-flash",
          pricingVersion: KNOWLEDGE_ANALYSIS_PRICING_VERSION,
          promptVersion: KNOWLEDGE_ANALYSIS_CHAT_PROMPT_VERSION,
          runId,
          schemaVersion: KNOWLEDGE_ANALYSIS_CHAT_SCHEMA_VERSION,
          workspaceId,
        },
        taskId: runId,
        taskName: "knowledge.analysis-chat",
      },
      userMessageId,
    };
  });
}

export async function markKnowledgeAnalysisChatEnqueueFailure(
  database: Database,
  runId: string,
): Promise<void> {
  const now = new Date();
  await database
    .update(knowledgeAgentRuns)
    .set({
      completedAt: now,
      safeErrorCode: "queue_unavailable",
      safeErrorSummary: "分析任务暂时无法进入队列，请稍后重试。",
      startedAt: now,
      status: "failed",
    })
    .where(and(eq(knowledgeAgentRuns.id, runId), eq(knowledgeAgentRuns.status, "queued")));
}

function createSourceAliases(sources: FrozenSource[]): SourceAliases {
  const byKey = new Map<string, FrozenSource>();
  const keyByReference = new Map<string, string>();
  let lectureIndex = 0;
  let caseIndex = 0;
  for (const source of sources) {
    const sequence =
      source.reference.sourceType === "lecture" ? (lectureIndex += 1) : (caseIndex += 1);
    const sourceKey = `${source.reference.sourceType === "lecture" ? "L" : "C"}${String(sequence).padStart(3, "0")}`;
    if (sequence > 999 || byKey.has(sourceKey)) throw new Error("analysis_source_alias_overflow");
    const referenceKey = stableJson(source.reference);
    if (keyByReference.has(referenceKey)) throw new Error("analysis_source_reference_duplicate");
    byKey.set(sourceKey, source);
    keyByReference.set(referenceKey, sourceKey);
  }
  return { byKey, keyByReference };
}

function compactSource(sourceKey: string, source: FrozenSource): Record<string, unknown> {
  return {
    sourceKey,
    sourceType: source.reference.sourceType,
    title: source.title.slice(0, CATALOG_TITLE_CHARACTER_LIMIT),
  };
}

function parsedMessageCitations(untrusted: unknown): KnowledgeCitation[] {
  const parsed = z.array(KnowledgeCitationSchema).safeParse(untrusted);
  return parsed.success ? parsed.data : [];
}

function citationSourceKeys(untrusted: unknown, aliases: SourceAliases): string[] {
  return [
    ...new Set(
      parsedMessageCitations(untrusted)
        .map((citation) => aliases.keyByReference.get(stableJson(citation.source)))
        .filter((sourceKey): sourceKey is string => sourceKey !== undefined),
    ),
  ];
}

function historyMessage(
  message: typeof knowledgeAnalysisMessages.$inferSelect,
  aliases: SourceAliases,
  preserveContent: boolean,
): Record<string, unknown> {
  const citations = parsedMessageCitations(message.citations);
  const sourceKeys = citationSourceKeys(citations, aliases);
  return {
    citationSourceKeys: sourceKeys,
    content: preserveContent
      ? message.contentMarkdown
      : message.contentMarkdown.slice(0, NON_PRIORITY_HISTORY_CHARACTER_LIMIT),
    role: message.role,
    sequence: message.sequence,
    unavailableCitationCount: citations.length - sourceKeys.length,
  };
}

function relevanceScore(source: FrozenSource, question: string): number {
  const terms = [
    ...new Set(
      question
        .toLowerCase()
        .split(/[\s，。；：！？、]+/u)
        .filter((term) => term.length >= 2),
    ),
  ];
  const text = `${source.title} ${stableJson(source.content)}`.toLowerCase();
  return terms.reduce((score, term) => score + (text.includes(term) ? term.length : 0), 0);
}

async function expandedSourceKeys(
  search: Pick<KnowledgeSearchService, "searchCases" | "searchLectures">,
  question: string,
): Promise<Set<string>> {
  const results = await Promise.allSettled([
    search.searchLectures({
      hybrid: { embedder: "knowledge_zh_v1", semanticRatio: 0.5 },
      limit: 20,
      query: question,
    }),
    search.searchCases({
      hybrid: { embedder: "knowledge_zh_v1", semanticRatio: 0.5 },
      limit: 20,
      query: question,
    }),
  ]);
  const keys = new Set<string>();
  if (results[0].status === "fulfilled")
    for (const hit of results[0].value.hits) keys.add(`lecture:${hit.document.lecture_id}`);
  if (results[1].status === "fulfilled")
    for (const hit of results[1].value.hits) keys.add(`case:${hit.document.case_id}`);
  return keys;
}

async function buildSourceContext(
  sources: FrozenSource[],
  aliases: SourceAliases,
  question: string,
  search: Pick<KnowledgeSearchService, "searchCases" | "searchLectures">,
  prioritySourceKeys: ReadonlySet<string>,
): Promise<Record<string, unknown>> {
  const hybridKeys =
    sources.length > MAX_EXPANDED_SOURCES ? await expandedSourceKeys(search, question) : new Set();
  const expanded = [...sources]
    .sort((left, right) => {
      const leftSourceKey = aliases.keyByReference.get(stableJson(left.reference));
      const rightSourceKey = aliases.keyByReference.get(stableJson(right.reference));
      const leftPriority =
        leftSourceKey !== undefined && prioritySourceKeys.has(leftSourceKey) ? 1 : 0;
      const rightPriority =
        rightSourceKey !== undefined && prioritySourceKeys.has(rightSourceKey) ? 1 : 0;
      const leftHybrid = hybridKeys.has(`${left.reference.sourceType}:${left.reference.sourceId}`)
        ? 1
        : 0;
      const rightHybrid = hybridKeys.has(
        `${right.reference.sourceType}:${right.reference.sourceId}`,
      )
        ? 1
        : 0;
      return (
        rightPriority - leftPriority ||
        rightHybrid - leftHybrid ||
        relevanceScore(right, question) - relevanceScore(left, question)
      );
    })
    .slice(0, MAX_EXPANDED_SOURCES)
    .map((source) => {
      const sourceKey = aliases.keyByReference.get(stableJson(source.reference));
      if (sourceKey === undefined) throw new Error("analysis_source_alias_missing");
      return {
        content: stableJson(source.content).slice(0, EXPANDED_SOURCE_CHARACTER_LIMIT),
        sourceKey,
        title: source.title,
      };
    });
  return {
    catalog: [...aliases.byKey].map(([sourceKey, source]) => compactSource(sourceKey, source)),
    expanded,
    prioritySourceKeys: [...prioritySourceKeys],
  };
}

function assertSafeMarkdown(markdown: string): void {
  if (/<\/?[a-z][^>]*>/iu.test(markdown))
    throw new AnalysisChatValidationError("model_output_invalid", "unsafe_markdown_html");
}

function resolveAssistantOutput(
  untrusted: unknown,
  aliases: SourceAliases,
): z.infer<typeof KnowledgeAssistantMessageSchema> {
  const parsed = KnowledgeAssistantModelOutputSchema.safeParse(untrusted);
  if (!parsed.success)
    throw new AnalysisChatValidationError("model_output_invalid", "model_output_schema_invalid", {
      cause: parsed.error,
    });
  assertSafeMarkdown(parsed.data.answerMarkdown);
  const citations: KnowledgeCitation[] = [];
  for (const citation of parsed.data.citations) {
    for (const sourceKey of citation.sourceKeys) {
      const source = aliases.byKey.get(sourceKey);
      if (source === undefined)
        throw new AnalysisChatValidationError(
          "citation_validation_failed",
          "citation_source_key_invalid",
        );
      citations.push({ claim: citation.claim, source: source.reference });
    }
  }
  return KnowledgeAssistantMessageSchema.parse({
    ...parsed.data,
    citations,
  });
}

async function generateJsonWithTransientRetry(
  provider: JsonModelProvider,
  request: JsonModelRequest,
): Promise<JsonModelResult> {
  try {
    return await provider.generateJson(request);
  } catch (error) {
    if (!(error instanceof ModelGatewayError) || !error.retryable) throw error;
    return provider.generateJson(request);
  }
}

async function generateValidatedAssistantOutput(
  provider: JsonModelProvider,
  request: JsonModelRequest,
  aliases: SourceAliases,
  usages: JsonModelUsage[],
): Promise<z.infer<typeof KnowledgeAssistantMessageSchema>> {
  const generated = await generateJsonWithTransientRetry(provider, request);
  usages.push(generated.usage);
  try {
    return resolveAssistantOutput(generated.json, aliases);
  } catch (error) {
    if (!(error instanceof AnalysisChatValidationError)) throw error;
    const repaired = await generateJsonWithTransientRetry(provider, {
      systemPrompt:
        "只修复给定 JSON 的结构与引用编号，只输出 JSON。不得增加新事实；引用只能使用 allowedSourceKeys；无法支持的引用应删除。",
      userPrompt: stableJson({
        allowedSourceKeys: [...aliases.byKey.keys()],
        invalidOutput: generated.json,
        outputShape: {
          answerMarkdown: "string",
          citations: [{ claim: "string", sourceKeys: ["L001"] }],
          conversationTopic: "string",
          suggestedFollowUps: ["string"],
          uncertainties: ["string"],
        },
        validationFailure: error.safeCode,
      }),
    });
    usages.push(repaired.usage);
    return resolveAssistantOutput(repaired.json, aliases);
  }
}

function safeFailure(error: unknown): { code: string; summary: string } {
  if (error instanceof AnalysisChatValidationError)
    return error.safeCode === "citation_validation_failed"
      ? { code: error.safeCode, summary: "模型引用未通过工作区资料校验，请重试。" }
      : { code: error.safeCode, summary: "模型返回结构未通过安全校验，请重试。" };
  if (error instanceof ModelGatewayError) {
    if (error.code === "timeout")
      return { code: "provider_timeout", summary: "模型服务响应超时，请稍后重试。" };
    if (error.detailCode === "output_truncated")
      return {
        code: "context_limit_exceeded",
        summary: "对话上下文或模型输出过长，请缩小分析范围后重试。",
      };
    if (error.code === "invalid_output" || error.code === "empty_output")
      return { code: "model_output_invalid", summary: "模型返回内容不完整或格式无效，请重试。" };
    return { code: "provider_unavailable", summary: "模型服务暂时不可用，请稍后重试。" };
  }
  if (error instanceof z.ZodError)
    return { code: "model_output_invalid", summary: "模型返回结构未通过安全校验，请重试。" };
  if (error instanceof Error && error.message === "analysis_context_limit_exceeded")
    return {
      code: "context_limit_exceeded",
      summary: "当前对话上下文过长，请新建对话或缩小分析范围。",
    };
  if (error instanceof Error && error.message === "analysis_snapshot_changed")
    return { code: "snapshot_changed", summary: "工作区资料或对话已更新，请刷新后重试。" };
  return { code: "analysis_failed", summary: "本次分析未能安全完成，请重试。" };
}

export async function executeKnowledgeAnalysisChat(
  database: Database,
  task: KnowledgeAnalysisChatTask,
  provider: JsonModelProvider,
  search: Pick<KnowledgeSearchService, "searchCases" | "searchLectures">,
): Promise<{ messageId: string }> {
  const runRows = await database
    .select()
    .from(knowledgeAgentRuns)
    .where(eq(knowledgeAgentRuns.id, task.payload.runId))
    .limit(1);
  const run = runRows[0];
  if (
    run === undefined ||
    run.status !== "queued" ||
    run.kind !== "analysis_chat" ||
    run.workspaceId !== task.payload.workspaceId ||
    run.conversationId !== task.payload.conversationId ||
    run.inputSnapshotHash !== task.payload.inputSnapshotHash ||
    run.authorizationContextId !== task.authorization.contextId
  )
    throw new Error("analysis_run_mismatch");
  const authorization = await loadAuthorizationContext(database, {
    contextHash: task.authorization.contextHash,
    id: task.authorization.contextId,
  });
  assertAuthorizationContext(authorization, {
    action: "knowledge:analysis:write",
    accessLevel: "internal",
    studentId: null,
  });
  await assertKnowledgeWorkspacePermission(
    database,
    authorization.actorUserId,
    task.payload.workspaceId,
    "send_message",
  );
  if (
    (await inputSnapshotHash(database, task.payload.workspaceId, task.payload.conversationId)) !==
    task.payload.inputSnapshotHash
  )
    throw new Error("analysis_snapshot_changed");
  const startedAt = new Date();
  await database
    .update(knowledgeAgentRuns)
    .set({ startedAt, status: "running" })
    .where(and(eq(knowledgeAgentRuns.id, run.id), eq(knowledgeAgentRuns.status, "queued")));
  const usages: JsonModelUsage[] = [];
  try {
    const [sources, messages, previousSummary] = await Promise.all([
      loadFrozenSources(database, task.payload.workspaceId),
      conversationMessages(database, task.payload.workspaceId, task.payload.conversationId),
      latestSummary(database, task.payload.workspaceId, task.payload.conversationId),
    ]);
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    if (lastUser === undefined) throw new Error("analysis_question_missing");
    const aliases = createSourceAliases(sources);
    const previousAssistant = [...messages]
      .reverse()
      .find((message) => message.role === "assistant" && message.sequence < lastUser.sequence);
    const prioritySourceKeys = new Set(
      previousAssistant === undefined
        ? []
        : citationSourceKeys(previousAssistant.citations, aliases),
    );
    let pendingSummary: { markdown: string; throughSequence: number; version: number } | null =
      null;
    const recentStart = Math.max(0, messages.length - RECENT_MESSAGE_LIMIT);
    const throughSequence = messages[recentStart - 1]?.sequence ?? 0;
    if (throughSequence > (previousSummary?.throughSequence ?? 0)) {
      const summaryInput = messages.filter(
        (message) =>
          message.sequence > (previousSummary?.throughSequence ?? 0) &&
          message.sequence <= throughSequence,
      );
      const generated = await generateJsonWithTransientRetry(provider, {
        systemPrompt:
          "只输出 JSON。把旧对话压缩成忠实摘要；保留问题、结论、分歧、引用 ID 和未解决事项，不引入新事实。",
        userPrompt: stableJson({
          previousSummary: previousSummary?.contentMarkdown ?? null,
          messages: summaryInput.map((message) => historyMessage(message, aliases, false)),
          outputShape: { summaryMarkdown: "string" },
        }),
      });
      usages.push(generated.usage);
      const summary = SummaryOutputSchema.parse(generated.json);
      pendingSummary = {
        markdown: summary.summaryMarkdown,
        throughSequence,
        version: (previousSummary?.version ?? 0) + 1,
      };
    }
    const sourceContext = await buildSourceContext(
      sources,
      aliases,
      lastUser.contentMarkdown,
      search,
      prioritySourceKeys,
    );
    const history = messages
      .slice(recentStart)
      .map((message) =>
        historyMessage(
          message,
          aliases,
          message.id === lastUser.id || message.id === previousAssistant?.id,
        ),
      );
    const userPrompt = stableJson({
      currentQuestion: lastUser.contentMarkdown,
      history,
      historySummary: pendingSummary?.markdown ?? previousSummary?.contentMarkdown ?? null,
      outputShape: {
        answerMarkdown: "string",
        citations: [
          {
            claim: "string",
            sourceKeys: ["L001"],
          },
        ],
        conversationTopic: "根据当前问题概括的简短中文主题，不超过 30 个汉字",
        suggestedFollowUps: ["string"],
        uncertainties: ["string"],
      },
      sources: sourceContext,
    });
    if (userPrompt.length > CONTEXT_TOTAL_CHARACTER_LIMIT)
      throw new Error("analysis_context_limit_exceeded");
    const output = await generateValidatedAssistantOutput(
      provider,
      {
        systemPrompt:
          "你是内部教育知识分析助手，只输出 JSON。只能使用工作区冻结资料与当前对话；追问应优先延续上一条助手回复及其 citationSourceKeys；引用只能填写 sources 中的 sourceKey，不得输出内部 ID、批次号或哈希；资料不支持的判断要标记为分析性判断或待核实；answerMarkdown 禁止原始 HTML；conversationTopic 必须根据当前问题生成简短、具体的中文主题，不要使用‘新对话’或泛化标题。",
        userPrompt,
      },
      aliases,
      usages,
    );
    const usage = combineUsage(usages);
    const completedAt = new Date();
    const messageId = randomUUID();
    await database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${task.payload.conversationId}::text, 0))`,
      );
      if (
        (await inputSnapshotHash(
          transaction,
          task.payload.workspaceId,
          task.payload.conversationId,
        )) !== task.payload.inputSnapshotHash
      )
        throw new Error("analysis_snapshot_changed");
      const sequenceRows = await transaction
        .select({ value: max(knowledgeAnalysisMessages.sequence) })
        .from(knowledgeAnalysisMessages)
        .where(eq(knowledgeAnalysisMessages.conversationId, task.payload.conversationId));
      await transaction.insert(knowledgeAnalysisMessages).values({
        agentRunId: run.id,
        citations: output.citations,
        contentMarkdown: output.answerMarkdown,
        conversationId: task.payload.conversationId,
        id: messageId,
        role: "assistant",
        sequence: (sequenceRows[0]?.value ?? 0) + 1,
        workspaceId: task.payload.workspaceId,
      });
      if (pendingSummary !== null)
        await transaction.insert(knowledgeAnalysisConversationSummaries).values({
          agentRunId: run.id,
          contentHash: sha256(pendingSummary.markdown),
          contentMarkdown: pendingSummary.markdown,
          conversationId: task.payload.conversationId,
          throughSequence: pendingSummary.throughSequence,
          version: pendingSummary.version,
          workspaceId: task.payload.workspaceId,
        });
      await transaction
        .update(knowledgeAgentRuns)
        .set({
          completedAt,
          completionTokens: usage.completionTokens,
          costMicrounits: estimateCost(usage),
          promptTokens: usage.promptTokens,
          status: "succeeded",
          totalTokens: usage.totalTokens,
        })
        .where(eq(knowledgeAgentRuns.id, run.id));
      await transaction
        .update(knowledgeAnalysisConversations)
        .set({ updatedAt: completedAt })
        .where(eq(knowledgeAnalysisConversations.id, task.payload.conversationId));
      if (messages.every((message) => message.role !== "assistant"))
        await transaction
          .update(knowledgeAnalysisConversations)
          .set({ title: output.conversationTopic })
          .where(
            and(
              eq(knowledgeAnalysisConversations.id, task.payload.conversationId),
              eq(knowledgeAnalysisConversations.title, "新对话"),
            ),
          );
    });
    return { messageId };
  } catch (error) {
    const failure = safeFailure(error);
    const usage = combineUsage(usages);
    await database
      .update(knowledgeAgentRuns)
      .set({
        completedAt: new Date(),
        completionTokens: usage.completionTokens,
        costMicrounits: estimateCost(usage),
        promptTokens: usage.promptTokens,
        safeErrorCode: failure.code,
        safeErrorSummary: failure.summary,
        status: "failed",
        totalTokens: usage.totalTokens,
      })
      .where(and(eq(knowledgeAgentRuns.id, run.id), eq(knowledgeAgentRuns.status, "running")));
    throw error;
  }
}

export async function readKnowledgeConversation(
  database: Database,
  actorUserId: string,
  workspaceId: string,
  conversationId: string,
): Promise<{
  conversation: typeof knowledgeAnalysisConversations.$inferSelect;
  messages: Array<typeof knowledgeAnalysisMessages.$inferSelect>;
  runs: Array<{
    id: string;
    safeErrorSummary: string | null;
    status: "queued" | "running" | "succeeded" | "failed";
  }>;
}> {
  await assertKnowledgeWorkspacePermission(database, actorUserId, workspaceId, "read");
  const conversations = await database
    .select()
    .from(knowledgeAnalysisConversations)
    .where(
      and(
        eq(knowledgeAnalysisConversations.id, conversationId),
        eq(knowledgeAnalysisConversations.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  if (conversations[0] === undefined) throw new KnowledgeWorkspaceNotFoundError();
  const [messages, runs] = await Promise.all([
    conversationMessages(database, workspaceId, conversationId),
    database
      .select({
        id: knowledgeAgentRuns.id,
        safeErrorSummary: knowledgeAgentRuns.safeErrorSummary,
        status: knowledgeAgentRuns.status,
      })
      .from(knowledgeAgentRuns)
      .where(
        and(
          eq(knowledgeAgentRuns.conversationId, conversationId),
          eq(knowledgeAgentRuns.kind, "analysis_chat"),
        ),
      )
      .orderBy(desc(knowledgeAgentRuns.createdAt)),
  ]);
  return { conversation: conversations[0], messages, runs };
}
