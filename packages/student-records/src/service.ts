import { randomUUID } from "node:crypto";

import {
  AuthorizationContextSchema,
  AuthorizationDeniedError,
  accessLevelRank,
  assertAuthorizationContext,
  loadAuthorizationContext,
  type AccessLevel,
  type AuthorizationContext,
  type StudentAction,
} from "@culiu/authorization";
import {
  auditEvents,
  evidenceInvalidations,
  evidenceLocators,
  evidenceObjects,
  factEvidence,
  studentFacts,
  students,
  type Database,
} from "@culiu/database/runtime";
import type { ImmutableObjectStore } from "@culiu/storage";
import { and, asc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import {
  CreateStudentFactInputSchema,
  InvalidateStudentEvidenceInputSchema,
  RegisterStudentEvidenceInputSchema,
  type CreateStudentFactInput,
  type EvidenceLocatorInput,
  type InvalidateStudentEvidenceInput,
  type RegisterStudentEvidenceInput,
} from "./contracts.js";
import { StudentRecordConflictError, StudentRecordNotFoundError } from "./errors.js";

const EvidenceObjectIdSchema = z.uuid();

type ConfirmationStatus = "confirmed" | "rejected" | "superseded" | "unconfirmed";
type EvidenceRelation = "contradicts" | "partially_supports" | "supports";
type FactSourceType = "advisor" | "evidence" | "import" | "parent" | "student";
type LocatorType = "cell" | "character_range" | "page" | "paragraph" | "record_field" | "timestamp";

export interface StudentEvidenceLocatorRecord {
  id: string;
  locator: Record<string, unknown>;
  locatorType: LocatorType;
}

export interface StudentEvidenceRecord {
  accessLevel: AccessLevel;
  byteCount: number;
  contentHash: string;
  createdAt: Date;
  current: boolean;
  id: string;
  invalidation: { createdAt: Date; reason: string } | null;
  locators: StudentEvidenceLocatorRecord[];
  mimeType: string;
  originalFileName: string;
  supersedesId: string | null;
  version: number;
}

export interface StudentFactEvidenceLinkRecord {
  effectiveValidationStatus: "invalid" | "pending" | "valid";
  evidenceLocatorId: string;
  evidenceObjectId: string;
  relation: EvidenceRelation;
  validationStatus: "invalid" | "pending" | "valid";
}

export interface StudentFactRecord {
  accessLevel: AccessLevel;
  confirmationStatus: ConfirmationStatus;
  createdAt: Date;
  current: boolean;
  evidenceLinks: StudentFactEvidenceLinkRecord[];
  fieldKey: string;
  id: string;
  sourceType: FactSourceType;
  supersedesId: string | null;
  updatedAt: Date;
  validFrom: Date;
  validTo: Date | null;
  value: Record<string, unknown>;
}

export interface StudentRecord {
  evidence: StudentEvidenceRecord[];
  facts: StudentFactRecord[];
  id: string;
  privacyLevel: AccessLevel;
  publicCode: string;
  status: "active" | "archived";
}

export interface RegisteredStudentEvidence {
  evidence: StudentEvidenceRecord;
}

export interface StudentEvidenceContent {
  content: Uint8Array;
  mimeType: string;
  originalFileName: string;
}

function accessLevelRankSql(column: unknown): SQL<number> {
  return sql<number>`case ${column}
    when 'internal' then 0
    when 'sensitive' then 1
    when 'restricted' then 2
    else -1
  end`;
}

async function requireStudentContext(
  database: Database,
  rawContext: AuthorizationContext,
  action: StudentAction,
  accessLevel: AccessLevel,
  now = new Date(),
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
    accessLevel,
    action,
    now,
    studentId: context.studentId,
  });
  return { ...context, studentId: context.studentId };
}

function ensureAccess(required: AccessLevel, maximum: AccessLevel): void {
  if (accessLevelRank[required] > accessLevelRank[maximum]) {
    throw new AuthorizationDeniedError();
  }
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current instanceof Error && "code" in current && current.code === "23505") return true;
    if (!(current instanceof Error) || !("cause" in current)) return false;
    current = current.cause;
  }
  return false;
}

function locatorToDatabase(locator: EvidenceLocatorInput): {
  locator: Record<string, unknown>;
  locatorType: LocatorType;
} {
  return {
    locator: locator.locator,
    locatorType: locator.locatorType,
  };
}

function requiredLocatorEvidenceId(
  locatorEvidenceIds: ReadonlyMap<string, string>,
  id: string,
): string {
  const evidenceId = locatorEvidenceIds.get(id);
  if (evidenceId === undefined) throw new StudentRecordNotFoundError();
  return evidenceId;
}

export async function registerStudentEvidence(
  database: Database,
  objectStore: ImmutableObjectStore,
  rawContext: AuthorizationContext,
  untrustedInput: RegisterStudentEvidenceInput,
  options: { now?: Date; requestCorrelationId?: string } = {},
): Promise<RegisteredStudentEvidence> {
  const input = RegisterStudentEvidenceInputSchema.parse(untrustedInput);
  const now = options.now ?? new Date();
  const context = await requireStudentContext(
    database,
    rawContext,
    "student:write",
    input.accessLevel,
    now,
  );
  const stored = await objectStore.store({
    content: input.content,
    domain: "student",
    studentId: context.studentId,
  });

  try {
    return await database.transaction(async (transaction) => {
      let supersedesId: string | null = null;
      let version = 1;
      if (input.supersedesEvidenceId !== undefined) {
        const previousRows = await transaction
          .select({
            accessLevel: evidenceObjects.accessLevel,
            id: evidenceObjects.id,
            studentId: evidenceObjects.studentId,
            version: evidenceObjects.version,
          })
          .from(evidenceObjects)
          .where(eq(evidenceObjects.id, input.supersedesEvidenceId))
          .for("update")
          .limit(1);
        const previous = previousRows[0];
        if (previous === undefined || previous.studentId !== context.studentId) {
          throw new StudentRecordNotFoundError();
        }
        if (accessLevelRank[input.accessLevel] < accessLevelRank[previous.accessLevel]) {
          throw new StudentRecordConflictError(
            "An evidence revision cannot lower the previous access level.",
          );
        }
        const existingRevision = await transaction
          .select({ id: evidenceObjects.id })
          .from(evidenceObjects)
          .where(eq(evidenceObjects.supersedesId, previous.id))
          .limit(1);
        if (existingRevision.length > 0) {
          throw new StudentRecordConflictError("The evidence already has a newer version.");
        }
        supersedesId = previous.id;
        version = previous.version + 1;
      }

      const evidenceId = randomUUID();
      await transaction.insert(evidenceObjects).values({
        accessLevel: input.accessLevel,
        byteCount: stored.size,
        contentHash: stored.sha256,
        createdAt: now,
        dataDomain: "student",
        id: evidenceId,
        mimeType: input.mimeType,
        originalFileName: input.fileName,
        storageKey: stored.key,
        studentId: context.studentId,
        supersedesId,
        uploadedByUserId: context.actorUserId,
        version,
      });
      const locatorRows = input.locators.map((locator) => ({
        createdAt: now,
        evidenceObjectId: evidenceId,
        id: randomUUID(),
        ...locatorToDatabase(locator),
      }));
      await transaction.insert(evidenceLocators).values(locatorRows);
      await transaction.insert(auditEvents).values({
        action: supersedesId === null ? "student.evidence.create" : "student.evidence.revise",
        actorType: "user",
        actorUserId: context.actorUserId,
        createdAt: now,
        details: {
          accessLevel: input.accessLevel,
          authorizationContextId: context.id,
          byteCount: stored.size,
          locatorCount: locatorRows.length,
          mimeType: input.mimeType,
          supersedesId,
        },
        objectId: evidenceId,
        objectType: "evidence_object",
        requestCorrelationId: options.requestCorrelationId ?? randomUUID(),
        result: "allowed",
        studentId: context.studentId,
      });

      return {
        evidence: {
          accessLevel: input.accessLevel,
          byteCount: stored.size,
          contentHash: stored.sha256,
          createdAt: now,
          current: true,
          id: evidenceId,
          invalidation: null,
          locators: locatorRows.map((locator) => ({
            id: locator.id,
            locator: locator.locator,
            locatorType: locator.locatorType,
          })),
          mimeType: input.mimeType,
          originalFileName: input.fileName,
          supersedesId,
          version,
        },
      };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new StudentRecordConflictError("This evidence version already exists.");
    }
    throw error;
  }
}

export async function createStudentFact(
  database: Database,
  rawContext: AuthorizationContext,
  untrustedInput: CreateStudentFactInput,
  options: { now?: Date; requestCorrelationId?: string } = {},
): Promise<StudentFactRecord> {
  const input = CreateStudentFactInputSchema.parse(untrustedInput);
  const now = options.now ?? new Date();
  const validFrom = input.validFrom ?? now;
  const context = await requireStudentContext(
    database,
    rawContext,
    "student:write",
    input.accessLevel,
    now,
  );

  return database.transaction(async (transaction) => {
    let supersedesId: string | null = null;
    if (input.supersedesFactId !== undefined) {
      const previousRows = await transaction
        .select({
          accessLevel: studentFacts.accessLevel,
          confirmationStatus: studentFacts.confirmationStatus,
          fieldKey: studentFacts.fieldKey,
          id: studentFacts.id,
          studentId: studentFacts.studentId,
          validFrom: studentFacts.validFrom,
          validTo: studentFacts.validTo,
        })
        .from(studentFacts)
        .where(eq(studentFacts.id, input.supersedesFactId))
        .for("update")
        .limit(1);
      const previous = previousRows[0];
      if (
        previous === undefined ||
        previous.studentId !== context.studentId ||
        previous.fieldKey !== input.fieldKey
      ) {
        throw new StudentRecordNotFoundError();
      }
      if (previous.validTo !== null || previous.confirmationStatus === "superseded") {
        throw new StudentRecordConflictError("The fact has already been superseded.");
      }
      if (validFrom <= previous.validFrom) {
        throw new StudentRecordConflictError("A fact revision must start after its prior version.");
      }
      if (accessLevelRank[input.accessLevel] < accessLevelRank[previous.accessLevel]) {
        throw new StudentRecordConflictError("A fact revision cannot lower its access level.");
      }
      const existingRevision = await transaction
        .select({ id: studentFacts.id })
        .from(studentFacts)
        .where(eq(studentFacts.supersedesId, previous.id))
        .limit(1);
      if (existingRevision.length > 0) {
        throw new StudentRecordConflictError("The fact already has a newer version.");
      }
      await transaction
        .update(studentFacts)
        .set({ confirmationStatus: "superseded", updatedAt: now, validTo: validFrom })
        .where(eq(studentFacts.id, previous.id));
      supersedesId = previous.id;
    }

    const locatorIds = input.evidenceLinks.map((link) => link.evidenceLocatorId);
    const locatorEvidenceIds = new Map<string, string>();
    if (locatorIds.length > 0) {
      const linkedEvidence = await transaction
        .select({
          accessLevel: evidenceObjects.accessLevel,
          domain: evidenceObjects.dataDomain,
          evidenceId: evidenceObjects.id,
          invalidationId: evidenceInvalidations.id,
          locatorId: evidenceLocators.id,
          studentId: evidenceObjects.studentId,
        })
        .from(evidenceLocators)
        .innerJoin(evidenceObjects, eq(evidenceObjects.id, evidenceLocators.evidenceObjectId))
        .leftJoin(
          evidenceInvalidations,
          eq(evidenceInvalidations.evidenceObjectId, evidenceObjects.id),
        )
        .where(inArray(evidenceLocators.id, locatorIds));
      const linkedIds = new Set(linkedEvidence.map((evidence) => evidence.locatorId));
      if (linkedIds.size !== locatorIds.length) throw new StudentRecordNotFoundError();
      for (const evidence of linkedEvidence) {
        if (
          evidence.domain !== "student" ||
          evidence.studentId !== context.studentId ||
          evidence.invalidationId !== null
        ) {
          throw new StudentRecordNotFoundError();
        }
        ensureAccess(evidence.accessLevel, input.accessLevel);
        const newer = await transaction
          .select({ id: evidenceObjects.id })
          .from(evidenceObjects)
          .where(eq(evidenceObjects.supersedesId, evidence.evidenceId))
          .limit(1);
        if (newer.length > 0) {
          throw new StudentRecordConflictError("A fact cannot cite a superseded evidence version.");
        }
        locatorEvidenceIds.set(evidence.locatorId, evidence.evidenceId);
      }
    }

    const factId = randomUUID();
    await transaction.insert(studentFacts).values({
      accessLevel: input.accessLevel,
      confirmationStatus: input.confirmationStatus,
      createdAt: now,
      fieldKey: input.fieldKey,
      id: factId,
      sourceType: input.sourceType,
      studentId: context.studentId,
      supersedesId,
      updatedAt: now,
      validFrom,
      value: input.value,
    });
    if (input.evidenceLinks.length > 0) {
      await transaction.insert(factEvidence).values(
        input.evidenceLinks.map((link) => ({
          createdAt: now,
          evidenceLocatorId: link.evidenceLocatorId,
          relation: link.relation,
          studentFactId: factId,
          validationStatus: "valid" as const,
        })),
      );
    }
    await transaction.insert(auditEvents).values({
      action: supersedesId === null ? "student.fact.create" : "student.fact.revise",
      actorType: "user",
      actorUserId: context.actorUserId,
      createdAt: now,
      details: {
        accessLevel: input.accessLevel,
        authorizationContextId: context.id,
        confirmationStatus: input.confirmationStatus,
        evidenceCount: input.evidenceLinks.length,
        fieldKey: input.fieldKey,
        sourceType: input.sourceType,
        supersedesId,
      },
      objectId: factId,
      objectType: "student_fact",
      requestCorrelationId: options.requestCorrelationId ?? randomUUID(),
      result: "allowed",
      studentId: context.studentId,
    });

    return {
      accessLevel: input.accessLevel,
      confirmationStatus: input.confirmationStatus,
      createdAt: now,
      current: true,
      evidenceLinks: input.evidenceLinks.map((link) => ({
        effectiveValidationStatus: "valid",
        evidenceLocatorId: link.evidenceLocatorId,
        evidenceObjectId: requiredLocatorEvidenceId(locatorEvidenceIds, link.evidenceLocatorId),
        relation: link.relation,
        validationStatus: "valid",
      })),
      fieldKey: input.fieldKey,
      id: factId,
      sourceType: input.sourceType,
      supersedesId,
      updatedAt: now,
      validFrom,
      validTo: null,
      value: input.value,
    };
  });
}

export async function invalidateStudentEvidence(
  database: Database,
  rawContext: AuthorizationContext,
  untrustedInput: InvalidateStudentEvidenceInput,
  options: { now?: Date; requestCorrelationId?: string } = {},
): Promise<void> {
  const input = InvalidateStudentEvidenceInputSchema.parse(untrustedInput);
  const now = options.now ?? new Date();
  const context = await requireStudentContext(
    database,
    rawContext,
    "student:write",
    "internal",
    now,
  );
  try {
    await database.transaction(async (transaction) => {
      const evidenceRows = await transaction
        .select({ accessLevel: evidenceObjects.accessLevel, studentId: evidenceObjects.studentId })
        .from(evidenceObjects)
        .where(eq(evidenceObjects.id, input.evidenceObjectId))
        .for("update")
        .limit(1);
      const evidence = evidenceRows[0];
      if (evidence === undefined || evidence.studentId !== context.studentId) {
        throw new StudentRecordNotFoundError();
      }
      ensureAccess(evidence.accessLevel, context.maxAccessLevel);
      await transaction.insert(evidenceInvalidations).values({
        createdAt: now,
        evidenceObjectId: input.evidenceObjectId,
        id: randomUUID(),
        invalidatedByUserId: context.actorUserId,
        reason: input.reason,
      });
      await transaction.insert(auditEvents).values({
        action: "student.evidence.invalidate",
        actorType: "user",
        actorUserId: context.actorUserId,
        createdAt: now,
        details: { authorizationContextId: context.id, reasonLength: input.reason.length },
        objectId: input.evidenceObjectId,
        objectType: "evidence_object",
        requestCorrelationId: options.requestCorrelationId ?? randomUUID(),
        result: "allowed",
        studentId: context.studentId,
      });
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new StudentRecordConflictError("The evidence has already been invalidated.");
    }
    throw error;
  }
}

export async function readStudentRecord(
  database: Database,
  rawContext: AuthorizationContext,
  options: { now?: Date; requestCorrelationId?: string } = {},
): Promise<StudentRecord> {
  const now = options.now ?? new Date();
  const context = await requireStudentContext(
    database,
    rawContext,
    "student:read",
    "internal",
    now,
  );
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
  if (student === undefined) throw new StudentRecordNotFoundError();

  const factRows = await database
    .select({
      accessLevel: studentFacts.accessLevel,
      confirmationStatus: studentFacts.confirmationStatus,
      createdAt: studentFacts.createdAt,
      fieldKey: studentFacts.fieldKey,
      id: studentFacts.id,
      sourceType: studentFacts.sourceType,
      supersedesId: studentFacts.supersedesId,
      updatedAt: studentFacts.updatedAt,
      validFrom: studentFacts.validFrom,
      validTo: studentFacts.validTo,
      value: studentFacts.value,
    })
    .from(studentFacts)
    .where(
      and(
        eq(studentFacts.studentId, context.studentId),
        sql`${accessLevelRankSql(studentFacts.accessLevel)} <= ${accessLevelRank[context.maxAccessLevel]}`,
      ),
    )
    .orderBy(asc(studentFacts.createdAt));
  const allFactChildren = await database
    .select({ supersedesId: studentFacts.supersedesId })
    .from(studentFacts)
    .where(
      and(eq(studentFacts.studentId, context.studentId), isNotNull(studentFacts.supersedesId)),
    );
  const supersededFactIds = new Set(
    allFactChildren.flatMap((row) => (row.supersedesId === null ? [] : [row.supersedesId])),
  );

  const evidenceRows = await database
    .select({
      accessLevel: evidenceObjects.accessLevel,
      byteCount: evidenceObjects.byteCount,
      contentHash: evidenceObjects.contentHash,
      createdAt: evidenceObjects.createdAt,
      id: evidenceObjects.id,
      invalidatedAt: evidenceInvalidations.createdAt,
      invalidationReason: evidenceInvalidations.reason,
      mimeType: evidenceObjects.mimeType,
      originalFileName: evidenceObjects.originalFileName,
      supersedesId: evidenceObjects.supersedesId,
      version: evidenceObjects.version,
    })
    .from(evidenceObjects)
    .leftJoin(evidenceInvalidations, eq(evidenceInvalidations.evidenceObjectId, evidenceObjects.id))
    .where(
      and(
        eq(evidenceObjects.studentId, context.studentId),
        eq(evidenceObjects.dataDomain, "student"),
        sql`${accessLevelRankSql(evidenceObjects.accessLevel)} <= ${accessLevelRank[context.maxAccessLevel]}`,
      ),
    )
    .orderBy(asc(evidenceObjects.createdAt));
  const allEvidenceChildren = await database
    .select({ supersedesId: evidenceObjects.supersedesId })
    .from(evidenceObjects)
    .where(
      and(
        eq(evidenceObjects.studentId, context.studentId),
        isNotNull(evidenceObjects.supersedesId),
      ),
    );
  const supersededEvidenceIds = new Set(
    allEvidenceChildren.flatMap((row) => (row.supersedesId === null ? [] : [row.supersedesId])),
  );
  const evidenceIds = evidenceRows.map((evidence) => evidence.id);
  const locatorRows =
    evidenceIds.length === 0
      ? []
      : await database
          .select({
            evidenceObjectId: evidenceLocators.evidenceObjectId,
            id: evidenceLocators.id,
            locator: evidenceLocators.locator,
            locatorType: evidenceLocators.locatorType,
          })
          .from(evidenceLocators)
          .where(inArray(evidenceLocators.evidenceObjectId, evidenceIds))
          .orderBy(asc(evidenceLocators.createdAt));
  const factIds = factRows.map((fact) => fact.id);
  const linkRows =
    factIds.length === 0
      ? []
      : await database
          .select({
            evidenceInvalidationId: evidenceInvalidations.id,
            evidenceLocatorId: factEvidence.evidenceLocatorId,
            evidenceObjectId: evidenceObjects.id,
            relation: factEvidence.relation,
            studentFactId: factEvidence.studentFactId,
            validationStatus: factEvidence.validationStatus,
          })
          .from(factEvidence)
          .innerJoin(evidenceLocators, eq(evidenceLocators.id, factEvidence.evidenceLocatorId))
          .innerJoin(evidenceObjects, eq(evidenceObjects.id, evidenceLocators.evidenceObjectId))
          .leftJoin(
            evidenceInvalidations,
            eq(evidenceInvalidations.evidenceObjectId, evidenceObjects.id),
          )
          .where(inArray(factEvidence.studentFactId, factIds));

  const evidence: StudentEvidenceRecord[] = evidenceRows.map((row) => ({
    accessLevel: row.accessLevel,
    byteCount: row.byteCount,
    contentHash: row.contentHash,
    createdAt: row.createdAt,
    current: !supersededEvidenceIds.has(row.id) && row.invalidatedAt === null,
    id: row.id,
    invalidation:
      row.invalidatedAt === null || row.invalidationReason === null
        ? null
        : { createdAt: row.invalidatedAt, reason: row.invalidationReason },
    locators: locatorRows
      .filter((locator) => locator.evidenceObjectId === row.id)
      .map((locator) => ({
        id: locator.id,
        locator: locator.locator,
        locatorType: locator.locatorType,
      })),
    mimeType: row.mimeType,
    originalFileName: row.originalFileName,
    supersedesId: row.supersedesId,
    version: row.version,
  }));
  const facts: StudentFactRecord[] = factRows.map((row) => ({
    accessLevel: row.accessLevel,
    confirmationStatus: row.confirmationStatus,
    createdAt: row.createdAt,
    current:
      !supersededFactIds.has(row.id) &&
      row.validTo === null &&
      row.confirmationStatus !== "superseded",
    evidenceLinks: linkRows
      .filter((link) => link.studentFactId === row.id)
      .map((link) => ({
        effectiveValidationStatus:
          link.evidenceInvalidationId === null ? link.validationStatus : "invalid",
        evidenceLocatorId: link.evidenceLocatorId,
        evidenceObjectId: link.evidenceObjectId,
        relation: link.relation,
        validationStatus: link.validationStatus,
      })),
    fieldKey: row.fieldKey,
    id: row.id,
    sourceType: row.sourceType,
    supersedesId: row.supersedesId,
    updatedAt: row.updatedAt,
    validFrom: row.validFrom,
    validTo: row.validTo,
    value: row.value,
  }));

  await database.insert(auditEvents).values({
    action: "student.record.view",
    actorType: "user",
    actorUserId: context.actorUserId,
    createdAt: now,
    details: {
      authorizationContextId: context.id,
      evidenceCount: evidence.length,
      factCount: facts.length,
    },
    objectId: context.studentId,
    objectType: "student_record",
    requestCorrelationId: options.requestCorrelationId ?? randomUUID(),
    result: "allowed",
    studentId: context.studentId,
  });

  return { ...student, evidence, facts };
}

export async function readStudentEvidenceContent(
  database: Database,
  objectStore: ImmutableObjectStore,
  rawContext: AuthorizationContext,
  evidenceObjectId: string,
  options: { now?: Date; requestCorrelationId?: string } = {},
): Promise<StudentEvidenceContent> {
  const parsedEvidenceObjectId = EvidenceObjectIdSchema.parse(evidenceObjectId);
  const now = options.now ?? new Date();
  const context = await requireStudentContext(
    database,
    rawContext,
    "student:read",
    "internal",
    now,
  );
  const rows = await database
    .select({
      accessLevel: evidenceObjects.accessLevel,
      byteCount: evidenceObjects.byteCount,
      contentHash: evidenceObjects.contentHash,
      id: evidenceObjects.id,
      invalidationId: evidenceInvalidations.id,
      mimeType: evidenceObjects.mimeType,
      originalFileName: evidenceObjects.originalFileName,
      storageKey: evidenceObjects.storageKey,
      studentId: evidenceObjects.studentId,
    })
    .from(evidenceObjects)
    .leftJoin(evidenceInvalidations, eq(evidenceInvalidations.evidenceObjectId, evidenceObjects.id))
    .where(
      and(
        eq(evidenceObjects.id, parsedEvidenceObjectId),
        eq(evidenceObjects.dataDomain, "student"),
        isNull(evidenceInvalidations.id),
      ),
    )
    .limit(1);
  const evidence = rows[0];
  if (
    evidence === undefined ||
    evidence.studentId !== context.studentId ||
    evidence.byteCount <= 0 ||
    evidence.originalFileName === "unknown"
  ) {
    throw new StudentRecordNotFoundError();
  }
  ensureAccess(evidence.accessLevel, context.maxAccessLevel);
  const content = await objectStore.read({
    domain: "student",
    key: evidence.storageKey,
    sha256: evidence.contentHash,
    size: evidence.byteCount,
    studentId: context.studentId,
  });
  await database.insert(auditEvents).values({
    action: "student.evidence.download",
    actorType: "user",
    actorUserId: context.actorUserId,
    createdAt: now,
    details: { authorizationContextId: context.id, byteCount: evidence.byteCount },
    objectId: evidence.id,
    objectType: "evidence_object",
    requestCorrelationId: options.requestCorrelationId ?? randomUUID(),
    result: "allowed",
    studentId: context.studentId,
  });
  return {
    content,
    mimeType: evidence.mimeType,
    originalFileName: evidence.originalFileName,
  };
}
