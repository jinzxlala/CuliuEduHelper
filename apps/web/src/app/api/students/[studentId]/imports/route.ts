import { AuthorizationDeniedError, createStudentAuthorizationContext } from "@culiu/authorization";
import { studentFacts, studentImportBatches } from "@culiu/database/runtime";
import {
  MAX_STUDENT_IMPORT_BYTES,
  StudentImportConflictError,
  StudentImportNotFoundError,
  createIncrementalStudentImportBatch,
  decideIncrementalSuggestion,
  prepareIncrementalStudentImportTask,
  readIncrementalSuggestions,
} from "@culiu/student-ingest";
import { enqueueTask } from "@culiu/tasks";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getActiveSessionPrincipal } from "../../../../../lib/auth-session";
import { getDatabaseClient } from "../../../../../lib/database";
import { getStudentObjectStore } from "../../../../../lib/object-store";
import { getTaskQueue } from "../../../../../lib/task-queue";

const PRIVATE_HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
const StudentIdSchema = z.uuid();
const BatchIdSchema = z.uuid();
const GitCommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const DecisionSchema = z
  .object({
    decision: z.enum(["accepted", "rejected"]),
    editedFieldKey: z
      .string()
      .regex(/^[a-z][a-z0-9_.-]{0,127}$/u)
      .optional(),
    editedValue: z.record(z.string().min(1).max(128), z.json()).optional(),
    expectedCreatedAt: z.iso.datetime().transform((value) => new Date(value)),
    suggestionId: z.uuid(),
  })
  .strict();

function errorResponse(error: unknown): NextResponse | null {
  if (error instanceof AuthorizationDeniedError) {
    return NextResponse.json({ error: "not_found" }, { headers: PRIVATE_HEADERS, status: 404 });
  }
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

async function authorizedContext(studentId: string): Promise<{
  context: Awaited<ReturnType<typeof createStudentAuthorizationContext>>;
  database: ReturnType<typeof getDatabaseClient>["database"];
} | null> {
  const principal = await getActiveSessionPrincipal();
  if (principal === null) return null;
  const database = getDatabaseClient().database;
  const context = await createStudentAuthorizationContext(database, principal, {
    accessLevel: "sensitive",
    action: "student:write",
    studentId,
  });
  return { context, database };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ studentId: string }> },
): Promise<NextResponse> {
  const studentId = StudentIdSchema.safeParse((await params).studentId);
  const batchId = BatchIdSchema.safeParse(new URL(request.url).searchParams.get("id"));
  if (!studentId.success || !batchId.success) {
    return NextResponse.json({ error: "not_found" }, { headers: PRIVATE_HEADERS, status: 404 });
  }
  try {
    const authorized = await authorizedContext(studentId.data);
    if (authorized === null) {
      return NextResponse.json(
        { error: "authentication_required" },
        { headers: PRIVATE_HEADERS, status: 401 },
      );
    }
    const batch = await authorized.database
      .select({ status: studentImportBatches.status })
      .from(studentImportBatches)
      .where(
        and(
          eq(studentImportBatches.id, batchId.data),
          eq(studentImportBatches.selectedStudentId, studentId.data),
          eq(studentImportBatches.createdByUserId, authorized.context.actorUserId),
        ),
      )
      .limit(1);
    if (batch[0] === undefined) throw new StudentImportNotFoundError();
    const suggestions = await readIncrementalSuggestions(
      authorized.database,
      authorized.context,
      batchId.data,
    );
    return NextResponse.json(
      { batchId: batchId.data, status: batch[0].status, suggestions },
      { headers: PRIVATE_HEADERS },
    );
  } catch (error) {
    const response = errorResponse(error);
    if (response !== null) return response;
    throw error;
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ studentId: string }> },
): Promise<NextResponse> {
  const studentId = StudentIdSchema.safeParse((await params).studentId);
  if (!studentId.success) {
    return NextResponse.json({ error: "not_found" }, { headers: PRIVATE_HEADERS, status: 404 });
  }
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_STUDENT_IMPORT_BYTES + 256 * 1024) {
    return NextResponse.json(
      { error: "payload_too_large" },
      { headers: PRIVATE_HEADERS, status: 413 },
    );
  }
  const gitCommit = GitCommitShaSchema.safeParse(process.env.CULIU_GIT_COMMIT_SHA);
  if (!gitCommit.success) {
    return NextResponse.json(
      { error: "server_not_configured", message: "服务端缺少有效的提交版本配置。" },
      { headers: PRIVATE_HEADERS, status: 503 },
    );
  }
  try {
    const authorized = await authorizedContext(studentId.data);
    if (authorized === null) {
      return NextResponse.json(
        { error: "authentication_required" },
        { headers: PRIVATE_HEADERS, status: 401 },
      );
    }
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return NextResponse.json(
        { error: "file_required" },
        { headers: PRIVATE_HEADERS, status: 422 },
      );
    }
    const facts = await authorized.database
      .select({ value: studentFacts.value })
      .from(studentFacts)
      .where(
        and(
          eq(studentFacts.studentId, studentId.data),
          eq(studentFacts.confirmationStatus, "confirmed"),
          isNull(studentFacts.validTo),
          inArray(studentFacts.fieldKey, [
            "identity.chinese_name",
            "identity.english_name",
            "identity.alias",
          ]),
        ),
      );
    const aliases = facts.flatMap((fact) =>
      typeof fact.value.text === "string" && fact.value.text.trim().length >= 2
        ? [fact.value.text.trim()]
        : [],
    );
    if (aliases.length === 0) {
      return NextResponse.json(
        { error: "identity_required", message: "请先在学生档案中确认中文名、英文名或别名。" },
        { headers: PRIVATE_HEADERS, status: 422 },
      );
    }
    const batch = await createIncrementalStudentImportBatch(
      authorized.database,
      getStudentObjectStore(),
      authorized.context,
      {
        content: new Uint8Array(await file.arrayBuffer()),
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
      },
      { aliases, ownershipConfirmed: form.get("ownershipConfirmed") === "true" },
    );
    const task = await prepareIncrementalStudentImportTask(
      authorized.database,
      authorized.context,
      batch.id,
      gitCommit.data,
    );
    await enqueueTask(getTaskQueue(), task);
    return NextResponse.json(
      { batchId: batch.id, status: "uploaded" },
      { headers: PRIVATE_HEADERS, status: 202 },
    );
  } catch (error) {
    const response = errorResponse(error);
    if (response !== null) return response;
    throw error;
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ studentId: string }> },
): Promise<NextResponse> {
  const studentId = StudentIdSchema.safeParse((await params).studentId);
  const input = DecisionSchema.safeParse(await request.json().catch(() => null));
  if (!studentId.success || !input.success) {
    return NextResponse.json({ error: "invalid_input" }, { headers: PRIVATE_HEADERS, status: 422 });
  }
  try {
    const authorized = await authorizedContext(studentId.data);
    if (authorized === null) {
      return NextResponse.json(
        { error: "authentication_required" },
        { headers: PRIVATE_HEADERS, status: 401 },
      );
    }
    return NextResponse.json(
      await decideIncrementalSuggestion(authorized.database, authorized.context, input.data),
      { headers: PRIVATE_HEADERS },
    );
  } catch (error) {
    const response = errorResponse(error);
    if (response !== null) return response;
    throw error;
  }
}
