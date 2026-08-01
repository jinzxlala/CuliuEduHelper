import { randomUUID } from "node:crypto";

import {
  AuthorizationContextSchema,
  AuthorizationDeniedError,
  assertAuthorizationContext,
  loadAuthorizationContext,
  type AuthorizationContext,
  type StudentAction,
} from "@culiu/authorization";
import {
  auditEvents,
  claimEvidence,
  profileClaims,
  profileReviewRecords,
  profileVersions,
  students,
  type Database,
} from "@culiu/database/runtime";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import {
  ProfileRevisionInputSchema,
  ProfileTransitionInputSchema,
  validateProfileRevisionAgainstSnapshot,
  type ProfileDraftOutput,
  type ProfileRevisionInput,
  type ProfileTransitionInput,
} from "./contracts.js";
import {
  ProfileDraftProcessingError,
  ProfileWorkflowConflictError,
  ProfileWorkflowNotFoundError,
} from "./errors.js";
import { validateCurrentProfileSnapshot } from "./snapshot-validation.js";

const ProfileVersionIdSchema = z.uuid();

async function requireWorkflowContext(
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
    ["23505", "23514", "55000", "P0001"].includes(String(code)),
  );
}

async function loadCurrentSnapshotForVersion(
  database: Database,
  profileVersionId: string,
  studentId: string,
): Promise<{
  inputSnapshotHash: string;
  inputSnapshotId: string;
  modelTaskRunId: string;
  snapshot: Awaited<ReturnType<typeof validateCurrentProfileSnapshot>>;
}> {
  const versions = await database
    .select({
      inputSnapshotHash: profileVersions.inputSnapshotHash,
      inputSnapshotId: profileVersions.inputSnapshotId,
      modelTaskRunId: profileVersions.modelTaskRunId,
    })
    .from(profileVersions)
    .where(and(eq(profileVersions.id, profileVersionId), eq(profileVersions.studentId, studentId)))
    .limit(1);
  const version = versions[0];
  if (version === undefined) throw new ProfileWorkflowNotFoundError();
  try {
    const snapshot = await validateCurrentProfileSnapshot(database, {
      inputSnapshotHash: version.inputSnapshotHash,
      inputSnapshotId: version.inputSnapshotId,
      studentId,
    });
    return { ...version, snapshot };
  } catch (error) {
    if (error instanceof ProfileDraftProcessingError) {
      throw new ProfileWorkflowConflictError("The profile input snapshot is no longer current.");
    }
    throw error;
  }
}

async function writeClaims(
  transaction: Parameters<Parameters<Database["transaction"]>[0]>[0],
  profileVersionId: string,
  output: Pick<ProfileDraftOutput, "claims">,
  now: Date,
): Promise<void> {
  for (const claimOutput of output.claims) {
    const claimId = randomUUID();
    await transaction.insert(profileClaims).values({
      category: claimOutput.category,
      confidence: claimOutput.confidence,
      createdAt: now,
      evidenceCount: claimOutput.evidence.length,
      id: claimId,
      informationNature: claimOutput.informationNature,
      profileVersionId,
      statement: claimOutput.statement,
    });
    if (claimOutput.evidence.length > 0) {
      await transaction.insert(claimEvidence).values(
        claimOutput.evidence.map((evidence) => ({
          createdAt: now,
          evidenceLocatorId: evidence.locatorId,
          profileClaimId: claimId,
          relation: evidence.relation,
          validationStatus: "valid" as const,
        })),
      );
    }
  }
}

export async function reviseProfileVersion(
  database: Database,
  rawContext: AuthorizationContext,
  untrustedProfileVersionId: string,
  untrustedInput: ProfileRevisionInput,
  options: { now?: Date; requestCorrelationId?: string } = {},
): Promise<{ id: string; status: "draft"; version: number }> {
  const profileVersionId = ProfileVersionIdSchema.parse(untrustedProfileVersionId);
  const input = ProfileRevisionInputSchema.parse(untrustedInput);
  const now = options.now ?? new Date();
  const requestCorrelationId = options.requestCorrelationId ?? randomUUID();
  const context = await requireWorkflowContext(database, rawContext, "student:profile:review", now);
  const current = await loadCurrentSnapshotForVersion(
    database,
    profileVersionId,
    context.studentId,
  );
  const output = validateProfileRevisionAgainstSnapshot(input, current.snapshot);

  try {
    return await database.transaction(async (transaction) => {
      await transaction
        .select({ id: students.id })
        .from(students)
        .where(eq(students.id, context.studentId))
        .for("update");
      const sourceRows = await transaction
        .select({
          approvedAt: profileVersions.approvedAt,
          approvedByUserId: profileVersions.approvedByUserId,
          inputSnapshotHash: profileVersions.inputSnapshotHash,
          inputSnapshotId: profileVersions.inputSnapshotId,
          modelTaskRunId: profileVersions.modelTaskRunId,
          status: profileVersions.status,
          updatedAt: profileVersions.updatedAt,
          version: profileVersions.version,
        })
        .from(profileVersions)
        .where(
          and(
            eq(profileVersions.id, profileVersionId),
            eq(profileVersions.studentId, context.studentId),
          ),
        )
        .for("update")
        .limit(1);
      const source = sourceRows[0];
      if (source === undefined) throw new ProfileWorkflowNotFoundError();
      if (!sameTimestamp(source.updatedAt, input.expectedSourceUpdatedAt)) {
        throw new ProfileWorkflowConflictError(
          "The profile version changed before it was revised.",
        );
      }
      if (!(["approved", "draft", "needs_review"] as const).includes(source.status as never)) {
        throw new ProfileWorkflowConflictError("This profile status cannot be revised.");
      }
      const latestRows = await transaction
        .select({ version: profileVersions.version })
        .from(profileVersions)
        .where(eq(profileVersions.studentId, context.studentId))
        .orderBy(sql`${profileVersions.version} desc`)
        .limit(1);
      if (latestRows[0]?.version !== source.version) {
        throw new ProfileWorkflowConflictError("Only the latest profile version can be revised.");
      }
      const id = randomUUID();
      const version = source.version + 1;
      await transaction.insert(profileVersions).values({
        createdAt: now,
        createdByUserId: context.actorUserId,
        id,
        inputSnapshotHash: source.inputSnapshotHash,
        inputSnapshotId: source.inputSnapshotId,
        modelTaskRunId: source.modelTaskRunId,
        questionsToConfirm: output.questionsToConfirm,
        sourceProfileVersionId: profileVersionId,
        status: "draft",
        studentId: context.studentId,
        updatedAt: now,
        version,
      });
      await writeClaims(transaction, id, output, now);
      await transaction.insert(profileReviewRecords).values({
        action: "revised",
        actorType: "user",
        actorUserId: context.actorUserId,
        createdAt: now,
        fromStatus: source.status,
        profileVersionId: id,
        requestCorrelationId,
        toStatus: "draft",
      });
      if (source.status === "draft" || source.status === "needs_review") {
        const reason = `superseded_by_revision:${id}`;
        await transaction
          .update(profileVersions)
          .set({ invalidationReason: reason, status: "archived", updatedAt: now })
          .where(eq(profileVersions.id, profileVersionId));
        await transaction.insert(profileReviewRecords).values({
          action: "archived",
          actorType: "user",
          actorUserId: context.actorUserId,
          createdAt: now,
          fromStatus: source.status,
          profileVersionId,
          reason,
          requestCorrelationId,
          toStatus: "archived",
        });
      }
      await transaction.insert(auditEvents).values({
        action: "student.profile.revise",
        actorType: "user",
        actorUserId: context.actorUserId,
        createdAt: now,
        details: {
          authorizationContextId: context.id,
          sourceProfileVersionId: profileVersionId,
          sourceVersion: source.version,
          version,
        },
        objectId: id,
        objectType: "profile_version",
        requestCorrelationId,
        result: "allowed",
        studentId: context.studentId,
      });
      return { id, status: "draft" as const, version };
    });
  } catch (error) {
    if (
      error instanceof AuthorizationDeniedError ||
      error instanceof ProfileWorkflowConflictError ||
      error instanceof ProfileWorkflowNotFoundError
    ) {
      throw error;
    }
    if (isConstraintFailure(error)) {
      throw new ProfileWorkflowConflictError("The profile changed or its evidence is stale.");
    }
    throw error;
  }
}

export async function transitionProfileVersion(
  database: Database,
  rawContext: AuthorizationContext,
  untrustedProfileVersionId: string,
  untrustedInput: ProfileTransitionInput,
  options: { now?: Date; requestCorrelationId?: string } = {},
): Promise<{ id: string; status: "approved" | "archived" | "draft" | "in_review" }> {
  const profileVersionId = ProfileVersionIdSchema.parse(untrustedProfileVersionId);
  const input = ProfileTransitionInputSchema.parse(untrustedInput);
  const now = options.now ?? new Date();
  const requestCorrelationId = options.requestCorrelationId ?? randomUUID();
  const action: StudentAction =
    input.action === "approve" || input.action === "archive"
      ? "student:profile:approve"
      : "student:profile:review";
  const context = await requireWorkflowContext(database, rawContext, action, now);
  if (input.action === "submit" || input.action === "approve") {
    await loadCurrentSnapshotForVersion(database, profileVersionId, context.studentId);
  }

  try {
    return await database.transaction(async (transaction) => {
      await transaction
        .select({ id: students.id })
        .from(students)
        .where(eq(students.id, context.studentId))
        .for("update");
      const rows = await transaction
        .select({
          status: profileVersions.status,
          updatedAt: profileVersions.updatedAt,
          version: profileVersions.version,
        })
        .from(profileVersions)
        .where(
          and(
            eq(profileVersions.id, profileVersionId),
            eq(profileVersions.studentId, context.studentId),
          ),
        )
        .for("update")
        .limit(1);
      const profile = rows[0];
      if (profile === undefined) throw new ProfileWorkflowNotFoundError();
      if (!sameTimestamp(profile.updatedAt, input.expectedUpdatedAt)) {
        throw new ProfileWorkflowConflictError("The profile version changed before review.");
      }
      const latestRows = await transaction
        .select({ version: profileVersions.version })
        .from(profileVersions)
        .where(eq(profileVersions.studentId, context.studentId))
        .orderBy(sql`${profileVersions.version} desc`)
        .limit(1);
      if (input.action !== "archive" && latestRows[0]?.version !== profile.version) {
        throw new ProfileWorkflowConflictError("Only the latest profile version can be reviewed.");
      }

      let toStatus: "approved" | "archived" | "draft" | "in_review";
      let reason: string | null = null;
      if (input.action === "submit") {
        if (profile.status !== "draft") {
          throw new ProfileWorkflowConflictError("Only a draft can be submitted.");
        }
        toStatus = "in_review";
      } else if (input.action === "return") {
        if (profile.status !== "in_review") {
          throw new ProfileWorkflowConflictError("Only an in-review profile can be returned.");
        }
        toStatus = "draft";
        reason = input.reason;
      } else if (input.action === "approve") {
        if (profile.status !== "in_review") {
          throw new ProfileWorkflowConflictError("Only an in-review profile can be approved.");
        }
        toStatus = "approved";
      } else {
        if (profile.status === "archived") {
          throw new ProfileWorkflowConflictError("The profile is already archived.");
        }
        toStatus = "archived";
        reason = input.reason;
      }

      if (toStatus === "approved") {
        const priorApproved = await transaction
          .select({ id: profileVersions.id })
          .from(profileVersions)
          .where(
            and(
              eq(profileVersions.studentId, context.studentId),
              eq(profileVersions.status, "approved"),
            ),
          )
          .for("update");
        for (const prior of priorApproved) {
          const archiveReason = `superseded_by_approved_profile:${profileVersionId}`;
          await transaction
            .update(profileVersions)
            .set({ invalidationReason: archiveReason, status: "archived", updatedAt: now })
            .where(eq(profileVersions.id, prior.id));
          await transaction.insert(profileReviewRecords).values({
            action: "archived",
            actorType: "user",
            actorUserId: context.actorUserId,
            createdAt: now,
            fromStatus: "approved",
            profileVersionId: prior.id,
            reason: archiveReason,
            requestCorrelationId,
            toStatus: "archived",
          });
        }
        await transaction
          .update(profileVersions)
          .set({
            approvedAt: now,
            approvedByUserId: context.actorUserId,
            status: "approved",
            updatedAt: now,
          })
          .where(eq(profileVersions.id, profileVersionId));
      } else {
        await transaction
          .update(profileVersions)
          .set({
            invalidationReason: toStatus === "archived" ? reason : null,
            status: toStatus,
            updatedAt: now,
          })
          .where(eq(profileVersions.id, profileVersionId));
      }
      await transaction.insert(profileReviewRecords).values({
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
        fromStatus: profile.status,
        profileVersionId,
        reason,
        requestCorrelationId,
        toStatus,
      });
      await transaction.insert(auditEvents).values({
        action: `student.profile.${input.action}`,
        actorType: "user",
        actorUserId: context.actorUserId,
        createdAt: now,
        details: {
          authorizationContextId: context.id,
          fromStatus: profile.status,
          reasonLength: reason?.length ?? 0,
          toStatus,
          version: profile.version,
        },
        objectId: profileVersionId,
        objectType: "profile_version",
        requestCorrelationId,
        result: "allowed",
        studentId: context.studentId,
      });
      return { id: profileVersionId, status: toStatus };
    });
  } catch (error) {
    if (
      error instanceof AuthorizationDeniedError ||
      error instanceof ProfileWorkflowConflictError ||
      error instanceof ProfileWorkflowNotFoundError
    ) {
      throw error;
    }
    if (isConstraintFailure(error)) {
      throw new ProfileWorkflowConflictError("The profile changed or its evidence is stale.");
    }
    throw error;
  }
}
