import { createKnowledgeImportAuthorizationContext } from "@culiu/authorization";
import {
  buildKnowledgeSubmission,
  KnowledgeImportError,
  KnowledgeSourceError,
  KnowledgeTranscriptWorkflowError,
  MAX_KNOWLEDGE_SUBMISSION_BYTES,
  markKnowledgeTranscriptEnqueueFailure,
  parseTranscriptDocument,
  prepareKnowledgeTranscriptTask,
  publishKnowledgeTranscriptDraft,
  readKnowledgeTranscriptSubmission,
  type SubmittedKnowledgeFile,
} from "@culiu/knowledge-ingest";
import { enqueueTask } from "@culiu/tasks";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getActiveSessionPrincipal } from "../../../../lib/auth-session";
import { getDatabaseClient } from "../../../../lib/database";
import { getKnowledgeImporter, publishKnowledgeSubmission } from "../../../../lib/knowledge-import";
import { getKnowledgeObjectStore } from "../../../../lib/object-store";
import { getTaskQueue } from "../../../../lib/task-queue";

const PRIVATE_HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
const GitCommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const SubmissionIdSchema = z.uuid();
const PublishInputSchema = z
  .object({
    analysisMarkdown: z.string().trim().min(1).max(500_000),
    submissionId: z.uuid(),
  })
  .strict();

async function submittedFile(
  form: FormData,
  name: string,
): Promise<SubmittedKnowledgeFile | undefined> {
  const value = form.get(name);
  if (!(value instanceof File) || value.size === 0) return undefined;
  return { bytes: new Uint8Array(await value.arrayBuffer()), fileName: value.name };
}

function workflowErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof KnowledgeTranscriptWorkflowError) {
    const status =
      error.code === "not_found"
        ? 404
        : error.code === "conflict"
          ? 409
          : error.code === "authorization_denied"
            ? 403
            : 422;
    return NextResponse.json(
      { error: error.code, message: error.message },
      { headers: PRIVATE_HEADERS, status },
    );
  }
  if (error instanceof KnowledgeSourceError || error instanceof KnowledgeImportError) {
    return NextResponse.json(
      { error: error.code, message: error.message },
      { headers: PRIVATE_HEADERS, status: 422 },
    );
  }
  return null;
}

export async function GET(request: Request): Promise<NextResponse> {
  const principal = await getActiveSessionPrincipal();
  if (principal === null) {
    return NextResponse.json(
      { error: "authentication_required" },
      { headers: PRIVATE_HEADERS, status: 401 },
    );
  }
  const submissionId = SubmissionIdSchema.safeParse(new URL(request.url).searchParams.get("id"));
  if (!submissionId.success) {
    return NextResponse.json(
      { error: "invalid_submission_id" },
      { headers: PRIVATE_HEADERS, status: 422 },
    );
  }
  try {
    return NextResponse.json(
      await readKnowledgeTranscriptSubmission(getDatabaseClient(), principal, submissionId.data),
      { headers: PRIVATE_HEADERS },
    );
  } catch (error) {
    const response = workflowErrorResponse(error);
    if (response !== null) return response;
    throw error;
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const principal = await getActiveSessionPrincipal();
  if (principal === null) {
    return NextResponse.json(
      { error: "authentication_required" },
      { headers: PRIVATE_HEADERS, status: 401 },
    );
  }
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_KNOWLEDGE_SUBMISSION_BYTES + 256 * 1024
  ) {
    return NextResponse.json(
      { error: "payload_too_large" },
      { headers: PRIVATE_HEADERS, status: 413 },
    );
  }
  try {
    const form = await request.formData();
    const mode = form.get("mode");
    if (mode === "analysis") {
      if (principal.role !== "admin") {
        return NextResponse.json({ error: "not_found" }, { headers: PRIVATE_HEADERS, status: 404 });
      }
      const analysis = await submittedFile(form, "analysis");
      if (analysis === undefined) {
        return NextResponse.json(
          { error: "analysis_required" },
          { headers: PRIVATE_HEADERS, status: 422 },
        );
      }
      const result = await publishKnowledgeSubmission(
        principal.id,
        buildKnowledgeSubmission({ analysis }),
      );
      return NextResponse.json(result, {
        headers: PRIVATE_HEADERS,
        status: result.status === "published" ? 201 : 200,
      });
    }
    if (mode !== "transcript") {
      return NextResponse.json(
        { error: "invalid_mode" },
        { headers: PRIVATE_HEADERS, status: 422 },
      );
    }
    if (principal.role !== "admin" && principal.role !== "advisor") {
      return NextResponse.json({ error: "not_found" }, { headers: PRIVATE_HEADERS, status: 404 });
    }
    const transcript = await submittedFile(form, "transcript");
    if (transcript === undefined) {
      return NextResponse.json(
        { error: "transcript_required" },
        { headers: PRIVATE_HEADERS, status: 422 },
      );
    }
    const gitCommitSha = GitCommitShaSchema.safeParse(process.env.CULIU_GIT_COMMIT_SHA);
    if (!gitCommitSha.success) {
      return NextResponse.json(
        { error: "server_not_configured", message: "服务端缺少有效的提交版本配置。" },
        { headers: PRIVATE_HEADERS, status: 503 },
      );
    }
    const databaseClient = getDatabaseClient();
    const context = await createKnowledgeImportAuthorizationContext(
      databaseClient.database,
      principal,
    );
    const parsed = await parseTranscriptDocument(transcript);
    const prepared = await prepareKnowledgeTranscriptTask(
      databaseClient,
      getKnowledgeObjectStore(),
      context,
      parsed,
      {
        gitCommitSha: gitCommitSha.data,
        outboundConfirmed: form.get("outboundConfirmed") === "true",
      },
    );
    try {
      await enqueueTask(getTaskQueue(), prepared.task);
    } catch {
      await markKnowledgeTranscriptEnqueueFailure(databaseClient, prepared);
      throw new KnowledgeTranscriptWorkflowError(
        "conflict",
        "任务队列暂时不可用；逐字稿已经安全保存，请稍后重新提交。",
      );
    }
    return NextResponse.json(
      { status: "queued", submissionId: prepared.submissionId },
      { headers: PRIVATE_HEADERS, status: 202 },
    );
  } catch (error) {
    const response = workflowErrorResponse(error);
    if (response !== null) return response;
    throw error;
  }
}

export async function PATCH(request: Request): Promise<NextResponse> {
  const principal = await getActiveSessionPrincipal();
  if (principal === null) {
    return NextResponse.json(
      { error: "authentication_required" },
      { headers: PRIVATE_HEADERS, status: 401 },
    );
  }
  if (principal.role !== "admin" && principal.role !== "advisor") {
    return NextResponse.json({ error: "not_found" }, { headers: PRIVATE_HEADERS, status: 404 });
  }
  const input = PublishInputSchema.safeParse(await request.json().catch(() => null));
  if (!input.success) {
    return NextResponse.json({ error: "invalid_draft" }, { headers: PRIVATE_HEADERS, status: 422 });
  }
  try {
    const result = await publishKnowledgeTranscriptDraft(
      getDatabaseClient(),
      getKnowledgeObjectStore(),
      getKnowledgeImporter(),
      principal,
      input.data,
    );
    return NextResponse.json(result, { headers: PRIVATE_HEADERS, status: 201 });
  } catch (error) {
    const response = workflowErrorResponse(error);
    if (response !== null) return response;
    throw error;
  }
}
