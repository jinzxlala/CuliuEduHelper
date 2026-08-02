import { randomUUID } from "node:crypto";

import {
  AuthorizationContextSchema,
  AuthorizationDeniedError,
  SessionPrincipalSchema,
  assertAuthorizationContext,
  loadAuthorizationContext,
  type AuthorizationContext,
  type StudentAction,
} from "@culiu/authorization";
import {
  appUsers,
  auditEvents,
  courseRuleVersions,
  courseVersions,
  courses,
  planCourseDependencies,
  planReviewRecords,
  planRuleDependencies,
  planRuleOverrides,
  planVersions,
  profileClaims,
  profileVersions,
  students,
  type Database,
} from "@culiu/database/runtime";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import {
  DecidePlanRuleOverrideInputSchema,
  CreateManualPlanInputSchema,
  FrozenPlanCatalogSchema,
  ManualPlanningWorkspaceSchema,
  PlanEvaluationSnapshotSchema,
  PlanTransitionInputSchema,
  RequestPlanRuleOverrideInputSchema,
  StoredManualPlanSchema,
  type CreateManualPlanInput,
  type DecidePlanRuleOverrideInput,
  type ManualPlanningWorkspace,
  type PlanEvaluationSnapshot,
  type PlanTransitionInput,
  type RequestPlanRuleOverrideInput,
  type StoredManualPlan,
} from "./plan-contracts.js";
import {
  PlanRuleOverrideNotFoundError,
  PlanWorkflowConflictError,
  PlanWorkflowNotFoundError,
} from "./errors.js";
import {
  collectPlanCourseVersionIds,
  evaluateManualPlan,
  hashPlanValue,
  selectRelevantPlanCatalog,
  stablePlanJson,
} from "./plan-evaluator.js";
import { renderManualPlanMarkdown } from "./plan-markdown.js";
import { loadApprovedCourseCatalog } from "./service.js";

const IdentifierSchema = z.uuid();
const overrideRequester = alias(appUsers, "plan_override_requester");
const overrideDecider = alias(appUsers, "plan_override_decider");
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

function asJsonObject(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function sameTimestamp(actual: Date, expected: string): boolean {
  return actual.toISOString() === new Date(expected).toISOString();
}

function isConstraintFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const directCode = "code" in error ? error.code : undefined;
  const cause = "cause" in error ? error.cause : undefined;
  const causeCode =
    typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
  return [directCode, causeCode].some((code) =>
    ["23503", "23505", "23514", "40001", "40P01", "55000", "P0001"].includes(String(code)),
  );
}

async function requirePlanContext(
  database: Database,
  rawContext: AuthorizationContext,
  action: StudentAction,
  now: Date,
): Promise<AuthorizationContext & { studentId: string }> {
  const parsed = AuthorizationContextSchema.parse(rawContext);
  if (parsed.studentId === null) throw new AuthorizationDeniedError();
  const context = await loadAuthorizationContext(database, {
    actorUserId: parsed.actorUserId,
    contextHash: parsed.contextHash,
    id: parsed.id,
    now,
  });
  if (context.studentId === null) throw new AuthorizationDeniedError();
  assertAuthorizationContext(context, {
    accessLevel: "sensitive",
    action,
    now,
    studentId: context.studentId,
  });
  return { ...context, studentId: context.studentId };
}

async function loadPlanningActor(
  database: Database,
  actorUserId: string,
): Promise<z.infer<typeof SessionPrincipalSchema>> {
  const rows = await database
    .select({
      active: appUsers.active,
      displayName: appUsers.displayName,
      email: appUsers.email,
      id: appUsers.id,
      role: appUsers.role,
    })
    .from(appUsers)
    .where(eq(appUsers.id, actorUserId))
    .limit(1);
  const actor = rows[0];
  if (actor === undefined || !actor.active || actor.role === "service") {
    throw new AuthorizationDeniedError();
  }
  return SessionPrincipalSchema.parse({
    displayName: actor.displayName,
    email: actor.email,
    id: actor.id,
    role: actor.role,
  });
}

function collectSupportingClaimIds(input: CreateManualPlanInput): string[] {
  return [
    ...new Set([
      ...input.content.classroomProfile.supportingClaimIds,
      ...input.content.shortTermItems.flatMap((item) => item.supportingClaimIds),
      ...input.content.routes.flatMap((route) => route.supportingClaimIds),
      ...input.studentInput.classroomFeedback.flatMap((feedback) => feedback.supportingClaimIds),
    ]),
  ].sort();
}

function planFromRow(row: typeof planVersions.$inferSelect): StoredManualPlan {
  return StoredManualPlanSchema.parse({
    ...row,
    catalogSnapshot: row.catalogSnapshot,
    content: row.content,
    evaluation: row.evaluation,
    studentInput: row.studentInput,
  });
}

async function auditPlan(
  transaction: Transaction,
  input: {
    action: string;
    actorUserId: string;
    contextId: string;
    details: Record<string, unknown>;
    objectId: string;
    objectType: "plan_rule_override" | "plan_version";
    requestCorrelationId: string;
    studentId: string;
  },
): Promise<void> {
  await transaction.insert(auditEvents).values({
    action: input.action,
    actorType: "user",
    actorUserId: input.actorUserId,
    details: { authorizationContextId: input.contextId, ...input.details },
    objectId: input.objectId,
    objectType: input.objectType,
    requestCorrelationId: input.requestCorrelationId,
    result: "allowed",
    studentId: input.studentId,
  });
}

function courseDependencyKind(
  courseVersionId: string,
  selectedIds: ReadonlySet<string>,
  inProgressIds: ReadonlySet<string>,
): "in_progress" | "rule_reference" | "selected" {
  if (selectedIds.has(courseVersionId)) return "selected";
  if (inProgressIds.has(courseVersionId)) return "in_progress";
  return "rule_reference";
}

export async function createManualPlanVersion(
  database: Database,
  rawContext: AuthorizationContext,
  untrustedInput: CreateManualPlanInput,
  options: { now?: Date; requestCorrelationId?: string } = {},
): Promise<StoredManualPlan> {
  const input = CreateManualPlanInputSchema.parse(untrustedInput);
  const now = options.now ?? new Date();
  const context = await requirePlanContext(database, rawContext, "student:plan:write", now);
  const requestCorrelationId = options.requestCorrelationId ?? randomUUID();
  if (input.reviewDueDate < now.toISOString().slice(0, 10)) {
    throw new PlanWorkflowConflictError("The review date cannot be in the past.");
  }
  const planningActor = await loadPlanningActor(database, context.actorUserId);
  const fullCatalog = await loadApprovedCourseCatalog(database, planningActor);
  const catalogSnapshot = selectRelevantPlanCatalog(fullCatalog, input.content, input.studentInput);
  const evaluation = evaluateManualPlan(catalogSnapshot, input.content, input.studentInput, now);
  const catalogSnapshotHash = hashPlanValue(catalogSnapshot);
  const inputSnapshotHash = hashPlanValue({
    catalogSnapshotHash,
    content: input.content,
    profileVersionId: input.profileVersionId,
    reviewDueDate: input.reviewDueDate,
    studentInput: input.studentInput,
  });
  const supportingClaimIds = collectSupportingClaimIds(input);
  const usedCourseVersionIds = collectPlanCourseVersionIds(input.content, input.studentInput);
  const selectedIds = new Set(
    input.content.shortTermItems
      .map((item) => item.courseVersionId)
      .concat(
        input.content.routes.flatMap((route) =>
          route.phases.flatMap((phase) => phase.courseVersionIds),
        ),
      ),
  );
  const inProgressIds = new Set(input.studentInput.inProgressCourseVersionIds);
  const allCatalogCourseVersionIds = catalogSnapshot.courses.map(
    (course) => course.courseVersionId,
  );
  const ruleVersionIds = catalogSnapshot.rules.map((rule) => rule.ruleVersionId);

  try {
    return await database.transaction(
      async (transaction) => {
        let sourceToArchive:
          | { id: string; status: "draft" | "in_review" | "needs_review" }
          | undefined;
        const studentRows = await transaction
          .select({ id: students.id })
          .from(students)
          .where(and(eq(students.id, context.studentId), eq(students.status, "active")))
          .for("update")
          .limit(1);
        if (studentRows.length === 0) throw new AuthorizationDeniedError();
        const currentCatalogSnapshot = selectRelevantPlanCatalog(
          await loadApprovedCourseCatalog(transaction, planningActor),
          input.content,
          input.studentInput,
        );
        if (hashPlanValue(currentCatalogSnapshot) !== catalogSnapshotHash) {
          throw new PlanWorkflowConflictError(
            "The course catalog changed while creating the plan.",
          );
        }
        const profileRows = await transaction
          .select({ id: profileVersions.id })
          .from(profileVersions)
          .where(
            and(
              eq(profileVersions.id, input.profileVersionId),
              eq(profileVersions.studentId, context.studentId),
              eq(profileVersions.status, "approved"),
            ),
          )
          .limit(1);
        if (profileRows.length === 0) {
          throw new PlanWorkflowConflictError(
            "Planning requires the student's current approved profile.",
          );
        }
        const claimRows = await transaction
          .select({ id: profileClaims.id, informationNature: profileClaims.informationNature })
          .from(profileClaims)
          .where(
            and(
              eq(profileClaims.profileVersionId, input.profileVersionId),
              inArray(profileClaims.id, supportingClaimIds),
            ),
          );
        if (
          claimRows.length !== supportingClaimIds.length ||
          claimRows.some((claim) => claim.informationNature === "missing")
        ) {
          throw new PlanWorkflowConflictError(
            "Every planning reason must cite a non-missing claim from the approved profile.",
          );
        }
        if (allCatalogCourseVersionIds.length > 0) {
          const currentCourses = await transaction
            .select({ id: courseVersions.id })
            .from(courseVersions)
            .where(
              and(
                inArray(courseVersions.id, allCatalogCourseVersionIds),
                eq(courseVersions.status, "approved"),
              ),
            );
          if (currentCourses.length !== allCatalogCourseVersionIds.length) {
            throw new PlanWorkflowConflictError(
              "The course catalog changed while creating the plan.",
            );
          }
        }
        if (ruleVersionIds.length > 0) {
          const currentRules = await transaction
            .select({ id: courseRuleVersions.id })
            .from(courseRuleVersions)
            .where(
              and(
                inArray(courseRuleVersions.id, ruleVersionIds),
                eq(courseRuleVersions.status, "approved"),
              ),
            );
          if (currentRules.length !== ruleVersionIds.length) {
            throw new PlanWorkflowConflictError(
              "The course rules changed while creating the plan.",
            );
          }
        }

        if (input.sourcePlanVersionId !== undefined) {
          const sources = await transaction
            .select({ status: planVersions.status, version: planVersions.version })
            .from(planVersions)
            .where(
              and(
                eq(planVersions.id, input.sourcePlanVersionId),
                eq(planVersions.studentId, context.studentId),
              ),
            )
            .for("update")
            .limit(1);
          const source = sources[0];
          if (source === undefined) throw new PlanWorkflowNotFoundError();
          if (source.status === "archived") {
            throw new PlanWorkflowConflictError("An archived plan cannot be revised.");
          }
          const latest = await transaction
            .select({ version: planVersions.version })
            .from(planVersions)
            .where(eq(planVersions.studentId, context.studentId))
            .orderBy(sql`${planVersions.version} desc`)
            .limit(1);
          if (latest[0]?.version !== source.version) {
            throw new PlanWorkflowConflictError("Only the latest plan version can be revised.");
          }
          if (source.status !== "approved") {
            sourceToArchive = { id: input.sourcePlanVersionId, status: source.status };
          }
        }

        const latest = await transaction
          .select({ version: planVersions.version })
          .from(planVersions)
          .where(eq(planVersions.studentId, context.studentId))
          .orderBy(sql`${planVersions.version} desc`)
          .limit(1);
        const version = (latest[0]?.version ?? 0) + 1;
        const planVersionId = randomUUID();
        await transaction.insert(planVersions).values({
          catalogSnapshot: asJsonObject(catalogSnapshot),
          catalogSnapshotHash,
          content: asJsonObject(input.content),
          createdAt: now,
          createdByUserId: context.actorUserId,
          evaluation: asJsonObject(evaluation),
          id: planVersionId,
          inputSnapshotHash,
          profileVersionId: input.profileVersionId,
          reviewDueDate: input.reviewDueDate,
          sourcePlanVersionId: input.sourcePlanVersionId,
          studentId: context.studentId,
          studentInput: asJsonObject(input.studentInput),
          updatedAt: now,
          version,
        });
        if (allCatalogCourseVersionIds.length > 0) {
          await transaction.insert(planCourseDependencies).values(
            allCatalogCourseVersionIds.map((courseVersionId) => ({
              courseVersionId,
              createdAt: now,
              dependencyKind: courseDependencyKind(courseVersionId, selectedIds, inProgressIds),
              planVersionId,
            })),
          );
        }
        if (ruleVersionIds.length > 0) {
          await transaction.insert(planRuleDependencies).values(
            ruleVersionIds.map((ruleVersionId) => ({
              createdAt: now,
              planVersionId,
              ruleVersionId,
            })),
          );
        }
        if (sourceToArchive !== undefined) {
          const reason = `superseded_by_plan_revision:${planVersionId}`;
          await transaction
            .update(planVersions)
            .set({ invalidationReason: reason, status: "archived", updatedAt: now })
            .where(eq(planVersions.id, sourceToArchive.id));
          await transaction.insert(planReviewRecords).values({
            action: "archived",
            actorType: "user",
            actorUserId: context.actorUserId,
            createdAt: now,
            fromStatus: sourceToArchive.status,
            planVersionId: sourceToArchive.id,
            reason,
            requestCorrelationId,
            toStatus: "archived",
          });
        }
        await transaction.insert(planReviewRecords).values({
          action: "created",
          actorType: "user",
          actorUserId: context.actorUserId,
          createdAt: now,
          planVersionId,
          requestCorrelationId,
          toStatus: "draft",
        });
        await auditPlan(transaction, {
          action: "student.plan.create",
          actorUserId: context.actorUserId,
          contextId: context.id,
          details: {
            hardViolationCount: evaluation.hardViolationCount,
            profileVersionId: input.profileVersionId,
            ruleVersionCount: ruleVersionIds.length,
            usedCourseVersionCount: usedCourseVersionIds.length,
            version,
            warningCount: evaluation.warningCount,
          },
          objectId: planVersionId,
          objectType: "plan_version",
          requestCorrelationId,
          studentId: context.studentId,
        });
        const created = await transaction
          .select()
          .from(planVersions)
          .where(eq(planVersions.id, planVersionId))
          .limit(1);
        const row = created[0];
        if (row === undefined) throw new PlanWorkflowNotFoundError();
        return planFromRow(row);
      },
      { isolationLevel: "serializable" },
    );
  } catch (error) {
    if (
      error instanceof AuthorizationDeniedError ||
      error instanceof PlanWorkflowConflictError ||
      error instanceof PlanWorkflowNotFoundError
    ) {
      throw error;
    }
    if (isConstraintFailure(error)) {
      throw new PlanWorkflowConflictError("The plan changed or its frozen inputs are stale.");
    }
    throw error;
  }
}

export async function readManualPlanVersion(
  database: Database,
  rawContext: AuthorizationContext,
  untrustedPlanVersionId: string,
  options: { now?: Date; requestCorrelationId?: string } = {},
): Promise<StoredManualPlan> {
  const planVersionId = IdentifierSchema.parse(untrustedPlanVersionId);
  const now = options.now ?? new Date();
  const context = await requirePlanContext(database, rawContext, "student:read", now);
  const rows = await database
    .select()
    .from(planVersions)
    .where(and(eq(planVersions.id, planVersionId), eq(planVersions.studentId, context.studentId)))
    .limit(1);
  const row = rows[0];
  if (row === undefined) throw new PlanWorkflowNotFoundError();
  await database.insert(auditEvents).values({
    action: "student.plan.view",
    actorType: "user",
    actorUserId: context.actorUserId,
    details: { authorizationContextId: context.id },
    objectId: planVersionId,
    objectType: "plan_version",
    requestCorrelationId: options.requestCorrelationId ?? randomUUID(),
    result: "allowed",
    studentId: context.studentId,
  });
  return planFromRow(row);
}

export async function readManualPlanningWorkspace(
  database: Database,
  rawContext: AuthorizationContext,
  options: { now?: Date; requestCorrelationId?: string } = {},
): Promise<ManualPlanningWorkspace> {
  const now = options.now ?? new Date();
  const context = await requirePlanContext(database, rawContext, "student:read", now);
  const planningActor = await loadPlanningActor(database, context.actorUserId);
  const [catalog, profileRows, planRows] = await Promise.all([
    loadApprovedCourseCatalog(database, planningActor),
    database
      .select({
        id: profileVersions.id,
        updatedAt: profileVersions.updatedAt,
        version: profileVersions.version,
      })
      .from(profileVersions)
      .where(
        and(
          eq(profileVersions.studentId, context.studentId),
          eq(profileVersions.status, "approved"),
        ),
      )
      .orderBy(desc(profileVersions.version))
      .limit(1),
    database
      .select()
      .from(planVersions)
      .where(eq(planVersions.studentId, context.studentId))
      .orderBy(desc(planVersions.version)),
  ]);
  const profile = profileRows[0];
  const claims =
    profile === undefined
      ? []
      : await database
          .select({
            category: profileClaims.category,
            confidence: profileClaims.confidence,
            id: profileClaims.id,
            informationNature: profileClaims.informationNature,
            statement: profileClaims.statement,
          })
          .from(profileClaims)
          .where(eq(profileClaims.profileVersionId, profile.id))
          .orderBy(asc(profileClaims.createdAt));
  const planIds = planRows.map((row) => row.id);
  const [reviewRows, overrideRows] =
    planIds.length === 0
      ? [[], []]
      : await Promise.all([
          database
            .select({
              action: planReviewRecords.action,
              actorDisplayName: appUsers.displayName,
              actorType: planReviewRecords.actorType,
              createdAt: planReviewRecords.createdAt,
              fromStatus: planReviewRecords.fromStatus,
              id: planReviewRecords.id,
              planVersionId: planReviewRecords.planVersionId,
              reason: planReviewRecords.reason,
              toStatus: planReviewRecords.toStatus,
            })
            .from(planReviewRecords)
            .leftJoin(appUsers, eq(appUsers.id, planReviewRecords.actorUserId))
            .where(inArray(planReviewRecords.planVersionId, planIds))
            .orderBy(asc(planReviewRecords.createdAt)),
          database
            .select({
              createdAt: planRuleOverrides.createdAt,
              decidedAt: planRuleOverrides.decidedAt,
              decidedByDisplayName: overrideDecider.displayName,
              decisionReason: planRuleOverrides.decisionReason,
              id: planRuleOverrides.id,
              planVersionId: planRuleOverrides.planVersionId,
              reason: planRuleOverrides.reason,
              requestedByDisplayName: overrideRequester.displayName,
              scopeKey: planRuleOverrides.scopeKey,
              status: planRuleOverrides.status,
              updatedAt: planRuleOverrides.updatedAt,
              violationKey: planRuleOverrides.violationKey,
            })
            .from(planRuleOverrides)
            .innerJoin(
              overrideRequester,
              eq(overrideRequester.id, planRuleOverrides.requestedByUserId),
            )
            .leftJoin(overrideDecider, eq(overrideDecider.id, planRuleOverrides.decidedByUserId))
            .where(inArray(planRuleOverrides.planVersionId, planIds))
            .orderBy(asc(planRuleOverrides.createdAt)),
        ]);
  const reviewsByPlan = new Map<string, Omit<(typeof reviewRows)[number], "planVersionId">[]>();
  for (const { planVersionId, ...review } of reviewRows) {
    const current = reviewsByPlan.get(planVersionId) ?? [];
    current.push(review);
    reviewsByPlan.set(planVersionId, current);
  }
  const overridesByPlan = new Map<string, Omit<(typeof overrideRows)[number], "planVersionId">[]>();
  for (const { planVersionId, ...override } of overrideRows) {
    const current = overridesByPlan.get(planVersionId) ?? [];
    current.push(override);
    overridesByPlan.set(planVersionId, current);
  }
  const workspace = ManualPlanningWorkspaceSchema.parse({
    approvedProfile:
      profile === undefined
        ? null
        : { claims, id: profile.id, updatedAt: profile.updatedAt, version: profile.version },
    catalog,
    plans: planRows.map((row) => ({
      ...planFromRow(row),
      overrides: overridesByPlan.get(row.id) ?? [],
      reviews: reviewsByPlan.get(row.id) ?? [],
    })),
    studentId: context.studentId,
  });
  await database.insert(auditEvents).values({
    action: "student.plan.workspace.view",
    actorType: "user",
    actorUserId: context.actorUserId,
    details: {
      authorizationContextId: context.id,
      planCount: workspace.plans.length,
      profileVersionId: workspace.approvedProfile?.id ?? null,
    },
    objectId: context.studentId,
    objectType: "student",
    requestCorrelationId: options.requestCorrelationId ?? randomUUID(),
    result: "allowed",
    studentId: context.studentId,
  });
  return workspace;
}

function findHardViolation(
  evaluation: PlanEvaluationSnapshot,
  scopeKey: string,
  violationKey: string,
): { ruleVersionId: string } | undefined {
  const scope = evaluation.scopes.find((item) => item.scopeKey === scopeKey);
  return scope?.result.violations.find(
    (violation) => violation.violationKey === violationKey && violation.severity === "hard",
  );
}

export async function requestPlanRuleOverride(
  database: Database,
  rawContext: AuthorizationContext,
  untrustedPlanVersionId: string,
  untrustedInput: RequestPlanRuleOverrideInput,
  options: { now?: Date; requestCorrelationId?: string } = {},
): Promise<{ id: string; status: "pending"; updatedAt: Date }> {
  const planVersionId = IdentifierSchema.parse(untrustedPlanVersionId);
  const input = RequestPlanRuleOverrideInputSchema.parse(untrustedInput);
  const now = options.now ?? new Date();
  const context = await requirePlanContext(database, rawContext, "student:plan:write", now);
  const requestCorrelationId = options.requestCorrelationId ?? randomUUID();
  try {
    return await database.transaction(
      async (transaction) => {
        const rows = await transaction
          .select({
            evaluation: planVersions.evaluation,
            status: planVersions.status,
            updatedAt: planVersions.updatedAt,
          })
          .from(planVersions)
          .where(
            and(eq(planVersions.id, planVersionId), eq(planVersions.studentId, context.studentId)),
          )
          .for("update")
          .limit(1);
        const plan = rows[0];
        if (plan === undefined) throw new PlanWorkflowNotFoundError();
        if (!sameTimestamp(plan.updatedAt, input.expectedPlanUpdatedAt)) {
          throw new PlanWorkflowConflictError("The plan changed before the override request.");
        }
        if (plan.status !== "draft" && plan.status !== "in_review") {
          throw new PlanWorkflowConflictError(
            "Overrides can only be requested for an active draft.",
          );
        }
        const evaluation = PlanEvaluationSnapshotSchema.parse(plan.evaluation);
        const violation = findHardViolation(evaluation, input.scopeKey, input.violationKey);
        if (violation === undefined) {
          throw new PlanWorkflowConflictError(
            "The override must reference a current hard violation.",
          );
        }
        const id = randomUUID();
        await transaction.insert(planRuleOverrides).values({
          createdAt: now,
          id,
          planVersionId,
          reason: input.reason,
          requestedByUserId: context.actorUserId,
          ruleVersionId: violation.ruleVersionId,
          scopeKey: input.scopeKey,
          updatedAt: now,
          violationKey: input.violationKey,
        });
        await auditPlan(transaction, {
          action: "student.plan.rule_override.request",
          actorUserId: context.actorUserId,
          contextId: context.id,
          details: { reasonLength: input.reason.length, scopeKey: input.scopeKey },
          objectId: id,
          objectType: "plan_rule_override",
          requestCorrelationId,
          studentId: context.studentId,
        });
        return { id, status: "pending" as const, updatedAt: now };
      },
      { isolationLevel: "serializable" },
    );
  } catch (error) {
    if (
      error instanceof AuthorizationDeniedError ||
      error instanceof PlanWorkflowConflictError ||
      error instanceof PlanWorkflowNotFoundError
    ) {
      throw error;
    }
    if (isConstraintFailure(error)) {
      throw new PlanWorkflowConflictError("An active override already exists for this violation.");
    }
    throw error;
  }
}

export async function decidePlanRuleOverride(
  database: Database,
  rawContext: AuthorizationContext,
  untrustedOverrideId: string,
  untrustedInput: DecidePlanRuleOverrideInput,
  options: { now?: Date; requestCorrelationId?: string } = {},
): Promise<{ id: string; status: "approved" | "rejected" }> {
  const overrideId = IdentifierSchema.parse(untrustedOverrideId);
  const input = DecidePlanRuleOverrideInputSchema.parse(untrustedInput);
  const now = options.now ?? new Date();
  const context = await requirePlanContext(database, rawContext, "student:plan:approve", now);
  const requestCorrelationId = options.requestCorrelationId ?? randomUUID();
  try {
    return await database.transaction(async (transaction) => {
      const rows = await transaction
        .select({
          override: planRuleOverrides,
          planStatus: planVersions.status,
          studentId: planVersions.studentId,
        })
        .from(planRuleOverrides)
        .innerJoin(planVersions, eq(planVersions.id, planRuleOverrides.planVersionId))
        .where(eq(planRuleOverrides.id, overrideId))
        .for("update")
        .limit(1);
      const row = rows[0];
      if (row === undefined || row.studentId !== context.studentId) {
        throw new PlanRuleOverrideNotFoundError();
      }
      if (!sameTimestamp(row.override.updatedAt, input.expectedUpdatedAt)) {
        throw new PlanWorkflowConflictError("The rule override changed before the decision.");
      }
      if (row.override.status !== "pending") {
        throw new PlanWorkflowConflictError("The rule override has already been decided.");
      }
      if (row.planStatus !== "draft" && row.planStatus !== "in_review") {
        throw new PlanWorkflowConflictError("The plan is no longer open for override decisions.");
      }
      const status = input.action === "approve" ? ("approved" as const) : ("rejected" as const);
      await transaction
        .update(planRuleOverrides)
        .set({
          decidedAt: now,
          decidedByUserId: context.actorUserId,
          decisionReason: input.action === "reject" ? input.reason : null,
          status,
          updatedAt: now,
        })
        .where(eq(planRuleOverrides.id, overrideId));
      await auditPlan(transaction, {
        action: `student.plan.rule_override.${input.action}`,
        actorUserId: context.actorUserId,
        contextId: context.id,
        details: {
          decisionReasonLength: input.action === "reject" ? input.reason.length : 0,
          planVersionId: row.override.planVersionId,
        },
        objectId: overrideId,
        objectType: "plan_rule_override",
        requestCorrelationId,
        studentId: context.studentId,
      });
      return { id: overrideId, status };
    });
  } catch (error) {
    if (
      error instanceof AuthorizationDeniedError ||
      error instanceof PlanRuleOverrideNotFoundError ||
      error instanceof PlanWorkflowConflictError
    ) {
      throw error;
    }
    if (isConstraintFailure(error)) {
      throw new PlanWorkflowConflictError("The rule override decision was rejected.");
    }
    throw error;
  }
}

async function assertPlanDependenciesCurrent(
  transaction: Transaction,
  planVersionId: string,
  profileVersionId: string,
): Promise<void> {
  const profileRows = await transaction
    .select({ id: profileVersions.id })
    .from(profileVersions)
    .where(and(eq(profileVersions.id, profileVersionId), eq(profileVersions.status, "approved")))
    .limit(1);
  if (profileRows.length === 0) {
    throw new PlanWorkflowConflictError("The approved profile is no longer current.");
  }
  const staleCourses = await transaction
    .select({ id: planCourseDependencies.courseVersionId })
    .from(planCourseDependencies)
    .innerJoin(courseVersions, eq(courseVersions.id, planCourseDependencies.courseVersionId))
    .where(
      and(
        eq(planCourseDependencies.planVersionId, planVersionId),
        sql`${planCourseDependencies.dependencyKind} in ('selected', 'in_progress')`,
        sql`${courseVersions.status} <> 'approved'`,
      ),
    )
    .limit(1);
  if (staleCourses.length > 0) {
    throw new PlanWorkflowConflictError("A selected course version is no longer approved.");
  }
  const staleRules = await transaction
    .select({ id: planRuleDependencies.ruleVersionId })
    .from(planRuleDependencies)
    .innerJoin(courseRuleVersions, eq(courseRuleVersions.id, planRuleDependencies.ruleVersionId))
    .where(
      and(
        eq(planRuleDependencies.planVersionId, planVersionId),
        sql`${courseRuleVersions.status} <> 'approved'`,
      ),
    )
    .limit(1);
  if (staleRules.length > 0) {
    throw new PlanWorkflowConflictError("A frozen rule version is no longer approved.");
  }
}

export async function transitionManualPlanVersion(
  database: Database,
  rawContext: AuthorizationContext,
  untrustedPlanVersionId: string,
  untrustedInput: PlanTransitionInput,
  options: { now?: Date; requestCorrelationId?: string } = {},
): Promise<{ id: string; status: "approved" | "archived" | "draft" | "in_review" }> {
  const planVersionId = IdentifierSchema.parse(untrustedPlanVersionId);
  const input = PlanTransitionInputSchema.parse(untrustedInput);
  const now = options.now ?? new Date();
  const requiredAction: StudentAction =
    input.action === "approve" ? "student:plan:approve" : "student:plan:review";
  const context = await requirePlanContext(database, rawContext, requiredAction, now);
  const requestCorrelationId = options.requestCorrelationId ?? randomUUID();
  try {
    return await database.transaction(
      async (transaction) => {
        const rows = await transaction
          .select()
          .from(planVersions)
          .where(
            and(eq(planVersions.id, planVersionId), eq(planVersions.studentId, context.studentId)),
          )
          .for("update")
          .limit(1);
        const row = rows[0];
        if (row === undefined) throw new PlanWorkflowNotFoundError();
        if (!sameTimestamp(row.updatedAt, input.expectedUpdatedAt)) {
          throw new PlanWorkflowConflictError("The plan changed before the transition.");
        }
        const expectedStatus = input.action === "submit" ? "draft" : "in_review";
        if (input.action !== "archive" && row.status !== expectedStatus) {
          throw new PlanWorkflowConflictError("The plan is not in the required state.");
        }
        if (input.action === "archive" && row.status === "archived") {
          throw new PlanWorkflowConflictError("The plan is already archived.");
        }
        const evaluation = PlanEvaluationSnapshotSchema.parse(row.evaluation);
        const catalogSnapshot = FrozenPlanCatalogSchema.parse(row.catalogSnapshot);
        if (
          hashPlanValue(catalogSnapshot) !== row.catalogSnapshotHash ||
          hashPlanValue({
            catalogSnapshotHash: row.catalogSnapshotHash,
            content: row.content,
            profileVersionId: row.profileVersionId,
            reviewDueDate: row.reviewDueDate,
            studentInput: row.studentInput,
          }) !== row.inputSnapshotHash
        ) {
          throw new PlanWorkflowConflictError("The frozen plan input hash is invalid.");
        }
        if (input.action === "approve") {
          await assertPlanDependenciesCurrent(transaction, planVersionId, row.profileVersionId);
          const recalculated = evaluateManualPlan(
            catalogSnapshot,
            StoredManualPlanSchema.shape.content.parse(row.content),
            StoredManualPlanSchema.shape.studentInput.parse(row.studentInput),
            new Date(evaluation.evaluatedAt),
          );
          if (stablePlanJson(recalculated) !== stablePlanJson(evaluation)) {
            throw new PlanWorkflowConflictError("The stored rule evaluation is not reproducible.");
          }
          const hardViolationKeys = evaluation.scopes.flatMap((scope) =>
            scope.result.violations
              .filter((violation) => violation.severity === "hard")
              .map((violation) => violation.violationKey),
          );
          if (hardViolationKeys.length > 0) {
            const approvedOverrides = await transaction
              .select({ violationKey: planRuleOverrides.violationKey })
              .from(planRuleOverrides)
              .where(
                and(
                  eq(planRuleOverrides.planVersionId, planVersionId),
                  eq(planRuleOverrides.status, "approved"),
                  inArray(planRuleOverrides.violationKey, hardViolationKeys),
                ),
              );
            if (
              new Set(approvedOverrides.map((override) => override.violationKey)).size !==
              new Set(hardViolationKeys).size
            ) {
              throw new PlanWorkflowConflictError(
                "Every hard rule violation requires an approved override with a reason and approver.",
              );
            }
          }
          if (row.reviewDueDate < now.toISOString().slice(0, 10)) {
            throw new PlanWorkflowConflictError("The review date must be renewed before approval.");
          }
          const priorApproved = await transaction
            .select({ id: planVersions.id })
            .from(planVersions)
            .where(
              and(
                eq(planVersions.studentId, context.studentId),
                eq(planVersions.status, "approved"),
              ),
            )
            .for("update");
          for (const prior of priorApproved) {
            const reason = `superseded_by_approved_plan:${planVersionId}`;
            await transaction
              .update(planVersions)
              .set({ invalidationReason: reason, status: "archived", updatedAt: now })
              .where(eq(planVersions.id, prior.id));
            await transaction.insert(planReviewRecords).values({
              action: "archived",
              actorType: "user",
              actorUserId: context.actorUserId,
              createdAt: now,
              fromStatus: "approved",
              planVersionId: prior.id,
              reason,
              requestCorrelationId,
              toStatus: "archived",
            });
          }
        }

        const status =
          input.action === "submit"
            ? ("in_review" as const)
            : input.action === "return"
              ? ("draft" as const)
              : input.action === "approve"
                ? ("approved" as const)
                : ("archived" as const);
        await transaction
          .update(planVersions)
          .set({
            approvedAt: input.action === "approve" ? now : row.approvedAt,
            approvedByUserId:
              input.action === "approve" ? context.actorUserId : row.approvedByUserId,
            invalidationReason: input.action === "archive" ? input.reason : null,
            status,
            updatedAt: now,
          })
          .where(eq(planVersions.id, planVersionId));
        const reason =
          input.action === "return" || input.action === "archive" ? input.reason : null;
        await transaction.insert(planReviewRecords).values({
          action:
            input.action === "submit"
              ? "submitted"
              : input.action === "return"
                ? "returned"
                : input.action === "approve"
                  ? "approved"
                  : "archived",
          actorType: "user",
          actorUserId: context.actorUserId,
          createdAt: now,
          fromStatus: row.status,
          planVersionId,
          reason,
          requestCorrelationId,
          toStatus: status,
        });
        await auditPlan(transaction, {
          action: `student.plan.${input.action}`,
          actorUserId: context.actorUserId,
          contextId: context.id,
          details: {
            fromStatus: row.status,
            reasonLength: reason?.length ?? 0,
            toStatus: status,
            version: row.version,
          },
          objectId: planVersionId,
          objectType: "plan_version",
          requestCorrelationId,
          studentId: context.studentId,
        });
        return { id: planVersionId, status };
      },
      { isolationLevel: "serializable" },
    );
  } catch (error) {
    if (
      error instanceof AuthorizationDeniedError ||
      error instanceof PlanWorkflowConflictError ||
      error instanceof PlanWorkflowNotFoundError
    ) {
      throw error;
    }
    if (isConstraintFailure(error)) {
      throw new PlanWorkflowConflictError("The plan transition was rejected.");
    }
    throw error;
  }
}

export async function exportApprovedManualPlanMarkdown(
  database: Database,
  rawContext: AuthorizationContext,
  untrustedPlanVersionId: string,
  options: { now?: Date; requestCorrelationId?: string } = {},
): Promise<string> {
  const planVersionId = IdentifierSchema.parse(untrustedPlanVersionId);
  const now = options.now ?? new Date();
  const context = await requirePlanContext(database, rawContext, "student:plan:export", now);
  const rows = await database
    .select({
      approvedByDisplayName: appUsers.displayName,
      plan: planVersions,
      studentPublicCode: students.publicCode,
    })
    .from(planVersions)
    .innerJoin(students, eq(students.id, planVersions.studentId))
    .innerJoin(appUsers, eq(appUsers.id, planVersions.approvedByUserId))
    .where(
      and(
        eq(planVersions.id, planVersionId),
        eq(planVersions.studentId, context.studentId),
        eq(planVersions.status, "approved"),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new PlanWorkflowConflictError("Only an approved, current plan can be exported.");
  }
  const plan = planFromRow(row.plan);
  const claimIds = [
    ...new Set([
      ...plan.content.classroomProfile.supportingClaimIds,
      ...plan.content.shortTermItems.flatMap((item) => item.supportingClaimIds),
      ...plan.content.routes.flatMap((route) => route.supportingClaimIds),
      ...plan.studentInput.classroomFeedback.flatMap((feedback) => feedback.supportingClaimIds),
    ]),
  ];
  const claims = await database
    .select({ id: profileClaims.id, statement: profileClaims.statement })
    .from(profileClaims)
    .where(
      and(
        eq(profileClaims.profileVersionId, plan.profileVersionId),
        inArray(profileClaims.id, claimIds),
      ),
    )
    .orderBy(asc(profileClaims.createdAt));
  const courseVersionIds = plan.catalogSnapshot.courses.map((course) => course.courseVersionId);
  const courseRows =
    courseVersionIds.length === 0
      ? []
      : await database
          .select({
            code: courses.code,
            courseVersionId: courseVersions.id,
            title: courseVersions.title,
          })
          .from(courseVersions)
          .innerJoin(courses, eq(courses.id, courseVersions.courseId))
          .where(inArray(courseVersions.id, courseVersionIds))
          .orderBy(asc(courses.code));
  const overrideRows = await database
    .select({
      approvedByDisplayName: appUsers.displayName,
      reason: planRuleOverrides.reason,
      scopeKey: planRuleOverrides.scopeKey,
      violationKey: planRuleOverrides.violationKey,
    })
    .from(planRuleOverrides)
    .innerJoin(appUsers, eq(appUsers.id, planRuleOverrides.decidedByUserId))
    .where(
      and(
        eq(planRuleOverrides.planVersionId, planVersionId),
        eq(planRuleOverrides.status, "approved"),
      ),
    )
    .orderBy(asc(planRuleOverrides.createdAt));
  const markdown = renderManualPlanMarkdown({
    approvedByDisplayName: row.approvedByDisplayName,
    courses: courseRows,
    overrides: overrideRows,
    plan,
    profileClaims: Object.fromEntries(claims.map((claim) => [claim.id, claim.statement])),
    studentPublicCode: row.studentPublicCode,
  });
  await database.insert(auditEvents).values({
    action: "student.plan.export.markdown",
    actorType: "user",
    actorUserId: context.actorUserId,
    details: {
      authorizationContextId: context.id,
      contentHash: hashPlanValue(markdown),
      version: plan.version,
    },
    objectId: planVersionId,
    objectType: "plan_version",
    requestCorrelationId: options.requestCorrelationId ?? randomUUID(),
    result: "allowed",
    studentId: context.studentId,
  });
  return markdown;
}
