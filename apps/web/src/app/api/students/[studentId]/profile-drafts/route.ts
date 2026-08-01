import {
  ProfileDraftConflictError,
  ProfileDraftInputError,
  ProfileDraftNotFoundError,
  prepareProfileDraftTask,
  readStudentProfiles,
} from "@culiu/student-profiles";
import { enqueueTask } from "@culiu/tasks";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getDatabaseClient } from "../../../../../lib/database";
import {
  createRouteStudentContext,
  privateStudentHeaders,
  studentRecordErrorResponse,
} from "../../../../../lib/student-record-http";
import { getTaskQueue } from "../../../../../lib/task-queue";

const GitCommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/u);

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ studentId: string }> },
): Promise<NextResponse> {
  const authorization = await createRouteStudentContext({
    accessLevel: "sensitive",
    action: "student:profile:generate",
    studentId: (await params).studentId,
  });
  if ("response" in authorization) return authorization.response;
  const gitCommitSha = GitCommitShaSchema.safeParse(process.env.CULIU_GIT_COMMIT_SHA);
  if (!gitCommitSha.success) {
    return NextResponse.json(
      { error: "server_not_configured" },
      { headers: privateStudentHeaders, status: 503 },
    );
  }
  try {
    const prepared = await prepareProfileDraftTask(
      getDatabaseClient().database,
      authorization.context,
      { gitCommitSha: gitCommitSha.data },
    );
    await enqueueTask(getTaskQueue(), prepared.task);
    return NextResponse.json(
      { reused: prepared.reused, taskId: prepared.task.taskId },
      { headers: privateStudentHeaders, status: 202 },
    );
  } catch (error) {
    if (error instanceof ProfileDraftInputError) {
      return NextResponse.json(
        { error: "insufficient_confirmed_evidence" },
        { headers: privateStudentHeaders, status: 422 },
      );
    }
    if (error instanceof ProfileDraftConflictError) {
      return NextResponse.json(
        { error: "conflict" },
        { headers: privateStudentHeaders, status: 409 },
      );
    }
    if (error instanceof ProfileDraftNotFoundError) {
      return NextResponse.json(
        { error: "not_found" },
        { headers: privateStudentHeaders, status: 404 },
      );
    }
    const response = studentRecordErrorResponse(error);
    if (response !== null) return response;
    throw error;
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ studentId: string }> },
): Promise<NextResponse> {
  const authorization = await createRouteStudentContext({
    accessLevel: "internal",
    action: "student:read",
    studentId: (await params).studentId,
  });
  if ("response" in authorization) return authorization.response;
  try {
    const profiles = await readStudentProfiles(getDatabaseClient().database, authorization.context);
    return NextResponse.json(profiles, { headers: privateStudentHeaders });
  } catch (error) {
    const response = studentRecordErrorResponse(error);
    if (response !== null) return response;
    throw error;
  }
}
