import { randomUUID } from "node:crypto";

import {
  AuthorizationContextSchema,
  assertAuthorizationContext,
  loadAuthorizationContext,
  type AuthorizationContext,
} from "@culiu/authorization";
import {
  auditEvents,
  evidenceLocators,
  evidenceObjects,
  factEvidence,
  studentAuthorizations,
  studentFactSuggestions,
  studentFacts,
  studentImportBatches,
  studentImportCandidates,
  students,
  type Database,
} from "@culiu/database/runtime";
import type { JsonModelProvider } from "@culiu/ai";
import type { ImmutableObjectStore } from "@culiu/storage";
import { StudentFactValueSchema } from "@culiu/student-records";
import type { StudentBasicExtractTask } from "@culiu/tasks";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

import {
  BASIC_IMPORT_PROMPT_VERSION,
  BASIC_IMPORT_PROMPT_HASH,
  BASIC_IMPORT_REDACTION_VERSION,
  BASIC_IMPORT_SCHEMA_HASH,
  BASIC_IMPORT_SCHEMA_VERSION,
  extractBasicStudentCandidates,
} from "./basic-extraction.js";
import {
  StudentImportUploadSchema,
  type BasicStudentImportModelOutput,
  type StudentImportUpload,
} from "./contracts.js";
import { parseStudentImportDocument } from "./document-parser.js";
import { redactParentPhones } from "./privacy.js";

const BatchIdSchema = z.uuid();
const CandidateIdSchema = z.uuid();

const ApplyBasicCandidateInputSchema = z
  .object({
    candidateId: z.uuid(),
    decision: z.enum(["create", "link", "rejected"]),
    fields: z
      .array(
        z
          .object({
            decision: z.enum(["accepted", "rejected"]),
            editedValue: z.string().trim().min(1).max(1000).optional(),
            suggestionId: z.uuid(),
          })
          .strict(),
      )
      .min(1)
      .max(6),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.fields.map((field) => field.suggestionId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "Suggestion decisions must be unique." });
    }
    if (
      (value.decision === "create" || value.decision === "link") &&
      !value.fields.some((field) => field.decision === "accepted")
    ) {
      context.addIssue({
        code: "custom",
        message: "Creating or linking a student requires an accepted field.",
      });
    }
  });
export type ApplyBasicCandidateInput = z.input<typeof ApplyBasicCandidateInputSchema>;

export class StudentImportConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StudentImportConflictError";
  }
}

export class StudentImportNotFoundError extends Error {
  constructor() {
    super("Student import was not found.");
    this.name = "StudentImportNotFoundError";
  }
}

async function requireImportContext(
  database: Database,
  rawContext: AuthorizationContext,
  now = new Date(),
): Promise<AuthorizationContext> {
  const parsed = AuthorizationContextSchema.parse(rawContext);
  const context = await loadAuthorizationContext(database, {
    actorUserId: parsed.actorUserId,
    contextHash: parsed.contextHash,
    id: parsed.id,
    now,
  });
  assertAuthorizationContext(context, {
    accessLevel: "restricted",
    action: "student:import",
    now,
    studentId: null,
  });
  return context;
}

function safeImportErrorCode(error: unknown): string {
  if (error instanceof z.ZodError) return "model_output_invalid";
  if (error instanceof Error && error.message.includes("phone placeholder")) {
    return "model_phone_token_invalid";
  }
  return "student_import_extraction_failed";
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase("zh-CN").replace(/\s+/gu, "");
}

async function findPossibleStudentMatches(
  database: Database,
  output: BasicStudentImportModelOutput,
): Promise<Map<number, string>> {
  const rows = await database
    .select({
      fieldKey: studentFacts.fieldKey,
      studentId: studentFacts.studentId,
      value: studentFacts.value,
    })
    .from(studentFacts)
    .where(
      and(
        isNull(studentFacts.validTo),
        eq(studentFacts.confirmationStatus, "confirmed"),
        inArray(studentFacts.fieldKey, [
          "identity.chinese_name",
          "identity.birth_date",
          "education.school",
        ]),
      ),
    );
  const factsByStudent = new Map<string, Map<string, string>>();
  for (const row of rows) {
    const text = typeof row.value.text === "string" ? normalized(row.value.text) : "";
    if (text === "") continue;
    const facts = factsByStudent.get(row.studentId) ?? new Map<string, string>();
    facts.set(row.fieldKey, text);
    factsByStudent.set(row.studentId, facts);
  }
  const matches = new Map<number, string>();
  for (const candidate of output.candidates) {
    const values = new Map(
      candidate.fields.map((field) => [field.fieldKey, normalized(field.value)] as const),
    );
    const chineseName = values.get("identity.chinese_name");
    if (chineseName === undefined) continue;
    const possible = [...factsByStudent.entries()].filter(([, facts]) => {
      if (facts.get("identity.chinese_name") !== chineseName) return false;
      return (["identity.birth_date", "education.school"] as const).some((key) => {
        const candidateValue = values.get(key);
        return candidateValue !== undefined && facts.get(key) === candidateValue;
      });
    });
    if (possible.length === 1 && possible[0] !== undefined) {
      matches.set(candidate.sourceOrdinal, possible[0][0]);
    }
  }
  return matches;
}

export interface StudentImportBatchSummary {
  readonly candidates: readonly {
    readonly decision: "create" | "link" | "pending" | "rejected";
    readonly displayLabel: string;
    readonly id: string;
    readonly possibleStudentId: string | null;
    readonly sourceOrdinal: number;
    readonly suggestions: readonly {
      readonly confidence: "high" | "low" | "medium" | "unknown";
      readonly decision: "accepted" | "pending" | "rejected";
      readonly fieldKey: string;
      readonly id: string;
      readonly proposedValue: Record<string, unknown>;
    }[];
  }[];
  readonly id: string;
  readonly originalFileName: string;
  readonly status:
    | "applied"
    | "failed"
    | "partially_applied"
    | "processing"
    | "review_ready"
    | "uploaded";
}

export async function createBasicStudentImportBatch(
  database: Database,
  objectStore: ImmutableObjectStore,
  rawContext: AuthorizationContext,
  untrustedUpload: StudentImportUpload,
  options: { now?: Date; requestCorrelationId?: string } = {},
): Promise<{ id: string; status: "uploaded" }> {
  const upload = StudentImportUploadSchema.parse(untrustedUpload);
  await parseStudentImportDocument(upload);
  const now = options.now ?? new Date();
  const context = await requireImportContext(database, rawContext, now);
  const stored = await objectStore.store({ content: upload.content, domain: "student_import" });
  const id = randomUUID();
  await database.transaction(async (transaction) => {
    await transaction.insert(studentImportBatches).values({
      authorizationContextId: context.id,
      byteCount: stored.size,
      contentHash: stored.sha256,
      createdAt: now,
      createdByUserId: context.actorUserId,
      id,
      kind: "basic",
      mimeType: upload.mimeType,
      originalFileName: upload.fileName,
      promptVersion: BASIC_IMPORT_PROMPT_VERSION,
      redactionVersion: BASIC_IMPORT_REDACTION_VERSION,
      schemaVersion: BASIC_IMPORT_SCHEMA_VERSION,
      status: "uploaded",
      storageKey: stored.key,
      updatedAt: now,
    });
    await transaction.insert(auditEvents).values({
      action: "student.import.upload",
      actorType: "user",
      actorUserId: context.actorUserId,
      createdAt: now,
      details: { authorizationContextId: context.id, byteCount: stored.size, kind: "basic" },
      objectId: id,
      objectType: "student_import",
      requestCorrelationId: options.requestCorrelationId ?? randomUUID(),
      result: "allowed",
      studentId: null,
    });
  });
  return { id, status: "uploaded" };
}

export async function extractBasicStudentImportBatch(
  database: Database,
  objectStore: ImmutableObjectStore,
  provider: JsonModelProvider,
  rawContext: AuthorizationContext,
  untrustedBatchId: string,
  options: { now?: Date; requestCorrelationId?: string } = {},
): Promise<StudentImportBatchSummary> {
  const batchId = BatchIdSchema.parse(untrustedBatchId);
  const now = options.now ?? new Date();
  const context = await requireImportContext(database, rawContext, now);
  const rows = await database
    .select()
    .from(studentImportBatches)
    .where(
      and(
        eq(studentImportBatches.id, batchId),
        eq(studentImportBatches.kind, "basic"),
        eq(studentImportBatches.createdByUserId, context.actorUserId),
      ),
    )
    .limit(1);
  const batch = rows[0];
  if (batch === undefined) throw new StudentImportNotFoundError();
  if (batch.status !== "uploaded" && batch.status !== "failed") {
    throw new StudentImportConflictError("This import batch has already been extracted.");
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
    const extracted = await extractBasicStudentCandidates(
      provider,
      redactParentPhones(parsed.modelText),
    );
    const possibleMatches = await findPossibleStudentMatches(database, extracted.modelOutput);
    await database.transaction(async (transaction) => {
      for (const candidate of extracted.modelOutput.candidates) {
        const candidateId = randomUUID();
        await transaction.insert(studentImportCandidates).values({
          batchId,
          createdAt: now,
          displayLabel: candidate.displayLabel,
          id: candidateId,
          possibleStudentId: possibleMatches.get(candidate.sourceOrdinal) ?? null,
          sourceLocator: { sourceOrdinal: candidate.sourceOrdinal },
          sourceOrdinal: candidate.sourceOrdinal,
        });
        await transaction.insert(studentFactSuggestions).values(
          candidate.fields.map((field) => ({
            batchId,
            candidateId,
            confidence: field.confidence,
            createdAt: now,
            fieldKey: field.fieldKey,
            id: randomUUID(),
            proposedValue: StudentFactValueSchema.parse({ text: field.value }),
            sourceLocator: field.sourceLocator,
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
      await transaction.insert(auditEvents).values({
        action: "student.import.extract",
        actorType: "user",
        actorUserId: context.actorUserId,
        createdAt: now,
        details: {
          authorizationContextId: context.id,
          candidateCount: extracted.modelOutput.candidates.length,
          kind: "basic",
        },
        objectId: batchId,
        objectType: "student_import",
        requestCorrelationId: options.requestCorrelationId ?? randomUUID(),
        result: "allowed",
        studentId: null,
      });
    });
  } catch (error) {
    await database
      .update(studentImportBatches)
      .set({ errorCode: safeImportErrorCode(error), status: "failed", updatedAt: new Date() })
      .where(eq(studentImportBatches.id, batchId));
    throw error;
  }
  return readStudentImportBatch(database, rawContext, batchId, options);
}

export async function readStudentImportBatch(
  database: Database,
  rawContext: AuthorizationContext,
  untrustedBatchId: string,
  options: { now?: Date } = {},
): Promise<StudentImportBatchSummary> {
  const batchId = BatchIdSchema.parse(untrustedBatchId);
  const context = await requireImportContext(database, rawContext, options.now ?? new Date());
  const batches = await database
    .select({
      id: studentImportBatches.id,
      originalFileName: studentImportBatches.originalFileName,
      status: studentImportBatches.status,
    })
    .from(studentImportBatches)
    .where(
      and(
        eq(studentImportBatches.id, batchId),
        eq(studentImportBatches.createdByUserId, context.actorUserId),
      ),
    )
    .limit(1);
  const batch = batches[0];
  if (batch === undefined) throw new StudentImportNotFoundError();
  const candidates = await database
    .select({
      decision: studentImportCandidates.decision,
      displayLabel: studentImportCandidates.displayLabel,
      id: studentImportCandidates.id,
      possibleStudentId: studentImportCandidates.possibleStudentId,
      sourceOrdinal: studentImportCandidates.sourceOrdinal,
    })
    .from(studentImportCandidates)
    .where(eq(studentImportCandidates.batchId, batchId))
    .orderBy(asc(studentImportCandidates.sourceOrdinal));
  const suggestions = await database
    .select({
      candidateId: studentFactSuggestions.candidateId,
      confidence: studentFactSuggestions.confidence,
      decision: studentFactSuggestions.decision,
      fieldKey: studentFactSuggestions.fieldKey,
      id: studentFactSuggestions.id,
      proposedValue: studentFactSuggestions.proposedValue,
    })
    .from(studentFactSuggestions)
    .where(eq(studentFactSuggestions.batchId, batchId))
    .orderBy(asc(studentFactSuggestions.createdAt));
  return {
    ...batch,
    candidates: candidates.map((candidate) => ({
      ...candidate,
      suggestions: suggestions
        .filter((suggestion) => suggestion.candidateId === candidate.id)
        .map((suggestion) => ({
          confidence: suggestion.confidence,
          decision: suggestion.decision,
          fieldKey: suggestion.fieldKey,
          id: suggestion.id,
          proposedValue: suggestion.proposedValue,
        })),
    })),
  };
}

function factAccessLevel(): "restricted" {
  return "restricted";
}

export async function applyBasicStudentImportCandidate(
  database: Database,
  objectStore: ImmutableObjectStore,
  rawContext: AuthorizationContext,
  untrustedInput: ApplyBasicCandidateInput,
  options: { now?: Date; requestCorrelationId?: string } = {},
): Promise<{ studentId: string | null }> {
  const input = ApplyBasicCandidateInputSchema.parse(untrustedInput);
  const now = options.now ?? new Date();
  const context = await requireImportContext(database, rawContext, now);
  const candidateId = CandidateIdSchema.parse(input.candidateId);
  const rows = await database
    .select({
      batchId: studentImportCandidates.batchId,
      decision: studentImportCandidates.decision,
      ownerUserId: studentImportBatches.createdByUserId,
      possibleStudentId: studentImportCandidates.possibleStudentId,
    })
    .from(studentImportCandidates)
    .innerJoin(studentImportBatches, eq(studentImportBatches.id, studentImportCandidates.batchId))
    .where(eq(studentImportCandidates.id, candidateId))
    .limit(1);
  const candidate = rows[0];
  if (candidate === undefined || candidate.ownerUserId !== context.actorUserId) {
    throw new StudentImportNotFoundError();
  }
  if (candidate.decision !== "pending") {
    throw new StudentImportConflictError("This candidate has already been decided.");
  }
  const suggestions = await database
    .select()
    .from(studentFactSuggestions)
    .where(eq(studentFactSuggestions.candidateId, candidateId));
  const requestedById = new Map(input.fields.map((field) => [field.suggestionId, field]));
  if (
    requestedById.size !== suggestions.length ||
    suggestions.some((suggestion) => !requestedById.has(suggestion.id))
  ) {
    throw new StudentImportConflictError("Every extracted field must receive one decision.");
  }
  if (input.decision === "rejected") {
    await database.transaction(async (transaction) => {
      await transaction
        .update(studentFactSuggestions)
        .set({ decision: "rejected", decidedAt: now, decidedByUserId: context.actorUserId })
        .where(eq(studentFactSuggestions.candidateId, candidateId));
      await transaction
        .update(studentImportCandidates)
        .set({ decision: "rejected", decidedAt: now, decidedByUserId: context.actorUserId })
        .where(eq(studentImportCandidates.id, candidateId));
    });
    await refreshBatchApplicationStatus(database, candidate.batchId, now);
    return { studentId: null };
  }

  if (input.decision === "link" && candidate.possibleStudentId === null) {
    throw new StudentImportConflictError("This candidate has no unique existing student match.");
  }
  const studentId = input.decision === "link" ? candidate.possibleStudentId : randomUUID();
  if (studentId === null) {
    throw new StudentImportConflictError("The linked student is unavailable.");
  }
  const accepted = suggestions.flatMap((suggestion) => {
    const requested = requestedById.get(suggestion.id);
    if (requested?.decision !== "accepted") return [];
    const originalText = suggestion.proposedValue.text;
    if (typeof originalText !== "string") {
      throw new StudentImportConflictError("Extracted field value is invalid.");
    }
    const text = requested.editedValue ?? originalText;
    return [{ ...suggestion, value: StudentFactValueSchema.parse({ text }) }];
  });
  const derivedContent = Buffer.from(
    JSON.stringify({
      candidateId,
      fields: accepted.map((suggestion) => ({
        fieldKey: suggestion.fieldKey,
        sourceLocator: suggestion.sourceLocator,
        value: suggestion.value,
      })),
      sourceBatchId: candidate.batchId,
    }),
    "utf8",
  );
  const stored = await objectStore.store({ content: derivedContent, domain: "student", studentId });
  const evidenceId = randomUUID();
  const locatorBySuggestion = new Map(accepted.map((suggestion) => [suggestion.id, randomUUID()]));
  await database.transaction(async (transaction) => {
    if (input.decision === "create") {
      await transaction.insert(students).values({
        createdAt: now,
        id: studentId,
        ownerUserId: context.actorUserId,
        privacyLevel: "restricted",
        publicCode: `STU-${studentId.slice(0, 8).toUpperCase()}`,
        updatedAt: now,
      });
      await transaction.insert(studentAuthorizations).values({
        allowedActions: [
          "student:read",
          "student:write",
          "student:profile:generate",
          "student:recommendation:generate",
          "student:recommendation:review",
          "student:profile:review",
          "student:profile:approve",
          "student:plan:write",
          "student:plan:review",
          "student:plan:approve",
          "student:plan:export",
        ],
        createdAt: now,
        grantedByUserId: context.actorUserId,
        maxAccessLevel: "restricted",
        studentId,
        userId: context.actorUserId,
        validFrom: now,
      });
    }
    await transaction.insert(evidenceObjects).values({
      accessLevel: "restricted",
      byteCount: stored.size,
      contentHash: stored.sha256,
      createdAt: now,
      dataDomain: "student",
      id: evidenceId,
      mimeType: "application/vnd.culiu.student-import+json",
      originalFileName: "student-import-derived.json",
      storageKey: stored.key,
      studentId,
      uploadedByUserId: context.actorUserId,
      version: 1,
    });
    await transaction.insert(evidenceLocators).values(
      accepted.map((suggestion) => ({
        createdAt: now,
        evidenceObjectId: evidenceId,
        id: locatorBySuggestion.get(suggestion.id) ?? randomUUID(),
        locator: { field: suggestion.fieldKey },
        locatorType: "record_field" as const,
      })),
    );
    for (const suggestion of suggestions) {
      const requested = requestedById.get(suggestion.id);
      if (requested?.decision !== "accepted") {
        await transaction
          .update(studentFactSuggestions)
          .set({ decision: "rejected", decidedAt: now, decidedByUserId: context.actorUserId })
          .where(eq(studentFactSuggestions.id, suggestion.id));
        continue;
      }
      const acceptedSuggestion = accepted.find((entry) => entry.id === suggestion.id);
      const locatorId = locatorBySuggestion.get(suggestion.id);
      if (acceptedSuggestion === undefined || locatorId === undefined) {
        throw new StudentImportConflictError("Accepted field could not be materialized.");
      }
      const current =
        input.decision === "link"
          ? await transaction
              .select({
                id: studentFacts.id,
                validFrom: studentFacts.validFrom,
                value: studentFacts.value,
              })
              .from(studentFacts)
              .where(
                and(
                  eq(studentFacts.studentId, studentId),
                  eq(studentFacts.fieldKey, suggestion.fieldKey),
                  isNull(studentFacts.validTo),
                ),
              )
              .for("update")
              .limit(1)
          : [];
      const prior = current[0];
      const unchanged =
        prior !== undefined &&
        JSON.stringify(prior.value) === JSON.stringify(acceptedSuggestion.value);
      let factId = prior?.id ?? randomUUID();
      if (!unchanged) {
        if (prior !== undefined) {
          if (now <= prior.validFrom) {
            throw new StudentImportConflictError(
              "Linked fact revision time must follow the current fact.",
            );
          }
          await transaction
            .update(studentFacts)
            .set({ confirmationStatus: "superseded", updatedAt: now, validTo: now })
            .where(eq(studentFacts.id, prior.id));
          factId = randomUUID();
        }
        await transaction.insert(studentFacts).values({
          accessLevel: factAccessLevel(),
          confirmationStatus: "confirmed",
          createdAt: now,
          fieldKey: suggestion.fieldKey,
          id: factId,
          sourceType: "import",
          studentId,
          ...(prior === undefined ? {} : { supersedesId: prior.id }),
          updatedAt: now,
          validFrom: now,
          value: acceptedSuggestion.value,
        });
      }
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
          editedValue:
            requested.editedValue === undefined
              ? null
              : StudentFactValueSchema.parse({ text: requested.editedValue }),
          resultingFactId: factId,
        })
        .where(eq(studentFactSuggestions.id, suggestion.id));
    }
    await transaction
      .update(studentImportCandidates)
      .set({
        createdStudentId: input.decision === "create" ? studentId : null,
        decision: input.decision,
        decidedAt: now,
        decidedByUserId: context.actorUserId,
      })
      .where(eq(studentImportCandidates.id, candidateId));
    await transaction.insert(auditEvents).values({
      action:
        input.decision === "create"
          ? "student.import.candidate.create"
          : "student.import.candidate.link",
      actorType: "user",
      actorUserId: context.actorUserId,
      createdAt: now,
      details: {
        acceptedFieldCount: accepted.length,
        authorizationContextId: context.id,
        rejectedFieldCount: suggestions.length - accepted.length,
      },
      objectId: candidateId,
      objectType: "student_import_candidate",
      requestCorrelationId: options.requestCorrelationId ?? randomUUID(),
      result: "allowed",
      studentId,
    });
  });
  await refreshBatchApplicationStatus(database, candidate.batchId, now);
  return { studentId };
}

async function refreshBatchApplicationStatus(
  database: Database,
  batchId: string,
  now: Date,
): Promise<void> {
  const candidates = await database
    .select({ decision: studentImportCandidates.decision })
    .from(studentImportCandidates)
    .where(eq(studentImportCandidates.batchId, batchId));
  const status = candidates.every((candidate) => candidate.decision !== "pending")
    ? "applied"
    : "partially_applied";
  await database
    .update(studentImportBatches)
    .set({ status, updatedAt: now })
    .where(eq(studentImportBatches.id, batchId));
}

export async function prepareBasicStudentImportTask(
  database: Database,
  rawContext: AuthorizationContext,
  untrustedBatchId: string,
  gitCommitSha: string,
  options: { now?: Date; correlationId?: string } = {},
): Promise<StudentBasicExtractTask> {
  const batchId = BatchIdSchema.parse(untrustedBatchId);
  const parsedGitCommit = z
    .string()
    .regex(/^[0-9a-f]{40}$/u)
    .parse(gitCommitSha);
  const context = await requireImportContext(database, rawContext, options.now ?? new Date());
  const rows = await database
    .select({ contentHash: studentImportBatches.contentHash, status: studentImportBatches.status })
    .from(studentImportBatches)
    .where(
      and(
        eq(studentImportBatches.id, batchId),
        eq(studentImportBatches.createdByUserId, context.actorUserId),
        eq(studentImportBatches.kind, "basic"),
      ),
    )
    .limit(1);
  const batch = rows[0];
  if (batch === undefined) throw new StudentImportNotFoundError();
  if (batch.status !== "uploaded" && batch.status !== "failed") {
    throw new StudentImportConflictError("This import batch cannot be queued again.");
  }
  return {
    authorization: { contextHash: context.contextHash, contextId: context.id },
    idempotencyKey: `student_basic_${batchId.replaceAll("-", "")}`,
    payload: {
      batchId,
      contentHash: batch.contentHash,
      correlationId: options.correlationId ?? randomUUID(),
      gitCommitSha: parsedGitCommit,
      model: "deepseek-v4-flash",
      promptHash: BASIC_IMPORT_PROMPT_HASH,
      promptVersion: BASIC_IMPORT_PROMPT_VERSION,
      redactionVersion: BASIC_IMPORT_REDACTION_VERSION,
      schemaHash: BASIC_IMPORT_SCHEMA_HASH,
      schemaVersion: BASIC_IMPORT_SCHEMA_VERSION,
    },
    taskId: randomUUID(),
    taskName: "student.basic.extract",
  };
}

export async function executeBasicStudentImportTask(
  database: Database,
  objectStore: ImmutableObjectStore,
  provider: JsonModelProvider,
  task: StudentBasicExtractTask,
): Promise<StudentImportBatchSummary> {
  if (
    task.payload.promptHash !== BASIC_IMPORT_PROMPT_HASH ||
    task.payload.schemaHash !== BASIC_IMPORT_SCHEMA_HASH
  ) {
    throw new StudentImportConflictError("Student import task versions do not match runtime.");
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
    throw new StudentImportConflictError("Student import content identity changed.");
  }
  return extractBasicStudentImportBatch(
    database,
    objectStore,
    provider,
    context,
    task.payload.batchId,
    { requestCorrelationId: task.payload.correlationId },
  );
}
