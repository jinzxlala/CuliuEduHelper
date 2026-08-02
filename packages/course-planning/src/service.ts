import { randomUUID } from "node:crypto";

import { SessionPrincipalSchema, type SessionPrincipal } from "@culiu/authorization";
import {
  appUsers,
  auditEvents,
  courseRuleVersions,
  courseRules,
  courseScheduleSessions,
  courseVersions,
  courses,
  type Database,
} from "@culiu/database/runtime";
import { and, asc, eq, getTableColumns, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";

import {
  ApprovedCourseCatalogSnapshotSchema,
  ApprovedCourseRuleSchema,
  ApprovedCourseSchema,
  CatalogTransitionInputSchema,
  CourseRuleDefinitionSchema,
  CreateCourseInputSchema,
  CreateCourseRuleInputSchema,
  ReviseCourseRuleInputSchema,
  ReviseCourseVersionInputSchema,
  type ApprovedCourse,
  type ApprovedCourseCatalogSnapshot,
  type ApprovedCourseRule,
  type CatalogTransitionInput,
  type CourseRuleDefinition,
  type CourseVersionContent,
  type CreateCourseInput,
  type CreateCourseRuleInput,
  type ReviseCourseRuleInput,
  type ReviseCourseVersionInput,
} from "./contracts.js";
import {
  CourseCatalogAuthorizationError,
  CourseCatalogConflictError,
  CourseCatalogNotFoundError,
  CourseRuleConfigurationError,
} from "./errors.js";
import { validateCourseRuleSet } from "./evaluator.js";

const IdentifierSchema = z.uuid();
type CatalogPermission = "approve" | "manage" | "read";
type QueryExecutor = Pick<Database, "select">;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

interface CourseVersionRow {
  approvedAt: Date | null;
  approvedByUserId: string | null;
  capabilityTags: string[];
  code: string;
  courseId: string;
  courseVersionId: string;
  deliverables: string[];
  deliveryMode: "scheduled" | "self_paced";
  difficulty: "advanced" | "foundation" | "intermediate";
  durationWeeks: number;
  notSuitableConditions: string[];
  objectives: string[];
  projectTypes: string[];
  stage: string;
  subjectTags: string[];
  summary: string;
  termEndDate: string | null;
  termStartDate: string | null;
  title: string;
  totalInstructionMinutes: number;
  updatedAt: Date;
  version: number;
  weeklyLoadMinutes: number;
}

async function requireCatalogActor(
  database: QueryExecutor,
  rawPrincipal: SessionPrincipal,
  permission: CatalogPermission,
): Promise<SessionPrincipal> {
  const principal = SessionPrincipalSchema.parse(rawPrincipal);
  const accounts = await database
    .select({ active: appUsers.active, email: appUsers.email, role: appUsers.role })
    .from(appUsers)
    .where(eq(appUsers.id, principal.id))
    .limit(1);
  const account = accounts[0];
  if (
    account === undefined ||
    !account.active ||
    account.role === "service" ||
    account.role !== principal.role ||
    account.email.toLowerCase() !== principal.email
  ) {
    throw new CourseCatalogAuthorizationError();
  }
  if ((permission === "approve" || permission === "manage") && account.role !== "admin") {
    throw new CourseCatalogAuthorizationError();
  }
  return principal;
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
    ["23503", "23505", "23514", "55000", "P0001"].includes(String(code)),
  );
}

async function audit(
  transaction: Transaction,
  input: {
    action: string;
    actorUserId: string;
    details: Record<string, unknown>;
    objectId: string;
    objectType: "course_rule_version" | "course_version";
    requestCorrelationId: string;
  },
): Promise<void> {
  await transaction.insert(auditEvents).values({
    action: input.action,
    actorType: "user",
    actorUserId: input.actorUserId,
    details: input.details,
    objectId: input.objectId,
    objectType: input.objectType,
    requestCorrelationId: input.requestCorrelationId,
    result: "allowed",
  });
}

async function insertCourseContent(
  transaction: Transaction,
  input: {
    actorUserId: string;
    content: CourseVersionContent;
    courseId: string;
    courseVersionId: string;
    now: Date;
    sourceCourseVersionId?: string;
    version: number;
  },
): Promise<void> {
  await transaction.insert(courseVersions).values({
    capabilityTags: input.content.capabilityTags,
    courseId: input.courseId,
    createdAt: input.now,
    createdByUserId: input.actorUserId,
    deliverables: input.content.deliverables,
    deliveryMode: input.content.deliveryMode,
    difficulty: input.content.difficulty,
    durationWeeks: input.content.durationWeeks,
    id: input.courseVersionId,
    notSuitableConditions: input.content.notSuitableConditions,
    objectives: input.content.objectives,
    projectTypes: input.content.projectTypes,
    sourceCourseVersionId: input.sourceCourseVersionId,
    stage: input.content.stage,
    subjectTags: input.content.subjectTags,
    summary: input.content.summary,
    termEndDate: input.content.termEndDate,
    termStartDate: input.content.termStartDate,
    title: input.content.title,
    totalInstructionMinutes: input.content.totalInstructionMinutes,
    updatedAt: input.now,
    version: input.version,
    weeklyLoadMinutes: input.content.weeklyLoadMinutes,
  });
  if (input.content.schedule.length > 0) {
    await transaction.insert(courseScheduleSessions).values(
      input.content.schedule.map((session) => ({
        courseVersionId: input.courseVersionId,
        createdAt: input.now,
        endMinute: session.endMinute,
        startMinute: session.startMinute,
        weekday: session.weekday,
      })),
    );
  }
}

function canonicalRuleDefinition(definition: CourseRuleDefinition): CourseRuleDefinition {
  if (definition.ruleType !== "mutual_exclusion" || definition.courseAId < definition.courseBId) {
    return definition;
  }
  return {
    ...definition,
    courseAId: definition.courseBId,
    courseBId: definition.courseAId,
  };
}

function ruleColumns(definition: CourseRuleDefinition): {
  maxAge?: number;
  maxConcurrentCourses?: number;
  maxWeeklyMinutes?: number;
  minAge?: number;
  relatedCourseId?: string;
  subjectCourseId?: string;
} {
  if (definition.ruleType === "prerequisite") {
    return {
      relatedCourseId: definition.requiredCourseId,
      subjectCourseId: definition.subjectCourseId,
    };
  }
  if (definition.ruleType === "mutual_exclusion") {
    return { relatedCourseId: definition.courseBId, subjectCourseId: definition.courseAId };
  }
  if (definition.ruleType === "age_range") {
    return {
      ...(definition.maxAge === undefined ? {} : { maxAge: definition.maxAge }),
      ...(definition.minAge === undefined ? {} : { minAge: definition.minAge }),
      subjectCourseId: definition.subjectCourseId,
    };
  }
  if (definition.ruleType === "load_limit") {
    return {
      ...(definition.maxConcurrentCourses === undefined
        ? {}
        : { maxConcurrentCourses: definition.maxConcurrentCourses }),
      ...(definition.maxWeeklyMinutes === undefined
        ? {}
        : { maxWeeklyMinutes: definition.maxWeeklyMinutes }),
    };
  }
  return {};
}

async function assertRuleCourseReferences(
  database: QueryExecutor,
  definition: CourseRuleDefinition,
): Promise<void> {
  const columns = ruleColumns(definition);
  const ids = [columns.subjectCourseId, columns.relatedCourseId].filter(
    (id): id is string => id !== undefined,
  );
  if (ids.length === 0) return;
  const rows = await database
    .select({ id: courses.id })
    .from(courses)
    .where(inArray(courses.id, ids));
  if (new Set(rows.map((row) => row.id)).size !== new Set(ids).size) {
    throw new CourseCatalogNotFoundError();
  }
}

async function insertRuleContent(
  transaction: Transaction,
  input: {
    actorUserId: string;
    definition: CourseRuleDefinition;
    now: Date;
    ruleId: string;
    ruleVersionId: string;
    sourceRuleVersionId?: string;
    version: number;
  },
): Promise<void> {
  const definition = canonicalRuleDefinition(input.definition);
  await assertRuleCourseReferences(transaction, definition);
  await transaction.insert(courseRuleVersions).values({
    ...ruleColumns(definition),
    createdAt: input.now,
    createdByUserId: input.actorUserId,
    id: input.ruleVersionId,
    message: definition.message,
    ruleId: input.ruleId,
    ruleType: definition.ruleType,
    severity: definition.severity,
    sourceRuleVersionId: input.sourceRuleVersionId,
    updatedAt: input.now,
    version: input.version,
  });
}

async function readApprovedCourses(database: QueryExecutor): Promise<ApprovedCourse[]> {
  const rows: CourseVersionRow[] = await database
    .select({
      approvedAt: courseVersions.approvedAt,
      approvedByUserId: courseVersions.approvedByUserId,
      capabilityTags: courseVersions.capabilityTags,
      code: courses.code,
      courseId: courses.id,
      courseVersionId: courseVersions.id,
      deliverables: courseVersions.deliverables,
      deliveryMode: courseVersions.deliveryMode,
      difficulty: courseVersions.difficulty,
      durationWeeks: courseVersions.durationWeeks,
      notSuitableConditions: courseVersions.notSuitableConditions,
      objectives: courseVersions.objectives,
      projectTypes: courseVersions.projectTypes,
      stage: courseVersions.stage,
      subjectTags: courseVersions.subjectTags,
      summary: courseVersions.summary,
      termEndDate: courseVersions.termEndDate,
      termStartDate: courseVersions.termStartDate,
      title: courseVersions.title,
      totalInstructionMinutes: courseVersions.totalInstructionMinutes,
      updatedAt: courseVersions.updatedAt,
      version: courseVersions.version,
      weeklyLoadMinutes: courseVersions.weeklyLoadMinutes,
    })
    .from(courseVersions)
    .innerJoin(courses, eq(courses.id, courseVersions.courseId))
    .where(eq(courseVersions.status, "approved"))
    .orderBy(asc(courses.code));
  const versionIds = rows.map((row) => row.courseVersionId);
  const sessionRows =
    versionIds.length === 0
      ? []
      : await database
          .select({
            courseVersionId: courseScheduleSessions.courseVersionId,
            endMinute: courseScheduleSessions.endMinute,
            startMinute: courseScheduleSessions.startMinute,
            weekday: courseScheduleSessions.weekday,
          })
          .from(courseScheduleSessions)
          .where(inArray(courseScheduleSessions.courseVersionId, versionIds))
          .orderBy(asc(courseScheduleSessions.weekday), asc(courseScheduleSessions.startMinute));
  const sessionsByVersion = new Map<string, typeof sessionRows>();
  for (const session of sessionRows) {
    const current = sessionsByVersion.get(session.courseVersionId) ?? [];
    current.push(session);
    sessionsByVersion.set(session.courseVersionId, current);
  }
  return rows.map((row) =>
    ApprovedCourseSchema.parse({
      code: row.code,
      content: {
        capabilityTags: row.capabilityTags,
        deliverables: row.deliverables,
        deliveryMode: row.deliveryMode,
        difficulty: row.difficulty,
        durationWeeks: row.durationWeeks,
        notSuitableConditions: row.notSuitableConditions,
        objectives: row.objectives,
        projectTypes: row.projectTypes,
        schedule: (sessionsByVersion.get(row.courseVersionId) ?? []).map((session) => ({
          endMinute: session.endMinute,
          startMinute: session.startMinute,
          weekday: session.weekday,
        })),
        stage: row.stage,
        subjectTags: row.subjectTags,
        summary: row.summary,
        ...(row.termEndDate === null ? {} : { termEndDate: row.termEndDate }),
        ...(row.termStartDate === null ? {} : { termStartDate: row.termStartDate }),
        title: row.title,
        totalInstructionMinutes: row.totalInstructionMinutes,
        weeklyLoadMinutes: row.weeklyLoadMinutes,
      },
      courseId: row.courseId,
      courseVersionId: row.courseVersionId,
      version: row.version,
    }),
  );
}

type RuleRow = typeof courseRuleVersions.$inferSelect & { key: string };

function approvedRuleFromRow(row: RuleRow): ApprovedCourseRule {
  const metadata = {
    key: row.key,
    ruleId: row.ruleId,
    ruleVersionId: row.id,
    version: row.version,
  };
  let definition: CourseRuleDefinition;
  if (row.ruleType === "prerequisite") {
    definition = CourseRuleDefinitionSchema.parse({
      message: row.message,
      requiredCourseId: row.relatedCourseId,
      ruleType: row.ruleType,
      severity: row.severity,
      subjectCourseId: row.subjectCourseId,
    });
  } else if (row.ruleType === "mutual_exclusion") {
    definition = CourseRuleDefinitionSchema.parse({
      courseAId: row.subjectCourseId,
      courseBId: row.relatedCourseId,
      message: row.message,
      ruleType: row.ruleType,
      severity: row.severity,
    });
  } else if (row.ruleType === "age_range") {
    definition = CourseRuleDefinitionSchema.parse({
      ...(row.maxAge === null ? {} : { maxAge: row.maxAge }),
      message: row.message,
      ...(row.minAge === null ? {} : { minAge: row.minAge }),
      ruleType: row.ruleType,
      severity: row.severity,
      subjectCourseId: row.subjectCourseId,
    });
  } else if (row.ruleType === "load_limit") {
    definition = CourseRuleDefinitionSchema.parse({
      ...(row.maxConcurrentCourses === null
        ? {}
        : { maxConcurrentCourses: row.maxConcurrentCourses }),
      ...(row.maxWeeklyMinutes === null ? {} : { maxWeeklyMinutes: row.maxWeeklyMinutes }),
      message: row.message,
      ruleType: row.ruleType,
      severity: row.severity,
    });
  } else {
    definition = CourseRuleDefinitionSchema.parse({
      message: row.message,
      ruleType: row.ruleType,
      severity: row.severity,
    });
  }
  return ApprovedCourseRuleSchema.parse({ ...metadata, ...definition });
}

async function readApprovedRules(
  database: QueryExecutor,
  excludeRuleId?: string,
): Promise<ApprovedCourseRule[]> {
  const rows = await database
    .select({
      ...getTableColumns(courseRuleVersions),
      key: courseRules.key,
    })
    .from(courseRuleVersions)
    .innerJoin(courseRules, eq(courseRules.id, courseRuleVersions.ruleId))
    .where(
      excludeRuleId === undefined
        ? eq(courseRuleVersions.status, "approved")
        : and(
            eq(courseRuleVersions.status, "approved"),
            sql`${courseRuleVersions.ruleId} <> ${excludeRuleId}`,
          ),
    )
    .orderBy(asc(courseRules.key));
  return rows.map((row) => approvedRuleFromRow(row as RuleRow));
}

export async function loadApprovedCourseCatalog(
  database: QueryExecutor,
  rawPrincipal: SessionPrincipal,
): Promise<ApprovedCourseCatalogSnapshot> {
  await requireCatalogActor(database, rawPrincipal, "read");
  return ApprovedCourseCatalogSnapshotSchema.parse({
    courses: await readApprovedCourses(database),
    rules: await readApprovedRules(database),
  });
}

export async function createCourse(
  database: Database,
  rawPrincipal: SessionPrincipal,
  untrustedInput: CreateCourseInput,
  options: { now?: Date; requestCorrelationId?: string } = {},
): Promise<{ courseId: string; courseVersionId: string; status: "draft"; version: 1 }> {
  const input = CreateCourseInputSchema.parse(untrustedInput);
  const principal = await requireCatalogActor(database, rawPrincipal, "manage");
  const now = options.now ?? new Date();
  const requestCorrelationId = options.requestCorrelationId ?? randomUUID();
  try {
    return await database.transaction(async (transaction) => {
      const courseId = randomUUID();
      const courseVersionId = randomUUID();
      await transaction.insert(courses).values({
        code: input.code,
        createdAt: now,
        createdByUserId: principal.id,
        id: courseId,
      });
      await insertCourseContent(transaction, {
        actorUserId: principal.id,
        content: input.content,
        courseId,
        courseVersionId,
        now,
        version: 1,
      });
      await audit(transaction, {
        action: "course.catalog.create",
        actorUserId: principal.id,
        details: { code: input.code, version: 1 },
        objectId: courseVersionId,
        objectType: "course_version",
        requestCorrelationId,
      });
      return { courseId, courseVersionId, status: "draft" as const, version: 1 as const };
    });
  } catch (error) {
    if (isConstraintFailure(error)) {
      throw new CourseCatalogConflictError("The course code or version already exists.");
    }
    throw error;
  }
}

export async function reviseCourseVersion(
  database: Database,
  rawPrincipal: SessionPrincipal,
  untrustedSourceCourseVersionId: string,
  untrustedInput: ReviseCourseVersionInput,
  options: { now?: Date; requestCorrelationId?: string } = {},
): Promise<{ courseId: string; courseVersionId: string; status: "draft"; version: number }> {
  const sourceCourseVersionId = IdentifierSchema.parse(untrustedSourceCourseVersionId);
  const input = ReviseCourseVersionInputSchema.parse(untrustedInput);
  const principal = await requireCatalogActor(database, rawPrincipal, "manage");
  const now = options.now ?? new Date();
  const requestCorrelationId = options.requestCorrelationId ?? randomUUID();
  try {
    return await database.transaction(async (transaction) => {
      const rows = await transaction
        .select({
          courseId: courseVersions.courseId,
          status: courseVersions.status,
          updatedAt: courseVersions.updatedAt,
          version: courseVersions.version,
        })
        .from(courseVersions)
        .where(eq(courseVersions.id, sourceCourseVersionId))
        .for("update")
        .limit(1);
      const source = rows[0];
      if (source === undefined) throw new CourseCatalogNotFoundError();
      if (!sameTimestamp(source.updatedAt, input.expectedSourceUpdatedAt)) {
        throw new CourseCatalogConflictError("The source course version changed before revision.");
      }
      if (source.status === "archived") {
        throw new CourseCatalogConflictError("An archived course version cannot be revised.");
      }
      const latest = await transaction
        .select({ version: courseVersions.version })
        .from(courseVersions)
        .where(eq(courseVersions.courseId, source.courseId))
        .orderBy(sql`${courseVersions.version} desc`)
        .limit(1);
      if (latest[0]?.version !== source.version) {
        throw new CourseCatalogConflictError("Only the latest course version can be revised.");
      }
      const courseVersionId = randomUUID();
      const version = source.version + 1;
      await insertCourseContent(transaction, {
        actorUserId: principal.id,
        content: input.content,
        courseId: source.courseId,
        courseVersionId,
        now,
        sourceCourseVersionId,
        version,
      });
      if (source.status === "draft") {
        await transaction
          .update(courseVersions)
          .set({
            invalidationReason: `superseded_by_revision:${courseVersionId}`,
            status: "archived",
            updatedAt: now,
          })
          .where(eq(courseVersions.id, sourceCourseVersionId));
      }
      await audit(transaction, {
        action: "course.catalog.revise",
        actorUserId: principal.id,
        details: { sourceCourseVersionId, sourceVersion: source.version, version },
        objectId: courseVersionId,
        objectType: "course_version",
        requestCorrelationId,
      });
      return { courseId: source.courseId, courseVersionId, status: "draft" as const, version };
    });
  } catch (error) {
    if (
      error instanceof CourseCatalogConflictError ||
      error instanceof CourseCatalogNotFoundError
    ) {
      throw error;
    }
    if (isConstraintFailure(error)) {
      throw new CourseCatalogConflictError("The course version changed concurrently.");
    }
    throw error;
  }
}

export async function transitionCourseVersion(
  database: Database,
  rawPrincipal: SessionPrincipal,
  untrustedCourseVersionId: string,
  untrustedInput: CatalogTransitionInput,
  options: { now?: Date; requestCorrelationId?: string } = {},
): Promise<{ courseVersionId: string; status: "approved" | "archived" }> {
  const courseVersionId = IdentifierSchema.parse(untrustedCourseVersionId);
  const input = CatalogTransitionInputSchema.parse(untrustedInput);
  const principal = await requireCatalogActor(database, rawPrincipal, "approve");
  const now = options.now ?? new Date();
  const requestCorrelationId = options.requestCorrelationId ?? randomUUID();
  try {
    return await database.transaction(async (transaction) => {
      const rows = await transaction
        .select({
          courseId: courseVersions.courseId,
          status: courseVersions.status,
          updatedAt: courseVersions.updatedAt,
          version: courseVersions.version,
        })
        .from(courseVersions)
        .where(eq(courseVersions.id, courseVersionId))
        .for("update")
        .limit(1);
      const courseVersion = rows[0];
      if (courseVersion === undefined) throw new CourseCatalogNotFoundError();
      if (!sameTimestamp(courseVersion.updatedAt, input.expectedUpdatedAt)) {
        throw new CourseCatalogConflictError("The course version changed before transition.");
      }
      if (courseVersion.status === "archived") {
        throw new CourseCatalogConflictError("The course version is already archived.");
      }
      if (input.action === "approve") {
        if (courseVersion.status !== "draft") {
          throw new CourseCatalogConflictError("Only a draft course version can be approved.");
        }
        const latest = await transaction
          .select({ version: courseVersions.version })
          .from(courseVersions)
          .where(eq(courseVersions.courseId, courseVersion.courseId))
          .orderBy(sql`${courseVersions.version} desc`)
          .limit(1);
        if (latest[0]?.version !== courseVersion.version) {
          throw new CourseCatalogConflictError("Only the latest course version can be approved.");
        }
        const priorApproved = await transaction
          .select({ id: courseVersions.id })
          .from(courseVersions)
          .where(
            and(
              eq(courseVersions.courseId, courseVersion.courseId),
              eq(courseVersions.status, "approved"),
            ),
          )
          .for("update");
        for (const prior of priorApproved) {
          await transaction
            .update(courseVersions)
            .set({
              invalidationReason: `superseded_by_approved_version:${courseVersionId}`,
              status: "archived",
              updatedAt: now,
            })
            .where(eq(courseVersions.id, prior.id));
        }
        await transaction
          .update(courseVersions)
          .set({
            approvedAt: now,
            approvedByUserId: principal.id,
            status: "approved",
            updatedAt: now,
          })
          .where(eq(courseVersions.id, courseVersionId));
      } else {
        if (courseVersion.status === "approved") {
          const dependentRules = await transaction
            .select({ id: courseRuleVersions.id })
            .from(courseRuleVersions)
            .where(
              and(
                eq(courseRuleVersions.status, "approved"),
                or(
                  eq(courseRuleVersions.subjectCourseId, courseVersion.courseId),
                  eq(courseRuleVersions.relatedCourseId, courseVersion.courseId),
                ),
              ),
            )
            .limit(1);
          if (dependentRules.length > 0) {
            throw new CourseCatalogConflictError(
              "Archive dependent approved rules before archiving this course.",
            );
          }
        }
        await transaction
          .update(courseVersions)
          .set({ invalidationReason: input.reason, status: "archived", updatedAt: now })
          .where(eq(courseVersions.id, courseVersionId));
      }
      const status = input.action === "approve" ? ("approved" as const) : ("archived" as const);
      await audit(transaction, {
        action: `course.catalog.${input.action}`,
        actorUserId: principal.id,
        details: {
          fromStatus: courseVersion.status,
          reasonLength: input.action === "archive" ? input.reason.length : 0,
          status,
          version: courseVersion.version,
        },
        objectId: courseVersionId,
        objectType: "course_version",
        requestCorrelationId,
      });
      return { courseVersionId, status };
    });
  } catch (error) {
    if (
      error instanceof CourseCatalogConflictError ||
      error instanceof CourseCatalogNotFoundError
    ) {
      throw error;
    }
    if (isConstraintFailure(error)) {
      throw new CourseCatalogConflictError("The course version transition was rejected.");
    }
    throw error;
  }
}

export async function createCourseRule(
  database: Database,
  rawPrincipal: SessionPrincipal,
  untrustedInput: CreateCourseRuleInput,
  options: { now?: Date; requestCorrelationId?: string } = {},
): Promise<{ ruleId: string; ruleVersionId: string; status: "draft"; version: 1 }> {
  const input = CreateCourseRuleInputSchema.parse(untrustedInput);
  const principal = await requireCatalogActor(database, rawPrincipal, "manage");
  const definition = canonicalRuleDefinition(input.definition);
  const now = options.now ?? new Date();
  const requestCorrelationId = options.requestCorrelationId ?? randomUUID();
  try {
    return await database.transaction(async (transaction) => {
      const ruleId = randomUUID();
      const ruleVersionId = randomUUID();
      await transaction.insert(courseRules).values({
        createdAt: now,
        createdByUserId: principal.id,
        id: ruleId,
        key: input.key,
      });
      await insertRuleContent(transaction, {
        actorUserId: principal.id,
        definition,
        now,
        ruleId,
        ruleVersionId,
        version: 1,
      });
      await audit(transaction, {
        action: "course.rule.create",
        actorUserId: principal.id,
        details: { key: input.key, ruleType: definition.ruleType, version: 1 },
        objectId: ruleVersionId,
        objectType: "course_rule_version",
        requestCorrelationId,
      });
      return { ruleId, ruleVersionId, status: "draft" as const, version: 1 as const };
    });
  } catch (error) {
    if (error instanceof CourseCatalogNotFoundError) throw error;
    if (isConstraintFailure(error)) {
      throw new CourseCatalogConflictError("The course rule key or version already exists.");
    }
    throw error;
  }
}

export async function reviseCourseRule(
  database: Database,
  rawPrincipal: SessionPrincipal,
  untrustedSourceRuleVersionId: string,
  untrustedInput: ReviseCourseRuleInput,
  options: { now?: Date; requestCorrelationId?: string } = {},
): Promise<{ ruleId: string; ruleVersionId: string; status: "draft"; version: number }> {
  const sourceRuleVersionId = IdentifierSchema.parse(untrustedSourceRuleVersionId);
  const input = ReviseCourseRuleInputSchema.parse(untrustedInput);
  const principal = await requireCatalogActor(database, rawPrincipal, "manage");
  const definition = canonicalRuleDefinition(input.definition);
  const now = options.now ?? new Date();
  const requestCorrelationId = options.requestCorrelationId ?? randomUUID();
  try {
    return await database.transaction(async (transaction) => {
      const rows = await transaction
        .select({
          ruleId: courseRuleVersions.ruleId,
          status: courseRuleVersions.status,
          updatedAt: courseRuleVersions.updatedAt,
          version: courseRuleVersions.version,
        })
        .from(courseRuleVersions)
        .where(eq(courseRuleVersions.id, sourceRuleVersionId))
        .for("update")
        .limit(1);
      const source = rows[0];
      if (source === undefined) throw new CourseCatalogNotFoundError();
      if (!sameTimestamp(source.updatedAt, input.expectedSourceUpdatedAt)) {
        throw new CourseCatalogConflictError("The source rule version changed before revision.");
      }
      if (source.status === "archived") {
        throw new CourseCatalogConflictError("An archived rule version cannot be revised.");
      }
      const latest = await transaction
        .select({ version: courseRuleVersions.version })
        .from(courseRuleVersions)
        .where(eq(courseRuleVersions.ruleId, source.ruleId))
        .orderBy(sql`${courseRuleVersions.version} desc`)
        .limit(1);
      if (latest[0]?.version !== source.version) {
        throw new CourseCatalogConflictError("Only the latest rule version can be revised.");
      }
      const ruleVersionId = randomUUID();
      const version = source.version + 1;
      await insertRuleContent(transaction, {
        actorUserId: principal.id,
        definition,
        now,
        ruleId: source.ruleId,
        ruleVersionId,
        sourceRuleVersionId,
        version,
      });
      if (source.status === "draft") {
        await transaction
          .update(courseRuleVersions)
          .set({
            invalidationReason: `superseded_by_revision:${ruleVersionId}`,
            status: "archived",
            updatedAt: now,
          })
          .where(eq(courseRuleVersions.id, sourceRuleVersionId));
      }
      await audit(transaction, {
        action: "course.rule.revise",
        actorUserId: principal.id,
        details: { sourceRuleVersionId, sourceVersion: source.version, version },
        objectId: ruleVersionId,
        objectType: "course_rule_version",
        requestCorrelationId,
      });
      return { ruleId: source.ruleId, ruleVersionId, status: "draft" as const, version };
    });
  } catch (error) {
    if (
      error instanceof CourseCatalogConflictError ||
      error instanceof CourseCatalogNotFoundError
    ) {
      throw error;
    }
    if (isConstraintFailure(error)) {
      throw new CourseCatalogConflictError("The course rule changed concurrently.");
    }
    throw error;
  }
}

export async function transitionCourseRule(
  database: Database,
  rawPrincipal: SessionPrincipal,
  untrustedRuleVersionId: string,
  untrustedInput: CatalogTransitionInput,
  options: { now?: Date; requestCorrelationId?: string } = {},
): Promise<{ ruleVersionId: string; status: "approved" | "archived" }> {
  const ruleVersionId = IdentifierSchema.parse(untrustedRuleVersionId);
  const input = CatalogTransitionInputSchema.parse(untrustedInput);
  const principal = await requireCatalogActor(database, rawPrincipal, "approve");
  const now = options.now ?? new Date();
  const requestCorrelationId = options.requestCorrelationId ?? randomUUID();
  try {
    return await database.transaction(async (transaction) => {
      const rows = await transaction
        .select({
          key: courseRules.key,
          ruleId: courseRuleVersions.ruleId,
          ruleVersion: courseRuleVersions,
        })
        .from(courseRuleVersions)
        .innerJoin(courseRules, eq(courseRules.id, courseRuleVersions.ruleId))
        .where(eq(courseRuleVersions.id, ruleVersionId))
        .for("update")
        .limit(1);
      const row = rows[0];
      if (row === undefined) throw new CourseCatalogNotFoundError();
      const current = row.ruleVersion;
      if (!sameTimestamp(current.updatedAt, input.expectedUpdatedAt)) {
        throw new CourseCatalogConflictError("The rule version changed before transition.");
      }
      if (current.status === "archived") {
        throw new CourseCatalogConflictError("The rule version is already archived.");
      }
      if (input.action === "approve") {
        if (current.status !== "draft") {
          throw new CourseCatalogConflictError("Only a draft rule version can be approved.");
        }
        const latest = await transaction
          .select({ version: courseRuleVersions.version })
          .from(courseRuleVersions)
          .where(eq(courseRuleVersions.ruleId, current.ruleId))
          .orderBy(sql`${courseRuleVersions.version} desc`)
          .limit(1);
        if (latest[0]?.version !== current.version) {
          throw new CourseCatalogConflictError("Only the latest rule version can be approved.");
        }
        const candidate = approvedRuleFromRow({ ...current, key: row.key });
        const candidateSnapshotResult = ApprovedCourseCatalogSnapshotSchema.safeParse({
          courses: await readApprovedCourses(transaction),
          rules: [...(await readApprovedRules(transaction, current.ruleId)), candidate],
        });
        if (!candidateSnapshotResult.success) {
          throw new CourseRuleConfigurationError(
            candidateSnapshotResult.error.issues.map((issue) => issue.message),
          );
        }
        const candidateSnapshot = candidateSnapshotResult.data;
        const issues = validateCourseRuleSet(candidateSnapshot);
        if (issues.length > 0) throw new CourseRuleConfigurationError(issues);
        const priorApproved = await transaction
          .select({ id: courseRuleVersions.id })
          .from(courseRuleVersions)
          .where(
            and(
              eq(courseRuleVersions.ruleId, current.ruleId),
              eq(courseRuleVersions.status, "approved"),
            ),
          )
          .for("update");
        for (const prior of priorApproved) {
          await transaction
            .update(courseRuleVersions)
            .set({
              invalidationReason: `superseded_by_approved_version:${ruleVersionId}`,
              status: "archived",
              updatedAt: now,
            })
            .where(eq(courseRuleVersions.id, prior.id));
        }
        await transaction
          .update(courseRuleVersions)
          .set({
            approvedAt: now,
            approvedByUserId: principal.id,
            status: "approved",
            updatedAt: now,
          })
          .where(eq(courseRuleVersions.id, ruleVersionId));
      } else {
        await transaction
          .update(courseRuleVersions)
          .set({ invalidationReason: input.reason, status: "archived", updatedAt: now })
          .where(eq(courseRuleVersions.id, ruleVersionId));
      }
      const status = input.action === "approve" ? ("approved" as const) : ("archived" as const);
      await audit(transaction, {
        action: `course.rule.${input.action}`,
        actorUserId: principal.id,
        details: {
          fromStatus: current.status,
          reasonLength: input.action === "archive" ? input.reason.length : 0,
          ruleType: current.ruleType,
          status,
          version: current.version,
        },
        objectId: ruleVersionId,
        objectType: "course_rule_version",
        requestCorrelationId,
      });
      return { ruleVersionId, status };
    });
  } catch (error) {
    if (
      error instanceof CourseCatalogConflictError ||
      error instanceof CourseCatalogNotFoundError ||
      error instanceof CourseRuleConfigurationError
    ) {
      throw error;
    }
    if (isConstraintFailure(error)) {
      throw new CourseCatalogConflictError("The course rule transition was rejected.");
    }
    throw error;
  }
}
