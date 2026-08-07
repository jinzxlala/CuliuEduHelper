import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { calculateAuthorizationContextHash, loadAuthorizationContext } from "@culiu/authorization";
import type { JsonModelProvider } from "@culiu/ai";

import {
  appUsers,
  authorizationContextSnapshots,
  createDatabaseClient,
  knowledgeAgentRuns,
  knowledgeAnalysisConversations,
  knowledgeAnalysisMessages,
  knowledgeAnalysisReports,
  knowledgeAnalysisSources,
  knowledgeAnalysisWorkspaceMembers,
  knowledgeAnalysisWorkspaces,
  knowledgeImportBatches,
  knowledgeLectureVersions,
  knowledgeSmartSearchRuns,
  parseDatabaseConfig,
  runMigrations,
  sourceDocuments,
  type DatabaseClient,
} from "@culiu/database";
import type { LectureDocument, SearchPage } from "@culiu/search";
import type { KnowledgeSmartSearchTask } from "@culiu/tasks";
import { LocalImmutableObjectStore } from "@culiu/storage";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { executeKnowledgeSmartSearch, listKnowledgeSmartSearches } from "./smart-search.js";
import {
  executeKnowledgeAnalysisChat,
  prepareKnowledgeAnalysisMessage,
  readKnowledgeConversation,
} from "./analysis-chat.js";
import {
  executeKnowledgeAnalysisReport,
  listKnowledgeAnalysisReports,
  prepareKnowledgeAnalysisReport,
  readKnowledgeAnalysisReportCitationAudit,
  readKnowledgeAnalysisReportArtifact,
  rerenderKnowledgeAnalysisReportPresentation,
} from "./analysis-report.js";
import {
  addKnowledgeWorkspaceSources,
  archiveKnowledgeWorkspace,
  createKnowledgeConversation,
  createKnowledgeWorkspace,
  listKnowledgeSourceCatalog,
  listKnowledgeWorkspaces,
  readKnowledgeWorkspace,
  revokeKnowledgeWorkspaceMember,
  setKnowledgeWorkspaceMember,
} from "./workspace-service.js";

let maintenanceClient: DatabaseClient | undefined;
let databaseClient: DatabaseClient | undefined;
let temporaryDatabaseName = "";
const ownerId = randomUUID();
const editorId = randomUUID();
const auditorId = randomUUID();
const serviceId = randomUUID();
const authorizationContextId = randomUUID();
let authorizationContextHash = "";
const publishedBatchId = randomUUID();
const sourceDocumentId = randomUUID();
const lectureId = "lecture:synthetic-analysis";

function activeClient(): DatabaseClient {
  if (databaseClient === undefined) throw new Error("Test database is unavailable.");
  return databaseClient;
}

beforeAll(async () => {
  const base = parseDatabaseConfig();
  temporaryDatabaseName = `culiu_analysis_${randomUUID().replaceAll("-", "")}`;
  const maintenanceUrl = new URL(base.connectionString);
  maintenanceUrl.pathname = "/postgres";
  maintenanceUrl.search = "";
  const databaseUrl = new URL(base.connectionString);
  databaseUrl.pathname = `/${temporaryDatabaseName}`;
  databaseUrl.search = "";
  maintenanceClient = createDatabaseClient({
    connectionString: maintenanceUrl.toString(),
    maxConnections: 1,
  });
  await maintenanceClient.pool.query(`create database "${temporaryDatabaseName}"`);
  databaseClient = createDatabaseClient({
    connectionString: databaseUrl.toString(),
    maxConnections: 5,
  });
  await runMigrations(databaseClient);

  const database = databaseClient.database;
  await database.insert(appUsers).values([
    {
      displayName: "Synthetic Analysis Owner",
      email: "analysis-owner@example.invalid",
      id: ownerId,
      role: "advisor",
    },
    {
      displayName: "Synthetic Analysis Editor",
      email: "analysis-editor@example.invalid",
      id: editorId,
      role: "advisor",
    },
    {
      displayName: "Synthetic Analysis Auditor",
      email: "analysis-auditor@example.invalid",
      id: auditorId,
      role: "auditor",
    },
    {
      displayName: "Synthetic Analysis Service",
      email: "analysis-service@example.invalid",
      id: serviceId,
      role: "service",
    },
  ]);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60 * 60 * 1000);
  const allowedActions = [
    "knowledge:analysis:read",
    "knowledge:analysis:write",
    "knowledge:search:smart",
  ];
  await database.insert(authorizationContextSnapshots).values({
    actorUserId: ownerId,
    allowedActions,
    contextHash: (authorizationContextHash = calculateAuthorizationContextHash({
      actorUserId: ownerId,
      allowedActions,
      createdAt: now,
      expiresAt,
      id: authorizationContextId,
      maxAccessLevel: "internal",
      studentId: null,
    })),
    createdAt: now,
    expiresAt,
    id: authorizationContextId,
    maxAccessLevel: "internal",
    studentId: null,
  });
  await database.insert(knowledgeImportBatches).values({
    corpusHash: "b".repeat(64),
    corpusId: "synthetic_stage3",
    expectedLectureCount: 1,
    id: publishedBatchId,
    manifestVersion: "1.0.0",
    mappingVersion: "1.0.0",
  });
  await database.insert(sourceDocuments).values({
    contentHash: "c".repeat(64),
    dataDomain: "knowledge",
    documentType: "analysis_markdown",
    id: sourceDocumentId,
    mimeType: "text/markdown",
    sourcePath: "knowledge/analysis/synthetic-stage3.md",
    studentId: null,
  });
  await database.insert(knowledgeLectureVersions).values({
    aiCrossDisciplinaryText: "Synthetic AI evidence.",
    batchId: publishedBatchId,
    failureText: "Synthetic limitation.",
    lectureId,
    majors: ["Synthetic major"],
    organization: "Synthetic organization",
    schools: ["Synthetic school"],
    sourceDocumentId,
    sourcePath: "knowledge/analysis/synthetic-stage3.md",
    speakers: ["Synthetic speaker"],
    summary: "Synthetic lecture summary.",
    title: "Synthetic stage 3 lecture",
    trendText: "Synthetic trend.",
  });
  await database
    .update(knowledgeImportBatches)
    .set({
      caseCount: 0,
      isCurrent: true,
      lectureCount: 1,
      publishedAt: now,
      status: "published",
      transcriptSegmentCount: 0,
      updatedAt: now,
    })
    .where(eq(knowledgeImportBatches.id, publishedBatchId));
});

afterAll(async () => {
  if (databaseClient !== undefined) await databaseClient.close();
  if (maintenanceClient !== undefined) {
    await maintenanceClient.pool.query(
      "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
      [temporaryDatabaseName],
    );
    await maintenanceClient.pool.query(`drop database if exists "${temporaryDatabaseName}"`);
    await maintenanceClient.close();
  }
});

async function createWorkspace(): Promise<{ conversationId: string; workspaceId: string }> {
  const database = activeClient().database;
  const workspaceId = randomUUID();
  const conversationId = randomUUID();
  await database.insert(knowledgeAnalysisWorkspaces).values({
    id: workspaceId,
    name: "Synthetic analysis workspace",
    ownerUserId: ownerId,
  });
  await database.insert(knowledgeAnalysisWorkspaceMembers).values({
    grantedByUserId: ownerId,
    role: "owner",
    userId: ownerId,
    workspaceId,
  });
  await database.insert(knowledgeAnalysisConversations).values({
    createdByUserId: ownerId,
    id: conversationId,
    title: "Synthetic conversation",
    workspaceId,
  });
  return { conversationId, workspaceId };
}

describe("knowledge analysis database boundaries", () => {
  it("supports explicit sharing, frozen sources, duplicate idempotency and immediate revocation", async () => {
    const database = activeClient().database;
    const created = await createKnowledgeWorkspace(database, ownerId, {
      description: "Synthetic shared workspace.",
      name: "Synthetic workspace service",
    });
    await setKnowledgeWorkspaceMember(database, ownerId, created.id, {
      role: "editor",
      userId: editorId,
    });
    await setKnowledgeWorkspaceMember(database, ownerId, created.id, {
      role: "editor",
      userId: auditorId,
    });
    expect((await readKnowledgeWorkspace(database, auditorId, created.id)).role).toBe("viewer");
    const reference = {
      batchId: publishedBatchId,
      contentHash: "c".repeat(64),
      sourceId: lectureId,
      sourceType: "lecture" as const,
    };
    expect(
      await addKnowledgeWorkspaceSources(database, editorId, created.id, { sources: [reference] }),
    ).toEqual({ created: [`lecture:${lectureId}`], existing: [] });
    expect(
      await addKnowledgeWorkspaceSources(database, editorId, created.id, { sources: [reference] }),
    ).toEqual({ created: [], existing: [`lecture:${lectureId}`] });
    expect(await listKnowledgeSourceCatalog(database, editorId, created.id, "lecture")).toEqual([
      expect.objectContaining({
        alreadyAdded: true,
        sourceId: lectureId,
        sourceType: "lecture",
        title: "Synthetic stage 3 lecture",
      }),
    ]);
    expect(
      (
        await createKnowledgeConversation(database, editorId, created.id, {
          title: "Synthetic analysis task",
        })
      ).id,
    ).toMatch(/^[0-9a-f-]{36}$/u);
    expect(await listKnowledgeWorkspaces(database, editorId)).toEqual([
      expect.objectContaining({ id: created.id, role: "editor" }),
    ]);
    await revokeKnowledgeWorkspaceMember(database, ownerId, created.id, editorId);
    await expect(readKnowledgeWorkspace(database, editorId, created.id)).rejects.toThrow();
    await archiveKnowledgeWorkspace(database, ownerId, created.id);
    await expect(
      createKnowledgeConversation(database, ownerId, created.id, { title: "Must be rejected" }),
    ).rejects.toThrow();
  });

  it("enforces internal membership roles and protects the owner membership", async () => {
    const database = activeClient().database;
    const { workspaceId } = await createWorkspace();
    await database.insert(knowledgeAnalysisWorkspaceMembers).values({
      grantedByUserId: ownerId,
      role: "editor",
      userId: editorId,
      workspaceId,
    });
    await database.insert(knowledgeAnalysisWorkspaceMembers).values({
      grantedByUserId: ownerId,
      role: "viewer",
      userId: auditorId,
      workspaceId,
    });

    await expect(
      database.insert(knowledgeAnalysisWorkspaceMembers).values({
        grantedByUserId: ownerId,
        role: "editor",
        userId: auditorId,
        workspaceId,
      }),
    ).rejects.toThrow();
    await expect(
      database.insert(knowledgeAnalysisWorkspaceMembers).values({
        grantedByUserId: ownerId,
        role: "viewer",
        userId: serviceId,
        workspaceId,
      }),
    ).rejects.toThrow();
    await expect(
      database
        .delete(knowledgeAnalysisWorkspaceMembers)
        .where(eq(knowledgeAnalysisWorkspaceMembers.userId, ownerId)),
    ).rejects.toThrow();
  });

  it("freezes only published knowledge versions and never deletes source history", async () => {
    const database = activeClient().database;
    const { workspaceId } = await createWorkspace();
    const sourceId = randomUUID();
    await expect(
      database.insert(knowledgeAnalysisSources).values({
        addedByUserId: ownerId,
        contentHash: "d".repeat(64),
        knowledgeBatchId: publishedBatchId,
        lectureId,
        sourceId: lectureId,
        sourceType: "lecture",
        workspaceId,
      }),
    ).rejects.toThrow();
    await database.insert(knowledgeAnalysisSources).values({
      addedByUserId: ownerId,
      contentHash: "c".repeat(64),
      id: sourceId,
      knowledgeBatchId: publishedBatchId,
      lectureId,
      sourceId: lectureId,
      sourceType: "lecture",
      workspaceId,
    });
    await expect(
      database.insert(knowledgeAnalysisSources).values({
        addedByUserId: ownerId,
        contentHash: "c".repeat(64),
        knowledgeBatchId: publishedBatchId,
        lectureId,
        sourceId: lectureId,
        sourceType: "lecture",
        workspaceId,
      }),
    ).rejects.toThrow();
    await expect(
      database.delete(knowledgeAnalysisSources).where(eq(knowledgeAnalysisSources.id, sourceId)),
    ).rejects.toThrow();

    await database
      .update(knowledgeAnalysisSources)
      .set({ removedAt: new Date(), removedByUserId: ownerId })
      .where(eq(knowledgeAnalysisSources.id, sourceId));
    await expect(
      database
        .update(knowledgeAnalysisSources)
        .set({ removedAt: null, removedByUserId: null })
        .where(eq(knowledgeAnalysisSources.id, sourceId)),
    ).rejects.toThrow();
  });

  it("keeps conversation messages append-only and workspace-scoped", async () => {
    const database = activeClient().database;
    const first = await createWorkspace();
    const second = await createWorkspace();
    const messageId = randomUUID();
    await database.insert(knowledgeAnalysisMessages).values({
      contentMarkdown: "Synthetic user question.",
      conversationId: first.conversationId,
      createdByUserId: ownerId,
      id: messageId,
      role: "user",
      sequence: 1,
      workspaceId: first.workspaceId,
    });
    await expect(
      database
        .update(knowledgeAnalysisMessages)
        .set({ contentMarkdown: "Mutated content." })
        .where(eq(knowledgeAnalysisMessages.id, messageId)),
    ).rejects.toThrow();
    await expect(
      database.insert(knowledgeAnalysisMessages).values({
        contentMarkdown: "Cross-workspace content.",
        conversationId: first.conversationId,
        createdByUserId: ownerId,
        role: "user",
        sequence: 2,
        workspaceId: second.workspaceId,
      }),
    ).rejects.toThrow();
  });

  it("executes a bounded smart search and persists only validated candidate references", async () => {
    const database = activeClient().database;
    const runId = randomUUID();
    const prompt = "寻找跨学科项目相关的讲座";
    await database.insert(knowledgeSmartSearchRuns).values({
      authorizationContextId,
      createdByUserId: ownerId,
      gitCommitSha: "e".repeat(40),
      id: runId,
      knowledgeBatchId: publishedBatchId,
      model: "deepseek-v4-flash",
      prompt,
      promptHash: createHash("sha256").update(prompt, "utf8").digest("hex"),
      promptVersion: "knowledge-smart-search.v2",
      retrievalVersion: "knowledge-hybrid.v2",
      schemaVersion: "knowledge-smart-search-output.v1",
    });
    const modelOutputs: unknown[] = [
      {
        interpretation: "查找跨学科项目讲座。",
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
            keywords: ["跨学科", "项目"],
            matchingStrategy: "last",
            query: "跨学科 项目",
            target: "lectures",
          },
        ],
        round: 1,
      },
      {
        interpretation: "扩大到项目制学习讲座。",
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
            keywords: ["项目制学习"],
            matchingStrategy: "last",
            query: "项目制学习",
            target: "lectures",
          },
        ],
        round: 2,
      },
      {
        limitations: [],
        results: [
          {
            matchedTerms: ["跨学科"],
            rationale: "Synthetic invalid model-created reference.",
            sourceId: "lecture:model-invented-id",
            sourceType: "lecture",
          },
        ],
        summary: "Synthetic invalid result.",
      },
      {
        limitations: [],
        results: [
          {
            matchedTerms: ["跨学科"],
            rationale: "讲座摘要包含跨学科项目证据。",
            sourceId: lectureId,
            sourceType: "lecture",
          },
        ],
        summary: "找到一场相关讲座。",
      },
    ];
    const provider: JsonModelProvider = {
      async generateJson() {
        await Promise.resolve();
        const json = modelOutputs.shift();
        if (json === undefined) throw new Error("Unexpected model call.");
        return {
          json,
          model: "deepseek-v4-flash",
          providerRequestId: randomUUID(),
          usage: {
            completionTokens: 10,
            promptCacheHitTokens: 0,
            promptCacheMissTokens: 20,
            promptTokens: 20,
            totalTokens: 30,
          },
        };
      },
    };
    const lecture: LectureDocument = {
      ai_cross_disciplinary_text: "Synthetic AI evidence.",
      date: null,
      failure_text: "Synthetic limitation.",
      lecture_id: lectureId,
      majors: ["Synthetic major"],
      organization: "Synthetic organization",
      schools: ["Synthetic school"],
      source_path: "knowledge/analysis/synthetic-stage3.md",
      speakers: ["Synthetic speaker"],
      summary: "Synthetic lecture summary.",
      title: "Synthetic stage 3 lecture",
      trend_text: "Synthetic trend.",
    };
    const lecturePage: SearchPage<LectureDocument> = {
      estimatedTotalHits: 1,
      facetDistribution: {},
      hits: [{ document: lecture, formatted: {} }],
      limit: 10,
      offset: 0,
      processingTimeMs: 1,
      query: "跨学科 项目",
    };
    const search = {
      searchCases: async () => {
        await Promise.resolve();
        return { ...lecturePage, estimatedTotalHits: 0, hits: [] };
      },
      searchLectures: async () => {
        await Promise.resolve();
        return lecturePage;
      },
    };
    const task: KnowledgeSmartSearchTask = {
      authorization: { contextHash: authorizationContextHash, contextId: authorizationContextId },
      idempotencyKey: `smart_search_${"a".repeat(64)}`,
      payload: {
        correlationId: randomUUID(),
        gitCommitSha: "e".repeat(40),
        model: "deepseek-v4-flash",
        promptVersion: "knowledge-smart-search.v2",
        retrievalVersion: "knowledge-hybrid.v2",
        runId,
        schemaVersion: "knowledge-smart-search-output.v1",
      },
      taskId: randomUUID(),
      taskName: "knowledge.smart-search",
    };
    const result = await executeKnowledgeSmartSearch(database, task, provider, search);
    expect(result.results).toEqual([
      expect.objectContaining({
        contentHash: "c".repeat(64),
        sourceId: lectureId,
        sourceType: "lecture",
      }),
    ]);
    const persisted = await database
      .select()
      .from(knowledgeSmartSearchRuns)
      .where(eq(knowledgeSmartSearchRuns.id, runId));
    expect(persisted[0]).toMatchObject({ progressStage: "succeeded", status: "succeeded" });
    expect(JSON.stringify(persisted[0]?.resultReferences)).not.toContain(
      "Synthetic lecture summary",
    );
    expect(JSON.stringify(persisted[0]?.resultReferences)).not.toContain("model-invented-id");
    const history = await listKnowledgeSmartSearches(database, ownerId);
    expect(history[0]).toMatchObject({ id: runId, resultCount: 1, status: "succeeded" });
    expect(await listKnowledgeSmartSearches(database, editorId)).toEqual([]);
  });

  it("keeps analysis chat scoped to the current conversation and validates frozen citations", async () => {
    const database = activeClient().database;
    const created = await createKnowledgeWorkspace(database, ownerId, {
      name: "Synthetic chat workspace",
    });
    await addKnowledgeWorkspaceSources(database, ownerId, created.id, {
      sources: [
        {
          batchId: publishedBatchId,
          contentHash: "c".repeat(64),
          sourceId: lectureId,
          sourceType: "lecture",
        },
      ],
    });
    const current = await createKnowledgeConversation(database, ownerId, created.id, {});
    const other = await createKnowledgeConversation(database, ownerId, created.id, {
      title: "Other conversation",
    });
    await database.insert(knowledgeAnalysisMessages).values({
      contentMarkdown: "OTHER_CONVERSATION_SECRET",
      conversationId: other.id,
      createdByUserId: ownerId,
      role: "user",
      sequence: 1,
      workspaceId: created.id,
    });
    const authorization = await loadAuthorizationContext(database, {
      contextHash: authorizationContextHash,
      id: authorizationContextId,
    });
    const prepared = await prepareKnowledgeAnalysisMessage(
      database,
      authorization,
      created.id,
      current.id,
      { content: "这场讲座有哪些跨学科启示？" },
      "e".repeat(40),
    );
    let capturedPrompt = "";
    const provider: JsonModelProvider = {
      async generateJson(request) {
        await Promise.resolve();
        capturedPrompt = request.userPrompt;
        return {
          json: {
            answerMarkdown: "该讲座强调跨学科项目。",
            citations: [
              {
                claim: "讲座强调跨学科项目",
                source: {
                  batchId: publishedBatchId,
                  contentHash: "c".repeat(64),
                  sourceId: lectureId,
                  sourceType: "lecture",
                },
              },
            ],
            conversationTopic: "跨学科项目分析",
            suggestedFollowUps: ["是否需要比较案例？"],
            uncertainties: ["未披露项目规模。"],
          },
          model: "deepseek-v4-flash",
          providerRequestId: randomUUID(),
          usage: {
            completionTokens: 20,
            promptCacheHitTokens: 0,
            promptCacheMissTokens: 50,
            promptTokens: 50,
            totalTokens: 70,
          },
        };
      },
    };
    await executeKnowledgeAnalysisChat(database, prepared.task, provider, {
      searchCases: async () => {
        await Promise.resolve();
        return {
          estimatedTotalHits: 0,
          facetDistribution: {},
          hits: [],
          limit: 20,
          offset: 0,
          processingTimeMs: 1,
          query: "",
        };
      },
      searchLectures: async () => {
        await Promise.resolve();
        return {
          estimatedTotalHits: 0,
          facetDistribution: {},
          hits: [],
          limit: 20,
          offset: 0,
          processingTimeMs: 1,
          query: "",
        };
      },
    });
    expect(capturedPrompt).not.toContain("OTHER_CONVERSATION_SECRET");
    const read = await readKnowledgeConversation(database, ownerId, created.id, current.id);
    expect(read.conversation.title).toBe("跨学科项目分析");
    expect(read.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(read.messages[1]?.citations).toEqual([
      expect.objectContaining({ claim: "讲座强调跨学科项目" }),
    ]);
  });

  it("renders and stores deterministic interactive and static report artifacts", async () => {
    const database = activeClient().database;
    const created = await createKnowledgeWorkspace(database, ownerId, {
      name: "Synthetic report workspace",
    });
    await addKnowledgeWorkspaceSources(database, ownerId, created.id, {
      sources: [
        {
          batchId: publishedBatchId,
          contentHash: "c".repeat(64),
          sourceId: lectureId,
          sourceType: "lecture",
        },
      ],
    });
    const conversation = await createKnowledgeConversation(database, ownerId, created.id, {
      title: "Report conversation",
    });
    await database.insert(knowledgeAnalysisMessages).values({
      contentMarkdown: "请总结跨学科趋势。",
      conversationId: conversation.id,
      createdByUserId: ownerId,
      role: "user",
      sequence: 1,
      workspaceId: created.id,
    });
    const authorization = await loadAuthorizationContext(database, {
      contextHash: authorizationContextHash,
      id: authorizationContextId,
    });
    const prepared = await prepareKnowledgeAnalysisReport(
      database,
      authorization,
      created.id,
      conversation.id,
      { requirements: "突出资料边界。" },
      "e".repeat(40),
    );
    let capturedReportPrompt = "";
    const provider: JsonModelProvider = {
      async generateJson(request) {
        await Promise.resolve();
        capturedReportPrompt = request.userPrompt;
        return {
          json: {
            executiveSummary: "合成资料显示一项跨学科趋势。",
            sections: [
              {
                chartKey: "source_type",
                citations: [
                  {
                    claim: "讲座包含跨学科证据。",
                    source: {
                      batchId: publishedBatchId,
                      contentHash: "c".repeat(64),
                      sourceId: lectureId,
                      sourceType: "lecture",
                    },
                  },
                ],
                id: "trend",
                paragraphs: ["该判断仅基于当前冻结讲座。"],
                title: "跨学科趋势",
              },
            ],
            title: "合成趋势分析",
          },
          model: "deepseek-v4-flash",
          providerRequestId: randomUUID(),
          usage: {
            completionTokens: 20,
            promptCacheHitTokens: 0,
            promptCacheMissTokens: 50,
            promptTokens: 50,
            totalTokens: 70,
          },
        };
      },
    };
    const root = await mkdtemp(join(tmpdir(), "culiu-report-"));
    try {
      const store = new LocalImmutableObjectStore(root);
      await executeKnowledgeAnalysisReport(database, prepared.task, provider, store);
      expect(capturedReportPrompt).toContain('"source":{"batchId"');
      expect(capturedReportPrompt).not.toContain('"source":"exact frozen reference"');
      const [interactive, staticHtml] = await Promise.all([
        readKnowledgeAnalysisReportArtifact(
          database,
          store,
          ownerId,
          created.id,
          prepared.reportId,
          "interactive",
        ),
        readKnowledgeAnalysisReportArtifact(
          database,
          store,
          ownerId,
          created.id,
          prepared.reportId,
          "static",
        ),
      ]);
      const interactiveText = Buffer.from(interactive).toString("utf8");
      const staticText = Buffer.from(staticHtml).toString("utf8");
      expect(interactiveText).toContain('data-action="zoom-in"');
      expect(interactiveText).toContain("script-src 'sha256-");
      expect(interactiveText).toContain("讲座资料 01");
      expect(interactiveText).toContain("Synthetic stage 3 lecture");
      expect(interactiveText).not.toContain(lectureId);
      expect(interactiveText).not.toContain("c".repeat(12));
      expect(staticText).not.toContain("<script");
      expect(staticText).toContain("讲座资料 01");
      expect(staticText).not.toContain(lectureId);
      const citationAudit = await readKnowledgeAnalysisReportCitationAudit(
        database,
        ownerId,
        created.id,
        prepared.reportId,
      );
      expect(citationAudit).toEqual([
        {
          contentHash: "c".repeat(64),
          publicDescription: "Synthetic stage 3 lecture",
          publicLabel: "讲座资料 01",
          sourceId: lectureId,
          sourceType: "lecture",
        },
      ]);
      const report = await database
        .select()
        .from(knowledgeAnalysisReports)
        .where(eq(knowledgeAnalysisReports.id, prepared.reportId));
      expect(report[0]).toMatchObject({
        interactiveByteCount: interactive.byteLength,
        status: "succeeded",
        version: 1,
      });
      expect(report[0]?.interactiveStorageKey).toMatch(/^knowledge\/reports\//u);
      const generated = report[0];
      if (
        generated === undefined ||
        generated.structuredReport === null ||
        generated.interactiveStorageKey === null ||
        generated.interactiveContentHash === null ||
        generated.interactiveByteCount === null ||
        generated.interactiveScriptHash === null ||
        generated.staticStorageKey === null ||
        generated.staticContentHash === null ||
        generated.staticByteCount === null
      )
        throw new Error("generated report fixture incomplete");
      const completedAt = new Date();
      const legacyRunId = randomUUID();
      const legacyReportId = randomUUID();
      await database.insert(knowledgeAgentRuns).values({
        authorizationContextId,
        completedAt,
        completionTokens: 0,
        contextVersion: "knowledge-analysis-report-context.v1",
        conversationId: conversation.id,
        costMicrounits: 0,
        gitCommitSha: "e".repeat(40),
        id: legacyRunId,
        inputSnapshotHash: generated.conversationSnapshotHash,
        kind: "analysis_report",
        model: "deepseek-v4-flash",
        pricingVersion: "deepseek-v4-flash-cny-2026-08-02",
        promptTokens: 0,
        promptVersion: "knowledge-analysis-report.v2",
        schemaVersion: "knowledge-analysis-report-output.v1",
        startedAt: completedAt,
        status: "succeeded",
        totalTokens: 0,
        workspaceId: created.id,
      });
      await database.insert(knowledgeAnalysisReports).values({
        agentRunId: legacyRunId,
        completedAt,
        conversationId: conversation.id,
        conversationSnapshotHash: generated.conversationSnapshotHash,
        conversationThroughSequence: generated.conversationThroughSequence,
        createdByUserId: ownerId,
        id: legacyReportId,
        interactiveByteCount: generated.interactiveByteCount,
        interactiveContentHash: generated.interactiveContentHash,
        interactiveScriptHash: generated.interactiveScriptHash,
        interactiveStorageKey: generated.interactiveStorageKey,
        requirements: generated.requirements,
        sourceSnapshot: generated.sourceSnapshot,
        staticByteCount: generated.staticByteCount,
        staticContentHash: generated.staticContentHash,
        staticStorageKey: generated.staticStorageKey,
        status: "succeeded",
        structuredReport: generated.structuredReport,
        templateVersion: "knowledge-analysis-report-html.v2",
        updatedAt: completedAt,
        workspaceId: created.id,
      });
      const presentationCopy = await rerenderKnowledgeAnalysisReportPresentation(
        database,
        store,
        authorization,
        created.id,
        legacyReportId,
        "e".repeat(40),
      );
      expect(presentationCopy.version).toBe(2);
      const reports = await listKnowledgeAnalysisReports(
        database,
        ownerId,
        created.id,
        conversation.id,
      );
      expect(reports.find((item) => item.id === presentationCopy.reportId)).toMatchObject({
        publicSafe: true,
        version: 2,
      });
      expect(reports.find((item) => item.id === legacyReportId)).toMatchObject({
        canCreatePresentationCopy: false,
        publicSafe: false,
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("makes successful smart-search runs and reports immutable", async () => {
    const database = activeClient().database;
    const { conversationId, workspaceId } = await createWorkspace();
    const startedAt = new Date();
    const completedAt = new Date(startedAt.getTime() + 1000);
    const smartSearchRunId = randomUUID();
    await database.insert(knowledgeSmartSearchRuns).values({
      authorizationContextId,
      createdByUserId: ownerId,
      gitCommitSha: "e".repeat(40),
      id: smartSearchRunId,
      knowledgeBatchId: publishedBatchId,
      model: "deepseek-v4-flash",
      prompt: "Find synthetic evidence.",
      promptHash: "f".repeat(64),
      promptVersion: "knowledge-smart-search.v2",
      retrievalVersion: "knowledge-hybrid.v2",
      schemaVersion: "knowledge-smart-search-output.v1",
    });
    await database
      .update(knowledgeSmartSearchRuns)
      .set({
        completedAt,
        progressStage: "succeeded",
        queryPlan: { queries: [] },
        startedAt,
        status: "succeeded",
        summary: "Synthetic result.",
      })
      .where(eq(knowledgeSmartSearchRuns.id, smartSearchRunId));
    await expect(
      database
        .update(knowledgeSmartSearchRuns)
        .set({ summary: "Mutated result." })
        .where(eq(knowledgeSmartSearchRuns.id, smartSearchRunId)),
    ).rejects.toThrow();

    const agentRunId = randomUUID();
    await database.insert(knowledgeAgentRuns).values({
      authorizationContextId,
      contextVersion: "knowledge-analysis-context.v1",
      conversationId,
      gitCommitSha: "e".repeat(40),
      id: agentRunId,
      inputSnapshotHash: "1".repeat(64),
      kind: "analysis_report",
      model: "deepseek-v4-flash",
      pricingVersion: "deepseek-v4-flash-cny-2026-08-02",
      promptVersion: "knowledge-analysis-report.v2",
      schemaVersion: "knowledge-analysis-report-output.v1",
      workspaceId,
    });
    const reportId = randomUUID();
    await database.insert(knowledgeAnalysisReports).values({
      agentRunId,
      conversationId,
      conversationSnapshotHash: "2".repeat(64),
      createdByUserId: ownerId,
      id: reportId,
      templateVersion: "knowledge-analysis-html.v1",
      workspaceId,
    });
    await database
      .update(knowledgeAnalysisReports)
      .set({
        completedAt,
        interactiveContentHash: "3".repeat(64),
        interactiveByteCount: 100,
        interactiveScriptHash: "5".repeat(64),
        interactiveStorageKey: `knowledge/reports/${reportId}/interactive.html`,
        staticContentHash: "4".repeat(64),
        staticByteCount: 100,
        staticStorageKey: `knowledge/reports/${reportId}/static.html`,
        status: "succeeded",
        structuredReport: { title: "Synthetic report" },
      })
      .where(eq(knowledgeAnalysisReports.id, reportId));
    await expect(
      database
        .update(knowledgeAnalysisReports)
        .set({ requirements: "Mutated requirements." })
        .where(eq(knowledgeAnalysisReports.id, reportId)),
    ).rejects.toThrow();
  });
});
