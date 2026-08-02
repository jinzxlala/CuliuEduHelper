import {
  SchedulingConflictError,
  SchedulingNotFoundError,
  decideCourseRecommendation,
  prepareCourseRecommendationTask,
  readCourseRecommendations,
} from "@culiu/course-planning";
import { AuthorizationDeniedError, createStudentAuthorizationContext } from "@culiu/authorization";
import { enqueueTask } from "@culiu/tasks";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getActiveSessionPrincipal } from "../../../../../lib/auth-session";
import { getDatabaseClient } from "../../../../../lib/database";
import { getTaskQueue } from "../../../../../lib/task-queue";

const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
const StudentIdSchema = z.uuid();
const GitCommitSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const DecisionSchema = z
  .object({ decision: z.enum(["accepted", "rejected"]), recommendationId: z.uuid() })
  .strict();

function errorResponse(error: unknown): NextResponse | null {
  if (error instanceof AuthorizationDeniedError || error instanceof SchedulingNotFoundError) {
    return NextResponse.json({ error: "not_found" }, { headers: HEADERS, status: 404 });
  }
  if (error instanceof SchedulingConflictError) {
    return NextResponse.json(
      { error: "conflict", message: error.message },
      { headers: HEADERS, status: 409 },
    );
  }
  if (error instanceof z.ZodError) {
    return NextResponse.json({ error: "invalid_input" }, { headers: HEADERS, status: 422 });
  }
  return null;
}

async function contextFor(
  studentId: string,
  action: "student:recommendation:generate" | "student:recommendation:review",
): Promise<{
  context: Awaited<ReturnType<typeof createStudentAuthorizationContext>>;
  database: ReturnType<typeof getDatabaseClient>["database"];
} | null> {
  const principal = await getActiveSessionPrincipal();
  if (principal === null) return null;
  const database = getDatabaseClient().database;
  const context = await createStudentAuthorizationContext(database, principal, {
    accessLevel: "sensitive",
    action,
    studentId,
  });
  return { context, database };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ studentId: string }> },
): Promise<NextResponse> {
  const studentId = StudentIdSchema.safeParse((await params).studentId);
  if (!studentId.success)
    return NextResponse.json({ error: "not_found" }, { headers: HEADERS, status: 404 });
  try {
    const authorized = await contextFor(studentId.data, "student:recommendation:review");
    if (authorized === null)
      return NextResponse.json(
        { error: "authentication_required" },
        { headers: HEADERS, status: 401 },
      );
    return NextResponse.json(
      await readCourseRecommendations(authorized.database, authorized.context),
      { headers: HEADERS },
    );
  } catch (error) {
    const response = errorResponse(error);
    if (response !== null) return response;
    throw error;
  }
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ studentId: string }> },
): Promise<NextResponse> {
  const studentId = StudentIdSchema.safeParse((await params).studentId);
  const gitCommit = GitCommitSchema.safeParse(process.env.CULIU_GIT_COMMIT_SHA);
  if (!studentId.success)
    return NextResponse.json({ error: "not_found" }, { headers: HEADERS, status: 404 });
  if (!gitCommit.success)
    return NextResponse.json({ error: "server_not_configured" }, { headers: HEADERS, status: 503 });
  try {
    const authorized = await contextFor(studentId.data, "student:recommendation:generate");
    if (authorized === null)
      return NextResponse.json(
        { error: "authentication_required" },
        { headers: HEADERS, status: 401 },
      );
    const task = await prepareCourseRecommendationTask(
      authorized.database,
      authorized.context,
      gitCommit.data,
    );
    await enqueueTask(getTaskQueue(), task);
    return NextResponse.json(
      { snapshotId: task.payload.snapshotId, taskId: task.taskId },
      { headers: HEADERS, status: 202 },
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
  if (!studentId.success || !input.success)
    return NextResponse.json({ error: "invalid_input" }, { headers: HEADERS, status: 422 });
  try {
    const authorized = await contextFor(studentId.data, "student:recommendation:review");
    if (authorized === null)
      return NextResponse.json(
        { error: "authentication_required" },
        { headers: HEADERS, status: 401 },
      );
    return NextResponse.json(
      await decideCourseRecommendation(
        authorized.database,
        authorized.context,
        input.data.recommendationId,
        input.data.decision,
      ),
      { headers: HEADERS },
    );
  } catch (error) {
    const response = errorResponse(error);
    if (response !== null) return response;
    throw error;
  }
}
