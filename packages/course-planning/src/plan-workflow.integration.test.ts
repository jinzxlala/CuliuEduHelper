import { randomUUID } from "node:crypto";

import {
  createStudentAuthorizationContext,
  type AuthorizationContext,
  type SessionPrincipal,
} from "@culiu/authorization";
import {
  appUsers,
  createDatabaseClient,
  evidenceLocators,
  evidenceObjects,
  factEvidence,
  parseDatabaseConfig,
  planReviewRecords,
  planRuleOverrides,
  planVersions,
  profileClaims,
  profileVersions,
  runMigrations,
  studentAuthorizations,
  studentFacts,
  students,
  type DatabaseClient,
} from "@culiu/database";
import {
  createDeterministicMockProfileProvider,
  executeProfileDraftTask,
  prepareProfileDraftTask,
  readStudentProfiles,
  transitionProfileVersion,
} from "@culiu/student-profiles";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CourseRuleDefinition, CourseVersionContent } from "./contracts.js";
import { PlanWorkflowConflictError } from "./errors.js";
import type { CreateManualPlanInput } from "./plan-contracts.js";
import {
  createCourse,
  createCourseRule,
  reviseCourseRule,
  reviseCourseVersion,
  transitionCourseRule,
  transitionCourseVersion,
} from "./service.js";
import {
  createManualPlanVersion,
  decidePlanRuleOverride,
  exportApprovedManualPlanMarkdown,
  readManualPlanVersion,
  requestPlanRuleOverride,
  transitionManualPlanVersion,
} from "./plan-workflow.js";

let maintenanceClient: DatabaseClient | undefined;
let databaseClient: DatabaseClient | undefined;
let temporaryDatabaseName = "";
let admin: SessionPrincipal;
let advisor: SessionPrincipal;
const CONTEXT_NOW = new Date("2026-08-02T09:00:00.000Z");

function activeClient(): DatabaseClient {
  if (databaseClient === undefined) throw new Error("Test database is unavailable.");
  return databaseClient;
}

function selfPacedContent(title: string): CourseVersionContent {
  return {
    capabilityTags: ["synthetic_reasoning"],
    deliverables: [`${title} synthetic deliverable`],
    deliveryMode: "self_paced",
    difficulty: "foundation",
    durationWeeks: 8,
    notSuitableConditions: [],
    objectives: [`Complete ${title} synthetic objective`],
    projectTypes: ["synthetic_project"],
    schedule: [],
    stage: "Synthetic stage",
    subjectTags: ["synthetic_subject"],
    summary: `${title} is synthetic and is not a real course offering.`,
    title,
    totalInstructionMinutes: 720,
    weeklyLoadMinutes: 120,
  };
}

async function versionUpdatedAt(table: "course" | "profile" | "rule", id: string): Promise<string> {
  if (table === "profile") {
    const rows = await activeClient()
      .database.select({ value: profileVersions.updatedAt })
      .from(profileVersions)
      .where(eq(profileVersions.id, id))
      .limit(1);
    if (rows[0] === undefined) throw new Error("Expected profile timestamp.");
    return rows[0].value.toISOString();
  }
  const target = table === "course" ? "course_version" : "course_rule_version";
  const result = await activeClient().pool.query<{ updated_at: Date }>(
    `select "updated_at" from "${target}" where "id" = $1`,
    [id],
  );
  const value = result.rows[0]?.updated_at;
  if (value === undefined) throw new Error("Expected catalog timestamp.");
  return value.toISOString();
}

async function createApprovedCourse(
  code: string,
  title: string,
): Promise<{ courseId: string; courseVersionId: string }> {
  const created = await createCourse(activeClient().database, admin, {
    code,
    content: selfPacedContent(title),
  });
  await transitionCourseVersion(activeClient().database, admin, created.courseVersionId, {
    action: "approve",
    expectedUpdatedAt: await versionUpdatedAt("course", created.courseVersionId),
  });
  return created;
}

async function createApprovedRule(
  key: string,
  definition: CourseRuleDefinition,
): Promise<{ ruleId: string; ruleVersionId: string }> {
  const created = await createCourseRule(activeClient().database, admin, { definition, key });
  await transitionCourseRule(activeClient().database, admin, created.ruleVersionId, {
    action: "approve",
    expectedUpdatedAt: await versionUpdatedAt("rule", created.ruleVersionId),
  });
  return created;
}

async function createApprovedProfile(): Promise<{
  approveContext: AuthorizationContext;
  claimId: string;
  exportContext: AuthorizationContext;
  planReviewContext: AuthorizationContext;
  planWriteContext: AuthorizationContext;
  profileVersionId: string;
  readContext: AuthorizationContext;
  studentId: string;
}> {
  const database = activeClient().database;
  const studentId = randomUUID();
  const evidenceId = randomUUID();
  const locatorId = randomUUID();
  const factId = randomUUID();
  await database.insert(students).values({
    id: studentId,
    ownerUserId: advisor.id,
    privacyLevel: "sensitive",
    publicCode: `synthetic_plan_${studentId}`,
  });
  await database.insert(studentAuthorizations).values({
    allowedActions: [
      "student:read",
      "student:profile:generate",
      "student:profile:review",
      "student:profile:approve",
      "student:plan:write",
      "student:plan:review",
      "student:plan:approve",
      "student:plan:export",
    ],
    grantedByUserId: advisor.id,
    maxAccessLevel: "sensitive",
    studentId,
    userId: advisor.id,
    validFrom: new Date(Date.now() - 60_000),
  });
  await database.insert(evidenceObjects).values({
    accessLevel: "sensitive",
    byteCount: 32,
    contentHash: "b".repeat(64),
    dataDomain: "student",
    id: evidenceId,
    mimeType: "text/plain",
    originalFileName: "synthetic-plan-evidence.txt",
    storageKey: `student/${studentId}/bb/${"b".repeat(64)}`,
    studentId,
    uploadedByUserId: advisor.id,
  });
  await database.insert(evidenceLocators).values({
    evidenceObjectId: evidenceId,
    id: locatorId,
    locator: { field: "course_feedback" },
    locatorType: "record_field",
  });
  await database.insert(studentFacts).values({
    accessLevel: "sensitive",
    confirmationStatus: "confirmed",
    fieldKey: "course.readiness",
    id: factId,
    sourceType: "evidence",
    studentId,
    value: { text: "Synthetic classroom evidence for planning." },
  });
  await database.insert(factEvidence).values({
    evidenceLocatorId: locatorId,
    relation: "supports",
    studentFactId: factId,
    validationStatus: "valid",
  });

  const generateContext = await createStudentAuthorizationContext(database, advisor, {
    accessLevel: "sensitive",
    action: "student:profile:generate",
    now: CONTEXT_NOW,
    studentId,
  });
  const profileReviewContext = await createStudentAuthorizationContext(database, advisor, {
    accessLevel: "sensitive",
    action: "student:profile:review",
    now: CONTEXT_NOW,
    studentId,
  });
  const profileApproveContext = await createStudentAuthorizationContext(database, advisor, {
    accessLevel: "sensitive",
    action: "student:profile:approve",
    now: CONTEXT_NOW,
    studentId,
  });
  const readContext = await createStudentAuthorizationContext(database, advisor, {
    accessLevel: "sensitive",
    action: "student:read",
    now: CONTEXT_NOW,
    studentId,
  });
  const prepared = await prepareProfileDraftTask(database, generateContext, {
    gitCommitSha: "8".repeat(40),
  });
  await executeProfileDraftTask(database, prepared.task, createDeterministicMockProfileProvider());
  const profiles = await readStudentProfiles(database, readContext);
  const profile = profiles.profiles[0];
  if (profile === undefined) throw new Error("Expected a synthetic profile.");
  await transitionProfileVersion(database, profileReviewContext, profile.id, {
    action: "submit",
    expectedUpdatedAt: profile.updatedAt.toISOString(),
  });
  await transitionProfileVersion(database, profileApproveContext, profile.id, {
    action: "approve",
    expectedUpdatedAt: await versionUpdatedAt("profile", profile.id),
  });
  const claims = await database
    .select({ id: profileClaims.id })
    .from(profileClaims)
    .where(eq(profileClaims.profileVersionId, profile.id))
    .limit(1);
  const claimId = claims[0]?.id;
  if (claimId === undefined) throw new Error("Expected a synthetic profile claim.");
  return {
    approveContext: await createStudentAuthorizationContext(database, advisor, {
      accessLevel: "sensitive",
      action: "student:plan:approve",
      now: CONTEXT_NOW,
      studentId,
    }),
    claimId,
    exportContext: await createStudentAuthorizationContext(database, advisor, {
      accessLevel: "sensitive",
      action: "student:plan:export",
      now: CONTEXT_NOW,
      studentId,
    }),
    planReviewContext: await createStudentAuthorizationContext(database, advisor, {
      accessLevel: "sensitive",
      action: "student:plan:review",
      now: CONTEXT_NOW,
      studentId,
    }),
    planWriteContext: await createStudentAuthorizationContext(database, advisor, {
      accessLevel: "sensitive",
      action: "student:plan:write",
      now: CONTEXT_NOW,
      studentId,
    }),
    profileVersionId: profile.id,
    readContext,
    studentId,
  };
}

function planInput(
  profileVersionId: string,
  claimId: string,
  courses: {
    advanced: { courseVersionId: string };
    alternative: { courseVersionId: string };
    foundation: { courseVersionId: string };
  },
): CreateManualPlanInput {
  return {
    content: {
      classroomProfile: {
        statement: "Synthetic evidence-backed classroom profile.",
        supportingClaimIds: [claimId],
      },
      decisionTimeline: [
        {
          decisionQuestion: "Which neutral route should continue?",
          observableSignals: ["Completes the synthetic deliverable independently"],
          period: { endDate: "2026-10-31", startDate: "2026-10-01" },
        },
      ],
      goal: "Validate a synthetic planning workflow without real student or course data.",
      overlapAndGaps: {
        overlap: ["Both routes observe reasoning and persistence"],
        routeAGaps: ["Needs more prerequisite structure"],
        routeBGaps: ["Needs more open project practice"],
      },
      period: { endDate: "2027-06-30", startDate: "2026-09-01" },
      risks: ["Synthetic outcomes must not be interpreted as business evidence"],
      routeComparison: Array.from({ length: 6 }, (_, index) => ({
        dimension: `Synthetic dimension ${String(index + 1)}`,
        routeA: `Route A observation ${String(index + 1)}`,
        routeB: `Route B observation ${String(index + 1)}`,
      })),
      routes: [
        {
          key: "route_a",
          name: "Route A: synthetic project",
          phases: [
            {
              courseVersionIds: [courses.alternative.courseVersionId],
              label: "Synthetic project phase",
              period: { endDate: "2026-12-31", startDate: "2026-11-01" },
              sequence: 1,
            },
          ],
          summary: "Observe engagement through a synthetic project path.",
          supportingClaimIds: [claimId],
        },
        {
          key: "route_b",
          name: "Route B: synthetic sequence",
          phases: [
            {
              courseVersionIds: [courses.foundation.courseVersionId],
              label: "Synthetic foundation phase",
              period: { endDate: "2026-12-31", startDate: "2026-11-01" },
              sequence: 1,
            },
            {
              courseVersionIds: [courses.advanced.courseVersionId],
              label: "Synthetic advanced phase",
              period: { endDate: "2027-03-31", startDate: "2027-01-01" },
              sequence: 2,
            },
          ],
          summary: "Observe progress through a synthetic prerequisite sequence.",
          supportingClaimIds: [claimId],
        },
      ],
      shortTermItems: [
        {
          courseVersionId: courses.advanced.courseVersionId,
          expectedOutcome: "Produce one synthetic artifact.",
          order: 1,
          period: { endDate: "2026-10-31", startDate: "2026-09-01" },
          reason: "Test an evidence-linked recommendation and its prerequisite override.",
          risks: ["The prerequisite is intentionally unmet in this synthetic fixture"],
          supportingClaimIds: [claimId],
        },
      ],
      title: "Synthetic manual course plan",
    },
    profileVersionId,
    reviewDueDate: "2027-01-31",
    studentInput: {
      ageYears: 15,
      classroomFeedback: [
        {
          statement: "Synthetic classroom feedback linked to the approved profile.",
          supportingClaimIds: [claimId],
        },
      ],
      completedCourseIds: [],
      constraints: ["Synthetic weekly capacity"],
      inProgressCourseVersionIds: [],
      interests: ["Synthetic project work"],
    },
  };
}

beforeAll(async () => {
  const base = parseDatabaseConfig();
  temporaryDatabaseName = `culiu_plans_${randomUUID().replaceAll("-", "")}`;
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
    maxConnections: 8,
  });
  await runMigrations(databaseClient);
  admin = {
    displayName: "Synthetic Planning Admin",
    email: "planning-admin@example.invalid",
    id: randomUUID(),
    role: "admin",
  };
  advisor = {
    displayName: "Synthetic Planning Advisor",
    email: "planning-advisor@example.invalid",
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

describe("manual plan workflow", () => {
  it("requires approved overrides, exports deterministically, protects versions, and invalidates affected plans", async () => {
    const actor = await createApprovedProfile();
    const foundation = await createApprovedCourse(
      "SYN_PLAN_FOUNDATION",
      "Synthetic Plan Foundation",
    );
    const advanced = await createApprovedCourse("SYN_PLAN_ADVANCED", "Synthetic Plan Advanced");
    const alternative = await createApprovedCourse(
      "SYN_PLAN_ALTERNATIVE",
      "Synthetic Plan Alternative",
    );
    const prerequisite = await createApprovedRule("plan.synthetic.prerequisite", {
      message: "Complete the synthetic foundation first.",
      requiredCourseId: foundation.courseId,
      ruleType: "prerequisite",
      severity: "hard",
      subjectCourseId: advanced.courseId,
    });
    await createApprovedRule("plan.synthetic.load", {
      maxConcurrentCourses: 2,
      maxWeeklyMinutes: 300,
      message: "Keep the synthetic plan load within its fixed limit.",
      ruleType: "load_limit",
      severity: "hard",
    });

    const plan = await createManualPlanVersion(
      activeClient().database,
      actor.planWriteContext,
      planInput(actor.profileVersionId, actor.claimId, { advanced, alternative, foundation }),
      { now: new Date("2026-08-02T09:01:00.000Z") },
    );
    expect(plan.status).toBe("draft");
    expect(plan.content.routes).toHaveLength(2);
    expect(plan.content.routeComparison).toHaveLength(6);
    expect(plan.evaluation.hardViolationCount).toBe(1);

    await expect(
      activeClient().pool.query('update "plan_version" set "content" = $1 where "id" = $2', [
        JSON.stringify({ illegal: true }),
        plan.id,
      ]),
    ).rejects.toThrow(/immutable/iu);

    const submitted = await transitionManualPlanVersion(
      activeClient().database,
      actor.planReviewContext,
      plan.id,
      { action: "submit", expectedUpdatedAt: plan.updatedAt.toISOString() },
      { now: new Date("2026-08-02T09:02:00.000Z") },
    );
    expect(submitted.status).toBe("in_review");
    await expect(
      transitionManualPlanVersion(
        activeClient().database,
        actor.approveContext,
        plan.id,
        {
          action: "approve",
          expectedUpdatedAt: await planUpdatedAt(plan.id),
        },
        { now: new Date("2026-08-02T09:03:00.000Z") },
      ),
    ).rejects.toThrow(/approved override/iu);

    const hardViolation = plan.evaluation.scopes
      .flatMap((scope) => scope.result.violations.map((violation) => ({ scope, violation })))
      .find(({ violation }) => violation.severity === "hard");
    if (hardViolation === undefined) throw new Error("Expected a hard violation.");
    const requested = await requestPlanRuleOverride(
      activeClient().database,
      actor.planWriteContext,
      plan.id,
      {
        expectedPlanUpdatedAt: await planUpdatedAt(plan.id),
        reason: "Synthetic equivalent prerequisite evidence was manually reviewed.",
        scopeKey: hardViolation.scope.scopeKey,
        violationKey: hardViolation.violation.violationKey,
      },
      { now: new Date("2026-08-02T09:04:00.000Z") },
    );
    await decidePlanRuleOverride(
      activeClient().database,
      actor.approveContext,
      requested.id,
      { action: "approve", expectedUpdatedAt: requested.updatedAt.toISOString() },
      { now: new Date("2026-08-02T09:05:00.000Z") },
    );
    const approved = await transitionManualPlanVersion(
      activeClient().database,
      actor.approveContext,
      plan.id,
      { action: "approve", expectedUpdatedAt: await planUpdatedAt(plan.id) },
      { now: new Date("2026-08-02T09:06:00.000Z") },
    );
    expect(approved.status).toBe("approved");
    await expect(
      activeClient().pool.query(
        `update "plan_version" set "approved_at" = "approved_at" + interval '1 second' where "id" = $1`,
        [plan.id],
      ),
    ).rejects.toThrow(/approval metadata is immutable/iu);

    const overrideRows = await activeClient()
      .database.select({
        decidedByUserId: planRuleOverrides.decidedByUserId,
        reason: planRuleOverrides.reason,
        status: planRuleOverrides.status,
      })
      .from(planRuleOverrides)
      .where(eq(planRuleOverrides.id, requested.id));
    expect(overrideRows[0]).toMatchObject({
      decidedByUserId: advisor.id,
      reason: "Synthetic equivalent prerequisite evidence was manually reviewed.",
      status: "approved",
    });

    const firstExport = await exportApprovedManualPlanMarkdown(
      activeClient().database,
      actor.exportContext,
      plan.id,
      { now: new Date("2026-08-02T09:07:00.000Z") },
    );
    const secondExport = await exportApprovedManualPlanMarkdown(
      activeClient().database,
      actor.exportContext,
      plan.id,
      { now: new Date("2026-08-02T09:08:00.000Z") },
    );
    expect(secondExport).toBe(firstExport);
    expect(firstExport).toContain("Synthetic manual course plan");
    expect(firstExport).toContain("人工覆盖（Synthetic Planning Advisor）");

    const tamperAttempt = await readManualPlanVersion(
      activeClient().database,
      { ...actor.readContext, studentId: randomUUID() },
      plan.id,
    );
    expect(tamperAttempt.studentId).toBe(actor.studentId);

    const revisedRule = await reviseCourseRule(
      activeClient().database,
      admin,
      prerequisite.ruleVersionId,
      {
        definition: {
          message: "Complete the revised synthetic foundation first.",
          requiredCourseId: foundation.courseId,
          ruleType: "prerequisite",
          severity: "hard",
          subjectCourseId: advanced.courseId,
        },
        expectedSourceUpdatedAt: await versionUpdatedAt("rule", prerequisite.ruleVersionId),
      },
    );
    await transitionCourseRule(activeClient().database, admin, revisedRule.ruleVersionId, {
      action: "approve",
      expectedUpdatedAt: await versionUpdatedAt("rule", revisedRule.ruleVersionId),
    });
    const invalidated = await activeClient()
      .database.select({
        invalidationReason: planVersions.invalidationReason,
        status: planVersions.status,
      })
      .from(planVersions)
      .where(eq(planVersions.id, plan.id));
    expect(invalidated[0]?.status).toBe("needs_review");
    expect(invalidated[0]?.invalidationReason).toContain("course_rule_version_archived:");
    const invalidationReviews = await activeClient()
      .database.select({ action: planReviewRecords.action, actorType: planReviewRecords.actorType })
      .from(planReviewRecords)
      .where(eq(planReviewRecords.planVersionId, plan.id));
    expect(invalidationReviews).toContainEqual({ action: "invalidated", actorType: "service" });
    await expect(
      exportApprovedManualPlanMarkdown(activeClient().database, actor.exportContext, plan.id),
    ).rejects.toBeInstanceOf(PlanWorkflowConflictError);

    const revisionInput = {
      ...planInput(actor.profileVersionId, actor.claimId, { advanced, alternative, foundation }),
      sourcePlanVersionId: plan.id,
    };
    const revisedPlan = await createManualPlanVersion(
      activeClient().database,
      actor.planWriteContext,
      revisionInput,
      { now: new Date("2026-08-02T09:09:00.000Z") },
    );
    await transitionManualPlanVersion(
      activeClient().database,
      actor.planReviewContext,
      revisedPlan.id,
      { action: "submit", expectedUpdatedAt: revisedPlan.updatedAt.toISOString() },
      { now: new Date("2026-08-02T09:10:00.000Z") },
    );
    const revisedHardViolation = revisedPlan.evaluation.scopes
      .flatMap((scope) => scope.result.violations.map((violation) => ({ scope, violation })))
      .find(({ violation }) => violation.severity === "hard");
    if (revisedHardViolation === undefined) throw new Error("Expected a revised hard violation.");
    const revisedOverride = await requestPlanRuleOverride(
      activeClient().database,
      actor.planWriteContext,
      revisedPlan.id,
      {
        expectedPlanUpdatedAt: await planUpdatedAt(revisedPlan.id),
        reason: "Synthetic equivalent prerequisite was reviewed again for the new rule version.",
        scopeKey: revisedHardViolation.scope.scopeKey,
        violationKey: revisedHardViolation.violation.violationKey,
      },
      { now: new Date("2026-08-02T09:11:00.000Z") },
    );
    await decidePlanRuleOverride(
      activeClient().database,
      actor.approveContext,
      revisedOverride.id,
      { action: "approve", expectedUpdatedAt: revisedOverride.updatedAt.toISOString() },
      { now: new Date("2026-08-02T09:12:00.000Z") },
    );
    await transitionManualPlanVersion(
      activeClient().database,
      actor.approveContext,
      revisedPlan.id,
      { action: "approve", expectedUpdatedAt: await planUpdatedAt(revisedPlan.id) },
      { now: new Date("2026-08-02T09:13:00.000Z") },
    );
    const revisedCourse = await reviseCourseVersion(
      activeClient().database,
      admin,
      alternative.courseVersionId,
      {
        content: { ...selfPacedContent("Synthetic Plan Alternative Revised") },
        expectedSourceUpdatedAt: await versionUpdatedAt("course", alternative.courseVersionId),
      },
    );
    await transitionCourseVersion(activeClient().database, admin, revisedCourse.courseVersionId, {
      action: "approve",
      expectedUpdatedAt: await versionUpdatedAt("course", revisedCourse.courseVersionId),
    });
    const courseInvalidated = await activeClient()
      .database.select({
        invalidationReason: planVersions.invalidationReason,
        status: planVersions.status,
      })
      .from(planVersions)
      .where(eq(planVersions.id, revisedPlan.id));
    expect(courseInvalidated[0]?.status).toBe("needs_review");
    expect(courseInvalidated[0]?.invalidationReason).toContain("course_version_archived:");

    const newRuleInput = {
      ...planInput(actor.profileVersionId, actor.claimId, {
        advanced,
        alternative: revisedCourse,
        foundation,
      }),
      sourcePlanVersionId: revisedPlan.id,
    };
    newRuleInput.studentInput.completedCourseIds = [foundation.courseId];
    const routeB = newRuleInput.content.routes[1];
    if (routeB === undefined) throw new Error("Expected route B.");
    newRuleInput.content.routes[1] = {
      ...routeB,
      phases: [
        {
          courseVersionIds: [advanced.courseVersionId],
          label: "Synthetic advanced phase with completed prerequisite",
          period: { endDate: "2027-03-31", startDate: "2027-01-01" },
          sequence: 1,
        },
      ],
    };
    const planBeforeNewRule = await createManualPlanVersion(
      activeClient().database,
      actor.planWriteContext,
      newRuleInput,
      { now: new Date("2026-08-02T09:13:10.000Z") },
    );
    expect(planBeforeNewRule.evaluation.hardViolationCount).toBe(0);
    await transitionManualPlanVersion(
      activeClient().database,
      actor.planReviewContext,
      planBeforeNewRule.id,
      { action: "submit", expectedUpdatedAt: planBeforeNewRule.updatedAt.toISOString() },
      { now: new Date("2026-08-02T09:13:20.000Z") },
    );
    await transitionManualPlanVersion(
      activeClient().database,
      actor.approveContext,
      planBeforeNewRule.id,
      { action: "approve", expectedUpdatedAt: await planUpdatedAt(planBeforeNewRule.id) },
      { now: new Date("2026-08-02T09:13:30.000Z") },
    );
    const newAgeRule = await createCourseRule(activeClient().database, admin, {
      definition: {
        maxAge: 18,
        message: "New synthetic age guidance requires plan review.",
        minAge: 10,
        ruleType: "age_range",
        severity: "warning",
        subjectCourseId: advanced.courseId,
      },
      key: "plan.synthetic.new-age-rule",
    });
    await transitionCourseRule(activeClient().database, admin, newAgeRule.ruleVersionId, {
      action: "approve",
      expectedUpdatedAt: await versionUpdatedAt("rule", newAgeRule.ruleVersionId),
    });
    const newRuleInvalidated = await activeClient()
      .database.select({
        invalidationReason: planVersions.invalidationReason,
        status: planVersions.status,
      })
      .from(planVersions)
      .where(eq(planVersions.id, planBeforeNewRule.id));
    expect(newRuleInvalidated[0]?.status).toBe("needs_review");
    expect(newRuleInvalidated[0]?.invalidationReason).toContain("course_rule_version_approved:");
  });
});

async function planUpdatedAt(planVersionId: string): Promise<string> {
  const rows = await activeClient()
    .database.select({ updatedAt: planVersions.updatedAt })
    .from(planVersions)
    .where(eq(planVersions.id, planVersionId))
    .limit(1);
  const updatedAt = rows[0]?.updatedAt;
  if (updatedAt === undefined) throw new Error("Expected plan timestamp.");
  return updatedAt.toISOString();
}
