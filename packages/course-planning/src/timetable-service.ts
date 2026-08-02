import { randomUUID } from "node:crypto";

import {
  AuthorizationContextSchema,
  AuthorizationDeniedError,
  assertAuthorizationContext,
  loadAuthorizationContext,
  type AuthorizationContext,
} from "@culiu/authorization";
import {
  backgroundJobs,
  candidateScheduleOccurrences,
  candidateSchedules,
  courseOfferingVersions,
  teacherVersions,
  teachingLocationVersions,
  timetableRuns,
  type Database,
} from "@culiu/database/runtime";
import { TimetableSolveTaskSchema, type TimetableSolveTask } from "@culiu/tasks";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { recommendationHash } from "./recommendation-contracts.js";
import { SchedulingConflictError, SchedulingNotFoundError } from "./scheduling-errors.js";
import { TimetableInputSchema, type TimetableSolveResult } from "./timetable-contracts.js";
import { solveTimetable } from "./timetable-solver.js";

export const TIMETABLE_SOLVER_VERSION = "highs-wasm-1.15.2";
export const TIMETABLE_CONSTRAINT_VERSION = "class-teacher-candidate.v1";
export const TIMETABLE_OBJECTIVE_VERSION = "priority-schedule-teacher-gap-stable.v1";
const GitCommitSchema = z.string().regex(/^[0-9a-f]{40}$/u);

async function requireSchedulingContext(
  database: Database,
  rawContext: AuthorizationContext,
  action: "scheduling:approve" | "scheduling:solve",
): Promise<AuthorizationContext> {
  const parsed = AuthorizationContextSchema.parse(rawContext);
  if (parsed.studentId !== null) throw new AuthorizationDeniedError();
  const context = await loadAuthorizationContext(database, {
    actorUserId: parsed.actorUserId,
    contextHash: parsed.contextHash,
    id: parsed.id,
    now: new Date(),
  });
  assertAuthorizationContext(context, {
    accessLevel: "internal",
    action,
    studentId: null,
  });
  return context;
}

async function buildTimetableSnapshot(
  database: Database,
): Promise<z.infer<typeof TimetableInputSchema>> {
  const teacherRows = await database
    .select()
    .from(teacherVersions)
    .where(eq(teacherVersions.status, "approved"));
  const locationRows = await database
    .select()
    .from(teachingLocationVersions)
    .where(eq(teachingLocationVersions.status, "approved"));
  const offeringRows = await database
    .select()
    .from(courseOfferingVersions)
    .where(eq(courseOfferingVersions.status, "approved"));
  if (teacherRows.length === 0 || locationRows.length === 0 || offeringRows.length === 0) {
    throw new SchedulingConflictError("Approved teachers, locations, and classes are required.");
  }
  const schedules = await database
    .select()
    .from(candidateSchedules)
    .where(
      inArray(
        candidateSchedules.offeringVersionId,
        offeringRows.map((row) => row.id),
      ),
    );
  const occurrences =
    schedules.length === 0
      ? []
      : await database
          .select()
          .from(candidateScheduleOccurrences)
          .where(
            inArray(
              candidateScheduleOccurrences.candidateScheduleId,
              schedules.map((row) => row.id),
            ),
          );
  const teacherVersionByIdentity = new Map(teacherRows.map((row) => [row.teacherId, row.id]));
  return TimetableInputSchema.parse({
    locations: locationRows.map((row) => ({
      id: row.id,
      unavailableDates: row.unavailableDates,
      weeklyAvailability: row.weeklyAvailability,
    })),
    offerings: offeringRows.map((row) => ({
      allowedTeacherIds: row.allowedTeacherIds
        .map((id) => teacherVersionByIdentity.get(id))
        .filter((id): id is string => id !== undefined),
      candidates: schedules
        .filter((schedule) => schedule.offeringVersionId === row.id)
        .map((schedule) => ({
          id: schedule.id,
          label: schedule.label,
          preferenceRank: schedule.preferenceRank,
          occurrences: occurrences
            .filter((item) => item.candidateScheduleId === schedule.id)
            .map((item) => ({
              endMinute: item.endMinute,
              sessionDate: item.sessionDate,
              startMinute: item.startMinute,
            })),
        })),
      className: row.className,
      endDate: row.endDate,
      id: row.id,
      locationId: row.locationVersionId,
      lockedCandidateId: row.lockedCandidateScheduleId,
      lockedTeacherId: row.lockedTeacherVersionId,
      priority: row.priority,
      requiredQualificationTags: row.requiredQualificationTags,
      startDate: row.startDate,
    })),
    teachers: teacherRows.map((row) => ({
      id: row.id,
      maxDailyMinutes: row.maxDailyMinutes,
      maxWeeklyMinutes: row.maxWeeklyMinutes,
      preferredTags: row.preferredTags,
      qualificationTags: row.qualificationTags,
      unavailableDates: row.unavailableDates,
      weeklyAvailability: row.weeklyAvailability,
    })),
    timeLimitSeconds: 30,
  });
}

export async function prepareTimetableSolveTask(
  database: Database,
  rawContext: AuthorizationContext,
  gitCommitSha: string,
): Promise<TimetableSolveTask> {
  const context = await requireSchedulingContext(database, rawContext, "scheduling:solve");
  const gitCommit = GitCommitSchema.parse(gitCommitSha);
  const input = await buildTimetableSnapshot(database);
  const inputHash = recommendationHash({
    constraintVersion: TIMETABLE_CONSTRAINT_VERSION,
    input,
    objectiveVersion: TIMETABLE_OBJECTIVE_VERSION,
    solverVersion: TIMETABLE_SOLVER_VERSION,
  });
  const runId = randomUUID();
  const taskId = randomUUID();
  await database.transaction(async (transaction) => {
    await transaction.insert(backgroundJobs).values({
      authorizationContextId: context.id,
      id: taskId,
      idempotencyKey: `timetable_${inputHash}`,
      maxAttempts: 1,
      status: "queued",
      taskName: "timetable.solve",
    });
    await transaction.insert(timetableRuns).values({
      authorizationContextSnapshotId: context.id,
      backgroundJobId: taskId,
      constraintVersion: TIMETABLE_CONSTRAINT_VERSION,
      createdByUserId: context.actorUserId,
      id: runId,
      inputHash,
      inputSnapshot: input,
      objectiveVersion: TIMETABLE_OBJECTIVE_VERSION,
      solverVersion: TIMETABLE_SOLVER_VERSION,
      status: "draft",
    });
  });
  return TimetableSolveTaskSchema.parse({
    authorization: { contextHash: context.contextHash, contextId: context.id },
    idempotencyKey: `timetable_${inputHash}`,
    payload: {
      constraintVersion: TIMETABLE_CONSTRAINT_VERSION,
      correlationId: randomUUID(),
      gitCommitSha: gitCommit,
      inputHash,
      objectiveVersion: TIMETABLE_OBJECTIVE_VERSION,
      runId,
      solverVersion: TIMETABLE_SOLVER_VERSION,
    },
    taskId,
    taskName: "timetable.solve",
  });
}

export async function executeTimetableSolveTask(
  database: Database,
  rawTask: unknown,
): Promise<{ runId: string; status: TimetableSolveResult["status"] }> {
  const task = TimetableSolveTaskSchema.parse(rawTask);
  const [run] = await database
    .select()
    .from(timetableRuns)
    .where(eq(timetableRuns.id, task.payload.runId))
    .limit(1);
  if (run === undefined || run.inputHash !== task.payload.inputHash)
    throw new SchedulingNotFoundError();
  const context = await loadAuthorizationContext(database, {
    actorUserId: run.createdByUserId,
    contextHash: task.authorization.contextHash,
    id: task.authorization.contextId,
    now: new Date(),
  });
  assertAuthorizationContext(context, {
    accessLevel: "internal",
    action: "scheduling:solve",
    studentId: null,
  });
  const claimToken = randomUUID();
  const startedAt = new Date();
  await database.transaction(async (transaction) => {
    await transaction
      .update(timetableRuns)
      .set({ status: "solving", updatedAt: startedAt })
      .where(and(eq(timetableRuns.id, run.id), eq(timetableRuns.status, "draft")));
    await transaction
      .update(backgroundJobs)
      .set({
        attempts: 1,
        claimToken,
        leaseExpiresAt: new Date(startedAt.getTime() + 300_000),
        startedAt,
        status: "running",
      })
      .where(and(eq(backgroundJobs.id, task.taskId), eq(backgroundJobs.status, "queued")));
  });
  try {
    const output = await solveTimetable(TimetableInputSchema.parse(run.inputSnapshot));
    const outputHash = recommendationHash(output);
    const completedAt = new Date();
    await database.transaction(async (transaction) => {
      await transaction
        .update(timetableRuns)
        .set({
          output: { ...output },
          outputHash,
          runtimeMs: completedAt.getTime() - startedAt.getTime(),
          status: output.status,
          updatedAt: completedAt,
        })
        .where(eq(timetableRuns.id, run.id));
      await transaction
        .update(backgroundJobs)
        .set({
          claimToken: null,
          completedAt,
          leaseExpiresAt: null,
          resultReference: { runId: run.id },
          status: "succeeded",
        })
        .where(and(eq(backgroundJobs.id, task.taskId), eq(backgroundJobs.claimToken, claimToken)));
    });
    return { runId: run.id, status: output.status };
  } catch (error) {
    const completedAt = new Date();
    await database.transaction(async (transaction) => {
      await transaction
        .update(timetableRuns)
        .set({ failureCode: "solver_failed", status: "failed", updatedAt: completedAt })
        .where(eq(timetableRuns.id, run.id));
      await transaction
        .update(backgroundJobs)
        .set({
          claimToken: null,
          completedAt,
          errorCode: "solver_failed",
          leaseExpiresAt: null,
          status: "failed",
        })
        .where(and(eq(backgroundJobs.id, task.taskId), eq(backgroundJobs.claimToken, claimToken)));
    });
    throw error;
  }
}

export async function readTimetableRuns(
  database: Database,
  rawContext: AuthorizationContext,
): Promise<
  Array<{
    createdAt: Date;
    id: string;
    inputHash: string;
    output: Record<string, unknown> | null;
    runtimeMs: number | null;
    status: string;
  }>
> {
  await requireSchedulingContext(database, rawContext, "scheduling:solve");
  return database
    .select({
      createdAt: timetableRuns.createdAt,
      id: timetableRuns.id,
      inputHash: timetableRuns.inputHash,
      output: timetableRuns.output,
      runtimeMs: timetableRuns.runtimeMs,
      status: timetableRuns.status,
    })
    .from(timetableRuns)
    .orderBy(desc(timetableRuns.createdAt));
}

export async function approveTimetableRun(
  database: Database,
  rawContext: AuthorizationContext,
  runId: string,
): Promise<{ id: string; status: string }> {
  const context = await requireSchedulingContext(database, rawContext, "scheduling:approve");
  return database.transaction(async (transaction) => {
    const [run] = await transaction
      .select({ status: timetableRuns.status })
      .from(timetableRuns)
      .where(eq(timetableRuns.id, runId))
      .limit(1);
    if (run === undefined || !["solved", "partially_solved"].includes(run.status))
      throw new SchedulingConflictError("Only a solved draft can be approved.");
    await transaction
      .update(timetableRuns)
      .set({
        archivedReason: "Superseded by a newly approved timetable.",
        status: "archived",
        updatedAt: new Date(),
      })
      .where(eq(timetableRuns.status, "approved"));
    const [updated] = await transaction
      .update(timetableRuns)
      .set({
        approvedAt: new Date(),
        approvedByUserId: context.actorUserId,
        status: "approved",
        updatedAt: new Date(),
      })
      .where(eq(timetableRuns.id, runId))
      .returning({ id: timetableRuns.id, status: timetableRuns.status });
    if (updated === undefined) throw new SchedulingNotFoundError();
    return updated;
  });
}
