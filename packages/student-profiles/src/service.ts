import { createHash, randomUUID } from "node:crypto";

import { DEEPSEEK_PROFILE_MODEL, ModelGatewayError, type JsonModelProvider } from "@culiu/ai";
import {
  AuthorizationContextSchema,
  AuthorizationDeniedError,
  assertAuthorizationContext,
  loadAuthorizationContext,
  type AuthorizationContext,
} from "@culiu/authorization";
import {
  auditEvents,
  authorizationContextSnapshots,
  backgroundJobs,
  claimEvidence,
  evidenceInvalidations,
  evidenceLocators,
  evidenceObjects,
  factEvidence,
  modelTaskRuns,
  profileClaims,
  profileInputSnapshotEvidence,
  profileInputSnapshotFacts,
  profileInputSnapshots,
  profileVersions,
  studentFacts,
  students,
  type Database,
} from "@culiu/database/runtime";
import { ProfileDraftTaskSchema, type ProfileDraftTask } from "@culiu/tasks";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import {
  PROFILE_PRICING_VERSION,
  PROFILE_PROMPT_HASH,
  PROFILE_PROMPT_VERSION,
  PROFILE_REDACTION_VERSION,
  PROFILE_SCHEMA_HASH,
  PROFILE_SCHEMA_VERSION,
  PROFILE_SYSTEM_PROMPT,
  ProfileInputSnapshotPayloadSchema,
  buildProfileUserPrompt,
  estimateDeepSeekFlashCostMicrosCny,
  isProfileOutboundFieldAllowed,
  profileOutputHash,
  sanitizeProfileFactValue,
  sha256,
  stableJson,
  validateProfileOutputAgainstSnapshot,
  type ProfileDraftOutput,
  type ProfileInputSnapshotPayload,
} from "./contracts.js";
import {
  ProfileDraftConflictError,
  ProfileDraftInputError,
  ProfileDraftNotFoundError,
  ProfileDraftProcessingError,
} from "./errors.js";

const GitCommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const MAX_FACTS = 50;
const PROFILE_LEASE_MS = 90_000;

function deterministicUuid(input: string): string {
  const bytes = Buffer.from(createHash("sha256").update(input, "utf8").digest().subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function requireProfileContext(
  database: Database,
  rawContext: AuthorizationContext,
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
    action: "student:profile:generate",
    now,
    studentId: context.studentId,
  });
  return { ...context, studentId: context.studentId };
}

async function buildSnapshot(
  database: Database,
  studentId: string,
  publicCode: string,
): Promise<ProfileInputSnapshotPayload> {
  const facts = await database
    .select({
      fieldKey: studentFacts.fieldKey,
      id: studentFacts.id,
      sourceType: studentFacts.sourceType,
      value: studentFacts.value,
    })
    .from(studentFacts)
    .where(
      and(
        eq(studentFacts.studentId, studentId),
        eq(studentFacts.confirmationStatus, "confirmed"),
        isNull(studentFacts.validTo),
        sql`${studentFacts.accessLevel} in ('internal', 'sensitive')`,
      ),
    )
    .orderBy(asc(studentFacts.createdAt));
  const currentCandidates = facts.filter((fact) => isProfileOutboundFieldAllowed(fact.fieldKey));
  if (currentCandidates.length === 0) throw new ProfileDraftInputError("No eligible facts.");
  const candidateIds = currentCandidates.map((fact) => fact.id);
  const childRows = await database
    .select({ supersedesId: studentFacts.supersedesId })
    .from(studentFacts)
    .where(and(eq(studentFacts.studentId, studentId), isNotNull(studentFacts.supersedesId)));
  const superseded = new Set(
    childRows.flatMap((row) => (row.supersedesId === null ? [] : [row.supersedesId])),
  );
  const links = await database
    .select({
      evidenceId: evidenceObjects.id,
      evidenceStudentId: evidenceObjects.studentId,
      invalidationId: evidenceInvalidations.id,
      locatorId: factEvidence.evidenceLocatorId,
      relation: factEvidence.relation,
      studentFactId: factEvidence.studentFactId,
      validationStatus: factEvidence.validationStatus,
    })
    .from(factEvidence)
    .innerJoin(evidenceLocators, eq(evidenceLocators.id, factEvidence.evidenceLocatorId))
    .innerJoin(evidenceObjects, eq(evidenceObjects.id, evidenceLocators.evidenceObjectId))
    .leftJoin(evidenceInvalidations, eq(evidenceInvalidations.evidenceObjectId, evidenceObjects.id))
    .where(
      and(
        inArray(factEvidence.studentFactId, candidateIds),
        eq(evidenceObjects.dataDomain, "student"),
        eq(evidenceObjects.studentId, studentId),
        sql`${evidenceObjects.accessLevel} in ('internal', 'sensitive')`,
      ),
    );
  const evidenceIds = [...new Set(links.map((link) => link.evidenceId))];
  const evidenceChildren =
    evidenceIds.length === 0
      ? []
      : await database
          .select({ supersedesId: evidenceObjects.supersedesId })
          .from(evidenceObjects)
          .where(inArray(evidenceObjects.supersedesId, evidenceIds));
  const supersededEvidence = new Set(
    evidenceChildren.flatMap((row) => (row.supersedesId === null ? [] : [row.supersedesId])),
  );
  const validLinks = links.filter(
    (link) =>
      link.evidenceStudentId === studentId &&
      link.invalidationId === null &&
      link.validationStatus === "valid" &&
      !supersededEvidence.has(link.evidenceId),
  );
  const snapshotFacts = currentCandidates
    .filter((fact) => !superseded.has(fact.id))
    .map((fact) => ({
      evidence: validLinks
        .filter((link) => link.studentFactId === fact.id)
        .map((link) => ({ locatorId: link.locatorId, relation: link.relation })),
      factId: fact.id,
      fieldKey: fact.fieldKey,
      sourceType: fact.sourceType === "import" ? "evidence" : fact.sourceType,
      value: sanitizeProfileFactValue(fact.value, publicCode),
    }))
    .filter((fact) => fact.evidence.length > 0)
    .slice(0, MAX_FACTS);
  if (snapshotFacts.length === 0) {
    throw new ProfileDraftInputError("No current confirmed facts with valid evidence.");
  }
  return ProfileInputSnapshotPayloadSchema.parse({
    facts: snapshotFacts,
    redactionVersion: PROFILE_REDACTION_VERSION,
  });
}

export interface PreparedProfileDraftTask {
  readonly reused: boolean;
  readonly task: ProfileDraftTask;
}

export async function prepareProfileDraftTask(
  database: Database,
  rawContext: AuthorizationContext,
  options: { correlationId?: string; gitCommitSha: string; now?: Date },
): Promise<PreparedProfileDraftTask> {
  const now = options.now ?? new Date();
  const gitCommitSha = GitCommitShaSchema.parse(options.gitCommitSha);
  const correlationId = options.correlationId ?? randomUUID();
  const context = await requireProfileContext(database, rawContext, now);
  const studentRows = await database
    .select({ publicCode: students.publicCode })
    .from(students)
    .where(and(eq(students.id, context.studentId), eq(students.status, "active")))
    .limit(1);
  const student = studentRows[0];
  if (student === undefined) throw new ProfileDraftNotFoundError();
  const snapshot = await buildSnapshot(database, context.studentId, student.publicCode);
  const inputSnapshotHash = sha256(stableJson(snapshot));
  const snapshotId = deterministicUuid(
    `profile-snapshot:${context.studentId}:${context.actorUserId}:${PROFILE_REDACTION_VERSION}:${inputSnapshotHash}`,
  );
  const taskId = deterministicUuid(
    `profile-task:${snapshotId}:${PROFILE_PROMPT_HASH}:${PROFILE_SCHEMA_HASH}:${DEEPSEEK_PROFILE_MODEL}`,
  );
  const idempotencyKey = `profile_${taskId.replaceAll("-", "")}`;
  const task = ProfileDraftTaskSchema.parse({
    authorization: { contextHash: context.contextHash, contextId: context.id },
    idempotencyKey,
    payload: {
      correlationId,
      gitCommitSha,
      inputSnapshotHash,
      inputSnapshotId: snapshotId,
      model: DEEPSEEK_PROFILE_MODEL,
      pricingVersion: PROFILE_PRICING_VERSION,
      promptHash: PROFILE_PROMPT_HASH,
      promptVersion: PROFILE_PROMPT_VERSION,
      redactionVersion: PROFILE_REDACTION_VERSION,
      schemaHash: PROFILE_SCHEMA_HASH,
      schemaVersion: PROFILE_SCHEMA_VERSION,
    },
    taskId,
    taskName: "profile.draft",
  });

  return database.transaction(async (transaction) => {
    const existing = await transaction
      .select({
        contextHash: authorizationContextSnapshots.contextHash,
        contextId: modelTaskRuns.authorizationContextId,
        correlationId: modelTaskRuns.requestCorrelationId,
        gitCommitSha: modelTaskRuns.gitCommitSha,
      })
      .from(backgroundJobs)
      .innerJoin(modelTaskRuns, eq(modelTaskRuns.backgroundJobId, backgroundJobs.id))
      .innerJoin(
        authorizationContextSnapshots,
        eq(authorizationContextSnapshots.id, modelTaskRuns.authorizationContextId),
      )
      .where(eq(backgroundJobs.id, taskId))
      .limit(1);
    const existingTask = existing[0];
    if (existingTask !== undefined) {
      return {
        reused: true,
        task: ProfileDraftTaskSchema.parse({
          ...task,
          authorization: {
            contextHash: existingTask.contextHash,
            contextId: existingTask.contextId,
          },
          payload: {
            ...task.payload,
            correlationId: existingTask.correlationId,
            gitCommitSha: existingTask.gitCommitSha,
          },
        }),
      };
    }
    await transaction.insert(profileInputSnapshots).values({
      authorizationContextId: context.id,
      createdAt: now,
      createdByUserId: context.actorUserId,
      evidenceLocatorCount: new Set(
        snapshot.facts.flatMap((fact) => fact.evidence.map((evidence) => evidence.locatorId)),
      ).size,
      factCount: snapshot.facts.length,
      id: snapshotId,
      payload: snapshot,
      redactionVersion: PROFILE_REDACTION_VERSION,
      snapshotHash: inputSnapshotHash,
      studentId: context.studentId,
    });
    await transaction.insert(profileInputSnapshotFacts).values(
      snapshot.facts.map((fact) => ({
        createdAt: now,
        snapshotId,
        studentFactId: fact.factId,
      })),
    );
    await transaction
      .insert(profileInputSnapshotEvidence)
      .values(
        [
          ...new Set(snapshot.facts.flatMap((fact) => fact.evidence.map((item) => item.locatorId))),
        ].map((evidenceLocatorId) => ({ createdAt: now, evidenceLocatorId, snapshotId })),
      );
    await transaction.insert(backgroundJobs).values({
      authorizationContextId: context.id,
      createdAt: now,
      id: taskId,
      idempotencyKey,
      maxAttempts: 3,
      status: "queued",
      taskName: "profile.draft",
    });
    await transaction.insert(modelTaskRuns).values({
      authorizationContextId: context.id,
      backgroundJobId: taskId,
      createdAt: now,
      gitCommitSha,
      id: taskId,
      inputSnapshotHash,
      inputSnapshotId: snapshotId,
      model: DEEPSEEK_PROFILE_MODEL,
      pricingVersion: PROFILE_PRICING_VERSION,
      promptHash: PROFILE_PROMPT_HASH,
      promptVersion: PROFILE_PROMPT_VERSION,
      provider: "deepseek",
      requestCorrelationId: correlationId,
      redactionVersion: PROFILE_REDACTION_VERSION,
      schemaHash: PROFILE_SCHEMA_HASH,
      schemaVersion: PROFILE_SCHEMA_VERSION,
      status: "queued",
      studentId: context.studentId,
      taskType: "profile.draft",
    });
    await transaction.insert(auditEvents).values({
      action: "student.profile.draft.enqueue",
      actorType: "user",
      actorUserId: context.actorUserId,
      createdAt: now,
      details: {
        authorizationContextId: context.id,
        evidenceLocatorCount: new Set(
          snapshot.facts.flatMap((fact) => fact.evidence.map((item) => item.locatorId)),
        ).size,
        factCount: snapshot.facts.length,
        inputSnapshotHash,
        model: DEEPSEEK_PROFILE_MODEL,
      },
      objectId: taskId,
      objectType: "model_task_run",
      requestCorrelationId: correlationId,
      result: "allowed",
      studentId: context.studentId,
    });
    return { reused: false, task };
  });
}

async function claimProfileTask(
  database: Database,
  task: ProfileDraftTask,
  now: Date,
): Promise<{ attempt: number; claimToken: string } | null> {
  return database.transaction(async (transaction) => {
    const rows = await transaction
      .select({
        attempts: backgroundJobs.attempts,
        leaseExpiresAt: backgroundJobs.leaseExpiresAt,
        maxAttempts: backgroundJobs.maxAttempts,
        status: backgroundJobs.status,
      })
      .from(backgroundJobs)
      .where(eq(backgroundJobs.id, task.taskId))
      .for("update")
      .limit(1);
    const job = rows[0];
    if (job === undefined) throw new ProfileDraftNotFoundError();
    if (job.status === "succeeded") return null;
    if (job.status === "running" && job.leaseExpiresAt !== null && job.leaseExpiresAt > now) {
      throw new ProfileDraftConflictError("Task is already running.");
    }
    if (job.attempts >= job.maxAttempts || job.status === "canceled") {
      throw new ProfileDraftConflictError("Task has no remaining attempts.");
    }
    const claimToken = randomUUID();
    const attempt = job.attempts + 1;
    const leaseExpiresAt = new Date(now.getTime() + PROFILE_LEASE_MS);
    await transaction
      .update(backgroundJobs)
      .set({
        attempts: attempt,
        claimToken,
        completedAt: null,
        errorCode: null,
        leaseExpiresAt,
        resultReference: null,
        startedAt: now,
        status: "running",
      })
      .where(eq(backgroundJobs.id, task.taskId));
    await transaction
      .update(modelTaskRuns)
      .set({
        attemptCount: attempt,
        completedAt: null,
        errorCode: null,
        startedAt: now,
        status: "running",
      })
      .where(eq(modelTaskRuns.id, task.taskId));
    return { attempt, claimToken };
  });
}

async function validateFrozenSnapshot(
  database: Database,
  task: ProfileDraftTask,
): Promise<{ actorUserId: string; snapshot: ProfileInputSnapshotPayload; studentId: string }> {
  const rows = await database
    .select({
      actorUserId: profileInputSnapshots.createdByUserId,
      authorizationContextId: profileInputSnapshots.authorizationContextId,
      payload: profileInputSnapshots.payload,
      snapshotHash: profileInputSnapshots.snapshotHash,
      studentId: profileInputSnapshots.studentId,
    })
    .from(profileInputSnapshots)
    .where(eq(profileInputSnapshots.id, task.payload.inputSnapshotId))
    .limit(1);
  const row = rows[0];
  if (
    row === undefined ||
    row.authorizationContextId !== task.authorization.contextId ||
    row.snapshotHash !== task.payload.inputSnapshotHash
  ) {
    throw new ProfileDraftProcessingError("snapshot_mismatch");
  }
  const context = await loadAuthorizationContext(database, {
    actorUserId: row.actorUserId,
    contextHash: task.authorization.contextHash,
    id: task.authorization.contextId,
  });
  assertAuthorizationContext(context, {
    accessLevel: "sensitive",
    action: "student:profile:generate",
    studentId: row.studentId,
  });
  const snapshot = ProfileInputSnapshotPayloadSchema.parse(row.payload);
  if (sha256(stableJson(snapshot)) !== row.snapshotHash) {
    throw new ProfileDraftProcessingError("snapshot_hash_invalid");
  }
  const factIds = snapshot.facts.map((fact) => fact.factId);
  const locatorIds = [
    ...new Set(snapshot.facts.flatMap((fact) => fact.evidence.map((e) => e.locatorId))),
  ];
  const factRows = await database
    .select({ id: studentFacts.id })
    .from(studentFacts)
    .where(
      and(
        inArray(studentFacts.id, factIds),
        eq(studentFacts.studentId, row.studentId),
        eq(studentFacts.confirmationStatus, "confirmed"),
        isNull(studentFacts.validTo),
        sql`${studentFacts.accessLevel} in ('internal', 'sensitive')`,
      ),
    );
  const factChildren = await database
    .select({ supersedesId: studentFacts.supersedesId })
    .from(studentFacts)
    .where(inArray(studentFacts.supersedesId, factIds));
  const locatorRows = await database
    .select({
      id: evidenceLocators.id,
      invalidationId: evidenceInvalidations.id,
      objectId: evidenceObjects.id,
      studentId: evidenceObjects.studentId,
    })
    .from(evidenceLocators)
    .innerJoin(evidenceObjects, eq(evidenceObjects.id, evidenceLocators.evidenceObjectId))
    .leftJoin(evidenceInvalidations, eq(evidenceInvalidations.evidenceObjectId, evidenceObjects.id))
    .where(
      and(
        inArray(evidenceLocators.id, locatorIds),
        eq(evidenceObjects.dataDomain, "student"),
        eq(evidenceObjects.studentId, row.studentId),
        sql`${evidenceObjects.accessLevel} in ('internal', 'sensitive')`,
      ),
    );
  const objectIds = locatorRows.map((locator) => locator.objectId);
  const evidenceChildren = await database
    .select({ supersedesId: evidenceObjects.supersedesId })
    .from(evidenceObjects)
    .where(inArray(evidenceObjects.supersedesId, objectIds));
  const snapshotFactRows = await database
    .select({ id: profileInputSnapshotFacts.studentFactId })
    .from(profileInputSnapshotFacts)
    .where(eq(profileInputSnapshotFacts.snapshotId, task.payload.inputSnapshotId));
  const snapshotEvidenceRows = await database
    .select({ id: profileInputSnapshotEvidence.evidenceLocatorId })
    .from(profileInputSnapshotEvidence)
    .where(eq(profileInputSnapshotEvidence.snapshotId, task.payload.inputSnapshotId));
  const linkRows = await database
    .select({
      evidenceLocatorId: factEvidence.evidenceLocatorId,
      relation: factEvidence.relation,
      studentFactId: factEvidence.studentFactId,
      validationStatus: factEvidence.validationStatus,
    })
    .from(factEvidence)
    .where(
      and(
        inArray(factEvidence.studentFactId, factIds),
        inArray(factEvidence.evidenceLocatorId, locatorIds),
      ),
    );
  const expectedLinks = new Set(
    snapshot.facts.flatMap((fact) =>
      fact.evidence.map((evidence) => `${fact.factId}:${evidence.locatorId}:${evidence.relation}`),
    ),
  );
  const validLinks = new Set(
    linkRows
      .filter((link) => link.validationStatus === "valid")
      .map((link) => `${link.studentFactId}:${link.evidenceLocatorId}:${link.relation}`),
  );
  if (
    factRows.length !== factIds.length ||
    factChildren.length > 0 ||
    locatorRows.length !== locatorIds.length ||
    locatorRows.some((locator) => locator.invalidationId !== null) ||
    evidenceChildren.length > 0 ||
    snapshotFactRows.length !== factIds.length ||
    snapshotEvidenceRows.length !== locatorIds.length ||
    snapshotFactRows.some((fact) => !factIds.includes(fact.id)) ||
    snapshotEvidenceRows.some((locator) => !locatorIds.includes(locator.id)) ||
    expectedLinks.size !== validLinks.size ||
    [...expectedLinks].some((link) => !validLinks.has(link))
  ) {
    throw new ProfileDraftProcessingError("snapshot_source_stale");
  }
  return { actorUserId: row.actorUserId, snapshot, studentId: row.studentId };
}

function safeErrorCode(error: unknown): string {
  if (error instanceof ProfileDraftProcessingError) return error.code;
  if (error instanceof ModelGatewayError) return `model_${error.code}`;
  if (error instanceof AuthorizationDeniedError) return "authorization_stale";
  if (error instanceof z.ZodError) return "output_schema_invalid";
  return "profile_processing_failed";
}

async function markTaskFailed(
  database: Database,
  task: ProfileDraftTask,
  errorCode: string,
  now: Date,
): Promise<void> {
  await database.transaction(async (transaction) => {
    await transaction
      .update(backgroundJobs)
      .set({
        claimToken: null,
        completedAt: now,
        errorCode,
        leaseExpiresAt: null,
        status: "failed",
      })
      .where(eq(backgroundJobs.id, task.taskId));
    await transaction
      .update(modelTaskRuns)
      .set({ completedAt: now, errorCode, status: "failed" })
      .where(eq(modelTaskRuns.id, task.taskId));
  });
}

export async function executeProfileDraftTask(
  database: Database,
  untrustedTask: ProfileDraftTask,
  provider: JsonModelProvider,
  options: { now?: Date } = {},
): Promise<{ profileVersionId: string; version: number } | { alreadyCompleted: true }> {
  const task = ProfileDraftTaskSchema.parse(untrustedTask);
  const startedAt = options.now ?? new Date();
  const claim = await claimProfileTask(database, task, startedAt);
  if (claim === null) return { alreadyCompleted: true };
  try {
    const frozen = await validateFrozenSnapshot(database, task);
    const generated = await provider.generateJson({
      systemPrompt: PROFILE_SYSTEM_PROMPT,
      userPrompt: buildProfileUserPrompt(frozen.snapshot),
    });
    if (generated.model !== task.payload.model) {
      throw new ProfileDraftProcessingError("model_mismatch");
    }
    const output = validateProfileOutputAgainstSnapshot(generated.json, frozen.snapshot);
    const outputHash = profileOutputHash(output);
    await validateFrozenSnapshot(database, task);
    const completedAt = new Date();
    return await database.transaction(async (transaction) => {
      const jobRows = await transaction
        .select({ claimToken: backgroundJobs.claimToken, status: backgroundJobs.status })
        .from(backgroundJobs)
        .where(eq(backgroundJobs.id, task.taskId))
        .for("update")
        .limit(1);
      const activeJob = jobRows[0];
      if (
        activeJob === undefined ||
        activeJob.status !== "running" ||
        activeJob.claimToken !== claim.claimToken
      ) {
        throw new ProfileDraftConflictError("The task lease is no longer owned by this worker.");
      }
      await transaction
        .select({ id: students.id })
        .from(students)
        .where(eq(students.id, frozen.studentId))
        .for("update");
      const existing = await transaction
        .select({ id: profileVersions.id, version: profileVersions.version })
        .from(profileVersions)
        .where(eq(profileVersions.modelTaskRunId, task.taskId))
        .limit(1);
      if (existing[0] !== undefined) {
        return { profileVersionId: existing[0].id, version: existing[0].version };
      }
      const latest = await transaction
        .select({ version: profileVersions.version })
        .from(profileVersions)
        .where(eq(profileVersions.studentId, frozen.studentId))
        .orderBy(sql`${profileVersions.version} desc`)
        .limit(1);
      const version = (latest[0]?.version ?? 0) + 1;
      const profileVersionId = randomUUID();
      await transaction.insert(profileVersions).values({
        createdAt: completedAt,
        createdByUserId: frozen.actorUserId,
        id: profileVersionId,
        inputSnapshotHash: task.payload.inputSnapshotHash,
        inputSnapshotId: task.payload.inputSnapshotId,
        modelTaskRunId: task.taskId,
        questionsToConfirm: output.questionsToConfirm,
        status: "draft",
        studentId: frozen.studentId,
        updatedAt: completedAt,
        version,
      });
      for (const claimOutput of output.claims) {
        const claimId = randomUUID();
        await transaction.insert(profileClaims).values({
          category: claimOutput.category,
          confidence: claimOutput.confidence,
          createdAt: completedAt,
          evidenceCount: claimOutput.evidence.length,
          id: claimId,
          informationNature: claimOutput.informationNature,
          profileVersionId,
          statement: claimOutput.statement,
        });
        if (claimOutput.evidence.length > 0) {
          await transaction.insert(claimEvidence).values(
            claimOutput.evidence.map((evidence) => ({
              createdAt: completedAt,
              evidenceLocatorId: evidence.locatorId,
              profileClaimId: claimId,
              relation: evidence.relation,
              validationStatus: "valid" as const,
            })),
          );
        }
      }
      await transaction
        .update(modelTaskRuns)
        .set({
          completedAt,
          completionTokens: generated.usage.completionTokens,
          estimatedCostMicrosCny: estimateDeepSeekFlashCostMicrosCny(generated.usage),
          outputHash,
          promptCacheHitTokens: generated.usage.promptCacheHitTokens,
          promptCacheMissTokens: generated.usage.promptCacheMissTokens,
          promptTokens: generated.usage.promptTokens,
          providerRequestId: generated.providerRequestId,
          status: "succeeded",
          totalTokens: generated.usage.totalTokens,
        })
        .where(eq(modelTaskRuns.id, task.taskId));
      await transaction
        .update(backgroundJobs)
        .set({
          claimToken: null,
          completedAt,
          leaseExpiresAt: null,
          resultReference: { profileVersionId, version },
          status: "succeeded",
        })
        .where(eq(backgroundJobs.id, task.taskId));
      await transaction.insert(auditEvents).values({
        action: "student.profile.draft.complete",
        actorType: "service",
        actorUserId: frozen.actorUserId,
        createdAt: completedAt,
        details: {
          authorizationContextId: task.authorization.contextId,
          inputSnapshotHash: task.payload.inputSnapshotHash,
          model: task.payload.model,
          outputHash,
          profileVersion: version,
        },
        objectId: profileVersionId,
        objectType: "profile_version",
        requestCorrelationId: task.payload.correlationId,
        result: "allowed",
        studentId: frozen.studentId,
      });
      return { profileVersionId, version };
    });
  } catch (error) {
    if (error instanceof ProfileDraftConflictError) throw error;
    await markTaskFailed(database, task, safeErrorCode(error), new Date());
    throw error instanceof ProfileDraftProcessingError
      ? error
      : new ProfileDraftProcessingError(safeErrorCode(error));
  }
}

export interface StudentProfileReadModel {
  readonly profiles: Array<{
    claims: Array<{
      category: string;
      confidence: string;
      evidenceCount: number;
      informationNature: string;
      statement: string;
    }>;
    createdAt: Date;
    id: string;
    questionsToConfirm: Array<{ question: string; relatedFieldKeys: string[] }>;
    status: string;
    version: number;
  }>;
  readonly tasks: Array<{ errorCode: string | null; id: string; status: string }>;
}

export async function readStudentProfiles(
  database: Database,
  rawContext: AuthorizationContext,
  options: { now?: Date } = {},
): Promise<StudentProfileReadModel> {
  const now = options.now ?? new Date();
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
    accessLevel: "internal",
    action: "student:read",
    now,
    studentId: context.studentId,
  });
  const versions = await database
    .select({
      createdAt: profileVersions.createdAt,
      id: profileVersions.id,
      questionsToConfirm: profileVersions.questionsToConfirm,
      status: profileVersions.status,
      version: profileVersions.version,
    })
    .from(profileVersions)
    .where(eq(profileVersions.studentId, context.studentId))
    .orderBy(sql`${profileVersions.version} desc`);
  const versionIds = versions.map((version) => version.id);
  const claims =
    versionIds.length === 0
      ? []
      : await database
          .select({
            category: profileClaims.category,
            confidence: profileClaims.confidence,
            evidenceCount: profileClaims.evidenceCount,
            informationNature: profileClaims.informationNature,
            profileVersionId: profileClaims.profileVersionId,
            statement: profileClaims.statement,
          })
          .from(profileClaims)
          .where(inArray(profileClaims.profileVersionId, versionIds))
          .orderBy(asc(profileClaims.createdAt));
  const tasks = await database
    .select({
      errorCode: modelTaskRuns.errorCode,
      id: modelTaskRuns.id,
      status: modelTaskRuns.status,
    })
    .from(modelTaskRuns)
    .where(eq(modelTaskRuns.studentId, context.studentId))
    .orderBy(sql`${modelTaskRuns.createdAt} desc`);
  return {
    profiles: versions.map((version) => ({
      ...version,
      claims: claims.filter((claim) => claim.profileVersionId === version.id),
    })),
    tasks,
  };
}

export function createDeterministicMockProfileProvider(): JsonModelProvider {
  return {
    generateJson(request) {
      const marker = "frozen input snapshot only:\n";
      const start = request.userPrompt.indexOf(marker);
      const parsed = ProfileInputSnapshotPayloadSchema.parse(
        JSON.parse(request.userPrompt.slice(start + marker.length)),
      );
      const firstFact = parsed.facts[0];
      const firstEvidence = firstFact?.evidence[0];
      if (firstFact === undefined || firstEvidence === undefined) {
        throw new ProfileDraftProcessingError("mock_input_invalid");
      }
      const categories = [
        "academic_foundation",
        "interest_thread",
        "experience_connections",
        "responsibility_impact",
        "interdisciplinary_ai_depth",
        "behavioral_evidence",
        "gaps_contradictions_risks",
        "one_sentence_label",
      ] as const;
      const json: ProfileDraftOutput = {
        claims: categories.map((category) => ({
          category,
          confidence: "medium",
          evidence: [{ locatorId: firstEvidence.locatorId, relation: "supports" }],
          informationNature: category === "one_sentence_label" ? "inference" : "fact",
          statement: `Synthetic draft for ${category}.`,
        })),
        questionsToConfirm: [
          {
            question: "Please confirm the current academic direction.",
            relatedFieldKeys: [firstFact.fieldKey],
          },
        ],
        schemaVersion: PROFILE_SCHEMA_VERSION,
      };
      return Promise.resolve({
        json,
        model: DEEPSEEK_PROFILE_MODEL,
        providerRequestId: "mock-profile-request",
        usage: {
          completionTokens: 80,
          promptCacheHitTokens: 0,
          promptCacheMissTokens: 120,
          promptTokens: 120,
          totalTokens: 200,
        },
      });
    },
  };
}
