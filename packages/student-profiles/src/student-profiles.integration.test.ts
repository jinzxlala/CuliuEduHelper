import { randomUUID } from "node:crypto";

import {
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
  profileVersions,
  runMigrations,
  studentAuthorizations,
  studentFacts,
  students,
  type DatabaseClient,
} from "@culiu/database";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PROFILE_REDACTION_VERSION, ProfileInputSnapshotPayloadSchema } from "./contracts.js";
import { ProfileDraftInputError } from "./errors.js";
import {
  createDeterministicMockProfileProvider,
  executeProfileDraftTask,
  prepareProfileDraftTask,
  readStudentProfiles,
} from "./service.js";

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
  generateContext: AuthorizationContext;
  locatorId: string;
  readContext: AuthorizationContext;
  studentId: string;
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
    allowedActions: ["student:read", "student:profile:generate"],
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
    studentId,
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
});
