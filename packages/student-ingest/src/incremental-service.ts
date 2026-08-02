import { randomUUID } from "node:crypto";

import type { JsonModelProvider } from "@culiu/ai";
import {
  AuthorizationContextSchema,
  assertAuthorizationContext,
  loadAuthorizationContext,
  type AuthorizationContext,
} from "@culiu/authorization";
import {
  auditEvents,
  courseRecommendations,
  evidenceLocators,
  evidenceObjects,
  factEvidence,
  planReviewRecords,
  planVersions,
  profileReviewRecords,
  profileVersions,
  studentFactSuggestions,
  studentFacts,
  studentImportBatches,
  type Database,
} from "@culiu/database/runtime";
import type { ImmutableObjectStore } from "@culiu/storage";
import { StudentFactValueSchema } from "@culiu/student-records";
import type { StudentEvidenceExtractTask } from "@culiu/tasks";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { StudentImportUploadSchema, type StudentImportUpload } from "./contracts.js";
import { parseStudentImportDocument } from "./document-parser.js";
import {
  INCREMENTAL_IMPORT_PROMPT_VERSION,
  INCREMENTAL_IMPORT_PROMPT_HASH,
  INCREMENTAL_IMPORT_REDACTION_VERSION,
  INCREMENTAL_IMPORT_SCHEMA_HASH,
  INCREMENTAL_IMPORT_SCHEMA_VERSION,
  extractIncrementalFactSuggestions,
  isolateStudentCsv,
  paragraphMaterial,
  redactSelectedStudentMaterial,
  type IsolatedStudentMaterial,
} from "./incremental-extraction.js";
import { StudentImportConflictError, StudentImportNotFoundError } from "./service.js";

const BatchIdSchema = z.uuid();
const SuggestionIdSchema = z.uuid();
const IncrementalScopeSchema = z
  .object({
    aliases: z.array(z.string().trim().min(2).max(200)).min(1).max(20),
    ownershipConfirmed: z.boolean(),
  })
  .strict();

export interface IncrementalSuggestionRecord {
  readonly confidence: "high" | "low" | "medium" | "unknown";
  readonly createdAt: Date;
  readonly decision: "accepted" | "pending" | "rejected";
  readonly fieldKey: string;
  readonly id: string;
  readonly informationNature: "advisor_judgment" | "fact" | "inference" | "missing";
  readonly proposedValue: Record<string, unknown>;
  readonly sourceRef: string;
}

async function requireStudentWriteContext(
  database: Database,
  rawContext: AuthorizationContext,
  now = new Date(),
): Promise<AuthorizationContext & { studentId: string }> {
  const parsed = AuthorizationContextSchema.parse(rawContext);
  if (parsed.studentId === null) throw new StudentImportNotFoundError();
  const context = await loadAuthorizationContext(database, {
    actorUserId: parsed.actorUserId,
    contextHash: parsed.contextHash,
    id: parsed.id,
    now,
  });
  if (context.studentId === null) throw new StudentImportNotFoundError();
  assertAuthorizationContext(context, {
    accessLevel: "sensitive",
    action: "student:write",
    now,
    studentId: context.studentId,
  });
  return { ...context, studentId: context.studentId };
}

export async function createIncrementalStudentImportBatch(
  database: Database,
  objectStore: ImmutableObjectStore,
  rawContext: AuthorizationContext,
  untrustedUpload: StudentImportUpload,
  untrustedScope: z.input<typeof IncrementalScopeSchema>,
  options: { now?: Date; requestCorrelationId?: string } = {},
): Promise<{ id: string; status: "uploaded" }> {
  const upload = StudentImportUploadSchema.parse(untrustedUpload);
  const scope = IncrementalScopeSchema.parse(untrustedScope);
  const parsed = await parseStudentImportDocument(upload);
  if (parsed.format !== "csv" && parsed.format !== "docx") {
    throw new StudentImportConflictError("Incremental evidence must be CSV or DOCX.");
  }
  if (parsed.format === "docx" && !scope.ownershipConfirmed) {
    throw new StudentImportConflictError("DOCX ownership must be confirmed before extraction.");
  }
  const now = options.now ?? new Date();
  const context = await requireStudentWriteContext(database, rawContext, now);
  const stored = await objectStore.store({ content: upload.content, domain: "student_import" });
  const id = randomUUID();
  await database.transaction(async (transaction) => {
    await transaction.insert(studentImportBatches).values({
      authorizationContextId: context.id,
      byteCount: stored.size,
      contentHash: stored.sha256,
      createdAt: now,
      createdByUserId: context.actorUserId,
      extractionScope: scope,
      id,
      kind: "incremental",
      mimeType: upload.mimeType,
      originalFileName: upload.fileName,
      promptVersion: INCREMENTAL_IMPORT_PROMPT_VERSION,
      redactionVersion: INCREMENTAL_IMPORT_REDACTION_VERSION,
      schemaVersion: INCREMENTAL_IMPORT_SCHEMA_VERSION,
      selectedStudentId: context.studentId,
      status: "uploaded",
      storageKey: stored.key,
      updatedAt: now,
    });
    await transaction.insert(auditEvents).values({
      action: "student.evidence.import.upload",
      actorType: "user",
      actorUserId: context.actorUserId,
      createdAt: now,
      details: { authorizationContextId: context.id, byteCount: stored.size },
      objectId: id,
      objectType: "student_import",
      requestCorrelationId: options.requestCorrelationId ?? randomUUID(),
      result: "allowed",
      studentId: context.studentId,
    });
  });
  return { id, status: "uploaded" };
}

function sourceLocator(sourceRef: string): {
  locator: Record<string, unknown>;
  locatorType: "cell" | "paragraph";
} {
  const cell = /^R(\d+)C(\d+)$/u.exec(sourceRef);
  if (cell !== null) {
    return {
      locator: { column: Number(cell[2]), row: Number(cell[1]), sheet: "isolated" },
      locatorType: "cell",
    };
  }
  const paragraph = /^P(\d+)$/u.exec(sourceRef);
  if (paragraph !== null) {
    return { locator: { paragraph: Number(paragraph[1]) }, locatorType: "paragraph" };
  }
  throw new StudentImportConflictError("Unknown local source reference.");
}

function isolateMaterial(
  format: "csv" | "docx" | "markdown" | "text",
  text: string,
  scope: z.infer<typeof IncrementalScopeSchema>,
): IsolatedStudentMaterial {
  if (format === "csv") return isolateStudentCsv(text, scope.aliases);
  if (format === "docx" && scope.ownershipConfirmed) return paragraphMaterial(text);
  throw new StudentImportConflictError("Incremental evidence scope is invalid.");
}

export async function extractIncrementalStudentImportBatch(
  database: Database,
  objectStore: ImmutableObjectStore,
  provider: JsonModelProvider,
  rawContext: AuthorizationContext,
  untrustedBatchId: string,
  options: { now?: Date; requestCorrelationId?: string } = {},
): Promise<IncrementalSuggestionRecord[]> {
  const batchId = BatchIdSchema.parse(untrustedBatchId);
  const now = options.now ?? new Date();
  const context = await requireStudentWriteContext(database, rawContext, now);
  const rows = await database
    .select()
    .from(studentImportBatches)
    .where(
      and(
        eq(studentImportBatches.id, batchId),
        eq(studentImportBatches.kind, "incremental"),
        eq(studentImportBatches.selectedStudentId, context.studentId),
        eq(studentImportBatches.createdByUserId, context.actorUserId),
      ),
    )
    .limit(1);
  const batch = rows[0];
  if (batch === undefined) throw new StudentImportNotFoundError();
  if (batch.status !== "uploaded" && batch.status !== "failed") {
    throw new StudentImportConflictError("This incremental batch has already been extracted.");
  }
  await database
    .update(studentImportBatches)
    .set({ errorCode: null, status: "processing", updatedAt: now })
    .where(eq(studentImportBatches.id, batchId));
  try {
    const content = await objectStore.read({
      domain: "student_import",
      key: batch.storageKey,
      sha256: batch.contentHash,
      size: batch.byteCount,
    });
    const parsed = await parseStudentImportDocument({
      content: Buffer.from(content),
      fileName: batch.originalFileName,
      mimeType: batch.mimeType,
    });
    const scope = IncrementalScopeSchema.parse(batch.extractionScope);
    const sourceText =
      parsed.format === "csv"
        ? new TextDecoder("utf-8", { fatal: true }).decode(content)
        : parsed.modelText;
    const isolated = isolateMaterial(parsed.format, sourceText, scope);
    const redacted = redactSelectedStudentMaterial(isolated, scope.aliases);
    const extracted = await extractIncrementalFactSuggestions(provider, redacted);
    const derived = Buffer.from(isolated.text, "utf8");
    const stored = await objectStore.store({
      content: derived,
      domain: "student",
      studentId: context.studentId,
    });
    const evidenceId = randomUUID();
    const uniqueRefs = [...new Set(extracted.output.suggestions.map((item) => item.sourceRef))];
    const locatorIds = new Map(uniqueRefs.map((sourceRef) => [sourceRef, randomUUID()]));
    await database.transaction(async (transaction) => {
      await transaction.insert(evidenceObjects).values({
        accessLevel: "sensitive",
        byteCount: stored.size,
        contentHash: stored.sha256,
        createdAt: now,
        dataDomain: "student",
        id: evidenceId,
        mimeType: "text/plain",
        originalFileName: `isolated-${batch.originalFileName.replace(/[^A-Za-z0-9._-]/gu, "_")}`,
        storageKey: stored.key,
        studentId: context.studentId,
        uploadedByUserId: context.actorUserId,
      });
      if (uniqueRefs.length > 0) {
        await transaction.insert(evidenceLocators).values(
          uniqueRefs.map((sourceRef) => ({
            ...sourceLocator(sourceRef),
            createdAt: now,
            evidenceObjectId: evidenceId,
            id: locatorIds.get(sourceRef) ?? randomUUID(),
          })),
        );
        await transaction.insert(studentFactSuggestions).values(
          extracted.output.suggestions.map((suggestion) => ({
            batchId,
            confidence: suggestion.confidence,
            createdAt: now,
            fieldKey: suggestion.fieldKey,
            id: randomUUID(),
            informationNature: suggestion.informationNature,
            proposedValue: StudentFactValueSchema.parse(suggestion.value),
            sourceLocator: {
              evidenceLocatorId: locatorIds.get(suggestion.sourceRef),
              sourceRef: suggestion.sourceRef,
            },
            studentId: context.studentId,
          })),
        );
      }
      await transaction
        .update(studentImportBatches)
        .set({
          errorCode: null,
          model: extracted.provider.model,
          modelUsage: { ...extracted.provider.usage },
          status: "review_ready",
          updatedAt: now,
        })
        .where(eq(studentImportBatches.id, batchId));
    });
    return await readIncrementalSuggestions(database, rawContext, batchId, { now });
  } catch (error) {
    await database
      .update(studentImportBatches)
      .set({ errorCode: "incremental_extraction_failed", status: "failed", updatedAt: new Date() })
      .where(eq(studentImportBatches.id, batchId));
    throw error;
  }
}

export async function readIncrementalSuggestions(
  database: Database,
  rawContext: AuthorizationContext,
  untrustedBatchId: string,
  options: { now?: Date } = {},
): Promise<IncrementalSuggestionRecord[]> {
  const batchId = BatchIdSchema.parse(untrustedBatchId);
  const context = await requireStudentWriteContext(database, rawContext, options.now ?? new Date());
  const batch = await database
    .select({ id: studentImportBatches.id })
    .from(studentImportBatches)
    .where(
      and(
        eq(studentImportBatches.id, batchId),
        eq(studentImportBatches.selectedStudentId, context.studentId),
        eq(studentImportBatches.createdByUserId, context.actorUserId),
      ),
    )
    .limit(1);
  if (batch.length === 0) throw new StudentImportNotFoundError();
  const rows = await database
    .select({
      confidence: studentFactSuggestions.confidence,
      createdAt: studentFactSuggestions.createdAt,
      decision: studentFactSuggestions.decision,
      fieldKey: studentFactSuggestions.fieldKey,
      id: studentFactSuggestions.id,
      informationNature: studentFactSuggestions.informationNature,
      proposedValue: studentFactSuggestions.proposedValue,
      sourceLocator: studentFactSuggestions.sourceLocator,
    })
    .from(studentFactSuggestions)
    .where(
      and(
        eq(studentFactSuggestions.batchId, batchId),
        eq(studentFactSuggestions.studentId, context.studentId),
      ),
    )
    .orderBy(asc(studentFactSuggestions.createdAt));
  return rows.map((row) => ({
    ...row,
    sourceRef: typeof row.sourceLocator.sourceRef === "string" ? row.sourceLocator.sourceRef : "",
  }));
}

const DecideSuggestionSchema = z
  .object({
    decision: z.enum(["accepted", "rejected"]),
    editedFieldKey: z
      .string()
      .regex(/^[a-z][a-z0-9_.-]{0,127}$/u)
      .optional(),
    editedValue: StudentFactValueSchema.optional(),
    expectedCreatedAt: z.date(),
    suggestionId: z.uuid(),
  })
  .strict();

export async function decideIncrementalSuggestion(
  database: Database,
  rawContext: AuthorizationContext,
  untrustedInput: z.input<typeof DecideSuggestionSchema>,
  options: { now?: Date; requestCorrelationId?: string } = {},
): Promise<{ factId: string | null }> {
  const input = DecideSuggestionSchema.parse(untrustedInput);
  const suggestionId = SuggestionIdSchema.parse(input.suggestionId);
  const now = options.now ?? new Date();
  const context = await requireStudentWriteContext(database, rawContext, now);
  return database.transaction(async (transaction) => {
    const rows = await transaction
      .select()
      .from(studentFactSuggestions)
      .where(
        and(
          eq(studentFactSuggestions.id, suggestionId),
          eq(studentFactSuggestions.studentId, context.studentId),
        ),
      )
      .for("update")
      .limit(1);
    const suggestion = rows[0];
    if (suggestion === undefined) throw new StudentImportNotFoundError();
    if (
      suggestion.decision !== "pending" ||
      suggestion.createdAt.getTime() !== input.expectedCreatedAt.getTime()
    ) {
      throw new StudentImportConflictError("Suggestion is stale or already decided.");
    }
    if (input.decision === "rejected") {
      await transaction
        .update(studentFactSuggestions)
        .set({ decision: "rejected", decidedAt: now, decidedByUserId: context.actorUserId })
        .where(eq(studentFactSuggestions.id, suggestionId));
      return { factId: null };
    }
    const fieldKey = input.editedFieldKey ?? suggestion.fieldKey;
    const value = input.editedValue ?? StudentFactValueSchema.parse(suggestion.proposedValue);
    const locatorId = z.uuid().parse(suggestion.sourceLocator.evidenceLocatorId);
    const evidence = await transaction
      .select({ accessLevel: evidenceObjects.accessLevel, studentId: evidenceObjects.studentId })
      .from(evidenceLocators)
      .innerJoin(evidenceObjects, eq(evidenceObjects.id, evidenceLocators.evidenceObjectId))
      .where(eq(evidenceLocators.id, locatorId))
      .limit(1);
    if (evidence[0]?.studentId !== context.studentId || evidence[0].accessLevel !== "sensitive") {
      throw new StudentImportConflictError("Suggestion evidence is no longer valid.");
    }
    const current = await transaction
      .select({ id: studentFacts.id, validFrom: studentFacts.validFrom })
      .from(studentFacts)
      .where(
        and(
          eq(studentFacts.studentId, context.studentId),
          eq(studentFacts.fieldKey, fieldKey),
          isNull(studentFacts.validTo),
        ),
      )
      .for("update")
      .limit(1);
    const prior = current[0];
    if (prior !== undefined && now <= prior.validFrom) {
      throw new StudentImportConflictError("Fact revision time must follow the current fact.");
    }
    if (prior !== undefined) {
      await transaction
        .update(studentFacts)
        .set({ confirmationStatus: "superseded", updatedAt: now, validTo: now })
        .where(eq(studentFacts.id, prior.id));
    }
    const factId = randomUUID();
    await transaction.insert(studentFacts).values({
      accessLevel: "sensitive",
      confirmationStatus: "confirmed",
      createdAt: now,
      fieldKey,
      id: factId,
      sourceType: "import",
      studentId: context.studentId,
      supersedesId: prior?.id ?? null,
      updatedAt: now,
      validFrom: now,
      value,
    });
    await transaction.insert(factEvidence).values({
      createdAt: now,
      evidenceLocatorId: locatorId,
      relation: "supports",
      studentFactId: factId,
      validationStatus: "valid",
    });
    await transaction
      .update(studentFactSuggestions)
      .set({
        decision: "accepted",
        decidedAt: now,
        decidedByUserId: context.actorUserId,
        editedValue: input.editedValue ?? null,
        fieldKey,
        resultingFactId: factId,
      })
      .where(eq(studentFactSuggestions.id, suggestionId));
    const reason = `Accepted student fact suggestion ${suggestionId}.`;
    const profiles = await transaction
      .select({ id: profileVersions.id })
      .from(profileVersions)
      .where(
        and(
          eq(profileVersions.studentId, context.studentId),
          eq(profileVersions.status, "approved"),
        ),
      );
    for (const profile of profiles) {
      await transaction
        .update(profileVersions)
        .set({ invalidationReason: reason, status: "needs_review", updatedAt: now })
        .where(eq(profileVersions.id, profile.id));
      await transaction.insert(profileReviewRecords).values({
        action: "invalidated",
        actorType: "service",
        createdAt: now,
        fromStatus: "approved",
        profileVersionId: profile.id,
        reason,
        requestCorrelationId: options.requestCorrelationId ?? randomUUID(),
        toStatus: "needs_review",
      });
    }
    const plans = await transaction
      .select({ id: planVersions.id })
      .from(planVersions)
      .where(
        and(eq(planVersions.studentId, context.studentId), eq(planVersions.status, "approved")),
      );
    for (const plan of plans) {
      await transaction
        .update(planVersions)
        .set({ invalidationReason: reason, status: "needs_review", updatedAt: now })
        .where(eq(planVersions.id, plan.id));
      await transaction.insert(planReviewRecords).values({
        action: "invalidated",
        actorType: "service",
        createdAt: now,
        fromStatus: "approved",
        planVersionId: plan.id,
        reason,
        requestCorrelationId: options.requestCorrelationId ?? randomUUID(),
        toStatus: "needs_review",
      });
    }
    await transaction
      .update(courseRecommendations)
      .set({ status: "needs_review", updatedAt: now })
      .where(
        and(
          eq(courseRecommendations.studentId, context.studentId),
          eq(courseRecommendations.status, "accepted"),
        ),
      );
    await transaction.insert(auditEvents).values({
      action: "student.fact.suggestion.accept",
      actorType: "user",
      actorUserId: context.actorUserId,
      createdAt: now,
      details: { authorizationContextId: context.id, fieldKey },
      objectId: suggestionId,
      objectType: "student_fact_suggestion",
      requestCorrelationId: options.requestCorrelationId ?? randomUUID(),
      result: "allowed",
      studentId: context.studentId,
    });
    return { factId };
  });
}

export async function prepareIncrementalStudentImportTask(
  database: Database,
  rawContext: AuthorizationContext,
  untrustedBatchId: string,
  gitCommitSha: string,
  options: { now?: Date; correlationId?: string } = {},
): Promise<StudentEvidenceExtractTask> {
  const batchId = BatchIdSchema.parse(untrustedBatchId);
  const commit = z
    .string()
    .regex(/^[0-9a-f]{40}$/u)
    .parse(gitCommitSha);
  const context = await requireStudentWriteContext(database, rawContext, options.now ?? new Date());
  const rows = await database
    .select({ contentHash: studentImportBatches.contentHash, status: studentImportBatches.status })
    .from(studentImportBatches)
    .where(
      and(
        eq(studentImportBatches.id, batchId),
        eq(studentImportBatches.kind, "incremental"),
        eq(studentImportBatches.selectedStudentId, context.studentId),
        eq(studentImportBatches.createdByUserId, context.actorUserId),
      ),
    )
    .limit(1);
  const batch = rows[0];
  if (batch === undefined) throw new StudentImportNotFoundError();
  if (batch.status !== "uploaded" && batch.status !== "failed") {
    throw new StudentImportConflictError("This incremental batch cannot be queued again.");
  }
  return {
    authorization: { contextHash: context.contextHash, contextId: context.id },
    idempotencyKey: `student_evidence_${batchId.replaceAll("-", "")}`,
    payload: {
      batchId,
      contentHash: batch.contentHash,
      correlationId: options.correlationId ?? randomUUID(),
      gitCommitSha: commit,
      model: "deepseek-v4-flash",
      promptHash: INCREMENTAL_IMPORT_PROMPT_HASH,
      promptVersion: INCREMENTAL_IMPORT_PROMPT_VERSION,
      redactionVersion: INCREMENTAL_IMPORT_REDACTION_VERSION,
      schemaHash: INCREMENTAL_IMPORT_SCHEMA_HASH,
      schemaVersion: INCREMENTAL_IMPORT_SCHEMA_VERSION,
    },
    taskId: randomUUID(),
    taskName: "student.evidence.extract",
  };
}

export async function executeIncrementalStudentImportTask(
  database: Database,
  objectStore: ImmutableObjectStore,
  provider: JsonModelProvider,
  task: StudentEvidenceExtractTask,
): Promise<IncrementalSuggestionRecord[]> {
  if (
    task.payload.promptHash !== INCREMENTAL_IMPORT_PROMPT_HASH ||
    task.payload.schemaHash !== INCREMENTAL_IMPORT_SCHEMA_HASH
  ) {
    throw new StudentImportConflictError("Incremental import task versions do not match runtime.");
  }
  const context = await loadAuthorizationContext(database, {
    contextHash: task.authorization.contextHash,
    id: task.authorization.contextId,
  });
  const rows = await database
    .select({ contentHash: studentImportBatches.contentHash })
    .from(studentImportBatches)
    .where(eq(studentImportBatches.id, task.payload.batchId))
    .limit(1);
  if (rows[0]?.contentHash !== task.payload.contentHash) {
    throw new StudentImportConflictError("Incremental import content identity changed.");
  }
  return extractIncrementalStudentImportBatch(
    database,
    objectStore,
    provider,
    context,
    task.payload.batchId,
    { requestCorrelationId: task.payload.correlationId },
  );
}
