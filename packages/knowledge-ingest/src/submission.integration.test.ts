import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createDatabaseClient,
  parseDatabaseConfig,
  runMigrations,
  type DatabaseClient,
} from "@culiu/database";
import { createKnowledgeImportAuthorizationContext } from "@culiu/authorization";
import {
  createMeilisearchClient,
  KnowledgeIndexManager,
  parseMeilisearchAdminConfig,
  type KnowledgeIndexNames,
} from "@culiu/search";
import { LocalImmutableObjectStore } from "@culiu/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { KnowledgeImporter } from "./importer.js";
import type { LoadedKnowledgeImport } from "./source-loader.js";
import { buildKnowledgeSubmission, type SubmittedKnowledgeFile } from "./submission.js";

const encoder = new TextEncoder();
const suffix = randomUUID().replaceAll("-", "");
const indexNames: KnowledgeIndexNames = {
  cases: `test_submission_cases_${suffix}`,
  lectures: `test_submission_lectures_${suffix}`,
  transcriptSegments: `test_submission_segments_${suffix}`,
};

let maintenanceClient: DatabaseClient | undefined;
let databaseClient: DatabaseClient | undefined;
let client: ReturnType<typeof createMeilisearchClient> | undefined;
let importer: KnowledgeImporter | undefined;
let objectStore: LocalImmutableObjectStore | undefined;
let temporaryDatabaseName = "";
let temporaryRoot = "";
let actorUserId = "";

function submitted(sourceKey: string, extension: string, content: string): SubmittedKnowledgeFile {
  return { bytes: encoder.encode(content), fileName: `${sourceKey}${extension}` };
}

function analysis(sourceKey: string, title: string): SubmittedKnowledgeFile {
  return submitted(
    sourceKey,
    ".md",
    `# ${title}

## 基础信息
- 主办机构：虚构机构
- 主讲人：匿名讲者

## 摘要
这是一场只用于集成测试的虚构讲座。

## 趋势
跨学科研究持续发展。

## 案例卡片
### 虚构案例
- 背景：匿名测试背景
- 申请方向/结果：虚构录取结果
- 可信度：低
- 证据边界：仅用于自动化测试

## AI+与跨学科
使用公开数据进行方法验证。

## 失败与反例
没有可验证的失败信息。

## 关键原话
“这是一条虚构测试原话。”

## 醋溜科技行动建议
仅用于验证导入链路。

## 证据边界
全部内容均为虚构测试数据。`,
  );
}

function completeEvidence(sourceKey: string, title: string): LoadedKnowledgeImport {
  const transcriptText = "虚构证据内容。";
  return buildKnowledgeSubmission({
    analysis: analysis(sourceKey, title),
    transcriptJson: submitted(
      sourceKey,
      ".json",
      JSON.stringify({
        complete: true,
        duration_seconds: 2,
        forced_aligner: "synthetic",
        generated_at: "2026-08-02T00:00:00+08:00",
        language: "Chinese",
        method: "synthetic",
        model: "synthetic",
        sentence_count: 1,
        sentences: [
          {
            changes: [],
            end: 1.5,
            original_text: transcriptText,
            start: 0.1,
            text: transcriptText,
          },
        ],
        source: "redacted.mp4",
        source_json: "redacted.json",
        tokens: [],
        transcribed_until_seconds: 2,
        version: "synthetic-v1",
      }),
    ),
    transcriptQa: submitted(
      sourceKey,
      ".qa.json",
      JSON.stringify({
        changed_sentence_count: 0,
        complete: true,
        method: "synthetic",
        rule_counts: {},
        sentence_count: 1,
        source_json: "redacted.json",
        source_sha256: "0".repeat(64),
        version: "synthetic-v1",
      }),
    ),
    transcriptSrt: submitted(
      sourceKey,
      ".srt",
      `1\n00:00:00,100 --> 00:00:01,500\n${transcriptText}\n`,
    ),
    transcriptText: submitted(
      sourceKey,
      ".txt",
      `[00:00:00.100 - 00:00:01.500] ${transcriptText}\n`,
    ),
  });
}

async function deleteIndexIfPresent(uid: string): Promise<void> {
  if (client === undefined) return;
  try {
    const task = await client.deleteIndex(uid);
    await client.tasks.waitForTask(task.taskUid, { interval: 50, timeout: 30_000 });
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "cause" in error &&
      typeof error.cause === "object" &&
      error.cause !== null &&
      "code" in error.cause
        ? error.cause.code
        : undefined;
    if (code !== "index_not_found") {
      throw error;
    }
  }
}

beforeAll(async () => {
  const base = parseDatabaseConfig();
  temporaryDatabaseName = `culiu_submission_${suffix}`;
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
  actorUserId = randomUUID();
  await databaseClient.pool.query(
    `insert into app_user (id, email, display_name, role)
     values ($1, $2, 'Synthetic Import Admin', 'admin')`,
    [actorUserId, `${actorUserId}@example.invalid`],
  );

  temporaryRoot = await mkdtemp(join(tmpdir(), "culiu-knowledge-submission-"));
  client = createMeilisearchClient(parseMeilisearchAdminConfig());
  objectStore = new LocalImmutableObjectStore(temporaryRoot);
  importer = new KnowledgeImporter({
    databaseClient,
    indexPublisher: new KnowledgeIndexManager({ client, enableEmbedders: false, indexNames }),
    manifestPath: "unused.json",
    objectStore,
    sourceRoots: {},
  });
});

afterAll(async () => {
  const cleanupResults = await Promise.allSettled(
    Object.values(indexNames).map(async (uid) => deleteIndexIfPresent(uid)),
  );
  if (databaseClient !== undefined) await databaseClient.close();
  if (maintenanceClient !== undefined) {
    await maintenanceClient.pool.query(
      "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
      [temporaryDatabaseName],
    );
    await maintenanceClient.pool.query(`drop database if exists "${temporaryDatabaseName}"`);
    await maintenanceClient.close();
  }
  if (temporaryRoot !== "") await rm(temporaryRoot, { force: true, recursive: true });
  const cleanupErrors: Error[] = [];
  for (const result of cleanupResults) {
    if (result.status === "rejected") {
      const reason: unknown = result.reason;
      cleanupErrors.push(
        reason instanceof Error ? reason : new Error("Unknown index cleanup failure."),
      );
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Failed to remove submission integration indexes.");
  }
});

describe("knowledge submission publication", () => {
  it("publishes analysis-only and complete-evidence submissions without replacing prior lectures", async () => {
    if (databaseClient === undefined || client === undefined || importer === undefined) {
      throw new Error("Integration test runtime is unavailable.");
    }
    const first = buildKnowledgeSubmission({
      analysis: analysis("2026-08-01_existing_lecture", "既有虚构讲座"),
    });
    const firstResult = await importer.importLoaded(
      {
        actorUserId,
        corpusHash: first.manifest.corpus_hash,
        corpusId: "submission_integration_test",
        expectedLectureCount: 1,
        manifestVersion: first.manifest.manifest_version,
        mappingVersion: first.manifest.mapping_version,
        publicationMode: "replace",
      },
      first,
    );
    expect(firstResult.documentCounts).toEqual({ cases: 1, lectures: 1, transcriptSegments: 0 });

    const second = completeEvidence("2026-08-02_new_lecture", "新增虚构讲座");
    const secondHash = createHash("sha256")
      .update(`${first.manifest.corpus_hash}:${second.manifest.corpus_hash}`)
      .digest("hex");
    const secondResult = await importer.importLoaded(
      {
        actorUserId,
        corpusHash: secondHash,
        corpusId: "submission_integration_test",
        expectedLectureCount: 1,
        manifestVersion: second.manifest.manifest_version,
        mappingVersion: second.manifest.mapping_version,
        publicationMode: "upsert",
      },
      second,
    );
    expect(secondResult.documentCounts).toEqual({ cases: 2, lectures: 2, transcriptSegments: 0 });

    const revision = buildKnowledgeSubmission({
      analysis: analysis("2026-08-02_new_lecture", "新增虚构讲座修订"),
    });
    const revisionHash = createHash("sha256")
      .update(`${secondHash}:${revision.manifest.corpus_hash}`)
      .digest("hex");
    const revisionResult = await importer.importLoaded(
      {
        actorUserId,
        corpusHash: revisionHash,
        corpusId: "submission_integration_test",
        expectedLectureCount: 1,
        manifestVersion: revision.manifest.manifest_version,
        mappingVersion: revision.manifest.mapping_version,
        publicationMode: "upsert",
      },
      revision,
    );
    expect(revisionResult.documentCounts).toEqual({ cases: 2, lectures: 2, transcriptSegments: 0 });

    const current = await databaseClient.pool.query<{
      lecture_count: number;
      source_count: string;
    }>(
      `select batch.lecture_count,
              count(source.source_document_id)::text as source_count
         from knowledge_import_batch batch
         join knowledge_import_source source on source.batch_id = batch.id
        where batch.is_current = true
        group by batch.id`,
    );
    expect(current.rows[0]).toEqual({ lecture_count: 2, source_count: "6" });

    const revisedSourceCount = await databaseClient.pool.query<{ source_count: string }>(
      `select count(*)::text as source_count
         from knowledge_import_source
        where batch_id = (select id from knowledge_import_batch where is_current = true)
          and lecture_id = $1`,
      [revision.documents.lectures[0]?.lecture_id],
    );
    expect(revisedSourceCount.rows[0]?.source_count).toBe("5");

    const search = await client
      .index<{ lecture_id: string }>(indexNames.lectures)
      .search("虚构讲座", { limit: 10 });
    expect(search.hits).toHaveLength(2);
    expect(new Set(search.hits.map((hit) => hit.lecture_id))).toEqual(
      new Set(
        first.documents.lectures.concat(revision.documents.lectures).map((item) => item.lecture_id),
      ),
    );
  }, 60_000);

  it("stores a transcript and generated draft before an explicit reviewed publication", async () => {
    if (
      databaseClient === undefined ||
      client === undefined ||
      importer === undefined ||
      objectStore === undefined
    ) {
      throw new Error("Integration test runtime is unavailable.");
    }
    const { createDeterministicMockKnowledgeExtractionProvider } = await import(
      "./knowledge-extraction.js"
    );
    const { parseTranscriptDocument } = await import("./transcript-documents.js");
    const {
      executeKnowledgeTranscriptExtraction,
      listKnowledgeTranscriptSubmissions,
      prepareKnowledgeTranscriptTask,
      publishKnowledgeTranscriptDraft,
      readLatestKnowledgeTranscriptSubmission,
      readKnowledgeTranscriptSubmission,
    } = await import("./transcript-workflow.js");
    const context = await createKnowledgeImportAuthorizationContext(databaseClient.database, {
      displayName: "Synthetic Import Admin",
      email: `${actorUserId}@example.invalid`,
      id: actorUserId,
      role: "admin",
    });
    const document = await parseTranscriptDocument({
      bytes: encoder.encode(
        "这是一份虚构的集成测试逐字稿。联系邮箱 test@example.com，手机 13800138000。",
      ),
      fileName: "0401_原文.md",
    });
    const prepared = await prepareKnowledgeTranscriptTask(
      databaseClient,
      objectStore,
      context,
      document,
      {
        gitCommitSha: "a".repeat(40),
        outboundConfirmed: true,
      },
    );

    await executeKnowledgeTranscriptExtraction(
      databaseClient,
      prepared.task,
      createDeterministicMockKnowledgeExtractionProvider(),
    );
    const view = await readKnowledgeTranscriptSubmission(
      databaseClient,
      {
        displayName: "Synthetic Import Admin",
        email: `${actorUserId}@example.invalid`,
        id: actorUserId,
        role: "admin",
      },
      prepared.submissionId,
    );
    expect(view.status).toBe("draft_ready");
    expect(view.generatedAnalysisMarkdown).toContain("## 证据边界");
    expect(view.lectureDate).toBe("2026-08-02");
    expect(view.lectureTitle).toBe("虚构跨学科讲座");
    expect(view.logs.map((entry) => entry.code)).toEqual([
      "transcript_saved",
      "task_queued",
      "worker_started",
      "draft_ready",
    ]);
    expect(view.logs.at(-1)?.message).toContain("Token：输入");
    expect(JSON.stringify(view.logs)).not.toContain("test@example.com");
    expect(JSON.stringify(view.logs)).not.toContain("13800138000");
    const latestView = await readLatestKnowledgeTranscriptSubmission(databaseClient, {
      displayName: "Synthetic Import Admin",
      email: `${actorUserId}@example.invalid`,
      id: actorUserId,
      role: "admin",
    });
    expect(latestView?.submissionId).toBe(prepared.submissionId);
    expect(latestView?.generatedAnalysisMarkdown).toBe(view.generatedAnalysisMarkdown);
    const submissionList = await listKnowledgeTranscriptSubmissions(databaseClient, {
      displayName: "Synthetic Import Admin",
      email: `${actorUserId}@example.invalid`,
      id: actorUserId,
      role: "admin",
    });
    expect(submissionList[0]).toMatchObject({
      originalFileName: "0401_原文.md",
      sourceKey: "2026-08-02_虚构跨学科讲座",
      status: "draft_ready",
      submissionId: prepared.submissionId,
    });

    const stored = await databaseClient.pool.query<{
      generated_analysis_markdown: string;
      original_content_hash: string;
      transcript_text: string;
    }>(
      `select generated_analysis_markdown, original_content_hash, transcript_text
         from knowledge_transcript_submission where id = $1`,
      [prepared.submissionId],
    );
    expect(stored.rows[0]?.transcript_text).toContain("虚构的集成测试逐字稿");
    expect(stored.rows[0]?.original_content_hash).toBe(document.contentHash);
    expect(stored.rows[0]?.generated_analysis_markdown).toBe(view.generatedAnalysisMarkdown);

    const published = await publishKnowledgeTranscriptDraft(
      databaseClient,
      objectStore,
      importer,
      {
        displayName: "Synthetic Import Admin",
        email: `${actorUserId}@example.invalid`,
        id: actorUserId,
        role: "admin",
      },
      {
        analysisMarkdown: view.generatedAnalysisMarkdown ?? "",
        lectureDate: view.lectureDate ?? "",
        lectureTitle: view.lectureTitle,
        submissionId: prepared.submissionId,
      },
    );
    expect(published.status).toBe("published");
    expect(published.documentCounts).toEqual({ cases: 3, lectures: 3, transcriptSegments: 0 });

    const publishedRow = await databaseClient.pool.query<{
      published_batch_id: string | null;
      reviewed_analysis_markdown: string | null;
      status: string;
    }>(
      `select published_batch_id, reviewed_analysis_markdown, status
         from knowledge_transcript_submission where id = $1`,
      [prepared.submissionId],
    );
    expect(publishedRow.rows[0]?.status).toBe("published");
    expect(publishedRow.rows[0]?.published_batch_id).not.toBeNull();
    expect(publishedRow.rows[0]?.reviewed_analysis_markdown).toContain("## 证据边界");
  }, 60_000);

  it("keeps a retryable failed attempt visible as processing", async () => {
    if (databaseClient === undefined || objectStore === undefined) {
      throw new Error("Integration test runtime is unavailable.");
    }
    const { ModelGatewayError } = await import("@culiu/ai");
    const { parseTranscriptDocument } = await import("./transcript-documents.js");
    const {
      executeKnowledgeTranscriptExtraction,
      listKnowledgeTranscriptSubmissions,
      prepareKnowledgeTranscriptTask,
      readKnowledgeTranscriptSubmission,
    } = await import("./transcript-workflow.js");
    const principal = {
      displayName: "Synthetic Import Admin",
      email: `${actorUserId}@example.invalid`,
      id: actorUserId,
      role: "admin" as const,
    };
    const context = await createKnowledgeImportAuthorizationContext(
      databaseClient.database,
      principal,
    );
    const document = await parseTranscriptDocument({
      bytes: encoder.encode("虚构的自动重试状态测试逐字稿。"),
      fileName: "2026-08-04_自动重试状态测试.md",
    });
    const prepared = await prepareKnowledgeTranscriptTask(
      databaseClient,
      objectStore,
      context,
      document,
      { gitCommitSha: "c".repeat(40), outboundConfirmed: true },
    );

    await expect(
      executeKnowledgeTranscriptExtraction(databaseClient, prepared.task, {
        generateJson: () =>
          Promise.reject(
            new ModelGatewayError("invalid_output", "Synthetic truncated output.", {
              detailCode: "output_truncated",
              retryable: true,
            }),
          ),
      }),
    ).rejects.toMatchObject({ detailCode: "output_truncated" });

    const view = await readKnowledgeTranscriptSubmission(
      databaseClient,
      principal,
      prepared.submissionId,
    );
    expect(view.status).toBe("processing");
    expect(view.completedAt).toBeNull();
    expect(view.logs.map((entry) => entry.code)).toEqual([
      "transcript_saved",
      "task_queued",
      "worker_started",
      "model_output_truncated",
      "retry_scheduled",
    ]);
    const submissionList = await listKnowledgeTranscriptSubmissions(databaseClient, principal);
    expect(submissionList[0]).toMatchObject({
      originalFileName: "2026-08-04_自动重试状态测试.md",
      status: "processing",
      submissionId: prepared.submissionId,
    });
  }, 60_000);

  it("records a safe terminal state when queueing fails after the transcript is stored", async () => {
    if (databaseClient === undefined || objectStore === undefined) {
      throw new Error("Integration test runtime is unavailable.");
    }
    const { parseTranscriptDocument } = await import("./transcript-documents.js");
    const {
      markKnowledgeTranscriptEnqueueFailure,
      prepareKnowledgeTranscriptTask,
      readKnowledgeTranscriptSubmission,
    } = await import("./transcript-workflow.js");
    const principal = {
      displayName: "Synthetic Import Admin",
      email: `${actorUserId}@example.invalid`,
      id: actorUserId,
      role: "admin" as const,
    };
    const context = await createKnowledgeImportAuthorizationContext(
      databaseClient.database,
      principal,
    );
    const document = await parseTranscriptDocument({
      bytes: encoder.encode("虚构的队列失败测试逐字稿。"),
      fileName: "2026-08-04_队列失败测试.md",
    });
    const prepared = await prepareKnowledgeTranscriptTask(
      databaseClient,
      objectStore,
      context,
      document,
      { gitCommitSha: "b".repeat(40), outboundConfirmed: true },
    );

    await markKnowledgeTranscriptEnqueueFailure(databaseClient, prepared);

    const view = await readKnowledgeTranscriptSubmission(
      databaseClient,
      principal,
      prepared.submissionId,
    );
    expect(view.status).toBe("failed");
    expect(view.failureMessage).toBe("Transcript extraction could not enter the task queue.");
    expect(view.failureCode).toBe("queue_enqueue_failed");
    expect(view.logs.at(-1)).toMatchObject({
      code: "queue_enqueue_failed",
      level: "error",
      message: "Transcript extraction could not enter the task queue.",
    });
    const job = await databaseClient.pool.query<{ error_code: string; status: string }>(
      "select error_code, status from background_job where id = $1",
      [prepared.task.taskId],
    );
    expect(job.rows[0]).toEqual({ error_code: "queue_enqueue_failed", status: "failed" });
  }, 60_000);
});
