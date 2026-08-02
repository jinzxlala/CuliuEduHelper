import { createHash, randomUUID } from "node:crypto";

import { ModelGatewayError, type JsonModelProvider } from "@culiu/ai";
import type { AuthorizationContext, SessionPrincipal } from "@culiu/authorization";
import type { DatabaseClient, DatabaseConnection } from "@culiu/database";
import type { ImmutableObjectStore, StoredObjectReference } from "@culiu/storage";
import { KnowledgeExtractTaskSchema, type KnowledgeExtractTask } from "@culiu/tasks";
import { z } from "zod";

import { KnowledgeImportError } from "./import-errors.js";
import type { KnowledgeImporter, KnowledgeImportResult } from "./importer.js";
import {
  buildKnowledgeExtractionUserPrompt,
  KNOWLEDGE_EXTRACTION_MODEL,
  KNOWLEDGE_EXTRACTION_PROMPT_HASH,
  KNOWLEDGE_EXTRACTION_PROMPT_VERSION,
  KNOWLEDGE_EXTRACTION_REDACTION_VERSION,
  KNOWLEDGE_EXTRACTION_SCHEMA_HASH,
  KNOWLEDGE_EXTRACTION_SCHEMA_VERSION,
  KNOWLEDGE_EXTRACTION_SYSTEM_PROMPT,
  knowledgeExtractionSha256,
  renderKnowledgeAnalysisMarkdown,
  sanitizeKnowledgeTranscriptForModel,
} from "./knowledge-extraction.js";
import { buildKnowledgeSubmission } from "./submission.js";
import type { ParsedTranscriptDocument } from "./transcript-documents.js";

const JOB_LEASE_MS = 120_000;

export class KnowledgeTranscriptWorkflowError extends Error {
  readonly code:
    | "authorization_denied"
    | "conflict"
    | "invalid_draft"
    | "not_found"
    | "outbound_confirmation_required";

  constructor(code: KnowledgeTranscriptWorkflowError["code"], message: string) {
    super(message);
    this.name = "KnowledgeTranscriptWorkflowError";
    this.code = code;
  }
}

export interface PreparedKnowledgeTranscriptTask {
  readonly submissionId: string;
  readonly task: KnowledgeExtractTask;
}

export interface KnowledgeTranscriptSubmissionView {
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  readonly generatedAnalysisMarkdown: string | null;
  readonly logs: readonly KnowledgeTranscriptLogEntry[];
  readonly originalFileName: string;
  readonly publishedBatchId: string | null;
  readonly sourceKey: string;
  readonly status: "draft_ready" | "failed" | "processing" | "published" | "queued";
  readonly submissionId: string;
  readonly updatedAt: string;
}

export interface KnowledgeTranscriptSubmissionSummary {
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly originalFileName: string;
  readonly sourceKey: string;
  readonly status: KnowledgeTranscriptSubmissionView["status"];
  readonly submissionId: string;
  readonly updatedAt: string;
}

export interface KnowledgeTranscriptLogEntry {
  readonly at: string;
  readonly code: string;
  readonly level: "error" | "info" | "success";
  readonly message: string;
}

interface WorkflowRow {
  readonly actor_user_id: string;
  readonly authorization_context_id: string;
  readonly byte_count: number;
  readonly completed_at: Date | string | null;
  readonly context_actor_user_id: string;
  readonly context_expires_at: Date | string;
  readonly context_hash: string;
  readonly context_student_id: string | null;
  readonly created_at: Date | string;
  readonly failure_summary: string | null;
  readonly failure_code: string | null;
  readonly generated_analysis_markdown: string | null;
  readonly generated_analysis_hash: string | null;
  readonly git_commit_sha: string;
  readonly job_attempts: number;
  readonly job_completed_at: Date | string | null;
  readonly job_error_code: string | null;
  readonly job_max_attempts: number;
  readonly job_started_at: Date | string | null;
  readonly job_status: "canceled" | "failed" | "queued" | "running" | "succeeded";
  readonly lecture_id: string;
  readonly mime_type: ParsedTranscriptDocument["mimeType"];
  readonly model_input_hash: string;
  readonly model: string;
  readonly original_content_hash: string;
  readonly original_file_name: string;
  readonly prompt_hash: string;
  readonly prompt_tokens: number | null;
  readonly prompt_version: string;
  readonly published_batch_id: string | null;
  readonly redaction_version: string;
  readonly provider: string;
  readonly role: "admin" | "advisor" | "auditor" | "service";
  readonly schema_hash: string;
  readonly schema_version: string;
  readonly source_key: string;
  readonly status: KnowledgeTranscriptSubmissionView["status"];
  readonly storage_key: string;
  readonly transcript_text: string;
  readonly transcript_text_hash: string;
  readonly completion_tokens: number | null;
  readonly total_tokens: number | null;
  readonly updated_at: Date | string;
  readonly user_active: boolean;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function deterministicUuid(seed: string): string {
  const bytes = Buffer.from(createHash("sha256").update(seed, "utf8").digest().subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function transaction<T>(connection: DatabaseConnection, work: () => Promise<T>): Promise<T> {
  await connection.query("begin");
  try {
    const result = await work();
    await connection.query("commit");
    return result;
  } catch (error) {
    await connection.query("rollback");
    throw error;
  }
}

function assertKnowledgeContext(
  context: AuthorizationContext,
  actorUserId: string,
  now: Date,
): void {
  if (
    context.actorUserId !== actorUserId ||
    context.studentId !== null ||
    context.maxAccessLevel !== "restricted" ||
    !context.allowedActions.includes("knowledge:import") ||
    context.expiresAt <= now
  ) {
    throw new KnowledgeTranscriptWorkflowError(
      "authorization_denied",
      "Knowledge transcript authorization is invalid or expired.",
    );
  }
}

export async function prepareKnowledgeTranscriptTask(
  databaseClient: DatabaseClient,
  objectStore: ImmutableObjectStore,
  context: AuthorizationContext,
  document: ParsedTranscriptDocument,
  options: {
    readonly correlationId?: string;
    readonly gitCommitSha: string;
    readonly now?: Date;
    readonly outboundConfirmed: boolean;
  },
): Promise<PreparedKnowledgeTranscriptTask> {
  if (!options.outboundConfirmed) {
    throw new KnowledgeTranscriptWorkflowError(
      "outbound_confirmation_required",
      "Confirm that this transcript may be sent to the configured DeepSeek service.",
    );
  }
  const now = options.now ?? new Date();
  assertKnowledgeContext(context, context.actorUserId, now);
  if (!/^[0-9a-f]{40}$/u.test(options.gitCommitSha)) {
    throw new Error("CULIU_GIT_COMMIT_SHA must be a 40-character lowercase commit SHA.");
  }
  const modelInput = sanitizeKnowledgeTranscriptForModel(document.text);
  const modelInputHash = knowledgeExtractionSha256(modelInput);
  const reference = await objectStore.store({
    content: Buffer.from(document.file.bytes),
    domain: "knowledge",
  });
  if (
    reference.sha256 !== document.contentHash ||
    reference.size !== document.byteCount ||
    reference.domain !== "knowledge"
  ) {
    throw new Error("Stored transcript failed immutable reference verification.");
  }
  const submissionId = randomUUID();
  const taskId = deterministicUuid(
    `knowledge-extract:${submissionId}:${document.textHash}:${KNOWLEDGE_EXTRACTION_PROMPT_HASH}:${KNOWLEDGE_EXTRACTION_SCHEMA_HASH}`,
  );
  const idempotencyKey = `knowledge_extract_${taskId.replaceAll("-", "")}`;
  const task = KnowledgeExtractTaskSchema.parse({
    authorization: { contextHash: context.contextHash, contextId: context.id },
    idempotencyKey,
    payload: {
      correlationId: options.correlationId ?? randomUUID(),
      gitCommitSha: options.gitCommitSha,
      model: KNOWLEDGE_EXTRACTION_MODEL,
      modelInputHash,
      promptHash: KNOWLEDGE_EXTRACTION_PROMPT_HASH,
      promptVersion: KNOWLEDGE_EXTRACTION_PROMPT_VERSION,
      redactionVersion: KNOWLEDGE_EXTRACTION_REDACTION_VERSION,
      schemaHash: KNOWLEDGE_EXTRACTION_SCHEMA_HASH,
      schemaVersion: KNOWLEDGE_EXTRACTION_SCHEMA_VERSION,
      submissionId,
      transcriptTextHash: document.textHash,
    },
    taskId,
    taskName: "knowledge.extract",
  });
  const connection = await databaseClient.pool.connect();
  try {
    await transaction(connection, async () => {
      const actor = await connection.query<{ id: string }>(
        `select id from app_user
          where id = $1 and active = true and role in ('admin', 'advisor')`,
        [context.actorUserId],
      );
      if (actor.rowCount !== 1) {
        throw new KnowledgeTranscriptWorkflowError(
          "authorization_denied",
          "Only an active admin or advisor may submit a knowledge transcript.",
        );
      }
      await connection.query(
        `insert into background_job
          (id, task_name, authorization_context_id, idempotency_key, status, max_attempts, created_at)
         values ($1, 'knowledge.extract', $2, $3, 'queued', 3, $4)`,
        [taskId, context.id, idempotencyKey, now],
      );
      await connection.query(
        `insert into knowledge_transcript_submission
          (id, actor_user_id, authorization_context_id, background_job_id, source_key,
           lecture_id, original_file_name, mime_type, byte_count, storage_key,
           original_content_hash, transcript_text, transcript_text_hash, model_input_hash,
           outbound_confirmed_at, status, provider, model, prompt_version, prompt_hash,
           schema_version, schema_hash, redaction_version, git_commit_sha, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                 $15, 'queued', 'deepseek', $16, $17, $18, $19, $20, $21, $22, $23, $23)`,
        [
          submissionId,
          context.actorUserId,
          context.id,
          taskId,
          document.sourceKey,
          document.lectureId,
          document.file.fileName,
          document.mimeType,
          document.byteCount,
          reference.key,
          document.contentHash,
          document.text,
          document.textHash,
          modelInputHash,
          now,
          KNOWLEDGE_EXTRACTION_MODEL,
          KNOWLEDGE_EXTRACTION_PROMPT_VERSION,
          KNOWLEDGE_EXTRACTION_PROMPT_HASH,
          KNOWLEDGE_EXTRACTION_SCHEMA_VERSION,
          KNOWLEDGE_EXTRACTION_SCHEMA_HASH,
          KNOWLEDGE_EXTRACTION_REDACTION_VERSION,
          options.gitCommitSha,
          now,
        ],
      );
      await connection.query(
        `insert into audit_event
          (actor_type, actor_user_id, action, object_type, object_id, result,
           request_correlation_id, details)
         values ('user', $1, 'knowledge.transcript.submitted', 'knowledge_transcript_submission',
                 $2, 'allowed', $3, jsonb_build_object('backgroundJobId', $4::text))`,
        [context.actorUserId, submissionId, task.payload.correlationId, taskId],
      );
    });
  } finally {
    connection.release();
  }
  return { submissionId, task };
}

export async function markKnowledgeTranscriptEnqueueFailure(
  databaseClient: DatabaseClient,
  prepared: PreparedKnowledgeTranscriptTask,
): Promise<void> {
  const connection = await databaseClient.pool.connect();
  try {
    await transaction(connection, async () => {
      await connection.query(
        `update knowledge_transcript_submission
            set status = 'failed', failure_code = 'queue_enqueue_failed',
                failure_summary = 'Transcript extraction could not enter the task queue.',
                completed_at = now(), updated_at = now()
          where id = $1 and background_job_id = $2 and status = 'queued'`,
        [prepared.submissionId, prepared.task.taskId],
      );
      await connection.query(
        `update background_job
            set status = 'failed', error_code = 'queue_enqueue_failed', completed_at = now()
          where id = $1 and status = 'queued'`,
        [prepared.task.taskId],
      );
      await connection.query(
        `insert into audit_event
          (actor_type, actor_user_id, action, object_type, object_id, result,
           request_correlation_id, details)
         select 'user', actor_user_id, 'knowledge.transcript.enqueue',
                'knowledge_transcript_submission', id, 'denied', $2,
                jsonb_build_object('backgroundJobId', background_job_id::text)
           from knowledge_transcript_submission
          where id = $1`,
        [prepared.submissionId, prepared.task.payload.correlationId],
      );
    });
  } finally {
    connection.release();
  }
}

async function loadWorkflowRow(
  connection: DatabaseConnection,
  submissionId: string,
  forUpdate = false,
): Promise<WorkflowRow> {
  const result = await connection.query<WorkflowRow>(
    `select submission.actor_user_id, submission.authorization_context_id,
            submission.byte_count, submission.completed_at,
            context.actor_user_id as context_actor_user_id,
            context.expires_at as context_expires_at, context.context_hash,
            context.student_id as context_student_id, submission.created_at,
            submission.failure_code, submission.failure_summary,
            submission.generated_analysis_markdown,
            submission.generated_analysis_hash, submission.git_commit_sha,
            job.attempts as job_attempts, job.completed_at as job_completed_at,
            job.error_code as job_error_code, job.max_attempts as job_max_attempts,
            job.started_at as job_started_at, job.status as job_status,
            submission.lecture_id, submission.mime_type, submission.model_input_hash,
            submission.model,
            submission.original_content_hash, submission.original_file_name,
            submission.prompt_hash, submission.prompt_tokens, submission.prompt_version,
            submission.provider, submission.published_batch_id,
            submission.redaction_version, app_user.role, submission.schema_hash,
            submission.schema_version, submission.source_key, submission.status,
            submission.storage_key, submission.transcript_text,
            submission.transcript_text_hash, submission.completion_tokens,
            submission.total_tokens, submission.updated_at,
            app_user.active as user_active
       from knowledge_transcript_submission submission
       join background_job job on job.id = submission.background_job_id
       join authorization_context_snapshot context on context.id = submission.authorization_context_id
       join app_user on app_user.id = submission.actor_user_id
      where submission.id = $1${forUpdate ? " for update of submission" : ""}`,
    [submissionId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new KnowledgeTranscriptWorkflowError("not_found", "Transcript submission was not found.");
  }
  return row;
}

function validateTaskRow(task: KnowledgeExtractTask, row: WorkflowRow, now: Date): void {
  if (
    row.actor_user_id !== row.context_actor_user_id ||
    row.context_student_id !== null ||
    row.context_hash !== task.authorization.contextHash ||
    row.authorization_context_id !== task.authorization.contextId ||
    row.transcript_text_hash !== task.payload.transcriptTextHash ||
    row.model_input_hash !== task.payload.modelInputHash ||
    row.prompt_version !== task.payload.promptVersion ||
    row.prompt_hash !== task.payload.promptHash ||
    row.schema_version !== task.payload.schemaVersion ||
    row.schema_hash !== task.payload.schemaHash ||
    row.redaction_version !== task.payload.redactionVersion ||
    row.git_commit_sha !== task.payload.gitCommitSha ||
    row.role === "auditor" ||
    row.role === "service" ||
    !row.user_active ||
    new Date(row.context_expires_at) <= now
  ) {
    throw new KnowledgeTranscriptWorkflowError(
      "authorization_denied",
      "Transcript extraction authorization or frozen task identity is invalid.",
    );
  }
}

function safeFailure(error: unknown): { readonly code: string; readonly summary: string } {
  if (error instanceof KnowledgeTranscriptWorkflowError) {
    return { code: error.code, summary: error.message.slice(0, 1024) };
  }
  if (error instanceof ModelGatewayError) {
    const summaries: Record<ModelGatewayError["detailCode"], string> = {
      content_filtered: "DeepSeek 因内容安全策略未返回提取结果。请检查逐字稿后重新提交。",
      content_invalid_json: "DeepSeek 返回的正文不是有效 JSON，无法生成分析稿。请重新提交。",
      content_missing: "DeepSeek 未返回 JSON 正文。请重新提交。",
      network_error: "Worker 无法连接 DeepSeek 服务，请检查网络后重试。",
      output_truncated:
        "DeepSeek 输出达到 max_tokens 上限，JSON 被中途截断。系统已提高后续任务的输出上限，请重新提交。",
      provider_http_error: "DeepSeek API 返回 HTTP 错误，请稍后重试。",
      provider_resource_interrupted: "DeepSeek 因服务端资源不足中断生成，请稍后重试。",
      request_timeout: "DeepSeek 请求超过本地等待时间，请稍后重试。",
      response_envelope_invalid: "DeepSeek API 响应包缺少必要字段，无法读取提取结果。",
      unexpected_finish_reason: "DeepSeek 以非正常原因停止生成，未产生完整提取结果。",
      usage_inconsistent: "DeepSeek 返回的 Token 用量字段不一致，结果已按安全策略拒绝。",
    };
    return { code: `model_${error.detailCode}`, summary: summaries[error.detailCode] };
  }
  if (error instanceof z.ZodError) {
    const issueDescriptions = [
      ...new Set(
        error.issues
          .map((issue) => {
            const path = issue.path.join(".");
            const reason: Partial<Record<z.core.$ZodIssue["code"], string>> = {
              invalid_type: "类型不符合约定",
              invalid_value: "取值不符合约定",
              too_big: "超过数量或长度限制",
              too_small: "缺少必要内容",
            };
            return path === "" ? "" : `${path}：${reason[issue.code] ?? "格式不符合约定"}`;
          })
          .filter((description) => description !== "")
          .slice(0, 8),
      ),
    ];
    const suffix = issueDescriptions.length === 0 ? "" : `（${issueDescriptions.join("；")}）`;
    return {
      code: "model_output_schema_invalid",
      summary: `DeepSeek 返回结构未通过校验${suffix}，请重新提交。`.slice(0, 1024),
    };
  }
  if (error instanceof Error) {
    return { code: error.name.slice(0, 128), summary: "Transcript extraction failed safely." };
  }
  return { code: "unknown_error", summary: "Transcript extraction failed safely." };
}

function buildSubmissionLogs(row: WorkflowRow): readonly KnowledgeTranscriptLogEntry[] {
  const createdAt = iso(row.created_at);
  const logs: KnowledgeTranscriptLogEntry[] = [
    {
      at: createdAt,
      code: "transcript_saved",
      level: "success",
      message: "逐字稿原文件与规范化正文已保存。",
    },
    {
      at: createdAt,
      code: "task_queued",
      level: "info",
      message: `提取任务已进入队列（${row.provider}/${row.model}，${row.prompt_version}，${row.schema_version}）。`,
    },
  ];
  if (row.job_started_at !== null) {
    logs.push({
      at: iso(row.job_started_at),
      code: "worker_started",
      level: "info",
      message: `Worker 已领取任务；当前累计尝试 ${String(row.job_attempts)}/${String(row.job_max_attempts)} 次。`,
    });
  }
  if (row.status === "processing") {
    logs.push({
      at: iso(row.updated_at),
      code: "model_processing",
      level: "info",
      message: "正在等待 DeepSeek 返回并执行 JSON、字段与证据边界校验。",
    });
  }
  if (row.status === "failed") {
    logs.push({
      at: row.completed_at === null ? iso(row.updated_at) : iso(row.completed_at),
      code: row.failure_code ?? row.job_error_code ?? "extraction_failed",
      level: "error",
      message: row.failure_summary ?? "提取任务失败，但没有可公开的错误详情。",
    });
    if (row.job_attempts > 0 && row.job_attempts < row.job_max_attempts) {
      logs.push({
        at: row.completed_at === null ? iso(row.updated_at) : iso(row.completed_at),
        code: "retry_scheduled",
        level: "info",
        message: `本次尝试未完成，系统将自动重试（已尝试 ${String(row.job_attempts)}/${String(row.job_max_attempts)} 次），无需重新上传。`,
      });
    }
  }
  if (row.status === "draft_ready" || row.status === "published") {
    const tokenText =
      row.prompt_tokens === null || row.completion_tokens === null || row.total_tokens === null
        ? ""
        : ` Token：输入 ${String(row.prompt_tokens)}，输出 ${String(row.completion_tokens)}，合计 ${String(row.total_tokens)}。`;
    logs.push({
      at: row.completed_at === null ? iso(row.updated_at) : iso(row.completed_at),
      code: "draft_ready",
      level: "success",
      message: `DeepSeek 返回内容已通过校验，分析草稿可以人工审核。${tokenText}`,
    });
  }
  if (row.status === "published") {
    logs.push({
      at: iso(row.updated_at),
      code: "published",
      level: "success",
      message: "人工审核稿已发布到正式知识版本。",
    });
  }
  return logs.sort((left, right) => left.at.localeCompare(right.at));
}

export async function executeKnowledgeTranscriptExtraction(
  databaseClient: DatabaseClient,
  task: KnowledgeExtractTask,
  provider: JsonModelProvider,
): Promise<{ readonly status: "draft_ready" | "published"; readonly submissionId: string }> {
  const parsedTask = KnowledgeExtractTaskSchema.parse(task);
  const now = new Date();
  const claimToken = randomUUID();
  let row: WorkflowRow;
  const connection = await databaseClient.pool.connect();
  try {
    row = await transaction(connection, async () => {
      const current = await loadWorkflowRow(connection, parsedTask.payload.submissionId, true);
      validateTaskRow(parsedTask, current, now);
      if (current.status === "published") return current;
      if (current.status === "draft_ready") return current;
      const job = await connection.query<{ attempts: number }>(
        `update background_job
            set status = 'running', attempts = attempts + 1, claim_token = $2,
                lease_expires_at = $3, started_at = coalesce(started_at, $4),
                completed_at = null, error_code = null
          where id = $1 and attempts < max_attempts
            and (status in ('queued', 'failed') or
                 (status = 'running' and lease_expires_at <= $4))
          returning attempts`,
        [parsedTask.taskId, claimToken, new Date(now.getTime() + JOB_LEASE_MS), now],
      );
      if (job.rowCount !== 1) {
        throw new KnowledgeTranscriptWorkflowError(
          "conflict",
          "Transcript extraction exhausted its allowed attempts.",
        );
      }
      await connection.query(
        `update knowledge_transcript_submission
            set status = 'processing', failure_code = null, failure_summary = null,
                completed_at = null, updated_at = $2
          where id = $1`,
        [parsedTask.payload.submissionId, now],
      );
      return current;
    });
  } finally {
    connection.release();
  }
  if (row.status === "published") {
    return { status: "published", submissionId: parsedTask.payload.submissionId };
  }
  if (row.status === "draft_ready") {
    return { status: "draft_ready", submissionId: parsedTask.payload.submissionId };
  }

  try {
    const modelInput = sanitizeKnowledgeTranscriptForModel(row.transcript_text);
    if (knowledgeExtractionSha256(row.transcript_text) !== row.transcript_text_hash) {
      throw new Error("Stored transcript text failed hash verification.");
    }
    if (knowledgeExtractionSha256(modelInput) !== parsedTask.payload.modelInputHash) {
      throw new Error("Stored model input failed hash verification.");
    }
    const result = await provider.generateJson({
      systemPrompt: KNOWLEDGE_EXTRACTION_SYSTEM_PROMPT,
      userPrompt: buildKnowledgeExtractionUserPrompt({
        sourceKey: row.source_key,
        title: row.source_key.slice(11),
        transcriptText: modelInput,
      }),
    });
    if (result.model !== parsedTask.payload.model) {
      throw new Error("Model provider returned an unexpected model identity.");
    }
    const markdown = renderKnowledgeAnalysisMarkdown(row.source_key.slice(11), result.json);
    const analysisHash = knowledgeExtractionSha256(markdown);
    buildKnowledgeSubmission({
      analysis: {
        bytes: Buffer.from(markdown, "utf8"),
        fileName: `${row.source_key}.md`,
      },
    });
    await databaseClient.pool.query(
      `update knowledge_transcript_submission
          set status = 'draft_ready', generated_analysis_markdown = $2,
              generated_analysis_hash = $3, provider_request_id = $4,
              prompt_tokens = $5, completion_tokens = $6, total_tokens = $7,
              updated_at = now(), completed_at = now()
        where id = $1 and status = 'processing'`,
      [
        parsedTask.payload.submissionId,
        markdown,
        analysisHash,
        result.providerRequestId,
        result.usage.promptTokens,
        result.usage.completionTokens,
        result.usage.totalTokens,
      ],
    );
    await databaseClient.pool.query(
      `update background_job
          set status = 'succeeded', claim_token = null, lease_expires_at = null,
              result_reference = jsonb_build_object('submissionId', $2::text, 'status', 'draft_ready'),
              completed_at = now()
        where id = $1 and claim_token = $3`,
      [parsedTask.taskId, parsedTask.payload.submissionId, claimToken],
    );
    await databaseClient.pool.query(
      `insert into audit_event
        (actor_type, actor_user_id, action, object_type, object_id, result,
         request_correlation_id, details)
       values ('service', $1, 'knowledge.transcript.draft_generated',
               'knowledge_transcript_submission', $2, 'allowed', $3,
               jsonb_build_object('backgroundJobId', $4::text))`,
      [
        row.actor_user_id,
        parsedTask.payload.submissionId,
        parsedTask.payload.correlationId,
        task.taskId,
      ],
    );
    return { status: "draft_ready", submissionId: parsedTask.payload.submissionId };
  } catch (error) {
    const failure = safeFailure(error);
    await databaseClient.pool.query(
      `update knowledge_transcript_submission
          set status = 'failed', failure_code = $2, failure_summary = $3,
              updated_at = now(), completed_at = now()
        where id = $1 and status = 'processing'`,
      [parsedTask.payload.submissionId, failure.code, failure.summary],
    );
    await databaseClient.pool.query(
      `update background_job
          set status = 'failed', claim_token = null, lease_expires_at = null,
              error_code = $2, completed_at = now()
        where id = $1 and claim_token = $3`,
      [parsedTask.taskId, failure.code, claimToken],
    );
    throw error;
  }
}

async function requireSubmissionViewer(
  connection: DatabaseConnection,
  principal: SessionPrincipal,
  submissionId: string,
): Promise<WorkflowRow> {
  const row = await loadWorkflowRow(connection, submissionId);
  if (
    !row.user_active ||
    (principal.role !== "admin" && principal.role !== "advisor") ||
    (principal.role !== "admin" && row.actor_user_id !== principal.id)
  ) {
    throw new KnowledgeTranscriptWorkflowError("not_found", "Transcript submission was not found.");
  }
  return row;
}

function submissionView(row: WorkflowRow, submissionId: string): KnowledgeTranscriptSubmissionView {
  const retryPending =
    row.status === "failed" && row.job_attempts > 0 && row.job_attempts < row.job_max_attempts;
  return {
    completedAt: retryPending || row.completed_at === null ? null : iso(row.completed_at),
    createdAt: iso(row.created_at),
    failureCode: row.failure_code,
    failureMessage: row.failure_summary,
    generatedAnalysisMarkdown: row.generated_analysis_markdown,
    logs: buildSubmissionLogs(row),
    originalFileName: row.original_file_name,
    publishedBatchId: row.published_batch_id,
    sourceKey: row.source_key,
    status: retryPending ? "processing" : row.status,
    submissionId,
    updatedAt: iso(row.updated_at),
  };
}

export async function readKnowledgeTranscriptSubmission(
  databaseClient: DatabaseClient,
  principal: SessionPrincipal,
  submissionId: string,
): Promise<KnowledgeTranscriptSubmissionView> {
  const connection = await databaseClient.pool.connect();
  try {
    const row = await requireSubmissionViewer(connection, principal, submissionId);
    return submissionView(row, submissionId);
  } finally {
    connection.release();
  }
}

export async function readLatestKnowledgeTranscriptSubmission(
  databaseClient: DatabaseClient,
  principal: SessionPrincipal,
): Promise<KnowledgeTranscriptSubmissionView | null> {
  if (principal.role !== "admin" && principal.role !== "advisor") return null;
  const connection = await databaseClient.pool.connect();
  try {
    const latest = await connection.query<{ id: string }>(
      `select id
         from knowledge_transcript_submission
        where actor_user_id = $1
        order by created_at desc, id desc
        limit 1`,
      [principal.id],
    );
    const submissionId = latest.rows[0]?.id;
    if (submissionId === undefined) return null;
    const row = await requireSubmissionViewer(connection, principal, submissionId);
    return submissionView(row, submissionId);
  } finally {
    connection.release();
  }
}

export async function listKnowledgeTranscriptSubmissions(
  databaseClient: DatabaseClient,
  principal: SessionPrincipal,
): Promise<readonly KnowledgeTranscriptSubmissionSummary[]> {
  if (principal.role !== "admin" && principal.role !== "advisor") return [];
  const result = await databaseClient.pool.query<{
    completed_at: Date | string | null;
    created_at: Date | string;
    id: string;
    job_attempts: number;
    job_max_attempts: number;
    original_file_name: string;
    source_key: string;
    status: KnowledgeTranscriptSubmissionView["status"];
    updated_at: Date | string;
  }>(
    `select submission.id, submission.completed_at, submission.created_at,
            job.attempts as job_attempts, job.max_attempts as job_max_attempts,
            submission.original_file_name, submission.source_key,
            submission.status, submission.updated_at
       from knowledge_transcript_submission submission
       join background_job job on job.id = submission.background_job_id
      where submission.actor_user_id = $1
      order by submission.created_at desc, submission.id desc`,
    [principal.id],
  );
  return result.rows.map((row) => {
    const retryPending =
      row.status === "failed" && row.job_attempts > 0 && row.job_attempts < row.job_max_attempts;
    return {
      completedAt: retryPending || row.completed_at === null ? null : iso(row.completed_at),
      createdAt: iso(row.created_at),
      originalFileName: row.original_file_name,
      sourceKey: row.source_key,
      status: retryPending ? "processing" : row.status,
      submissionId: row.id,
      updatedAt: iso(row.updated_at),
    };
  });
}

function objectReference(row: WorkflowRow): StoredObjectReference {
  return {
    domain: "knowledge",
    key: row.storage_key,
    sha256: row.original_content_hash,
    size: row.byte_count,
  };
}

export async function publishKnowledgeTranscriptDraft(
  databaseClient: DatabaseClient,
  objectStore: ImmutableObjectStore,
  importer: KnowledgeImporter,
  principal: SessionPrincipal,
  input: { readonly analysisMarkdown: string; readonly submissionId: string },
): Promise<KnowledgeImportResult> {
  const connection = await databaseClient.pool.connect();
  let row: WorkflowRow;
  try {
    row = await transaction(connection, async () => {
      const current = await requireSubmissionViewer(connection, principal, input.submissionId);
      if (current.status !== "draft_ready") {
        throw new KnowledgeTranscriptWorkflowError(
          "conflict",
          "Only a generated draft that has not yet been published can be confirmed.",
        );
      }
      const claimed = await connection.query(
        `update knowledge_transcript_submission
            set status = 'processing', completed_at = null, updated_at = now()
          where id = $1 and status = 'draft_ready'`,
        [input.submissionId],
      );
      if (claimed.rowCount !== 1) {
        throw new KnowledgeTranscriptWorkflowError(
          "conflict",
          "Draft publication is already running.",
        );
      }
      return current;
    });
  } finally {
    connection.release();
  }

  try {
    const transcriptBytes = await objectStore.read(objectReference(row));
    const analysisMarkdown = input.analysisMarkdown.trim();
    if (analysisMarkdown.length === 0 || analysisMarkdown.length > 500_000) {
      throw new KnowledgeTranscriptWorkflowError(
        "invalid_draft",
        "Reviewed analysis Markdown must contain between 1 and 500000 characters.",
      );
    }
    const loaded = buildKnowledgeSubmission({
      analysis: {
        bytes: Buffer.from(analysisMarkdown, "utf8"),
        fileName: `${row.source_key}.md`,
      },
      transcriptDocument: { bytes: transcriptBytes, fileName: row.original_file_name },
    });
    const current = await databaseClient.pool.query<{ corpus_hash: string }>(
      "select corpus_hash from knowledge_import_batch where is_current = true and status = 'published' limit 1",
    );
    const publicationHash = createHash("sha256")
      .update(
        `upsert:${current.rows[0]?.corpus_hash ?? "empty"}:${loaded.manifest.corpus_hash}`,
        "utf8",
      )
      .digest("hex");
    const result = await importer.importLoaded(
      {
        actorUserId: principal.id,
        corpusHash: publicationHash,
        corpusId: "culiu_knowledge_publication_v1",
        expectedLectureCount: 1,
        manifestVersion: loaded.manifest.manifest_version,
        mappingVersion: loaded.manifest.mapping_version,
        publicationMode: "upsert",
      },
      loaded,
    );
    const reviewedHash = knowledgeExtractionSha256(analysisMarkdown);
    await databaseClient.pool.query(
      `update knowledge_transcript_submission
          set status = 'published', reviewed_analysis_markdown = $2,
              reviewed_analysis_hash = $3, published_batch_id = $4,
              updated_at = now(), completed_at = now()
        where id = $1 and status = 'processing'`,
      [input.submissionId, analysisMarkdown, reviewedHash, result.batchId],
    );
    await databaseClient.pool.query(
      `insert into audit_event
        (actor_type, actor_user_id, action, object_type, object_id, result,
         request_correlation_id, details)
       values ('user', $1, 'knowledge.transcript.published',
               'knowledge_transcript_submission', $2, 'allowed', $3,
               jsonb_build_object('batchId', $4::text))`,
      [principal.id, input.submissionId, randomUUID(), result.batchId],
    );
    return result;
  } catch (error) {
    await databaseClient.pool.query(
      `update knowledge_transcript_submission
          set status = 'draft_ready', completed_at = now(), updated_at = now()
        where id = $1 and status = 'processing'`,
      [input.submissionId],
    );
    if (error instanceof KnowledgeImportError) throw error;
    throw error;
  }
}
