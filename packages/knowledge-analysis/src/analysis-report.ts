import { createHash, randomUUID } from "node:crypto";

import {
  assertAuthorizationContext,
  loadAuthorizationContext,
  type AuthorizationContext,
} from "@culiu/authorization";
import type { JsonModelProvider, JsonModelUsage } from "@culiu/ai";
import {
  knowledgeAgentRuns,
  knowledgeAnalysisConversations,
  knowledgeAnalysisMessages,
  knowledgeAnalysisReports,
  knowledgeAnalysisSources,
  knowledgeCaseVersions,
  knowledgeLectureVersions,
  sourceDocuments,
  type Database,
} from "@culiu/database/runtime";
import type { ImmutableObjectStore, StoredObjectReference } from "@culiu/storage";
import type { KnowledgeAnalysisReportTask } from "@culiu/tasks";
import { and, asc, desc, eq, inArray, isNull, lte, max, sql } from "drizzle-orm";
import { z } from "zod";

import {
  AnalysisReportRequestSchema,
  AnalysisReportSpecSchema,
  KnowledgeCitationSchema,
  KnowledgeSourceReferenceSchema,
  type AnalysisReportSpec,
  type KnowledgeCitation,
  type KnowledgeSourceReference,
} from "./contracts.js";
import {
  ANALYSIS_REPORT_MAX_BYTES,
  ANALYSIS_REPORT_TEMPLATE_VERSION,
  renderAnalysisReport,
  type ReportCitationPresentation,
} from "./report-renderer.js";
import {
  assertKnowledgeWorkspacePermission,
  KnowledgeWorkspaceConflictError,
  KnowledgeWorkspaceNotFoundError,
} from "./workspace-service.js";

export const ANALYSIS_REPORT_PROMPT_VERSION = "knowledge-analysis-report.v2" as const;
export const ANALYSIS_REPORT_SCHEMA_VERSION = "knowledge-analysis-report-output.v1" as const;
export const ANALYSIS_REPORT_CONTEXT_VERSION = "knowledge-analysis-report-context.v1" as const;
export const ANALYSIS_REPORT_PRICING_VERSION = "deepseek-v4-flash-cny-2026-08-02" as const;

const FrozenReportSourceSchema = z
  .object({
    reference: KnowledgeSourceReferenceSchema,
    workspaceSourceId: z.uuid(),
  })
  .strict();

const ChartKeySchema = z.enum([
  "source_type",
  "case_major",
  "case_type",
  "case_confidence",
  "lecture_organization",
  "lecture_year",
]);

const NarrativeSchema = z
  .object({
    executiveSummary: z.string().trim().min(1).max(8_000),
    sections: z
      .array(
        z
          .object({
            chartKey: ChartKeySchema.nullable(),
            citations: z.array(KnowledgeCitationSchema).max(100),
            id: z
              .string()
              .regex(/^[a-z][a-z0-9_-]*$/u)
              .max(80),
            paragraphs: z.array(z.string().trim().min(1).max(4_000)).min(1).max(20),
            title: z.string().trim().min(1).max(200),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    title: z.string().trim().min(1).max(240),
  })
  .strict();

interface DeterministicPoint {
  label: string;
  sourceIds: string[];
  value: number;
}
type DeterministicCharts = Record<z.infer<typeof ChartKeySchema>, DeterministicPoint[]>;

interface LoadedSource {
  content: Record<string, unknown>;
  reference: KnowledgeSourceReference;
  title: string;
}

export interface KnowledgeAnalysisReportCitationAuditRow {
  contentHash: string;
  publicDescription: string;
  publicLabel: string;
  sourceId: string;
  sourceType: "lecture" | "case";
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function estimateCost(usage: JsonModelUsage): number {
  return Math.ceil(
    usage.promptCacheHitTokens * 0.02 + usage.promptCacheMissTokens + usage.completionTokens * 2,
  );
}

async function activeSourceSnapshot(
  database: Database,
  workspaceId: string,
): Promise<z.infer<typeof FrozenReportSourceSchema>[]> {
  const rows = await database
    .select({
      batchId: knowledgeAnalysisSources.knowledgeBatchId,
      contentHash: knowledgeAnalysisSources.contentHash,
      id: knowledgeAnalysisSources.id,
      sourceId: knowledgeAnalysisSources.sourceId,
      sourceType: knowledgeAnalysisSources.sourceType,
    })
    .from(knowledgeAnalysisSources)
    .where(
      and(
        eq(knowledgeAnalysisSources.workspaceId, workspaceId),
        isNull(knowledgeAnalysisSources.removedAt),
      ),
    )
    .orderBy(asc(knowledgeAnalysisSources.createdAt));
  return rows.map((row) =>
    FrozenReportSourceSchema.parse({
      reference: {
        batchId: row.batchId,
        contentHash: row.contentHash,
        sourceId: row.sourceId,
        sourceType: row.sourceType,
      },
      workspaceSourceId: row.id,
    }),
  );
}

async function reportSnapshotHash(
  database: Database,
  workspaceId: string,
  conversationId: string,
  throughSequence: number,
  sources: z.infer<typeof FrozenReportSourceSchema>[],
): Promise<string> {
  const messages = await database
    .select({
      citations: knowledgeAnalysisMessages.citations,
      content: knowledgeAnalysisMessages.contentMarkdown,
      role: knowledgeAnalysisMessages.role,
      sequence: knowledgeAnalysisMessages.sequence,
    })
    .from(knowledgeAnalysisMessages)
    .where(
      and(
        eq(knowledgeAnalysisMessages.workspaceId, workspaceId),
        eq(knowledgeAnalysisMessages.conversationId, conversationId),
        lte(knowledgeAnalysisMessages.sequence, throughSequence),
      ),
    )
    .orderBy(asc(knowledgeAnalysisMessages.sequence));
  return sha256(stableJson({ conversationId, messages, sources, throughSequence, workspaceId }));
}

export async function prepareKnowledgeAnalysisReport(
  database: Database,
  authorization: AuthorizationContext,
  workspaceId: string,
  conversationId: string,
  untrustedInput: unknown,
  gitCommitSha: string,
): Promise<{ reportId: string; task: KnowledgeAnalysisReportTask }> {
  const input = AnalysisReportRequestSchema.parse(untrustedInput);
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
    "create_report",
  );
  if (!/^[0-9a-f]{40}$/u.test(gitCommitSha)) throw new Error("invalid_git_commit_sha");
  const reportId = randomUUID();
  const runId = randomUUID();
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
    const sequenceRows = await transaction
      .select({ value: max(knowledgeAnalysisMessages.sequence) })
      .from(knowledgeAnalysisMessages)
      .where(
        and(
          eq(knowledgeAnalysisMessages.workspaceId, workspaceId),
          eq(knowledgeAnalysisMessages.conversationId, conversationId),
        ),
      );
    const throughSequence = sequenceRows[0]?.value ?? 0;
    if (throughSequence === 0)
      throw new KnowledgeWorkspaceConflictError("当前对话还没有可用于生成报告的内容。");
    const sources = await activeSourceSnapshot(transaction, workspaceId);
    if (sources.length === 0)
      throw new KnowledgeWorkspaceConflictError("工作区还没有冻结的背景资料。");
    const snapshotHash = await reportSnapshotHash(
      transaction,
      workspaceId,
      conversationId,
      throughSequence,
      sources,
    );
    let reportSeriesId: string = randomUUID();
    let version = 1;
    if (input.supersedesReportId !== undefined) {
      const prior = await transaction
        .select({
          conversationId: knowledgeAnalysisReports.conversationId,
          reportSeriesId: knowledgeAnalysisReports.reportSeriesId,
          status: knowledgeAnalysisReports.status,
          version: knowledgeAnalysisReports.version,
          workspaceId: knowledgeAnalysisReports.workspaceId,
        })
        .from(knowledgeAnalysisReports)
        .where(eq(knowledgeAnalysisReports.id, input.supersedesReportId))
        .limit(1);
      if (
        prior[0]?.workspaceId !== workspaceId ||
        prior[0].conversationId !== conversationId ||
        prior[0].status !== "succeeded"
      )
        throw new KnowledgeWorkspaceNotFoundError();
      reportSeriesId = prior[0].reportSeriesId;
      version = prior[0].version + 1;
    }
    await transaction.insert(knowledgeAgentRuns).values({
      authorizationContextId: authorization.id,
      contextVersion: ANALYSIS_REPORT_CONTEXT_VERSION,
      conversationId,
      gitCommitSha,
      id: runId,
      inputSnapshotHash: snapshotHash,
      kind: "analysis_report",
      model: "deepseek-v4-flash",
      pricingVersion: ANALYSIS_REPORT_PRICING_VERSION,
      promptVersion: ANALYSIS_REPORT_PROMPT_VERSION,
      schemaVersion: ANALYSIS_REPORT_SCHEMA_VERSION,
      workspaceId,
    });
    await transaction.insert(knowledgeAnalysisReports).values({
      agentRunId: runId,
      conversationId,
      conversationSnapshotHash: snapshotHash,
      conversationThroughSequence: throughSequence,
      createdByUserId: authorization.actorUserId,
      id: reportId,
      reportSeriesId,
      requirements: input.requirements,
      sourceSnapshot: sources,
      supersedesReportId: input.supersedesReportId,
      templateVersion: ANALYSIS_REPORT_TEMPLATE_VERSION,
      version,
      workspaceId,
    });
    return {
      reportId,
      task: {
        authorization: { contextHash: authorization.contextHash, contextId: authorization.id },
        idempotencyKey: `knowledge_report_${sha256(`${reportId}:${snapshotHash}`)}`,
        payload: {
          contextVersion: ANALYSIS_REPORT_CONTEXT_VERSION,
          conversationId,
          correlationId: randomUUID(),
          gitCommitSha,
          inputSnapshotHash: snapshotHash,
          model: "deepseek-v4-flash",
          pricingVersion: ANALYSIS_REPORT_PRICING_VERSION,
          promptVersion: ANALYSIS_REPORT_PROMPT_VERSION,
          reportId,
          schemaVersion: ANALYSIS_REPORT_SCHEMA_VERSION,
          templateVersion: ANALYSIS_REPORT_TEMPLATE_VERSION,
          workspaceId,
        },
        taskId: runId,
        taskName: "knowledge.analysis-report",
      },
    };
  });
}

async function loadFrozenSources(
  database: Database,
  snapshot: z.infer<typeof FrozenReportSourceSchema>[],
): Promise<LoadedSource[]> {
  const output: LoadedSource[] = [];
  for (const item of snapshot) {
    const workspaceRows = await database
      .select({
        batchId: knowledgeAnalysisSources.knowledgeBatchId,
        contentHash: knowledgeAnalysisSources.contentHash,
        sourceId: knowledgeAnalysisSources.sourceId,
        sourceType: knowledgeAnalysisSources.sourceType,
      })
      .from(knowledgeAnalysisSources)
      .where(eq(knowledgeAnalysisSources.id, item.workspaceSourceId))
      .limit(1);
    if (
      workspaceRows[0] === undefined ||
      stableJson({
        batchId: workspaceRows[0].batchId,
        contentHash: workspaceRows[0].contentHash,
        sourceId: workspaceRows[0].sourceId,
        sourceType: workspaceRows[0].sourceType,
      }) !== stableJson(item.reference)
    )
      throw new Error("report_source_snapshot_mismatch");
    if (item.reference.sourceType === "lecture") {
      const rows = await database
        .select({ documentHash: sourceDocuments.contentHash, lecture: knowledgeLectureVersions })
        .from(knowledgeLectureVersions)
        .innerJoin(
          sourceDocuments,
          eq(sourceDocuments.id, knowledgeLectureVersions.sourceDocumentId),
        )
        .where(
          and(
            eq(knowledgeLectureVersions.batchId, item.reference.batchId),
            eq(knowledgeLectureVersions.lectureId, item.reference.sourceId),
          ),
        )
        .limit(1);
      if (rows[0] === undefined || rows[0].documentHash !== item.reference.contentHash)
        throw new Error("report_source_hash_mismatch");
      output.push({
        content: rows[0].lecture,
        reference: item.reference,
        title: rows[0].lecture.title,
      });
    } else {
      const rows = await database
        .select({ caseRow: knowledgeCaseVersions, documentHash: sourceDocuments.contentHash })
        .from(knowledgeCaseVersions)
        .innerJoin(sourceDocuments, eq(sourceDocuments.id, knowledgeCaseVersions.sourceDocumentId))
        .where(
          and(
            eq(knowledgeCaseVersions.batchId, item.reference.batchId),
            eq(knowledgeCaseVersions.caseId, item.reference.sourceId),
          ),
        )
        .limit(1);
      if (rows[0] === undefined || rows[0].documentHash !== item.reference.contentHash)
        throw new Error("report_source_hash_mismatch");
      output.push({
        content: rows[0].caseRow,
        reference: item.reference,
        title: `${rows[0].caseRow.academicLabel} · ${rows[0].caseRow.caseType}`,
      });
    }
  }
  return output;
}

function grouped(
  sources: LoadedSource[],
  labels: (source: LoadedSource) => string[],
): DeterministicPoint[] {
  const groups = new Map<string, Set<string>>();
  for (const source of sources)
    for (const raw of labels(source)) {
      const label = raw.trim() || "未标注";
      const set = groups.get(label) ?? new Set<string>();
      set.add(source.reference.sourceId);
      groups.set(label, set);
    }
  return [...groups.entries()]
    .map(([label, ids]) => ({ label, sourceIds: [...ids].sort(), value: ids.size }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label))
    .slice(0, 20);
}

function deterministicCharts(sources: LoadedSource[]): DeterministicCharts {
  const cases = sources.filter((source) => source.reference.sourceType === "case");
  const lectures = sources.filter((source) => source.reference.sourceType === "lecture");
  return {
    case_confidence: grouped(cases, (source) => [stringField(source.content.confidence)]),
    case_major: grouped(cases, (source) => [stringField(source.content.major)]),
    case_type: grouped(cases, (source) => [stringField(source.content.caseType)]),
    lecture_organization: grouped(lectures, (source) => [stringField(source.content.organization)]),
    lecture_year: grouped(lectures, (source) => [
      stringField(source.content.lectureDate).slice(0, 4),
    ]),
    source_type: [
      {
        label: "讲座",
        sourceIds: lectures.map((source) => source.reference.sourceId),
        value: lectures.length,
      },
      {
        label: "案例",
        sourceIds: cases.map((source) => source.reference.sourceId),
        value: cases.length,
      },
    ],
  };
}

function stringField(value: unknown): string {
  return typeof value === "string" && value.trim() !== "" ? value : "未标注";
}

function validateCitations(citations: KnowledgeCitation[], sources: LoadedSource[]): void {
  const allowed = new Set(sources.map((source) => stableJson(source.reference)));
  if (citations.some((citation) => !allowed.has(stableJson(citation.source))))
    throw new Error("report_citation_outside_snapshot");
}

function safePublicDescription(source: LoadedSource): string {
  const candidate = source.title.replace(/\s+/gu, " ").trim().slice(0, 200);
  if (
    candidate === "" ||
    candidate.includes(source.reference.sourceId) ||
    candidate.includes(source.reference.contentHash) ||
    /\b(?:case|lecture)_[a-z0-9_-]{8,}\b/iu.test(candidate) ||
    /\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/iu.test(candidate) ||
    /\b[0-9a-f]{32,}\b/iu.test(candidate)
  )
    return "";
  return candidate;
}

function buildCitationPresentations(
  sources: LoadedSource[],
  reportSpec: AnalysisReportSpec,
): ReportCitationPresentation[] {
  const sourceByIdentity = new Map(
    sources.map((source) => [stableJson(source.reference), source] as const),
  );
  const output: ReportCitationPresentation[] = [];
  const seen = new Set<string>();
  const counters = { case: 0, lecture: 0 };
  for (const citation of reportSpec.sections.flatMap((section) => section.citations)) {
    const identity = stableJson(citation.source);
    if (seen.has(identity)) continue;
    const source = sourceByIdentity.get(identity);
    if (source === undefined) throw new Error("report_citation_outside_snapshot");
    seen.add(identity);
    counters[source.reference.sourceType] += 1;
    output.push({
      publicDescription: safePublicDescription(source),
      publicLabel:
        source.reference.sourceType === "case"
          ? `匿名案例 ${String(counters.case).padStart(2, "0")}`
          : `讲座资料 ${String(counters.lecture).padStart(2, "0")}`,
      source: source.reference,
    });
  }
  return output;
}

function modelSource(source: LoadedSource): Record<string, unknown> {
  const permitted =
    source.reference.sourceType === "lecture"
      ? [
          "title",
          "summary",
          "trendText",
          "aiCrossDisciplinaryText",
          "failureText",
          "lectureDate",
          "organization",
          "speakers",
          "schools",
          "majors",
        ]
      : [
          "caseType",
          "curriculumSystem",
          "academicLabel",
          "background",
          "admissionResult",
          "schools",
          "major",
          "researchMethods",
          "activityTypes",
          "aiDomains",
          "aiDepth",
          "confidence",
          "evidenceBoundary",
          "profileSummary",
          "developmentPath",
          "coreStrengths",
          "applicationStrategy",
          "advisorInsights",
          "verifiedFacts",
          "interpretations",
          "missingInformation",
        ];
  return {
    reference: source.reference,
    title: source.title,
    fields: Object.fromEntries(permitted.map((key) => [key, source.content[key]])),
  };
}

function safeFailure(error: unknown): { code: string; summary: string } {
  if (error instanceof z.ZodError)
    return { code: "model_output_invalid", summary: "模型返回的报告结构未通过校验。" };
  if (error instanceof Error && error.name === "AuthorizationDeniedError")
    return { code: "authorization_denied", summary: "报告任务授权已失效。" };
  if (error instanceof Error && error.message.includes("snapshot"))
    return { code: "snapshot_mismatch", summary: "冻结输入复验失败，未生成报告。" };
  if (error instanceof Error && error.message.includes("unsafe_report"))
    return { code: "unsafe_html", summary: "报告未通过 HTML 安全校验。" };
  return { code: "report_generation_failed", summary: "分析报告未能安全完成，请稍后重试。" };
}

export async function executeKnowledgeAnalysisReport(
  database: Database,
  task: KnowledgeAnalysisReportTask,
  provider: JsonModelProvider,
  objectStore: ImmutableObjectStore,
): Promise<{ reportId: string }> {
  const authorization = await loadAuthorizationContext(database, {
    contextHash: task.authorization.contextHash,
    id: task.authorization.contextId,
  });
  assertAuthorizationContext(authorization, {
    action: "knowledge:analysis:write",
    accessLevel: "internal",
    actorUserId: authorization.actorUserId,
    studentId: null,
  });
  await assertKnowledgeWorkspacePermission(
    database,
    authorization.actorUserId,
    task.payload.workspaceId,
    "create_report",
  );
  const rows = await database
    .select({ report: knowledgeAnalysisReports, run: knowledgeAgentRuns })
    .from(knowledgeAnalysisReports)
    .innerJoin(knowledgeAgentRuns, eq(knowledgeAgentRuns.id, knowledgeAnalysisReports.agentRunId))
    .where(eq(knowledgeAnalysisReports.id, task.payload.reportId))
    .limit(1);
  const record = rows[0];
  if (
    record === undefined ||
    record.report.status !== "queued" ||
    record.run.status !== "queued" ||
    record.report.workspaceId !== task.payload.workspaceId ||
    record.report.conversationId !== task.payload.conversationId ||
    record.report.conversationSnapshotHash !== task.payload.inputSnapshotHash ||
    record.run.inputSnapshotHash !== task.payload.inputSnapshotHash
  )
    throw new Error("report_run_mismatch");
  const snapshot = z.array(FrozenReportSourceSchema).parse(record.report.sourceSnapshot);
  const expectedHash = await reportSnapshotHash(
    database,
    task.payload.workspaceId,
    task.payload.conversationId,
    record.report.conversationThroughSequence,
    snapshot,
  );
  if (expectedHash !== task.payload.inputSnapshotHash) throw new Error("report_snapshot_mismatch");
  const startedAt = new Date();
  await database.transaction(async (transaction) => {
    await transaction
      .update(knowledgeAgentRuns)
      .set({ startedAt, status: "running" })
      .where(eq(knowledgeAgentRuns.id, record.run.id));
    await transaction
      .update(knowledgeAnalysisReports)
      .set({ status: "planning", updatedAt: startedAt })
      .where(eq(knowledgeAnalysisReports.id, record.report.id));
  });
  try {
    const [sources, messages] = await Promise.all([
      loadFrozenSources(database, snapshot),
      database
        .select({
          citations: knowledgeAnalysisMessages.citations,
          contentMarkdown: knowledgeAnalysisMessages.contentMarkdown,
          role: knowledgeAnalysisMessages.role,
          sequence: knowledgeAnalysisMessages.sequence,
        })
        .from(knowledgeAnalysisMessages)
        .where(
          and(
            eq(knowledgeAnalysisMessages.workspaceId, task.payload.workspaceId),
            eq(knowledgeAnalysisMessages.conversationId, task.payload.conversationId),
            lte(knowledgeAnalysisMessages.sequence, record.report.conversationThroughSequence),
          ),
        )
        .orderBy(asc(knowledgeAnalysisMessages.sequence)),
    ]);
    const charts = deterministicCharts(sources);
    await database
      .update(knowledgeAnalysisReports)
      .set({ status: "computing", updatedAt: new Date() })
      .where(eq(knowledgeAnalysisReports.id, record.report.id));
    const modelInput = {
      charts,
      conversation: messages,
      outputShape: {
        executiveSummary: "string",
        sections: [
          {
            chartKey: "allowed chart key or null",
            citations: [
              {
                claim: "string",
                source: {
                  batchId: "逐字段复制 sources[].reference.batchId 的 uuid",
                  contentHash: "逐字段复制 sources[].reference.contentHash 的 sha256",
                  sourceId: "逐字段复制 sources[].reference.sourceId",
                  sourceType: "逐字段复制 sources[].reference.sourceType，只能是 lecture 或 case",
                },
              },
            ],
            id: "stable-id",
            paragraphs: ["string"],
            title: "string",
          },
        ],
        title: "string",
      },
      requirements: record.report.requirements,
      sources: sources.map(modelSource),
    };
    const userPrompt = JSON.stringify(modelInput);
    if (userPrompt.length > 200_000) throw new Error("report_context_limit_exceeded");
    const response = await provider.generateJson({
      systemPrompt:
        "你是醋溜教育内部分析报告撰稿器。只输出 JSON。所有数字和图表只能引用输入 charts 中的服务端确定性统计；不能重新计算、创造样本或编写 SQL、JavaScript、Python、HTML。每条 citations[].source 必须是包含 batchId、contentHash、sourceId、sourceType 四个字段的 JSON 对象，并逐字段复制 sources[].reference；绝对不能把 source 写成字符串。证据不足时明确写为分析判断或待核实。",
      userPrompt,
    });
    if (response.model !== task.payload.model) throw new Error("report_model_mismatch");
    const narrative = NarrativeSchema.parse(response.json);
    validateCitations(
      narrative.sections.flatMap((section) => section.citations),
      sources,
    );
    const reportSpec: AnalysisReportSpec = AnalysisReportSpecSchema.parse({
      executiveSummary: narrative.executiveSummary,
      metrics: [
        { detail: "工作区冻结资料总数", label: "资料", value: String(sources.length) },
        {
          detail: "冻结讲座版本",
          label: "讲座",
          value: String(
            sources.filter((source) => source.reference.sourceType === "lecture").length,
          ),
        },
        {
          detail: "冻结案例版本",
          label: "案例",
          value: String(sources.filter((source) => source.reference.sourceType === "case").length),
        },
      ],
      sections: narrative.sections.map((section) => ({
        chart:
          section.chartKey === null
            ? null
            : { points: charts[section.chartKey], title: section.title, type: "bar" },
        citations: section.citations,
        id: section.id,
        paragraphs: section.paragraphs,
        title: section.title,
      })),
      title: narrative.title,
    });
    await database
      .update(knowledgeAnalysisReports)
      .set({ status: "rendering", updatedAt: new Date() })
      .where(eq(knowledgeAnalysisReports.id, record.report.id));
    const rendered = renderAnalysisReport(
      reportSpec,
      buildCitationPresentations(sources, reportSpec),
    );
    const [interactiveRef, staticRef] = await Promise.all([
      objectStore.store({
        content: Uint8Array.from(rendered.interactive),
        domain: "knowledge",
        purpose: "analysis_report",
      }),
      objectStore.store({
        content: Uint8Array.from(rendered.static),
        domain: "knowledge",
        purpose: "analysis_report",
      }),
    ]);
    if (
      interactiveRef.size > ANALYSIS_REPORT_MAX_BYTES ||
      staticRef.size > ANALYSIS_REPORT_MAX_BYTES
    )
      throw new Error("report_html_too_large");
    const completedAt = new Date();
    await database.transaction(async (transaction) => {
      const current = await transaction
        .select({ status: knowledgeAnalysisReports.status })
        .from(knowledgeAnalysisReports)
        .where(eq(knowledgeAnalysisReports.id, record.report.id))
        .limit(1);
      if (current[0]?.status !== "rendering") throw new Error("report_state_changed");
      await transaction
        .update(knowledgeAgentRuns)
        .set({
          completedAt,
          completionTokens: response.usage.completionTokens,
          costMicrounits: estimateCost(response.usage),
          promptTokens: response.usage.promptTokens,
          status: "succeeded",
          totalTokens: response.usage.totalTokens,
        })
        .where(eq(knowledgeAgentRuns.id, record.run.id));
      await transaction
        .update(knowledgeAnalysisReports)
        .set({
          completedAt,
          interactiveByteCount: interactiveRef.size,
          interactiveContentHash: interactiveRef.sha256,
          interactiveScriptHash: rendered.scriptHash,
          interactiveStorageKey: interactiveRef.key,
          staticByteCount: staticRef.size,
          staticContentHash: staticRef.sha256,
          staticStorageKey: staticRef.key,
          status: "succeeded",
          structuredReport: reportSpec,
          updatedAt: completedAt,
        })
        .where(eq(knowledgeAnalysisReports.id, record.report.id));
    });
    return { reportId: record.report.id };
  } catch (error) {
    const failure = safeFailure(error);
    const completedAt = new Date();
    await database.transaction(async (transaction) => {
      await transaction
        .update(knowledgeAgentRuns)
        .set({
          completedAt,
          safeErrorCode: failure.code,
          safeErrorSummary: failure.summary,
          status: "failed",
        })
        .where(
          and(eq(knowledgeAgentRuns.id, record.run.id), eq(knowledgeAgentRuns.status, "running")),
        );
      await transaction
        .update(knowledgeAnalysisReports)
        .set({
          completedAt,
          safeErrorCode: failure.code,
          safeErrorSummary: failure.summary,
          status: "failed",
          updatedAt: completedAt,
        })
        .where(
          and(
            eq(knowledgeAnalysisReports.id, record.report.id),
            inArray(knowledgeAnalysisReports.status, ["planning", "computing", "rendering"]),
          ),
        );
    });
    throw error;
  }
}

export async function markKnowledgeAnalysisReportEnqueueFailure(
  database: Database,
  reportId: string,
): Promise<void> {
  const completedAt = new Date();
  const rows = await database
    .select({ agentRunId: knowledgeAnalysisReports.agentRunId })
    .from(knowledgeAnalysisReports)
    .where(eq(knowledgeAnalysisReports.id, reportId))
    .limit(1);
  await database.transaction(async (transaction) => {
    if (rows[0]?.agentRunId !== null && rows[0]?.agentRunId !== undefined)
      await transaction
        .update(knowledgeAgentRuns)
        .set({
          completedAt,
          safeErrorCode: "queue_unavailable",
          safeErrorSummary: "报告任务暂时无法进入队列，请稍后重试。",
          startedAt: completedAt,
          status: "failed",
        })
        .where(eq(knowledgeAgentRuns.id, rows[0].agentRunId));
    await transaction
      .update(knowledgeAnalysisReports)
      .set({
        completedAt,
        safeErrorCode: "queue_unavailable",
        safeErrorSummary: "报告任务暂时无法进入队列，请稍后重试。",
        status: "failed",
        updatedAt: completedAt,
      })
      .where(
        and(
          eq(knowledgeAnalysisReports.id, reportId),
          eq(knowledgeAnalysisReports.status, "queued"),
        ),
      );
  });
}

export async function listKnowledgeAnalysisReports(
  database: Database,
  actorUserId: string,
  workspaceId: string,
  conversationId: string,
): Promise<
  Array<{
    canCreatePresentationCopy: boolean;
    completedAt: Date | null;
    createdAt: Date;
    id: string;
    reportSeriesId: string;
    safeErrorSummary: string | null;
    status: "queued" | "planning" | "computing" | "rendering" | "succeeded" | "failed";
    title: string;
    publicSafe: boolean;
    version: number;
  }>
> {
  await assertKnowledgeWorkspacePermission(database, actorUserId, workspaceId, "read");
  const rows = await database
    .select({
      completedAt: knowledgeAnalysisReports.completedAt,
      createdAt: knowledgeAnalysisReports.createdAt,
      id: knowledgeAnalysisReports.id,
      reportSeriesId: knowledgeAnalysisReports.reportSeriesId,
      safeErrorSummary: knowledgeAnalysisReports.safeErrorSummary,
      status: knowledgeAnalysisReports.status,
      structuredReport: knowledgeAnalysisReports.structuredReport,
      supersedesReportId: knowledgeAnalysisReports.supersedesReportId,
      templateVersion: knowledgeAnalysisReports.templateVersion,
      version: knowledgeAnalysisReports.version,
    })
    .from(knowledgeAnalysisReports)
    .where(
      and(
        eq(knowledgeAnalysisReports.workspaceId, workspaceId),
        eq(knowledgeAnalysisReports.conversationId, conversationId),
      ),
    )
    .orderBy(desc(knowledgeAnalysisReports.createdAt));
  const supersededIds = new Set(
    rows
      .map((row) => row.supersedesReportId)
      .filter((reportId): reportId is string => reportId !== null),
  );
  return rows.map(
    ({ structuredReport, supersedesReportId: _supersedesReportId, templateVersion, ...row }) => {
      void _supersedesReportId;
      const publicSafe = templateVersion === ANALYSIS_REPORT_TEMPLATE_VERSION;
      return {
        ...row,
        canCreatePresentationCopy:
          row.status === "succeeded" && !publicSafe && !supersededIds.has(row.id),
        publicSafe,
        title: AnalysisReportSpecSchema.safeParse(structuredReport).data?.title ?? "分析报告",
      };
    },
  );
}

export async function readKnowledgeAnalysisReportCitationAudit(
  database: Database,
  actorUserId: string,
  workspaceId: string,
  reportId: string,
): Promise<KnowledgeAnalysisReportCitationAuditRow[]> {
  await assertKnowledgeWorkspacePermission(database, actorUserId, workspaceId, "read");
  const rows = await database
    .select({
      sourceSnapshot: knowledgeAnalysisReports.sourceSnapshot,
      status: knowledgeAnalysisReports.status,
      structuredReport: knowledgeAnalysisReports.structuredReport,
    })
    .from(knowledgeAnalysisReports)
    .where(
      and(
        eq(knowledgeAnalysisReports.id, reportId),
        eq(knowledgeAnalysisReports.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  if (rows[0]?.status !== "succeeded" || rows[0].structuredReport === null)
    throw new KnowledgeWorkspaceNotFoundError();
  const reportSpec = AnalysisReportSpecSchema.parse(rows[0].structuredReport);
  const snapshot = z.array(FrozenReportSourceSchema).parse(rows[0].sourceSnapshot);
  const sources = await loadFrozenSources(database, snapshot);
  return buildCitationPresentations(sources, reportSpec).map((presentation) => ({
    contentHash: presentation.source.contentHash,
    publicDescription: presentation.publicDescription,
    publicLabel: presentation.publicLabel,
    sourceId: presentation.source.sourceId,
    sourceType: presentation.source.sourceType,
  }));
}

export async function rerenderKnowledgeAnalysisReportPresentation(
  database: Database,
  objectStore: ImmutableObjectStore,
  authorization: AuthorizationContext,
  workspaceId: string,
  reportId: string,
  gitCommitSha: string,
): Promise<{ reportId: string; version: number }> {
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
    "create_report",
  );
  if (!/^[0-9a-f]{40}$/u.test(gitCommitSha)) throw new Error("invalid_git_commit_sha");
  const priorRows = await database
    .select()
    .from(knowledgeAnalysisReports)
    .where(
      and(
        eq(knowledgeAnalysisReports.id, reportId),
        eq(knowledgeAnalysisReports.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  const prior = priorRows[0];
  if (prior?.status !== "succeeded" || prior.structuredReport === null)
    throw new KnowledgeWorkspaceNotFoundError();
  if (prior.templateVersion === ANALYSIS_REPORT_TEMPLATE_VERSION)
    throw new KnowledgeWorkspaceConflictError("该报告已经是对外安全版本。");
  const reportSpec = AnalysisReportSpecSchema.parse(prior.structuredReport);
  const snapshot = z.array(FrozenReportSourceSchema).parse(prior.sourceSnapshot);
  const sources = await loadFrozenSources(database, snapshot);
  const rendered = renderAnalysisReport(
    reportSpec,
    buildCitationPresentations(sources, reportSpec),
  );
  const [interactiveRef, staticRef] = await Promise.all([
    objectStore.store({
      content: Uint8Array.from(rendered.interactive),
      domain: "knowledge",
      purpose: "analysis_report",
    }),
    objectStore.store({
      content: Uint8Array.from(rendered.static),
      domain: "knowledge",
      purpose: "analysis_report",
    }),
  ]);
  const newReportId = randomUUID();
  const runId = randomUUID();
  const version = prior.version + 1;
  const completedAt = new Date();
  await database.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${prior.reportSeriesId}::text, 0))`,
    );
    const successor = await transaction
      .select({ id: knowledgeAnalysisReports.id })
      .from(knowledgeAnalysisReports)
      .where(eq(knowledgeAnalysisReports.supersedesReportId, prior.id))
      .limit(1);
    if (successor[0] !== undefined)
      throw new KnowledgeWorkspaceConflictError("该报告已经存在后续版本。");
    await transaction.insert(knowledgeAgentRuns).values({
      authorizationContextId: authorization.id,
      completedAt,
      completionTokens: 0,
      contextVersion: ANALYSIS_REPORT_CONTEXT_VERSION,
      conversationId: prior.conversationId,
      costMicrounits: 0,
      gitCommitSha,
      id: runId,
      inputSnapshotHash: prior.conversationSnapshotHash,
      kind: "analysis_report",
      model: "deterministic-renderer",
      pricingVersion: "no-model.v1",
      promptTokens: 0,
      promptVersion: "knowledge-analysis-report-presentation.v1",
      schemaVersion: ANALYSIS_REPORT_SCHEMA_VERSION,
      startedAt: completedAt,
      status: "succeeded",
      totalTokens: 0,
      workspaceId,
    });
    await transaction.insert(knowledgeAnalysisReports).values({
      agentRunId: runId,
      completedAt,
      conversationId: prior.conversationId,
      conversationSnapshotHash: prior.conversationSnapshotHash,
      conversationThroughSequence: prior.conversationThroughSequence,
      createdByUserId: authorization.actorUserId,
      id: newReportId,
      interactiveByteCount: interactiveRef.size,
      interactiveContentHash: interactiveRef.sha256,
      interactiveScriptHash: rendered.scriptHash,
      interactiveStorageKey: interactiveRef.key,
      reportSeriesId: prior.reportSeriesId,
      requirements: prior.requirements,
      sourceSnapshot: prior.sourceSnapshot,
      staticByteCount: staticRef.size,
      staticContentHash: staticRef.sha256,
      staticStorageKey: staticRef.key,
      status: "succeeded",
      structuredReport: reportSpec,
      supersedesReportId: prior.id,
      templateVersion: ANALYSIS_REPORT_TEMPLATE_VERSION,
      updatedAt: completedAt,
      version,
      workspaceId,
    });
  });
  return { reportId: newReportId, version };
}

export async function readKnowledgeAnalysisReportArtifact(
  database: Database,
  objectStore: ImmutableObjectStore,
  actorUserId: string,
  workspaceId: string,
  reportId: string,
  variant: "interactive" | "static",
): Promise<Uint8Array> {
  await assertKnowledgeWorkspacePermission(database, actorUserId, workspaceId, "download_report");
  const rows = await database
    .select()
    .from(knowledgeAnalysisReports)
    .where(
      and(
        eq(knowledgeAnalysisReports.id, reportId),
        eq(knowledgeAnalysisReports.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  const report = rows[0];
  if (report?.status !== "succeeded") throw new KnowledgeWorkspaceNotFoundError();
  if (
    report.interactiveStorageKey === null ||
    report.interactiveContentHash === null ||
    report.interactiveByteCount === null ||
    report.staticStorageKey === null ||
    report.staticContentHash === null ||
    report.staticByteCount === null
  )
    throw new Error("report_artifact_metadata_missing");
  const reference: StoredObjectReference =
    variant === "interactive"
      ? {
          domain: "knowledge",
          key: report.interactiveStorageKey,
          purpose: "analysis_report",
          sha256: report.interactiveContentHash,
          size: report.interactiveByteCount,
        }
      : {
          domain: "knowledge",
          key: report.staticStorageKey,
          purpose: "analysis_report",
          sha256: report.staticContentHash,
          size: report.staticByteCount,
        };
  return objectStore.read(reference);
}
