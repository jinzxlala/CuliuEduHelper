import { randomUUID } from "node:crypto";

import type { SessionPrincipal } from "@culiu/authorization";
import {
  appUsers,
  courseRuleVersions,
  courseVersions,
  createDatabaseClient,
  parseDatabaseConfig,
  runMigrations,
  type DatabaseClient,
} from "@culiu/database";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CourseRuleDefinition, CourseVersionContent } from "./contracts.js";
import {
  CourseCatalogAuthorizationError,
  CourseCatalogConflictError,
  CourseRuleConfigurationError,
} from "./errors.js";
import { evaluateCourseSelection } from "./evaluator.js";
import {
  createCourse,
  createCourseRule,
  loadApprovedCourseCatalog,
  readCourseCatalogVersions,
  reviseCourseVersion,
  transitionCourseRule,
  transitionCourseVersion,
} from "./service.js";

let maintenanceClient: DatabaseClient | undefined;
let databaseClient: DatabaseClient | undefined;
let temporaryDatabaseName = "";
let admin: SessionPrincipal;
let advisor: SessionPrincipal;

function activeClient(): DatabaseClient {
  if (databaseClient === undefined) throw new Error("Test database is unavailable.");
  return databaseClient;
}

function scheduledContent(title: string, startMinute: number): CourseVersionContent {
  return {
    capabilityTags: ["problem_solving"],
    deliverables: [`${title} synthetic project`],
    deliveryMode: "scheduled",
    difficulty: "foundation",
    durationWeeks: 8,
    notSuitableConditions: [],
    objectives: [`Complete ${title} synthetic objective`],
    projectTypes: ["guided_project"],
    schedule: [{ endMinute: startMinute + 90, startMinute, weekday: 6 }],
    stage: "Synthetic stage",
    subjectTags: ["synthetic_subject"],
    summary: `${title} is synthetic test content and is not a real course offering.`,
    termEndDate: "2026-10-31",
    termStartDate: "2026-09-01",
    title,
    totalInstructionMinutes: 720,
    weeklyLoadMinutes: 180,
  };
}

async function updatedAt(table: "course" | "rule", id: string): Promise<string> {
  const database = activeClient().database;
  const rows =
    table === "course"
      ? await database
          .select({ value: courseVersions.updatedAt })
          .from(courseVersions)
          .where(eq(courseVersions.id, id))
          .limit(1)
      : await database
          .select({ value: courseRuleVersions.updatedAt })
          .from(courseRuleVersions)
          .where(eq(courseRuleVersions.id, id))
          .limit(1);
  const value = rows[0]?.value;
  if (value === undefined) throw new Error("Expected version timestamp.");
  return value.toISOString();
}

async function createApprovedCourse(
  code: string,
  title: string,
  startMinute: number,
): Promise<{ courseId: string; courseVersionId: string }> {
  const created = await createCourse(activeClient().database, admin, {
    code,
    content: scheduledContent(title, startMinute),
  });
  await transitionCourseVersion(activeClient().database, admin, created.courseVersionId, {
    action: "approve",
    expectedUpdatedAt: await updatedAt("course", created.courseVersionId),
  });
  return created;
}

async function createApprovedRule(key: string, definition: CourseRuleDefinition): Promise<string> {
  const created = await createCourseRule(activeClient().database, admin, { definition, key });
  await transitionCourseRule(activeClient().database, admin, created.ruleVersionId, {
    action: "approve",
    expectedUpdatedAt: await updatedAt("rule", created.ruleVersionId),
  });
  return created.ruleVersionId;
}

beforeAll(async () => {
  const base = parseDatabaseConfig();
  temporaryDatabaseName = `culiu_courses_${randomUUID().replaceAll("-", "")}`;
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
    displayName: "Synthetic Catalog Admin",
    email: "catalog-admin@example.invalid",
    id: randomUUID(),
    role: "admin",
  };
  advisor = {
    displayName: "Synthetic Catalog Advisor",
    email: "catalog-advisor@example.invalid",
    id: randomUUID(),
    role: "advisor",
  };
  await databaseClient.database.insert(appUsers).values([
    {
      displayName: admin.displayName,
      email: admin.email,
      id: admin.id,
      role: admin.role,
    },
    {
      displayName: advisor.displayName,
      email: advisor.email,
      id: advisor.id,
      role: advisor.role,
    },
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

describe("versioned course catalog service", () => {
  it("approves a synthetic catalog, compiles all five rule types, and evaluates deterministically", async () => {
    const foundation = await createApprovedCourse("SYN_FOUNDATION", "Synthetic Foundation", 540);
    const advanced = await createApprovedCourse("SYN_ADVANCED", "Synthetic Advanced", 600);
    const alternative = await createApprovedCourse("SYN_ALTERNATIVE", "Synthetic Alternative", 630);

    await createApprovedRule("prerequisite.synthetic-advanced", {
      message: "Complete the synthetic foundation first.",
      requiredCourseId: foundation.courseId,
      ruleType: "prerequisite",
      severity: "hard",
      subjectCourseId: advanced.courseId,
    });
    await createApprovedRule("mutex.synthetic-paths", {
      courseAId: advanced.courseId,
      courseBId: alternative.courseId,
      message: "Choose one synthetic path.",
      ruleType: "mutual_exclusion",
      severity: "hard",
    });
    await createApprovedRule("age.synthetic-advanced", {
      maxAge: 16,
      message: "Synthetic advanced is for ages 10 through 16.",
      minAge: 10,
      ruleType: "age_range",
      severity: "hard",
      subjectCourseId: advanced.courseId,
    });
    await createApprovedRule("time.global", {
      message: "Selected scheduled courses cannot overlap.",
      ruleType: "time_conflict",
      severity: "hard",
    });
    await createApprovedRule("load.global", {
      maxConcurrentCourses: 2,
      maxWeeklyMinutes: 400,
      message: "Keep the synthetic weekly load within the approved limit.",
      ruleType: "load_limit",
      severity: "hard",
    });

    const snapshot = await loadApprovedCourseCatalog(activeClient().database, advisor);
    expect(snapshot.courses).toHaveLength(3);
    expect(snapshot.rules.map((rule) => rule.ruleType).sort()).toEqual([
      "age_range",
      "load_limit",
      "mutual_exclusion",
      "prerequisite",
      "time_conflict",
    ]);
    expect(
      evaluateCourseSelection(snapshot, {
        ageYears: 10,
        completedCourseIds: [foundation.courseId],
        selectedCourseVersionIds: [advanced.courseVersionId],
      }),
    ).toMatchObject({ eligible: true, totalWeeklyLoadMinutes: 180, violations: [] });
    const rejected = evaluateCourseSelection(snapshot, {
      ageYears: 17,
      completedCourseIds: [],
      selectedCourseVersionIds: [advanced.courseVersionId, alternative.courseVersionId],
    });
    expect(rejected.eligible).toBe(false);
    expect(new Set(rejected.violations.map((violation) => violation.ruleType))).toEqual(
      new Set(["age_range", "mutual_exclusion", "prerequisite", "time_conflict"]),
    );
  });

  it("allows read-only advisors but rejects advisor writes and stale or inactive principals", async () => {
    await expect(
      createCourse(activeClient().database, advisor, {
        code: "SYN_FORBIDDEN",
        content: scheduledContent("Forbidden Synthetic Course", 780),
      }),
    ).rejects.toBeInstanceOf(CourseCatalogAuthorizationError);
    await expect(
      readCourseCatalogVersions(activeClient().database, advisor),
    ).rejects.toBeInstanceOf(CourseCatalogAuthorizationError);
    await activeClient()
      .database.update(appUsers)
      .set({ active: false })
      .where(eq(appUsers.id, advisor.id));
    await expect(
      loadApprovedCourseCatalog(activeClient().database, advisor),
    ).rejects.toBeInstanceOf(CourseCatalogAuthorizationError);
    await activeClient()
      .database.update(appUsers)
      .set({ active: true })
      .where(eq(appUsers.id, advisor.id));
  });

  it("creates revisions instead of mutating content and prevents source branching", async () => {
    const source = await createApprovedCourse("SYN_VERSIONED", "Synthetic Version One", 780);
    await expect(
      activeClient().pool.query('update "course_version" set "title" = $1 where "id" = $2', [
        "Illegally Mutated",
        source.courseVersionId,
      ]),
    ).rejects.toThrow(/immutable/u);
    const sourceTimestamp = await updatedAt("course", source.courseVersionId);
    const revision = await reviseCourseVersion(
      activeClient().database,
      admin,
      source.courseVersionId,
      {
        content: scheduledContent("Synthetic Version Two", 780),
        expectedSourceUpdatedAt: sourceTimestamp,
      },
    );
    expect(revision.version).toBe(2);
    const managedVersions = (
      await readCourseCatalogVersions(activeClient().database, admin)
    ).filter((course) => course.code === "SYN_VERSIONED");
    expect(managedVersions).toMatchObject([
      {
        content: { title: "Synthetic Version Two" },
        sourceCourseVersionId: source.courseVersionId,
        status: "draft",
        version: 2,
      },
      {
        content: { title: "Synthetic Version One" },
        sourceCourseVersionId: null,
        status: "approved",
        version: 1,
      },
    ]);
    await expect(
      activeClient().pool.query('delete from "course_version" where "id" = $1', [
        revision.courseVersionId,
      ]),
    ).rejects.toThrow(/cannot be deleted/u);
    await expect(
      activeClient().pool.query(
        'update "course_version" set "status" = \'archived\', "invalidation_reason" = $1, "approved_by_user_id" = $2, "approved_at" = now(), "updated_at" = now() where "id" = $3',
        ["forged approval", admin.id, revision.courseVersionId],
      ),
    ).rejects.toThrow(/cannot gain approval metadata/u);
    await expect(
      reviseCourseVersion(activeClient().database, admin, source.courseVersionId, {
        content: scheduledContent("Synthetic Branch", 780),
        expectedSourceUpdatedAt: sourceTimestamp,
      }),
    ).rejects.toBeInstanceOf(CourseCatalogConflictError);
  });

  it("rejects approval when a rule references a course without an approved version", async () => {
    const draftCourse = await createCourse(activeClient().database, admin, {
      code: "SYN_DRAFT_ONLY",
      content: scheduledContent("Synthetic Draft Only", 900),
    });
    const draftRule = await createCourseRule(activeClient().database, admin, {
      definition: {
        message: "This cannot be active before its course is approved.",
        minAge: 8,
        ruleType: "age_range",
        severity: "hard",
        subjectCourseId: draftCourse.courseId,
      },
      key: "age.synthetic-draft",
    });
    await expect(
      transitionCourseRule(activeClient().database, admin, draftRule.ruleVersionId, {
        action: "approve",
        expectedUpdatedAt: await updatedAt("rule", draftRule.ruleVersionId),
      }),
    ).rejects.toBeInstanceOf(CourseRuleConfigurationError);
    await expect(
      activeClient().pool.query(
        'update "course_rule_version" set "status" = \'approved\', "approved_by_user_id" = $1, "approved_at" = now(), "updated_at" = now() where "id" = $2',
        [admin.id, draftRule.ruleVersionId],
      ),
    ).rejects.toThrow(/without an approved version/u);
  });

  it("rejects overlapping sessions and a prerequisite cycle even through direct SQL", async () => {
    const first = await createApprovedCourse("SYN_CYCLE_A", "Synthetic Cycle A", 960);
    const second = await createApprovedCourse("SYN_CYCLE_B", "Synthetic Cycle B", 1080);
    await createApprovedRule("prerequisite.synthetic-cycle-b", {
      message: "Synthetic B requires A.",
      requiredCourseId: first.courseId,
      ruleType: "prerequisite",
      severity: "hard",
      subjectCourseId: second.courseId,
    });
    const reverse = await createCourseRule(activeClient().database, admin, {
      definition: {
        message: "Synthetic A cannot require B because that creates a cycle.",
        requiredCourseId: second.courseId,
        ruleType: "prerequisite",
        severity: "hard",
        subjectCourseId: first.courseId,
      },
      key: "prerequisite.synthetic-cycle-a",
    });
    await expect(
      activeClient().pool.query(
        'update "course_rule_version" set "status" = \'approved\', "approved_by_user_id" = $1, "approved_at" = now(), "updated_at" = now() where "id" = $2',
        [admin.id, reverse.ruleVersionId],
      ),
    ).rejects.toThrow(/cycle/u);

    const draft = await createCourse(activeClient().database, admin, {
      code: "SYN_OVERLAP",
      content: scheduledContent("Synthetic Overlap", 1200),
    });
    await expect(
      activeClient().pool.query(
        'insert into "course_schedule_session" ("course_version_id", "weekday", "start_minute", "end_minute") values ($1, 6, 1240, 1300)',
        [draft.courseVersionId],
      ),
    ).rejects.toThrow(/overlap/u);
  });
});
