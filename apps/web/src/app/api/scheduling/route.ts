import {
  SchedulingAuthorizationError,
  SchedulingConflictError,
  SchedulingNotFoundError,
  createCourseOffering,
  createTeacher,
  createTeachingLocation,
  approveTimetableRun,
  prepareTimetableSolveTask,
  readSchedulingCatalog,
  readTimetableRuns,
  transitionSchedulingVersion,
} from "@culiu/course-planning";
import { createSchedulingAuthorizationContext } from "@culiu/authorization";
import { enqueueTask } from "@culiu/tasks";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getActiveSessionPrincipal } from "../../../lib/auth-session";
import { getDatabaseClient } from "../../../lib/database";
import { getTaskQueue } from "../../../lib/task-queue";

const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
const ActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create_teacher"), input: z.unknown() }).strict(),
  z.object({ action: z.literal("create_location"), input: z.unknown() }).strict(),
  z.object({ action: z.literal("create_offering"), input: z.unknown() }).strict(),
  z
    .object({
      action: z.literal("transition"),
      input: z.unknown(),
      kind: z.enum(["teacher", "location", "offering"]),
      versionId: z.uuid(),
    })
    .strict(),
  z.object({ action: z.literal("solve_timetable") }).strict(),
  z.object({ action: z.literal("approve_timetable"), runId: z.uuid() }).strict(),
]);

async function adminPrincipal(): Promise<Awaited<ReturnType<typeof getActiveSessionPrincipal>>> {
  const principal = await getActiveSessionPrincipal();
  return principal?.role === "admin" ? principal : null;
}

function schedulingError(error: unknown): NextResponse | null {
  if (error instanceof SchedulingAuthorizationError || error instanceof SchedulingNotFoundError) {
    return NextResponse.json({ error: "not_found" }, { headers: HEADERS, status: 404 });
  }
  if (error instanceof SchedulingConflictError) {
    return NextResponse.json(
      { error: "conflict", message: error.message },
      { headers: HEADERS, status: 409 },
    );
  }
  if (error instanceof z.ZodError) {
    return NextResponse.json(
      { error: "invalid_input", message: "提交内容格式不正确。" },
      { headers: HEADERS, status: 422 },
    );
  }
  return null;
}

export async function GET(): Promise<NextResponse> {
  const principal = await adminPrincipal();
  if (principal === null) {
    return NextResponse.json({ error: "not_found" }, { headers: HEADERS, status: 404 });
  }
  try {
    const database = getDatabaseClient().database;
    const context = await createSchedulingAuthorizationContext(database, principal);
    return NextResponse.json(
      {
        ...(await readSchedulingCatalog(database, principal)),
        timetableRuns: await readTimetableRuns(database, context),
      },
      { headers: HEADERS },
    );
  } catch (error) {
    const response = schedulingError(error);
    if (response !== null) return response;
    throw error;
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const principal = await adminPrincipal();
  if (principal === null) {
    return NextResponse.json({ error: "not_found" }, { headers: HEADERS, status: 404 });
  }
  const parsed = ActionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input" }, { headers: HEADERS, status: 422 });
  }
  try {
    const database = getDatabaseClient().database;
    const result =
      parsed.data.action === "create_teacher"
        ? await createTeacher(database, principal, parsed.data.input)
        : parsed.data.action === "create_location"
          ? await createTeachingLocation(database, principal, parsed.data.input)
          : parsed.data.action === "create_offering"
            ? await createCourseOffering(database, principal, parsed.data.input)
            : parsed.data.action === "transition"
              ? await transitionSchedulingVersion(
                  database,
                  principal,
                  parsed.data.kind,
                  parsed.data.versionId,
                  parsed.data.input,
                )
              : parsed.data.action === "approve_timetable"
                ? await approveTimetableRun(
                    database,
                    await createSchedulingAuthorizationContext(database, principal),
                    parsed.data.runId,
                  )
                : await (async () => {
                    const gitCommit = z
                      .string()
                      .regex(/^[0-9a-f]{40}$/u)
                      .parse(process.env.CULIU_GIT_COMMIT_SHA);
                    const task = await prepareTimetableSolveTask(
                      database,
                      await createSchedulingAuthorizationContext(database, principal),
                      gitCommit,
                    );
                    await enqueueTask(getTaskQueue(), task);
                    return { runId: task.payload.runId, taskId: task.taskId };
                  })();
    return NextResponse.json(result, { headers: HEADERS, status: 201 });
  } catch (error) {
    const response = schedulingError(error);
    if (response !== null) return response;
    throw error;
  }
}
