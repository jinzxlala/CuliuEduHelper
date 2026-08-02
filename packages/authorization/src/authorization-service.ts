import { randomUUID } from "node:crypto";

import { and, asc, eq, gt, isNull, or, sql, type SQL } from "drizzle-orm";
import {
  appUsers,
  auditEvents,
  authorizationContextSnapshots,
  studentAuthorizations,
  studentFacts,
  students,
  type Database,
} from "@culiu/database/runtime";
import { z } from "zod";

import {
  AccessLevelSchema,
  AuthorizationContextSchema,
  StudentActionSchema,
  type AccessLevel,
  type AuthorizationContext,
  type SessionPrincipal,
  type StudentAction,
} from "./contracts.js";
import { assertAuthorizationContext, calculateAuthorizationContextHash } from "./context.js";
import { AuthorizationDeniedError } from "./errors.js";

const DEFAULT_CONTEXT_LIFETIME_MS = 15 * 60 * 1000;
const KNOWLEDGE_IMPORT_CONTEXT_LIFETIME_MS = 2 * 60 * 60 * 1000;
const STUDENT_IMPORT_CONTEXT_LIFETIME_MS = 2 * 60 * 60 * 1000;
const SCHEDULING_CONTEXT_LIFETIME_MS = 2 * 60 * 60 * 1000;
const StudentIdSchema = z.uuid();

const accessLevelRankSql = (column: unknown): SQL<number> => sql<number>`case ${column}
  when 'internal' then 0
  when 'sensitive' then 1
  when 'restricted' then 2
  else -1
end`;

const containsAllActionsSql = (actions: readonly string[]): SQL => {
  const actionValues = sql.join(
    actions.map((action) => sql`${action}`),
    sql`, `,
  );
  return sql`${studentAuthorizations.allowedActions} @> ARRAY[${actionValues}]::text[]`;
};

export interface AuthorizedStudentSummary {
  id: string;
  privacyLevel: AccessLevel;
  publicCode: string;
  status: "active" | "archived";
}

export interface StudentFactSummary {
  accessLevel: AccessLevel;
  confirmationStatus: "unconfirmed" | "confirmed" | "rejected" | "superseded";
  fieldKey: string;
  id: string;
  sourceType: "advisor" | "student" | "parent" | "evidence" | "import";
  value: Record<string, unknown>;
}

export interface StudentOverview extends AuthorizedStudentSummary {
  facts: StudentFactSummary[];
}

export async function createStudentDirectoryContext(
  database: Database,
  principal: SessionPrincipal,
  options: { now?: Date; requestCorrelationId?: string } = {},
): Promise<AuthorizationContext> {
  const now = options.now ?? new Date();
  await requireActivePrincipal(database, principal);
  const context = await persistContext(database, {
    actorUserId: principal.id,
    allowedActions: ["student:list"],
    createdAt: now,
    expiresAt: new Date(now.getTime() + DEFAULT_CONTEXT_LIFETIME_MS),
    maxAccessLevel: "internal",
    studentId: null,
  });
  await recordStudentAudit(database, {
    action: "student.list.authorize",
    actorUserId: principal.id,
    contextId: context.id,
    objectId: "assigned-students",
    requestCorrelationId: options.requestCorrelationId ?? randomUUID(),
    result: "allowed",
    studentId: null,
  });
  return context;
}

export async function createKnowledgeImportAuthorizationContext(
  database: Database,
  principal: SessionPrincipal,
  options: { now?: Date; requestCorrelationId?: string } = {},
): Promise<AuthorizationContext> {
  const now = options.now ?? new Date();
  const requestCorrelationId = options.requestCorrelationId ?? randomUUID();
  await requireActivePrincipal(database, principal);
  if (principal.role !== "admin" && principal.role !== "advisor") {
    await database.insert(auditEvents).values({
      action: "knowledge.import.authorize",
      actorType: "user",
      actorUserId: principal.id,
      details: {},
      objectId: "knowledge-transcript-submission",
      objectType: "knowledge_import",
      requestCorrelationId,
      result: "denied",
      studentId: null,
    });
    throw new AuthorizationDeniedError();
  }
  const context = await persistContext(database, {
    actorUserId: principal.id,
    allowedActions: ["knowledge:import"],
    createdAt: now,
    expiresAt: new Date(now.getTime() + KNOWLEDGE_IMPORT_CONTEXT_LIFETIME_MS),
    maxAccessLevel: "restricted",
    studentId: null,
  });
  await database.insert(auditEvents).values({
    action: "knowledge.import.authorize",
    actorType: "user",
    actorUserId: principal.id,
    details: { authorizationContextId: context.id },
    objectId: "knowledge-transcript-submission",
    objectType: "knowledge_import",
    requestCorrelationId,
    result: "allowed",
    studentId: null,
  });
  return context;
}

export async function createStudentImportAuthorizationContext(
  database: Database,
  principal: SessionPrincipal,
  options: { now?: Date; requestCorrelationId?: string } = {},
): Promise<AuthorizationContext> {
  const now = options.now ?? new Date();
  const requestCorrelationId = options.requestCorrelationId ?? randomUUID();
  await requireActivePrincipal(database, principal);
  if (principal.role !== "admin") {
    await database.insert(auditEvents).values({
      action: "student.import.authorize",
      actorType: "user",
      actorUserId: principal.id,
      details: {},
      objectId: "student-import",
      objectType: "student_import",
      requestCorrelationId,
      result: "denied",
      studentId: null,
    });
    throw new AuthorizationDeniedError();
  }
  const context = await persistContext(database, {
    actorUserId: principal.id,
    allowedActions: ["student:import"],
    createdAt: now,
    expiresAt: new Date(now.getTime() + STUDENT_IMPORT_CONTEXT_LIFETIME_MS),
    maxAccessLevel: "restricted",
    studentId: null,
  });
  await database.insert(auditEvents).values({
    action: "student.import.authorize",
    actorType: "user",
    actorUserId: principal.id,
    details: { authorizationContextId: context.id },
    objectId: "student-import",
    objectType: "student_import",
    requestCorrelationId,
    result: "allowed",
    studentId: null,
  });
  return context;
}

export async function createSchedulingAuthorizationContext(
  database: Database,
  principal: SessionPrincipal,
  options: { now?: Date; requestCorrelationId?: string } = {},
): Promise<AuthorizationContext> {
  const now = options.now ?? new Date();
  const requestCorrelationId = options.requestCorrelationId ?? randomUUID();
  await requireActivePrincipal(database, principal);
  if (principal.role !== "admin") {
    throw new AuthorizationDeniedError();
  }
  const context = await persistContext(database, {
    actorUserId: principal.id,
    allowedActions: ["scheduling:solve", "scheduling:approve"],
    createdAt: now,
    expiresAt: new Date(now.getTime() + SCHEDULING_CONTEXT_LIFETIME_MS),
    maxAccessLevel: "internal",
    studentId: null,
  });
  await database.insert(auditEvents).values({
    action: "scheduling.authorize",
    actorType: "user",
    actorUserId: principal.id,
    details: { authorizationContextId: context.id },
    objectId: "class-timetable",
    objectType: "scheduling",
    requestCorrelationId,
    result: "allowed",
    studentId: null,
  });
  return context;
}

export async function createStudentAuthorizationContext(
  database: Database,
  principal: SessionPrincipal,
  request: {
    action: StudentAction;
    accessLevel: AccessLevel;
    now?: Date;
    requestCorrelationId?: string;
    studentId: string;
  },
): Promise<AuthorizationContext> {
  const studentId = StudentIdSchema.parse(request.studentId);
  const action = StudentActionSchema.parse(request.action);
  const accessLevel = AccessLevelSchema.parse(request.accessLevel);
  const now = request.now ?? new Date();
  const requestCorrelationId = request.requestCorrelationId ?? randomUUID();
  await requireActivePrincipal(database, principal);

  const grants = await database
    .select({
      expiresAt: studentAuthorizations.expiresAt,
      maxAccessLevel: studentAuthorizations.maxAccessLevel,
    })
    .from(studentAuthorizations)
    .innerJoin(students, eq(students.id, studentAuthorizations.studentId))
    .where(
      and(
        eq(studentAuthorizations.userId, principal.id),
        eq(studentAuthorizations.studentId, studentId),
        eq(students.status, "active"),
        sql`${studentAuthorizations.allowedActions} @> ARRAY[${action}]::text[]`,
        sql`${accessLevelRankSql(studentAuthorizations.maxAccessLevel)} >= ${accessLevelRankSql(students.privacyLevel)}`,
        sql`${accessLevelRankSql(studentAuthorizations.maxAccessLevel)} >= ${accessLevelRankSql(accessLevel)}`,
        sql`${studentAuthorizations.validFrom} <= ${now}`,
        or(isNull(studentAuthorizations.expiresAt), gt(studentAuthorizations.expiresAt, now)),
      ),
    )
    .limit(1);
  const grant = grants[0];
  if (grant === undefined) {
    await recordStudentAudit(database, {
      action: "student.access.authorize",
      actorUserId: principal.id,
      contextId: null,
      objectId: studentId,
      requestCorrelationId,
      result: "denied",
      studentId: null,
    });
    throw new AuthorizationDeniedError();
  }

  const normalExpiry = new Date(now.getTime() + DEFAULT_CONTEXT_LIFETIME_MS);
  const expiresAt =
    grant.expiresAt !== null && grant.expiresAt < normalExpiry ? grant.expiresAt : normalExpiry;
  const context = await persistContext(database, {
    actorUserId: principal.id,
    allowedActions: [action],
    createdAt: now,
    expiresAt,
    maxAccessLevel: grant.maxAccessLevel,
    studentId,
  });
  await recordStudentAudit(database, {
    action: "student.access.authorize",
    actorUserId: principal.id,
    contextId: context.id,
    objectId: studentId,
    requestCorrelationId,
    result: "allowed",
    studentId,
  });
  return context;
}

export async function loadAuthorizationContext(
  database: Database,
  reference: {
    actorUserId?: string;
    contextHash: string;
    id: string;
    now?: Date;
  },
): Promise<AuthorizationContext> {
  const now = reference.now ?? new Date();
  const rows = await database
    .select({
      actorActive: appUsers.active,
      actorRole: appUsers.role,
      actorUserId: authorizationContextSnapshots.actorUserId,
      allowedActions: authorizationContextSnapshots.allowedActions,
      contextHash: authorizationContextSnapshots.contextHash,
      createdAt: authorizationContextSnapshots.createdAt,
      expiresAt: authorizationContextSnapshots.expiresAt,
      id: authorizationContextSnapshots.id,
      maxAccessLevel: authorizationContextSnapshots.maxAccessLevel,
      studentId: authorizationContextSnapshots.studentId,
    })
    .from(authorizationContextSnapshots)
    .innerJoin(appUsers, eq(appUsers.id, authorizationContextSnapshots.actorUserId))
    .where(eq(authorizationContextSnapshots.id, reference.id))
    .limit(1);
  const row = rows[0];
  if (
    row === undefined ||
    !row.actorActive ||
    row.actorRole === "service" ||
    row.contextHash !== reference.contextHash ||
    row.expiresAt <= now ||
    (reference.actorUserId !== undefined && row.actorUserId !== reference.actorUserId)
  ) {
    throw new AuthorizationDeniedError();
  }

  const context = AuthorizationContextSchema.parse({
    actorUserId: row.actorUserId,
    allowedActions: row.allowedActions,
    contextHash: row.contextHash,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    id: row.id,
    maxAccessLevel: row.maxAccessLevel,
    studentId: row.studentId,
  });
  assertContextHash(context);

  if (context.studentId !== null) {
    const currentGrant = await database
      .select({ id: studentAuthorizations.id })
      .from(studentAuthorizations)
      .innerJoin(students, eq(students.id, studentAuthorizations.studentId))
      .where(
        and(
          eq(studentAuthorizations.userId, context.actorUserId),
          eq(studentAuthorizations.studentId, context.studentId),
          eq(students.status, "active"),
          containsAllActionsSql(context.allowedActions),
          sql`${accessLevelRankSql(studentAuthorizations.maxAccessLevel)} >= ${accessLevelRankSql(context.maxAccessLevel)}`,
          sql`${accessLevelRankSql(studentAuthorizations.maxAccessLevel)} >= ${accessLevelRankSql(students.privacyLevel)}`,
          sql`${studentAuthorizations.validFrom} <= ${now}`,
          or(isNull(studentAuthorizations.expiresAt), gt(studentAuthorizations.expiresAt, now)),
        ),
      )
      .limit(1);
    if (currentGrant.length === 0) {
      throw new AuthorizationDeniedError();
    }
  }

  return context;
}

export async function listAuthorizedStudents(
  database: Database,
  rawContext: AuthorizationContext,
  options: { now?: Date; requestCorrelationId?: string } = {},
): Promise<AuthorizedStudentSummary[]> {
  assertContextHash(AuthorizationContextSchema.parse(rawContext));
  const context = await loadAuthorizationContext(database, {
    actorUserId: rawContext.actorUserId,
    contextHash: rawContext.contextHash,
    id: rawContext.id,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  assertAuthorizationContext(context, {
    action: "student:list",
    accessLevel: "internal",
    ...(options.now === undefined ? {} : { now: options.now }),
    studentId: null,
  });

  const now = options.now ?? new Date();
  const rows = await database
    .select({
      id: students.id,
      privacyLevel: students.privacyLevel,
      publicCode: students.publicCode,
      status: students.status,
    })
    .from(students)
    .innerJoin(studentAuthorizations, eq(studentAuthorizations.studentId, students.id))
    .where(
      and(
        eq(studentAuthorizations.userId, context.actorUserId),
        eq(students.status, "active"),
        sql`${studentAuthorizations.allowedActions} @> ARRAY['student:read']::text[]`,
        sql`${accessLevelRankSql(studentAuthorizations.maxAccessLevel)} >= ${accessLevelRankSql(students.privacyLevel)}`,
        sql`${studentAuthorizations.validFrom} <= ${now}`,
        or(isNull(studentAuthorizations.expiresAt), gt(studentAuthorizations.expiresAt, now)),
      ),
    )
    .orderBy(asc(students.publicCode));

  await recordStudentAudit(database, {
    action: "student.list",
    actorUserId: context.actorUserId,
    contextId: context.id,
    objectId: "assigned-students",
    requestCorrelationId: options.requestCorrelationId ?? randomUUID(),
    result: "allowed",
    studentId: null,
  });
  return rows.map((row) => ({ ...row }));
}

export async function readStudentOverview(
  database: Database,
  rawContext: AuthorizationContext,
  options: { now?: Date; requestCorrelationId?: string } = {},
): Promise<StudentOverview> {
  assertContextHash(AuthorizationContextSchema.parse(rawContext));
  if (rawContext.studentId === null) {
    throw new AuthorizationDeniedError();
  }
  const context = await loadAuthorizationContext(database, {
    actorUserId: rawContext.actorUserId,
    contextHash: rawContext.contextHash,
    id: rawContext.id,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  if (context.studentId === null) {
    throw new AuthorizationDeniedError();
  }
  assertAuthorizationContext(context, {
    action: "student:read",
    accessLevel: context.maxAccessLevel,
    ...(options.now === undefined ? {} : { now: options.now }),
    studentId: context.studentId,
  });

  const studentRows = await database
    .select({
      id: students.id,
      privacyLevel: students.privacyLevel,
      publicCode: students.publicCode,
      status: students.status,
    })
    .from(students)
    .where(and(eq(students.id, context.studentId), eq(students.status, "active")))
    .limit(1);
  const student = studentRows[0];
  if (student === undefined) {
    throw new AuthorizationDeniedError();
  }
  const facts = await database
    .select({
      accessLevel: studentFacts.accessLevel,
      confirmationStatus: studentFacts.confirmationStatus,
      fieldKey: studentFacts.fieldKey,
      id: studentFacts.id,
      sourceType: studentFacts.sourceType,
      value: studentFacts.value,
    })
    .from(studentFacts)
    .where(
      and(
        eq(studentFacts.studentId, context.studentId),
        sql`${accessLevelRankSql(studentFacts.accessLevel)} <= ${accessLevelRankSql(context.maxAccessLevel)}`,
      ),
    )
    .orderBy(asc(studentFacts.createdAt));

  await recordStudentAudit(database, {
    action: "student.view",
    actorUserId: context.actorUserId,
    contextId: context.id,
    objectId: context.studentId,
    requestCorrelationId: options.requestCorrelationId ?? randomUUID(),
    result: "allowed",
    studentId: context.studentId,
  });
  return { ...student, facts };
}

async function requireActivePrincipal(
  database: Database,
  principal: SessionPrincipal,
): Promise<void> {
  const rows = await database
    .select({ id: appUsers.id, role: appUsers.role })
    .from(appUsers)
    .where(and(eq(appUsers.id, principal.id), eq(appUsers.active, true)))
    .limit(1);
  const account = rows[0];
  if (account === undefined || account.role === "service" || account.role !== principal.role) {
    throw new AuthorizationDeniedError();
  }
}

async function persistContext(
  database: Database,
  input: Omit<AuthorizationContext, "contextHash" | "id">,
): Promise<AuthorizationContext> {
  const id = randomUUID();
  const contextWithoutHash = { ...input, id };
  const contextHash = calculateAuthorizationContextHash(contextWithoutHash);
  const context = AuthorizationContextSchema.parse({ ...contextWithoutHash, contextHash });
  await database.insert(authorizationContextSnapshots).values(context);
  return context;
}

function assertContextHash(context: AuthorizationContext): void {
  if (calculateAuthorizationContextHash(context) !== context.contextHash) {
    throw new AuthorizationDeniedError();
  }
}

async function recordStudentAudit(
  database: Database,
  input: {
    action: string;
    actorUserId: string;
    contextId: string | null;
    objectId: string;
    requestCorrelationId: string;
    result: "allowed" | "denied";
    studentId: string | null;
  },
): Promise<void> {
  await database.insert(auditEvents).values({
    action: input.action,
    actorType: "user",
    actorUserId: input.actorUserId,
    details: input.contextId === null ? {} : { authorizationContextId: input.contextId },
    objectId: input.objectId,
    objectType: "student",
    requestCorrelationId: input.requestCorrelationId,
    result: input.result,
    studentId: input.studentId,
  });
}
