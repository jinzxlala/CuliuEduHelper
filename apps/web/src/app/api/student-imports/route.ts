import { createStudentImportAuthorizationContext } from "@culiu/authorization";
import {
  MAX_STUDENT_IMPORT_BYTES,
  StudentImportConflictError,
  StudentImportNotFoundError,
  applyBasicStudentImportCandidate,
  createBasicStudentImportBatch,
  prepareBasicStudentImportTask,
  readStudentImportBatch,
} from "@culiu/student-ingest";
import { enqueueTask } from "@culiu/tasks";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getActiveSessionPrincipal } from "../../../lib/auth-session";
import { getDatabaseClient } from "../../../lib/database";
import { getStudentObjectStore } from "../../../lib/object-store";
import { getTaskQueue } from "../../../lib/task-queue";

const PRIVATE_HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
const BatchIdSchema = z.uuid();
const GitCommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const CandidateDecisionSchema = z
  .object({
    candidateId: z.uuid(),
    decision: z.enum(["create", "rejected"]),
    fields: z.array(
      z
        .object({
          decision: z.enum(["accepted", "rejected"]),
          editedValue: z.string().trim().min(1).max(1000).optional(),
          suggestionId: z.uuid(),
        })
        .strict(),
    ),
  })
  .strict();

async function requireAdmin(): Promise<Awaited<ReturnType<typeof getActiveSessionPrincipal>>> {
  const principal = await getActiveSessionPrincipal();
  return principal?.role === "admin" ? principal : null;
}

function importError(error: unknown): NextResponse | null {
  if (error instanceof StudentImportNotFoundError) {
    return NextResponse.json({ error: "not_found" }, { headers: PRIVATE_HEADERS, status: 404 });
  }
  if (error instanceof StudentImportConflictError) {
    return NextResponse.json(
      { error: "conflict", message: error.message },
      { headers: PRIVATE_HEADERS, status: 409 },
    );
  }
  if (error instanceof z.ZodError) {
    return NextResponse.json(
      { error: "invalid_input", message: "提交内容格式不正确。" },
      { headers: PRIVATE_HEADERS, status: 422 },
    );
  }
  return null;
}

export async function GET(request: Request): Promise<NextResponse> {
  const principal = await requireAdmin();
  if (principal === null) {
    return NextResponse.json({ error: "not_found" }, { headers: PRIVATE_HEADERS, status: 404 });
  }
  const batchId = BatchIdSchema.safeParse(new URL(request.url).searchParams.get("id"));
  if (!batchId.success) {
    return NextResponse.json(
      { error: "invalid_batch_id" },
      { headers: PRIVATE_HEADERS, status: 422 },
    );
  }
  try {
    const database = getDatabaseClient().database;
    const context = await createStudentImportAuthorizationContext(database, principal);
    return NextResponse.json(await readStudentImportBatch(database, context, batchId.data), {
      headers: PRIVATE_HEADERS,
    });
  } catch (error) {
    const response = importError(error);
    if (response !== null) return response;
    throw error;
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const principal = await requireAdmin();
  if (principal === null) {
    return NextResponse.json({ error: "not_found" }, { headers: PRIVATE_HEADERS, status: 404 });
  }
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_STUDENT_IMPORT_BYTES + 256 * 1024) {
    return NextResponse.json(
      { error: "payload_too_large" },
      { headers: PRIVATE_HEADERS, status: 413 },
    );
  }
  const gitCommitSha = GitCommitShaSchema.safeParse(process.env.CULIU_GIT_COMMIT_SHA);
  if (!gitCommitSha.success) {
    return NextResponse.json(
      { error: "server_not_configured", message: "服务端缺少有效的提交版本配置。" },
      { headers: PRIVATE_HEADERS, status: 503 },
    );
  }
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return NextResponse.json(
        { error: "file_required" },
        { headers: PRIVATE_HEADERS, status: 422 },
      );
    }
    const database = getDatabaseClient().database;
    const context = await createStudentImportAuthorizationContext(database, principal);
    const batch = await createBasicStudentImportBatch(database, getStudentObjectStore(), context, {
      content: new Uint8Array(await file.arrayBuffer()),
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
    });
    const task = await prepareBasicStudentImportTask(
      database,
      context,
      batch.id,
      gitCommitSha.data,
    );
    try {
      await enqueueTask(getTaskQueue(), task);
    } catch {
      return NextResponse.json(
        {
          batchId: batch.id,
          error: "queue_unavailable",
          message: "文件已保存，但任务队列暂不可用。",
        },
        { headers: PRIVATE_HEADERS, status: 503 },
      );
    }
    return NextResponse.json(
      { batchId: batch.id, status: "uploaded" },
      { headers: PRIVATE_HEADERS, status: 202 },
    );
  } catch (error) {
    const response = importError(error);
    if (response !== null) return response;
    throw error;
  }
}

export async function PATCH(request: Request): Promise<NextResponse> {
  const principal = await requireAdmin();
  if (principal === null) {
    return NextResponse.json({ error: "not_found" }, { headers: PRIVATE_HEADERS, status: 404 });
  }
  const input = CandidateDecisionSchema.safeParse(await request.json().catch(() => null));
  if (!input.success) {
    return NextResponse.json(
      { error: "invalid_decision" },
      { headers: PRIVATE_HEADERS, status: 422 },
    );
  }
  try {
    const database = getDatabaseClient().database;
    const context = await createStudentImportAuthorizationContext(database, principal);
    const result = await applyBasicStudentImportCandidate(
      database,
      getStudentObjectStore(),
      context,
      input.data,
    );
    return NextResponse.json(result, { headers: PRIVATE_HEADERS });
  } catch (error) {
    const response = importError(error);
    if (response !== null) return response;
    throw error;
  }
}
