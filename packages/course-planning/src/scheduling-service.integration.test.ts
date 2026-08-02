import { randomUUID } from "node:crypto";

import { createSchedulingAuthorizationContext, type SessionPrincipal } from "@culiu/authorization";
import {
  appUsers,
  courseVersions,
  createDatabaseClient,
  parseDatabaseConfig,
  runMigrations,
  teacherVersions,
  teachingLocationVersions,
  type DatabaseClient,
} from "@culiu/database";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createCourse, transitionCourseVersion } from "./service.js";
import { SchedulingAuthorizationError, SchedulingConflictError } from "./scheduling-errors.js";
import {
  createCourseOffering,
  createTeacher,
  createTeachingLocation,
  readSchedulingCatalog,
  transitionSchedulingVersion,
} from "./scheduling-service.js";
import {
  approveTimetableRun,
  executeTimetableSolveTask,
  prepareTimetableSolveTask,
  readTimetableRuns,
} from "./timetable-service.js";

let maintenanceClient: DatabaseClient | undefined;
let databaseClient: DatabaseClient | undefined;
let temporaryDatabaseName = "";
let admin: SessionPrincipal;
let advisor: SessionPrincipal;

function activeClient(): DatabaseClient {
  if (databaseClient === undefined) throw new Error("Test database unavailable.");
  return databaseClient;
}

beforeAll(async () => {
  const base = parseDatabaseConfig();
  temporaryDatabaseName = `culiu_schedule_${randomUUID().replaceAll("-", "")}`;
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
  admin = {
    displayName: "Synthetic Admin",
    email: "schedule-admin@example.invalid",
    id: randomUUID(),
    role: "admin",
  };
  advisor = {
    displayName: "Synthetic Advisor",
    email: "schedule-advisor@example.invalid",
    id: randomUUID(),
    role: "advisor",
  };
  await databaseClient.database.insert(appUsers).values([
    { displayName: admin.displayName, email: admin.email, id: admin.id, role: admin.role },
    { displayName: advisor.displayName, email: advisor.email, id: advisor.id, role: advisor.role },
  ]);
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

async function timestamp(kind: "course" | "location" | "teacher", id: string): Promise<string> {
  const table =
    kind === "course"
      ? courseVersions
      : kind === "teacher"
        ? teacherVersions
        : teachingLocationVersions;
  const [row] = await activeClient()
    .database.select({ updatedAt: table.updatedAt })
    .from(table)
    .where(eq(table.id, id))
    .limit(1);
  if (row === undefined) throw new Error("Missing timestamp.");
  return row.updatedAt.toISOString();
}

describe("scheduling catalog", () => {
  it("keeps location fixed, leaves the teacher unassigned, and stores full candidate timetables", async () => {
    const course = await createCourse(activeClient().database, admin, {
      code: "SYN_SCHEDULING",
      content: {
        capabilityTags: ["synthetic_subject"],
        deliverables: ["Synthetic output"],
        deliveryMode: "scheduled",
        difficulty: "foundation",
        durationWeeks: 1,
        notSuitableConditions: [],
        objectives: ["Synthetic objective"],
        projectTypes: [],
        schedule: [{ endMinute: 660, startMinute: 540, weekday: 6 }],
        stage: "Synthetic",
        subjectTags: ["synthetic_subject"],
        summary: "Synthetic course used only by an integration test.",
        termEndDate: "2026-09-06",
        termStartDate: "2026-09-05",
        title: "Synthetic scheduling course",
        totalInstructionMinutes: 240,
        weeklyLoadMinutes: 240,
      },
    });
    await transitionCourseVersion(activeClient().database, admin, course.courseVersionId, {
      action: "approve",
      expectedUpdatedAt: await timestamp("course", course.courseVersionId),
    });
    const teacher = await createTeacher(activeClient().database, admin, {
      code: "SYN_TEACHER",
      content: {
        maxDailyMinutes: 480,
        maxWeeklyMinutes: 1200,
        name: "虚构教师",
        preferredTags: ["synthetic_subject"],
        qualificationTags: ["synthetic_subject"],
        unavailableDates: [],
        weeklyAvailability: [
          { endMinute: 1080, startMinute: 480, weekday: 6 },
          { endMinute: 1080, startMinute: 480, weekday: 7 },
        ],
      },
    });
    await transitionSchedulingVersion(
      activeClient().database,
      admin,
      "teacher",
      teacher.versionId,
      {
        action: "approve",
        expectedUpdatedAt: await timestamp("teacher", teacher.versionId),
      },
    );
    const location = await createTeachingLocation(activeClient().database, admin, {
      code: "SYN_ROOM",
      content: {
        name: "虚构教室",
        unavailableDates: [],
        weeklyAvailability: [
          { endMinute: 1080, startMinute: 480, weekday: 6 },
          { endMinute: 1080, startMinute: 480, weekday: 7 },
        ],
      },
    });
    await transitionSchedulingVersion(
      activeClient().database,
      admin,
      "location",
      location.versionId,
      {
        action: "approve",
        expectedUpdatedAt: await timestamp("location", location.versionId),
      },
    );
    const offering = await createCourseOffering(activeClient().database, admin, {
      code: "SYN_CLASS",
      content: {
        allowedTeacherIds: [teacher.teacherId],
        className: "虚构班级",
        courseVersionId: course.courseVersionId,
        endDate: "2026-09-06",
        locationVersionId: location.versionId,
        requiredQualificationTags: ["synthetic_subject"],
        startDate: "2026-09-05",
        studentRosterText: ["虚构学生甲", "虚构学生乙"],
        candidateSchedules: [
          {
            kind: "short_term",
            label: "上午方案",
            preferenceRank: 1,
            occurrences: [
              { endMinute: 660, sessionDate: "2026-09-05", startMinute: 540 },
              { endMinute: 660, sessionDate: "2026-09-06", startMinute: 540 },
            ],
          },
          {
            kind: "short_term",
            label: "下午方案",
            preferenceRank: 2,
            occurrences: [
              { endMinute: 900, sessionDate: "2026-09-05", startMinute: 780 },
              { endMinute: 900, sessionDate: "2026-09-06", startMinute: 780 },
            ],
          },
        ],
      },
    });
    await transitionSchedulingVersion(
      activeClient().database,
      admin,
      "offering",
      offering.versionId,
      {
        action: "approve",
        expectedUpdatedAt: offering.updatedAt.toISOString(),
      },
    );
    const catalog = await readSchedulingCatalog(activeClient().database, admin);
    expect(catalog.offerings).toHaveLength(1);
    expect(catalog.offerings[0]?.content.locationVersionId).toBe(location.versionId);
    expect(catalog.offerings[0]?.content.candidateSchedules).toHaveLength(2);
    expect(catalog.offerings[0]?.content.studentRosterText).toEqual(["虚构学生甲", "虚构学生乙"]);
    expect(catalog.offerings[0]?.content).not.toHaveProperty("teacherVersionId");
    expect(catalog.offerings[0]?.status).toBe("approved");
    await expect(readSchedulingCatalog(activeClient().database, advisor)).rejects.toBeInstanceOf(
      SchedulingAuthorizationError,
    );
  });

  it("persists a HiGHS result as a reviewable draft and approves it explicitly", async () => {
    const context = await createSchedulingAuthorizationContext(activeClient().database, admin);
    const task = await prepareTimetableSolveTask(activeClient().database, context, "a".repeat(40));
    expect(JSON.stringify(task)).not.toContain("studentRosterText");
    const result = await executeTimetableSolveTask(activeClient().database, task);
    expect(result.status).toBe("solved");
    const runs = await readTimetableRuns(activeClient().database, context);
    expect(runs[0]?.status).toBe("solved");
    await expect(
      approveTimetableRun(activeClient().database, context, result.runId),
    ).resolves.toEqual({
      id: result.runId,
      status: "approved",
    });
  });

  it("rejects a candidate timetable outside fixed location availability", async () => {
    const catalog = await readSchedulingCatalog(activeClient().database, admin);
    await expect(
      createCourseOffering(activeClient().database, admin, {
        code: "SYN_BAD_CLASS",
        content: {
          allowedTeacherIds: [],
          className: "越界班级",
          courseVersionId: catalog.offerings[0]?.content.courseVersionId,
          endDate: "2026-09-06",
          locationVersionId: catalog.locations[0]?.versionId,
          requiredQualificationTags: ["synthetic_subject"],
          startDate: "2026-09-05",
          studentRosterText: [],
          candidateSchedules: [
            {
              kind: "short_term",
              label: "不可用时段",
              preferenceRank: 1,
              occurrences: [{ endMinute: 120, sessionDate: "2026-09-05", startMinute: 60 }],
            },
          ],
        },
      }),
    ).rejects.toBeInstanceOf(SchedulingConflictError);
  });
});
