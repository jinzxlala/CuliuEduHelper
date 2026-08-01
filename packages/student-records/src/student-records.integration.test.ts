import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AuthorizationDeniedError,
  createStudentAuthorizationContext,
  type AuthorizationContext,
  type SessionPrincipal,
} from "@culiu/authorization";
import {
  appUsers,
  createDatabaseClient,
  evidenceLocators,
  evidenceObjects,
  parseDatabaseConfig,
  runMigrations,
  studentAuthorizations,
  studentFacts,
  students,
  type DatabaseClient,
} from "@culiu/database";
import { LocalImmutableObjectStore } from "@culiu/storage";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { StudentRecordConflictError, StudentRecordNotFoundError } from "./errors.js";
import {
  createStudentFact,
  invalidateStudentEvidence,
  readStudentEvidenceContent,
  readStudentRecord,
  registerStudentEvidence,
  type RegisteredStudentEvidence,
  type StudentEvidenceLocatorRecord,
} from "./service.js";

let maintenanceClient: DatabaseClient | undefined;
let databaseClient: DatabaseClient | undefined;
let temporaryDatabaseName = "";
let temporaryRoot = "";
let objectStore: LocalImmutableObjectStore | undefined;

function activeDatabaseClient(): DatabaseClient {
  if (databaseClient === undefined) throw new Error("Test database is unavailable.");
  return databaseClient;
}

function activeObjectStore(): LocalImmutableObjectStore {
  if (objectStore === undefined) throw new Error("Test object store is unavailable.");
  return objectStore;
}

async function createActorAndStudent(
  options: {
    maxAccessLevel?: "internal" | "restricted" | "sensitive";
  } = {},
): Promise<{
  principal: SessionPrincipal;
  readContext: AuthorizationContext;
  studentId: string;
  writeContext: AuthorizationContext;
}> {
  const database = activeDatabaseClient().database;
  const userId = randomUUID();
  const studentId = randomUUID();
  const principal: SessionPrincipal = {
    displayName: "Synthetic Records Advisor",
    email: `${userId}@example.invalid`,
    id: userId,
    role: "advisor",
  };
  await database.insert(appUsers).values({
    displayName: principal.displayName,
    email: principal.email,
    id: principal.id,
    role: principal.role,
  });
  await database.insert(students).values({
    id: studentId,
    ownerUserId: userId,
    privacyLevel: "sensitive",
    publicCode: `synthetic_${studentId}`,
  });
  await database.insert(studentAuthorizations).values({
    allowedActions: ["student:read", "student:write"],
    grantedByUserId: userId,
    maxAccessLevel: options.maxAccessLevel ?? "sensitive",
    studentId,
    userId,
    validFrom: new Date(Date.now() - 60_000),
  });
  const readContext = await createStudentAuthorizationContext(database, principal, {
    accessLevel: "sensitive",
    action: "student:read",
    studentId,
  });
  const writeContext = await createStudentAuthorizationContext(database, principal, {
    accessLevel: "sensitive",
    action: "student:write",
    studentId,
  });
  return { principal, readContext, studentId, writeContext };
}

async function registerSyntheticEvidence(
  context: AuthorizationContext,
  text = "synthetic transcript evidence",
): Promise<RegisteredStudentEvidence> {
  return registerStudentEvidence(activeDatabaseClient().database, activeObjectStore(), context, {
    accessLevel: "sensitive",
    content: Buffer.from(text, "utf8"),
    fileName: "synthetic.txt",
    locators: [{ locator: { field: "summary" }, locatorType: "record_field" }],
    mimeType: "text/plain",
  });
}

function firstLocator(evidence: RegisteredStudentEvidence): StudentEvidenceLocatorRecord {
  const locator = evidence.evidence.locators[0];
  if (locator === undefined) throw new Error("Synthetic evidence did not create a locator.");
  return locator;
}

beforeAll(async () => {
  const base = parseDatabaseConfig();
  temporaryDatabaseName = `culiu_records_${randomUUID().replaceAll("-", "")}`;
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
  temporaryRoot = await mkdtemp(join(tmpdir(), "culiu-student-records-"));
  objectStore = new LocalImmutableObjectStore(temporaryRoot);
});

afterAll(async () => {
  if (databaseClient !== undefined) {
    await databaseClient.close();
    databaseClient = undefined;
  }
  if (maintenanceClient !== undefined) {
    await maintenanceClient.pool.query(
      "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
      [temporaryDatabaseName],
    );
    await maintenanceClient.pool.query(`drop database if exists "${temporaryDatabaseName}"`);
    await maintenanceClient.close();
    maintenanceClient = undefined;
  }
  if (temporaryRoot !== "") await rm(temporaryRoot, { force: true, recursive: true });
});

describe("student records", () => {
  it("stores immutable evidence, binds a confirmed fact, reads it, and downloads the bytes", async () => {
    const actor = await createActorAndStudent();
    const registered = await registerSyntheticEvidence(actor.writeContext);
    const locator = firstLocator(registered);
    const fact = await createStudentFact(activeDatabaseClient().database, actor.writeContext, {
      accessLevel: "sensitive",
      confirmationStatus: "confirmed",
      evidenceLinks: [{ evidenceLocatorId: locator.id, relation: "supports" }],
      fieldKey: "academic.gpa",
      sourceType: "evidence",
      value: { scale: 4, value: 3.8 },
    });
    expect(fact.evidenceLinks[0]?.evidenceObjectId).toBe(registered.evidence.id);

    const record = await readStudentRecord(activeDatabaseClient().database, actor.readContext);
    expect(record.facts.find((candidate) => candidate.id === fact.id)).toMatchObject({
      confirmationStatus: "confirmed",
      current: true,
      fieldKey: "academic.gpa",
    });
    expect(
      record.evidence.find((candidate) => candidate.id === registered.evidence.id),
    ).toMatchObject({ current: true, originalFileName: "synthetic.txt" });
    const download = await readStudentEvidenceContent(
      activeDatabaseClient().database,
      activeObjectStore(),
      actor.readContext,
      registered.evidence.id,
    );
    expect(Buffer.from(download.content).toString("utf8")).toBe("synthetic transcript evidence");
  });

  it("rejects a locator belonging to another student", async () => {
    const first = await createActorAndStudent();
    const second = await createActorAndStudent();
    const otherEvidence = await registerSyntheticEvidence(second.writeContext);
    await expect(
      createStudentFact(activeDatabaseClient().database, first.writeContext, {
        evidenceLinks: [
          {
            evidenceLocatorId: firstLocator(otherEvidence).id,
            relation: "supports",
          },
        ],
        fieldKey: "academic.rank",
        sourceType: "evidence",
        value: { rank: 3 },
      }),
    ).rejects.toBeInstanceOf(StudentRecordNotFoundError);
  });

  it("rejects knowledge-domain evidence masquerading as student evidence", async () => {
    const actor = await createActorAndStudent();
    const database = activeDatabaseClient().database;
    const serviceId = randomUUID();
    const evidenceId = randomUUID();
    const locatorId = randomUUID();
    const digest = "a".repeat(64);
    await database.insert(appUsers).values({
      displayName: "Synthetic Knowledge Service",
      email: `${serviceId}@example.invalid`,
      id: serviceId,
      role: "service",
    });
    await database.insert(evidenceObjects).values({
      accessLevel: "internal",
      byteCount: 1,
      contentHash: digest,
      dataDomain: "knowledge",
      id: evidenceId,
      mimeType: "text/plain",
      originalFileName: "anonymous.txt",
      storageKey: `knowledge/aa/${digest}`,
      uploadedByUserId: serviceId,
    });
    await database.insert(evidenceLocators).values({
      evidenceObjectId: evidenceId,
      id: locatorId,
      locator: { field: "anonymous" },
      locatorType: "record_field",
    });
    await expect(
      createStudentFact(database, actor.writeContext, {
        evidenceLinks: [{ evidenceLocatorId: locatorId, relation: "supports" }],
        fieldKey: "academic.rank",
        sourceType: "evidence",
        value: { rank: 3 },
      }),
    ).rejects.toBeInstanceOf(StudentRecordNotFoundError);
  });

  it("blocks a restricted upload when the authorization ceiling is sensitive", async () => {
    const actor = await createActorAndStudent({ maxAccessLevel: "sensitive" });
    await expect(
      registerStudentEvidence(
        activeDatabaseClient().database,
        activeObjectStore(),
        actor.writeContext,
        {
          accessLevel: "restricted",
          content: Buffer.from("restricted synthetic evidence"),
          fileName: "restricted.txt",
          locators: [{ locator: { field: "restricted" }, locatorType: "record_field" }],
          mimeType: "text/plain",
        },
      ),
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);
  });

  it("creates a linear fact revision and preserves immutable history", async () => {
    const actor = await createActorAndStudent();
    const first = await createStudentFact(activeDatabaseClient().database, actor.writeContext, {
      confirmationStatus: "confirmed",
      fieldKey: "interest.primary",
      sourceType: "advisor",
      value: { text: "robotics" },
    });
    const second = await createStudentFact(activeDatabaseClient().database, actor.writeContext, {
      confirmationStatus: "confirmed",
      fieldKey: "interest.primary",
      sourceType: "advisor",
      supersedesFactId: first.id,
      validFrom: new Date(first.validFrom.getTime() + 1_000),
      value: { text: "robotics and biology" },
    });
    const record = await readStudentRecord(activeDatabaseClient().database, actor.readContext);
    expect(record.facts.find((fact) => fact.id === first.id)).toMatchObject({
      confirmationStatus: "superseded",
      current: false,
    });
    expect(record.facts.find((fact) => fact.id === second.id)).toMatchObject({ current: true });
    await expect(
      activeDatabaseClient().pool.query("update student_fact set value = $1 where id = $2", [
        { text: "tampered" },
        second.id,
      ]),
    ).rejects.toMatchObject({ code: "55000" });
  });

  it("invalidates evidence append-only and makes existing links effectively invalid", async () => {
    const actor = await createActorAndStudent();
    const registered = await registerSyntheticEvidence(actor.writeContext);
    const fact = await createStudentFact(activeDatabaseClient().database, actor.writeContext, {
      evidenceLinks: [{ evidenceLocatorId: firstLocator(registered).id, relation: "supports" }],
      fieldKey: "activity.role",
      sourceType: "evidence",
      value: { text: "synthetic lead" },
    });
    await invalidateStudentEvidence(activeDatabaseClient().database, actor.writeContext, {
      evidenceObjectId: registered.evidence.id,
      reason: "Synthetic source was withdrawn.",
    });
    const record = await readStudentRecord(activeDatabaseClient().database, actor.readContext);
    expect(
      record.facts.find((candidate) => candidate.id === fact.id)?.evidenceLinks[0],
    ).toMatchObject({ effectiveValidationStatus: "invalid" });
    await expect(
      readStudentEvidenceContent(
        activeDatabaseClient().database,
        activeObjectStore(),
        actor.readContext,
        registered.evidence.id,
      ),
    ).rejects.toBeInstanceOf(StudentRecordNotFoundError);
    await expect(
      invalidateStudentEvidence(activeDatabaseClient().database, actor.writeContext, {
        evidenceObjectId: registered.evidence.id,
        reason: "Duplicate invalidation",
      }),
    ).rejects.toBeInstanceOf(StudentRecordConflictError);
  });

  it("creates one evidence revision and rejects a second branch", async () => {
    const actor = await createActorAndStudent();
    const first = await registerSyntheticEvidence(actor.writeContext, "version one");
    const second = await registerStudentEvidence(
      activeDatabaseClient().database,
      activeObjectStore(),
      actor.writeContext,
      {
        accessLevel: "sensitive",
        content: Buffer.from("version two"),
        fileName: "synthetic-v2.txt",
        locators: [{ locator: { field: "summary" }, locatorType: "record_field" }],
        mimeType: "text/plain",
        supersedesEvidenceId: first.evidence.id,
      },
    );
    expect(second.evidence).toMatchObject({ supersedesId: first.evidence.id, version: 2 });
    const record = await readStudentRecord(activeDatabaseClient().database, actor.readContext);
    expect(record.evidence.find((evidence) => evidence.id === first.evidence.id)?.current).toBe(
      false,
    );
    await expect(
      registerStudentEvidence(
        activeDatabaseClient().database,
        activeObjectStore(),
        actor.writeContext,
        {
          accessLevel: "sensitive",
          content: Buffer.from("branched version"),
          fileName: "synthetic-branch.txt",
          locators: [{ locator: { field: "summary" }, locatorType: "record_field" }],
          mimeType: "text/plain",
          supersedesEvidenceId: first.evidence.id,
        },
      ),
    ).rejects.toBeInstanceOf(StudentRecordConflictError);
  });

  it("rechecks a revoked grant before every record operation", async () => {
    const actor = await createActorAndStudent();
    await activeDatabaseClient()
      .database.delete(studentAuthorizations)
      .where(eq(studentAuthorizations.userId, actor.principal.id));
    await expect(
      readStudentRecord(activeDatabaseClient().database, actor.readContext),
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);
  });

  it("enforces cross-student and access-level evidence rules in PostgreSQL", async () => {
    const first = await createActorAndStudent();
    const second = await createActorAndStudent();
    const evidence = await registerSyntheticEvidence(second.writeContext);
    const factId = randomUUID();
    await activeDatabaseClient()
      .database.insert(studentFacts)
      .values({
        accessLevel: "internal",
        fieldKey: "synthetic.direct",
        id: factId,
        sourceType: "advisor",
        studentId: first.studentId,
        value: { text: "synthetic" },
      });
    await expect(
      activeDatabaseClient().pool.query(
        "insert into fact_evidence (student_fact_id, evidence_locator_id, relation, validation_status) values ($1, $2, 'supports', 'valid')",
        [factId, firstLocator(evidence).id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
