import { randomUUID } from "node:crypto";

import {
  AuthorizationDeniedError,
  createStudentAuthorizationContext,
  type AuthorizationContext,
  type SessionPrincipal,
} from "@culiu/authorization";
import type { JsonModelProvider } from "@culiu/ai";
import {
  appUsers,
  createDatabaseClient,
  evidenceInvalidations,
  evidenceLocators,
  evidenceObjects,
  factEvidence,
  parseDatabaseConfig,
  profileClaims,
  profileInputSnapshots,
  profileReviewRecords,
  profileVersions,
  runMigrations,
  studentAuthorizations,
  studentFacts,
  students,
  type DatabaseClient,
} from "@culiu/database";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PROFILE_REDACTION_VERSION,
  ProfileInputSnapshotPayloadSchema,
  type ProfileRevisionInput,
} from "./contracts.js";
import { ProfileDraftInputError } from "./errors.js";
import {
  createDeterministicMockProfileProvider,
  executeProfileDraftTask,
  prepareProfileDraftTask,
  readStudentProfiles,
  type StudentProfileReadModel,
} from "./service.js";
import { reviseProfileVersion, transitionProfileVersion } from "./workflow.js";

let maintenanceClient: DatabaseClient | undefined;
let databaseClient: DatabaseClient | undefined;
let temporaryDatabaseName = "";

function activeDatabaseClient(): DatabaseClient {
  if (databaseClient === undefined) throw new Error("Test database is unavailable.");
  return databaseClient;
}

async function createStudentWithFact(
  options: {
    confirmationStatus?: "confirmed" | "unconfirmed";
    fieldKey?: string;
    value?: Record<string, unknown>;
  } = {},
): Promise<{
  approveContext: AuthorizationContext;
  evidenceId: string;
  factId: string;
  generateContext: AuthorizationContext;
  locatorId: string;
  readContext: AuthorizationContext;
  reviewContext: AuthorizationContext;
  studentId: string;
  userId: string;
}> {
  const database = activeDatabaseClient().database;
  const userId = randomUUID();
  const studentId = randomUUID();
  const evidenceId = randomUUID();
  const locatorId = randomUUID();
  const factId = randomUUID();
  const principal: SessionPrincipal = {
    displayName: "Synthetic Profile Advisor",
    email: `${userId}@example.invalid`,
    id: userId,
    role: "advisor",
  };
  await database.insert(appUsers).values({
    displayName: principal.displayName,
    email: principal.email,
    id: userId,
    role: "advisor",
  });
  await database.insert(students).values({
    id: studentId,
    ownerUserId: userId,
    privacyLevel: "sensitive",
    publicCode: `synthetic_${studentId}`,
  });
  await database.insert(studentAuthorizations).values({
    allowedActions: [
      "student:read",
      "student:profile:generate",
      "student:profile:review",
      "student:profile:approve",
    ],
    grantedByUserId: userId,
    maxAccessLevel: "sensitive",
    studentId,
    userId,
    validFrom: new Date(Date.now() - 60_000),
  });
  await database.insert(evidenceObjects).values({
    accessLevel: "sensitive",
    byteCount: 20,
    contentHash: "a".repeat(64),
    dataDomain: "student",
    id: evidenceId,
    mimeType: "text/plain",
    originalFileName: "synthetic.txt",
    storageKey: `student/${studentId}/aa/${"a".repeat(64)}`,
    studentId,
    uploadedByUserId: userId,
  });
  await database.insert(evidenceLocators).values({
    evidenceObjectId: evidenceId,
    id: locatorId,
    locator: { field: "academic_summary" },
    locatorType: "record_field",
  });
  await database.insert(studentFacts).values({
    accessLevel: "sensitive",
    confirmationStatus: options.confirmationStatus ?? "confirmed",
    fieldKey: options.fieldKey ?? "academic.readiness",
    id: factId,
    sourceType: "evidence",
    studentId,
    value: options.value ?? { text: "Synthetic evidence-backed readiness" },
  });
  await database.insert(factEvidence).values({
    evidenceLocatorId: locatorId,
    relation: "supports",
    studentFactId: factId,
    validationStatus: "valid",
  });
  return {
    approveContext: await createStudentAuthorizationContext(database, principal, {
      accessLevel: "sensitive",
      action: "student:profile:approve",
      studentId,
    }),
    evidenceId,
    factId,
    generateContext: await createStudentAuthorizationContext(database, principal, {
      accessLevel: "sensitive",
      action: "student:profile:generate",
      studentId,
    }),
    locatorId,
    readContext: await createStudentAuthorizationContext(database, principal, {
      accessLevel: "internal",
      action: "student:read",
      studentId,
    }),
    reviewContext: await createStudentAuthorizationContext(database, principal, {
      accessLevel: "sensitive",
      action: "student:profile:review",
      studentId,
    }),
    studentId,
    userId,
  };
}

async function generateProfile(
  actor: Awaited<ReturnType<typeof createStudentWithFact>>,
  gitCommitCharacter = "7",
): Promise<StudentProfileReadModel["profiles"][number]> {
  const prepared = await prepareProfileDraftTask(
    activeDatabaseClient().database,
    actor.generateContext,
    { gitCommitSha: gitCommitCharacter.repeat(40) },
  );
  await executeProfileDraftTask(
    activeDatabaseClient().database,
    prepared.task,
    createDeterministicMockProfileProvider(),
  );
  const profiles = await readStudentProfiles(activeDatabaseClient().database, actor.readContext);
  const profile = profiles.profiles[0];
  if (profile === undefined) throw new Error("Expected a generated profile.");
  return profile;
}

function revisionInput(
  profile: Awaited<ReturnType<typeof generateProfile>>,
  statementSuffix: string,
): ProfileRevisionInput {
  return {
    claims: profile.claims.map(
      ({ category, confidence, evidence, informationNature, statement }, index) => ({
        category,
        confidence,
        evidence,
        informationNature,
        statement: index === 0 ? `${statement} ${statementSuffix}` : statement,
      }),
    ),
    expectedSourceUpdatedAt: profile.updatedAt.toISOString(),
    questionsToConfirm: profile.questionsToConfirm,
  };
}

beforeAll(async () => {
  const base = parseDatabaseConfig();
  temporaryDatabaseName = `culiu_profiles_${randomUUID().replaceAll("-", "")}`;
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
    maxConnections: 5,
  });
  await runMigrations(databaseClient);
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

describe("student profile draft pipeline", () => {
  it("freezes de-identified evidence input and atomically creates an eight-section draft", async () => {
    const actor = await createStudentWithFact({
      value: {
        email: "student@example.com",
        text: "Synthetic student can connect robotics evidence.",
      },
    });
    const prepared = await prepareProfileDraftTask(
      activeDatabaseClient().database,
      actor.generateContext,
      { gitCommitSha: "1".repeat(40) },
    );
    const duplicate = await prepareProfileDraftTask(
      activeDatabaseClient().database,
      actor.generateContext,
      { gitCommitSha: "9".repeat(40) },
    );
    expect(duplicate.reused).toBe(true);
    expect(duplicate.task).toEqual(prepared.task);
    const snapshotRows = await activeDatabaseClient()
      .database.select({ payload: profileInputSnapshots.payload })
      .from(profileInputSnapshots)
      .where(eq(profileInputSnapshots.id, prepared.task.payload.inputSnapshotId));
    const payload = ProfileInputSnapshotPayloadSchema.parse(snapshotRows[0]?.payload);
    expect(payload.redactionVersion).toBe(PROFILE_REDACTION_VERSION);
    expect(JSON.stringify(payload)).not.toContain("student@example.com");

    const result = await executeProfileDraftTask(
      activeDatabaseClient().database,
      prepared.task,
      createDeterministicMockProfileProvider(),
    );
    expect(result).toMatchObject({ version: 1 });
    const readModel = await readStudentProfiles(activeDatabaseClient().database, actor.readContext);
    expect(readModel.profiles[0]).toMatchObject({ status: "draft", version: 1 });
    expect(readModel.profiles[0]?.claims).toHaveLength(8);
    expect(readModel.tasks[0]).toMatchObject({ errorCode: null, status: "succeeded" });
    const profileId = readModel.profiles[0]?.id;
    if (profileId === undefined) throw new Error("Expected a profile version.");
    await expect(
      activeDatabaseClient()
        .database.update(profileClaims)
        .set({ statement: "tampered" })
        .where(eq(profileClaims.profileVersionId, profileId)),
    ).rejects.toMatchObject({ cause: { code: "P0001" } });
  });

  it("does not create partial output when frozen evidence becomes invalid", async () => {
    const actor = await createStudentWithFact();
    const prepared = await prepareProfileDraftTask(
      activeDatabaseClient().database,
      actor.generateContext,
      { gitCommitSha: "2".repeat(40) },
    );
    const evidenceRows = await activeDatabaseClient()
      .database.select({ evidenceObjectId: evidenceLocators.evidenceObjectId })
      .from(evidenceLocators)
      .where(eq(evidenceLocators.id, actor.locatorId));
    await activeDatabaseClient()
      .database.insert(evidenceInvalidations)
      .values({
        evidenceObjectId: evidenceRows[0]?.evidenceObjectId ?? randomUUID(),
        invalidatedByUserId: actor.generateContext.actorUserId,
        reason: "Synthetic withdrawal",
      });
    await expect(
      executeProfileDraftTask(
        activeDatabaseClient().database,
        prepared.task,
        createDeterministicMockProfileProvider(),
      ),
    ).rejects.toThrow();
    const profiles = await activeDatabaseClient()
      .database.select({ id: profileVersions.id })
      .from(profileVersions)
      .where(eq(profileVersions.studentId, actor.studentId));
    expect(profiles).toHaveLength(0);
  });

  it("stores no partial profile when model output cites evidence outside the snapshot", async () => {
    const actor = await createStudentWithFact();
    const prepared = await prepareProfileDraftTask(
      activeDatabaseClient().database,
      actor.generateContext,
      { gitCommitSha: "5".repeat(40) },
    );
    const baseProvider = createDeterministicMockProfileProvider();
    const invalidProvider: JsonModelProvider = {
      async generateJson(request) {
        const result = await baseProvider.generateJson(request);
        const json = structuredClone(result.json) as {
          claims: Array<{ evidence: Array<{ locatorId: string }> }>;
        };
        const firstEvidence = json.claims[0]?.evidence[0];
        if (firstEvidence === undefined) throw new Error("Expected mock evidence.");
        firstEvidence.locatorId = randomUUID();
        return { ...result, json };
      },
    };
    await expect(
      executeProfileDraftTask(activeDatabaseClient().database, prepared.task, invalidProvider),
    ).rejects.toThrow();
    const profiles = await activeDatabaseClient()
      .database.select({ id: profileVersions.id })
      .from(profileVersions)
      .where(eq(profileVersions.studentId, actor.studentId));
    expect(profiles).toHaveLength(0);
  });

  it("rejects unconfirmed or non-allowlisted facts before any task is persisted", async () => {
    const unconfirmed = await createStudentWithFact({ confirmationStatus: "unconfirmed" });
    await expect(
      prepareProfileDraftTask(activeDatabaseClient().database, unconfirmed.generateContext, {
        gitCommitSha: "3".repeat(40),
      }),
    ).rejects.toBeInstanceOf(ProfileDraftInputError);
    const blocked = await createStudentWithFact({ fieldKey: "identity.name" });
    await expect(
      prepareProfileDraftTask(activeDatabaseClient().database, blocked.generateContext, {
        gitCommitSha: "4".repeat(40),
      }),
    ).rejects.toBeInstanceOf(ProfileDraftInputError);
  });

  it("creates immutable advisor revisions and enforces submit, return, and approve transitions", async () => {
    const actor = await createStudentWithFact();
    const generated = await generateProfile(actor, "6");
    await expect(
      activeDatabaseClient()
        .database.update(profileVersions)
        .set({
          approvedAt: new Date(),
          approvedByUserId: actor.userId,
          status: "approved",
          updatedAt: new Date(),
        })
        .where(eq(profileVersions.id, generated.id)),
    ).rejects.toMatchObject({ cause: { code: "P0001" } });
    const revised = await reviseProfileVersion(
      activeDatabaseClient().database,
      actor.reviewContext,
      generated.id,
      revisionInput(generated, "Advisor revision."),
    );
    expect(revised).toMatchObject({ status: "draft", version: 2 });
    let profiles = await readStudentProfiles(activeDatabaseClient().database, actor.readContext);
    expect(profiles.profiles.map((profile) => [profile.version, profile.status])).toEqual([
      [2, "draft"],
      [1, "archived"],
    ]);
    const draft = profiles.profiles[0];
    if (draft === undefined) throw new Error("Expected revised profile.");
    await transitionProfileVersion(activeDatabaseClient().database, actor.reviewContext, draft.id, {
      action: "submit",
      expectedUpdatedAt: draft.updatedAt.toISOString(),
    });
    profiles = await readStudentProfiles(activeDatabaseClient().database, actor.readContext);
    const inReview = profiles.profiles[0];
    if (inReview === undefined) throw new Error("Expected in-review profile.");
    expect(inReview.status).toBe("in_review");
    await expect(
      reviseProfileVersion(
        activeDatabaseClient().database,
        actor.reviewContext,
        inReview.id,
        revisionInput(inReview, "Invalid concurrent revision."),
      ),
    ).rejects.toThrow(/cannot be revised/u);
    await transitionProfileVersion(
      activeDatabaseClient().database,
      actor.reviewContext,
      inReview.id,
      {
        action: "return",
        expectedUpdatedAt: inReview.updatedAt.toISOString(),
        reason: "Synthetic evidence wording needs correction.",
      },
    );
    profiles = await readStudentProfiles(activeDatabaseClient().database, actor.readContext);
    const returned = profiles.profiles[0];
    if (returned === undefined) throw new Error("Expected returned profile.");
    const third = await reviseProfileVersion(
      activeDatabaseClient().database,
      actor.reviewContext,
      returned.id,
      revisionInput(returned, "Final advisor wording."),
    );
    profiles = await readStudentProfiles(activeDatabaseClient().database, actor.readContext);
    const finalDraft = profiles.profiles.find((profile) => profile.id === third.id);
    if (finalDraft === undefined) throw new Error("Expected final draft.");
    await transitionProfileVersion(
      activeDatabaseClient().database,
      actor.reviewContext,
      finalDraft.id,
      { action: "submit", expectedUpdatedAt: finalDraft.updatedAt.toISOString() },
    );
    profiles = await readStudentProfiles(activeDatabaseClient().database, actor.readContext);
    const finalReview = profiles.profiles.find((profile) => profile.id === finalDraft.id);
    if (finalReview === undefined) throw new Error("Expected final review.");
    await transitionProfileVersion(
      activeDatabaseClient().database,
      actor.approveContext,
      finalReview.id,
      { action: "approve", expectedUpdatedAt: finalReview.updatedAt.toISOString() },
    );
    profiles = await readStudentProfiles(activeDatabaseClient().database, actor.readContext);
    const approved = profiles.profiles.find((profile) => profile.id === finalDraft.id);
    expect(approved).toMatchObject({
      approvedByUserId: actor.userId,
      sourceProfileVersionId: returned.id,
      status: "approved",
      version: 3,
    });
    expect(approved?.reviews.map((review) => review.action)).toEqual([
      "revised",
      "submitted",
      "approved",
    ]);
    const reviewRows = await activeDatabaseClient()
      .database.select({ id: profileReviewRecords.id })
      .from(profileReviewRecords)
      .where(eq(profileReviewRecords.profileVersionId, finalDraft.id));
    expect(reviewRows).toHaveLength(3);
    await expect(
      activeDatabaseClient()
        .database.update(profileReviewRecords)
        .set({ reason: "tampered" })
        .where(eq(profileReviewRecords.id, reviewRows[0]?.id ?? randomUUID())),
    ).rejects.toMatchObject({ cause: { code: "P0001" } });
  });

  it("marks an approved profile needs_review when cited evidence is invalidated", async () => {
    const actor = await createStudentWithFact();
    const draft = await generateProfile(actor, "8");
    await transitionProfileVersion(activeDatabaseClient().database, actor.reviewContext, draft.id, {
      action: "submit",
      expectedUpdatedAt: draft.updatedAt.toISOString(),
    });
    let profiles = await readStudentProfiles(activeDatabaseClient().database, actor.readContext);
    const inReview = profiles.profiles[0];
    if (inReview === undefined) throw new Error("Expected in-review profile.");
    await transitionProfileVersion(
      activeDatabaseClient().database,
      actor.approveContext,
      draft.id,
      {
        action: "approve",
        expectedUpdatedAt: inReview.updatedAt.toISOString(),
      },
    );
    await activeDatabaseClient().database.insert(evidenceInvalidations).values({
      evidenceObjectId: actor.evidenceId,
      invalidatedByUserId: actor.userId,
      reason: "Synthetic consent withdrawal.",
    });
    profiles = await readStudentProfiles(activeDatabaseClient().database, actor.readContext);
    expect(profiles.profiles[0]).toMatchObject({
      approvedByUserId: actor.userId,
      invalidationReason: `evidence_invalidated:${actor.evidenceId}`,
      status: "needs_review",
    });
    expect(profiles.profiles[0]?.reviews.at(-1)).toMatchObject({
      action: "invalidated",
      fromStatus: "approved",
      toStatus: "needs_review",
    });
  });

  it("keeps review and approval authorization contexts separate", async () => {
    const actor = await createStudentWithFact();
    const draft = await generateProfile(actor, "c");
    await transitionProfileVersion(activeDatabaseClient().database, actor.reviewContext, draft.id, {
      action: "submit",
      expectedUpdatedAt: draft.updatedAt.toISOString(),
    });
    const profiles = await readStudentProfiles(activeDatabaseClient().database, actor.readContext);
    const inReview = profiles.profiles[0];
    if (inReview === undefined) throw new Error("Expected in-review profile.");
    await expect(
      transitionProfileVersion(activeDatabaseClient().database, actor.reviewContext, draft.id, {
        action: "approve",
        expectedUpdatedAt: inReview.updatedAt.toISOString(),
      }),
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);
    await expect(
      transitionProfileVersion(activeDatabaseClient().database, actor.approveContext, draft.id, {
        action: "return",
        expectedUpdatedAt: inReview.updatedAt.toISOString(),
        reason: "Synthetic review correction.",
      }),
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);
  });

  it("marks an approved profile needs_review when cited evidence is superseded", async () => {
    const actor = await createStudentWithFact();
    const draft = await generateProfile(actor, "9");
    await transitionProfileVersion(activeDatabaseClient().database, actor.reviewContext, draft.id, {
      action: "submit",
      expectedUpdatedAt: draft.updatedAt.toISOString(),
    });
    let profiles = await readStudentProfiles(activeDatabaseClient().database, actor.readContext);
    const inReview = profiles.profiles[0];
    if (inReview === undefined) throw new Error("Expected in-review profile.");
    await transitionProfileVersion(
      activeDatabaseClient().database,
      actor.approveContext,
      draft.id,
      {
        action: "approve",
        expectedUpdatedAt: inReview.updatedAt.toISOString(),
      },
    );
    const replacementHash = "b".repeat(64);
    await activeDatabaseClient()
      .database.insert(evidenceObjects)
      .values({
        accessLevel: "sensitive",
        byteCount: 21,
        contentHash: replacementHash,
        dataDomain: "student",
        mimeType: "text/plain",
        originalFileName: "synthetic-v2.txt",
        storageKey: `student/${actor.studentId}/bb/${replacementHash}`,
        studentId: actor.studentId,
        supersedesId: actor.evidenceId,
        uploadedByUserId: actor.userId,
        version: 2,
      });
    profiles = await readStudentProfiles(activeDatabaseClient().database, actor.readContext);
    expect(profiles.profiles[0]).toMatchObject({
      invalidationReason: `evidence_superseded:${actor.evidenceId}`,
      status: "needs_review",
    });
  });

  it("blocks approval when evidence becomes stale while the profile is in review", async () => {
    const actor = await createStudentWithFact();
    const draft = await generateProfile(actor, "a");
    await transitionProfileVersion(activeDatabaseClient().database, actor.reviewContext, draft.id, {
      action: "submit",
      expectedUpdatedAt: draft.updatedAt.toISOString(),
    });
    const profiles = await readStudentProfiles(activeDatabaseClient().database, actor.readContext);
    const inReview = profiles.profiles[0];
    if (inReview === undefined) throw new Error("Expected in-review profile.");
    await activeDatabaseClient().database.insert(evidenceInvalidations).values({
      evidenceObjectId: actor.evidenceId,
      invalidatedByUserId: actor.userId,
      reason: "Synthetic stale evidence.",
    });
    await expect(
      transitionProfileVersion(activeDatabaseClient().database, actor.approveContext, draft.id, {
        action: "approve",
        expectedUpdatedAt: inReview.updatedAt.toISOString(),
      }),
    ).rejects.toThrow(/no longer current/u);
    const rows = await activeDatabaseClient()
      .database.select({ status: profileVersions.status })
      .from(profileVersions)
      .where(eq(profileVersions.id, draft.id));
    expect(rows[0]?.status).toBe("in_review");
  });

  it("marks an approved profile needs_review when an input fact is superseded", async () => {
    const actor = await createStudentWithFact();
    const draft = await generateProfile(actor, "b");
    await transitionProfileVersion(activeDatabaseClient().database, actor.reviewContext, draft.id, {
      action: "submit",
      expectedUpdatedAt: draft.updatedAt.toISOString(),
    });
    let profiles = await readStudentProfiles(activeDatabaseClient().database, actor.readContext);
    const inReview = profiles.profiles[0];
    if (inReview === undefined) throw new Error("Expected in-review profile.");
    await transitionProfileVersion(
      activeDatabaseClient().database,
      actor.approveContext,
      draft.id,
      {
        action: "approve",
        expectedUpdatedAt: inReview.updatedAt.toISOString(),
      },
    );
    const supersededAt = new Date(Date.now() + 1_000);
    await activeDatabaseClient()
      .database.update(studentFacts)
      .set({ confirmationStatus: "superseded", updatedAt: supersededAt, validTo: supersededAt })
      .where(eq(studentFacts.id, actor.factId));
    profiles = await readStudentProfiles(activeDatabaseClient().database, actor.readContext);
    expect(profiles.profiles[0]).toMatchObject({
      invalidationReason: `fact_superseded:${actor.factId}`,
      status: "needs_review",
    });
  });
});
