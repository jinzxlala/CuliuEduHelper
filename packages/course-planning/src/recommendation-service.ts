import { randomUUID } from "node:crypto";

import { DEEPSEEK_PROFILE_MODEL, type JsonModelProvider } from "@culiu/ai";
import {
  AuthorizationContextSchema,
  AuthorizationDeniedError,
  assertAuthorizationContext,
  loadAuthorizationContext,
  type AuthorizationContext,
} from "@culiu/authorization";
import {
  backgroundJobs,
  courseOfferingVersions,
  courseRecommendationSnapshots,
  courseRecommendations,
  courseRuleVersions,
  courseVersions,
  courses,
  profileClaims,
  profileVersions,
  studentFacts,
  type Database,
} from "@culiu/database/runtime";
import {
  CourseRecommendationGenerateTaskSchema,
  type CourseRecommendationGenerateTask,
} from "@culiu/tasks";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

import {
  COURSE_RECOMMENDATION_MODEL,
  COURSE_RECOMMENDATION_PRICING_VERSION,
  COURSE_RECOMMENDATION_PROMPT_HASH,
  COURSE_RECOMMENDATION_PROMPT_VERSION,
  COURSE_RECOMMENDATION_REDACTION_VERSION,
  COURSE_RECOMMENDATION_SCHEMA_HASH,
  COURSE_RECOMMENDATION_SCHEMA_VERSION,
  COURSE_RECOMMENDATION_SYSTEM_PROMPT,
  CourseRecommendationOutputSchema,
  CourseRecommendationSnapshotPayloadSchema,
  buildRecommendationUserPrompt,
  recommendationHash,
  validateRecommendationOutput,
  type CourseRecommendationOutput,
  type CourseRecommendationSnapshotPayload,
} from "./recommendation-contracts.js";
import { SchedulingConflictError, SchedulingNotFoundError } from "./scheduling-errors.js";

const GitCommitSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const LEASE_MS = 90_000;

async function requireRecommendationContext(
  database: Database,
  rawContext: AuthorizationContext,
  action: "student:recommendation:generate" | "student:recommendation:review",
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
    accessLevel: "sensitive",
    action,
    now,
    studentId: context.studentId,
  });
  return { ...context, studentId: context.studentId };
}

function stringArrayFact(value: Record<string, unknown>): string[] {
  const candidate = value.ids ?? value.values;
  return Array.isArray(candidate)
    ? candidate.filter((item): item is string => typeof item === "string")
    : [];
}

async function buildEligiblePayload(
  database: Database,
  studentId: string,
): Promise<{ payload: CourseRecommendationSnapshotPayload; profileVersionId: string }> {
  const [profile] = await database
    .select({ id: profileVersions.id })
    .from(profileVersions)
    .where(and(eq(profileVersions.studentId, studentId), eq(profileVersions.status, "approved")))
    .orderBy(desc(profileVersions.version))
    .limit(1);
  if (profile === undefined) {
    throw new SchedulingConflictError("A current approved student profile is required.");
  }
  const claims = await database
    .select({
      category: profileClaims.category,
      id: profileClaims.id,
      informationNature: profileClaims.informationNature,
      statement: profileClaims.statement,
    })
    .from(profileClaims)
    .where(eq(profileClaims.profileVersionId, profile.id));
  const usableClaims = claims.filter((claim) => claim.informationNature !== "missing");
  if (usableClaims.length === 0)
    throw new SchedulingConflictError("The approved profile has no usable claims.");

  const factRows = await database
    .select({ fieldKey: studentFacts.fieldKey, value: studentFacts.value })
    .from(studentFacts)
    .where(
      and(
        eq(studentFacts.studentId, studentId),
        eq(studentFacts.confirmationStatus, "confirmed"),
        isNull(studentFacts.validTo),
      ),
    );
  const completedCourseIds = new Set(
    factRows
      .filter((fact) => fact.fieldKey === "education.completed_course_ids")
      .flatMap((fact) => stringArrayFact(fact.value)),
  );
  const approvedCourses = await database
    .select({
      courseId: courses.id,
      courseVersionId: courseVersions.id,
      title: courseVersions.title,
    })
    .from(courseVersions)
    .innerJoin(courses, eq(courses.id, courseVersions.courseId))
    .where(eq(courseVersions.status, "approved"));
  const rules = await database
    .select({
      relatedCourseId: courseRuleVersions.relatedCourseId,
      ruleType: courseRuleVersions.ruleType,
      severity: courseRuleVersions.severity,
      subjectCourseId: courseRuleVersions.subjectCourseId,
    })
    .from(courseRuleVersions)
    .where(eq(courseRuleVersions.status, "approved"));
  const eligibleCourses = approvedCourses.filter((course) => {
    if (completedCourseIds.has(course.courseId)) return false;
    return !rules.some((rule) => {
      if (rule.severity !== "hard") return false;
      if (rule.ruleType === "prerequisite" && rule.subjectCourseId === course.courseId) {
        return rule.relatedCourseId !== null && !completedCourseIds.has(rule.relatedCourseId);
      }
      if (rule.ruleType === "mutual_exclusion") {
        return (
          (rule.subjectCourseId === course.courseId &&
            rule.relatedCourseId !== null &&
            completedCourseIds.has(rule.relatedCourseId)) ||
          (rule.relatedCourseId === course.courseId &&
            rule.subjectCourseId !== null &&
            completedCourseIds.has(rule.subjectCourseId))
        );
      }
      return false;
    });
  });
  if (eligibleCourses.length === 0)
    throw new SchedulingConflictError("No course remains after deterministic rules.");
  const eligibleIds = eligibleCourses.map((course) => course.courseVersionId);
  const offerings = await database
    .select({
      className: courseOfferingVersions.className,
      courseVersionId: courseOfferingVersions.courseVersionId,
      offeringVersionId: courseOfferingVersions.id,
    })
    .from(courseOfferingVersions)
    .where(
      and(
        eq(courseOfferingVersions.status, "approved"),
        inArray(courseOfferingVersions.courseVersionId, eligibleIds),
      ),
    );
  return {
    payload: CourseRecommendationSnapshotPayloadSchema.parse({
      claims: usableClaims.map(({ category, id, statement }) => ({ category, id, statement })),
      courses: eligibleCourses,
      offerings,
    }),
    profileVersionId: profile.id,
  };
}

export async function prepareCourseRecommendationTask(
  database: Database,
  rawContext: AuthorizationContext,
  gitCommitSha: string,
): Promise<CourseRecommendationGenerateTask> {
  const context = await requireRecommendationContext(
    database,
    rawContext,
    "student:recommendation:generate",
  );
  const gitCommit = GitCommitSchema.parse(gitCommitSha);
  const built = await buildEligiblePayload(database, context.studentId);
  const snapshotHash = recommendationHash({
    payload: built.payload,
    profileVersionId: built.profileVersionId,
    versions: {
      model: COURSE_RECOMMENDATION_MODEL,
      pricing: COURSE_RECOMMENDATION_PRICING_VERSION,
      prompt: COURSE_RECOMMENDATION_PROMPT_VERSION,
      redaction: COURSE_RECOMMENDATION_REDACTION_VERSION,
      schema: COURSE_RECOMMENDATION_SCHEMA_VERSION,
    },
  });
  const snapshotId = randomUUID();
  const taskId = randomUUID();
  await database.transaction(async (transaction) => {
    await transaction.insert(courseRecommendationSnapshots).values({
      authorizationContextSnapshotId: context.id,
      createdByUserId: context.actorUserId,
      eligibleCourseVersionIds: built.payload.courses.map((item) => item.courseVersionId),
      eligibleOfferingVersionIds: built.payload.offerings.map((item) => item.offeringVersionId),
      id: snapshotId,
      model: COURSE_RECOMMENDATION_MODEL,
      modelProvider: "deepseek",
      payload: built.payload,
      pricingVersion: COURSE_RECOMMENDATION_PRICING_VERSION,
      profileClaimIds: built.payload.claims.map((item) => item.id),
      profileVersionId: built.profileVersionId,
      promptVersion: COURSE_RECOMMENDATION_PROMPT_VERSION,
      redactionVersion: COURSE_RECOMMENDATION_REDACTION_VERSION,
      schemaVersion: COURSE_RECOMMENDATION_SCHEMA_VERSION,
      snapshotHash,
      studentId: context.studentId,
    });
    await transaction.insert(backgroundJobs).values({
      authorizationContextId: context.id,
      id: taskId,
      idempotencyKey: `course_rec_${snapshotHash}`,
      maxAttempts: 3,
      status: "queued",
      taskName: "course.recommendation.generate",
    });
  });
  return CourseRecommendationGenerateTaskSchema.parse({
    authorization: { contextHash: context.contextHash, contextId: context.id },
    idempotencyKey: `course_rec_${snapshotHash}`,
    payload: {
      correlationId: randomUUID(),
      gitCommitSha: gitCommit,
      model: COURSE_RECOMMENDATION_MODEL,
      pricingVersion: COURSE_RECOMMENDATION_PRICING_VERSION,
      promptHash: COURSE_RECOMMENDATION_PROMPT_HASH,
      promptVersion: COURSE_RECOMMENDATION_PROMPT_VERSION,
      redactionVersion: COURSE_RECOMMENDATION_REDACTION_VERSION,
      schemaHash: COURSE_RECOMMENDATION_SCHEMA_HASH,
      schemaVersion: COURSE_RECOMMENDATION_SCHEMA_VERSION,
      snapshotHash,
      snapshotId,
    },
    taskId,
    taskName: "course.recommendation.generate",
  });
}

export async function executeCourseRecommendationTask(
  database: Database,
  rawTask: unknown,
  provider: JsonModelProvider,
): Promise<{ recommendationId: string; status: "draft" }> {
  const task = CourseRecommendationGenerateTaskSchema.parse(rawTask);
  const now = new Date();
  const claimToken = randomUUID();
  const [job] = await database
    .update(backgroundJobs)
    .set({
      attempts: 1,
      claimToken,
      leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
      startedAt: now,
      status: "running",
    })
    .where(and(eq(backgroundJobs.id, task.taskId), eq(backgroundJobs.status, "queued")))
    .returning({ id: backgroundJobs.id });
  if (job === undefined) throw new SchedulingConflictError("Recommendation task is not claimable.");
  try {
    const [snapshot] = await database
      .select()
      .from(courseRecommendationSnapshots)
      .where(eq(courseRecommendationSnapshots.id, task.payload.snapshotId))
      .limit(1);
    if (snapshot === undefined || snapshot.snapshotHash !== task.payload.snapshotHash) {
      throw new SchedulingNotFoundError();
    }
    const context = await loadAuthorizationContext(database, {
      actorUserId: snapshot.createdByUserId,
      contextHash: task.authorization.contextHash,
      id: task.authorization.contextId,
      now: new Date(),
    });
    assertAuthorizationContext(context, {
      accessLevel: "sensitive",
      action: "student:recommendation:generate",
      now: new Date(),
      studentId: snapshot.studentId,
    });
    const [currentProfile] = await database
      .select({ status: profileVersions.status })
      .from(profileVersions)
      .where(eq(profileVersions.id, snapshot.profileVersionId))
      .limit(1);
    if (currentProfile?.status !== "approved")
      throw new SchedulingConflictError("Profile requires review.");
    const payload = CourseRecommendationSnapshotPayloadSchema.parse(snapshot.payload);
    const result = await provider.generateJson({
      systemPrompt: COURSE_RECOMMENDATION_SYSTEM_PROMPT,
      userPrompt: buildRecommendationUserPrompt(payload),
    });
    if (result.model !== DEEPSEEK_PROFILE_MODEL)
      throw new SchedulingConflictError("Unexpected model.");
    const output = validateRecommendationOutput(result.json, payload);
    const recommendationId = randomUUID();
    await database.transaction(async (transaction) => {
      await transaction.insert(courseRecommendations).values({
        backgroundJobId: task.taskId,
        completionTokens: result.usage.completionTokens,
        id: recommendationId,
        output,
        promptTokens: result.usage.promptTokens,
        providerRequestId: result.providerRequestId,
        snapshotId: snapshot.id,
        status: "draft",
        studentId: snapshot.studentId,
      });
      await transaction
        .update(backgroundJobs)
        .set({
          claimToken: null,
          completedAt: new Date(),
          leaseExpiresAt: null,
          resultReference: { recommendationId },
          status: "succeeded",
        })
        .where(and(eq(backgroundJobs.id, task.taskId), eq(backgroundJobs.claimToken, claimToken)));
    });
    return { recommendationId, status: "draft" };
  } catch (error) {
    await database
      .update(backgroundJobs)
      .set({
        claimToken: null,
        completedAt: new Date(),
        errorCode: "recommendation_failed",
        leaseExpiresAt: null,
        status: "failed",
      })
      .where(and(eq(backgroundJobs.id, task.taskId), eq(backgroundJobs.claimToken, claimToken)));
    throw error;
  }
}

export async function readCourseRecommendations(
  database: Database,
  rawContext: AuthorizationContext,
): Promise<
  Array<{ id: string; output: CourseRecommendationOutput; status: string; createdAt: Date }>
> {
  const context = await requireRecommendationContext(
    database,
    rawContext,
    "student:recommendation:review",
  );
  const rows = await database
    .select({
      createdAt: courseRecommendations.createdAt,
      eligibleCourseVersionIds: courseRecommendationSnapshots.eligibleCourseVersionIds,
      eligibleOfferingVersionIds: courseRecommendationSnapshots.eligibleOfferingVersionIds,
      id: courseRecommendations.id,
      output: courseRecommendations.output,
      profileVersionId: courseRecommendationSnapshots.profileVersionId,
      status: courseRecommendations.status,
    })
    .from(courseRecommendations)
    .innerJoin(
      courseRecommendationSnapshots,
      eq(courseRecommendationSnapshots.id, courseRecommendations.snapshotId),
    )
    .where(eq(courseRecommendations.studentId, context.studentId))
    .orderBy(desc(courseRecommendations.createdAt));
  const currentCourses = new Set(
    (
      await database
        .select({ id: courseVersions.id })
        .from(courseVersions)
        .where(eq(courseVersions.status, "approved"))
    ).map((item) => item.id),
  );
  const currentOfferings = new Set(
    (
      await database
        .select({ id: courseOfferingVersions.id })
        .from(courseOfferingVersions)
        .where(eq(courseOfferingVersions.status, "approved"))
    ).map((item) => item.id),
  );
  const profileIds = [...new Set(rows.map((row) => row.profileVersionId))];
  const approvedProfiles = new Set(
    profileIds.length === 0
      ? []
      : (
          await database
            .select({ id: profileVersions.id })
            .from(profileVersions)
            .where(
              and(inArray(profileVersions.id, profileIds), eq(profileVersions.status, "approved")),
            )
        ).map((item) => item.id),
  );
  const result = [];
  for (const row of rows) {
    const stale =
      !approvedProfiles.has(row.profileVersionId) ||
      row.eligibleCourseVersionIds.some((id) => !currentCourses.has(id)) ||
      row.eligibleOfferingVersionIds.some((id) => !currentOfferings.has(id));
    const status = stale && row.status === "accepted" ? "needs_review" : row.status;
    if (status !== row.status) {
      await database
        .update(courseRecommendations)
        .set({ status, updatedAt: new Date() })
        .where(eq(courseRecommendations.id, row.id));
    }
    result.push({
      createdAt: row.createdAt,
      id: row.id,
      output: CourseRecommendationOutputSchema.parse(row.output),
      status,
    });
  }
  return result;
}

export async function decideCourseRecommendation(
  database: Database,
  rawContext: AuthorizationContext,
  recommendationId: string,
  decision: "accepted" | "rejected",
): Promise<{ status: "accepted" | "rejected" }> {
  const context = await requireRecommendationContext(
    database,
    rawContext,
    "student:recommendation:review",
  );
  const [updated] = await database
    .update(courseRecommendations)
    .set({
      ...(decision === "accepted" ? { acceptedAt: new Date() } : {}),
      decidedByUserId: context.actorUserId,
      status: decision,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(courseRecommendations.id, recommendationId),
        eq(courseRecommendations.studentId, context.studentId),
        eq(courseRecommendations.status, "draft"),
      ),
    )
    .returning({ status: courseRecommendations.status });
  if (updated === undefined) throw new SchedulingNotFoundError();
  return { status: updated.status as "accepted" | "rejected" };
}
