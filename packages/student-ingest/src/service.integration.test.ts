import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonModelProvider } from "@culiu/ai";
import {
  AuthorizationDeniedError,
  createStudentAuthorizationContext,
  createStudentImportAuthorizationContext,
  type AuthorizationContext,
  type SessionPrincipal,
} from "@culiu/authorization";
import {
  appUsers,
  createDatabaseClient,
  evidenceObjects,
  parseDatabaseConfig,
  runMigrations,
  studentFacts,
  studentFactSuggestions,
  studentAuthorizations,
  studentImportBatches,
  students,
  type DatabaseClient,
} from "@culiu/database";
import { LocalImmutableObjectStore } from "@culiu/storage";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyBasicStudentImportCandidate,
  createBasicStudentImportBatch,
  extractBasicStudentImportBatch,
  readStudentImportBatch,
} from "./service.js";
import {
  createIncrementalStudentImportBatch,
  decideIncrementalSuggestion,
  extractIncrementalStudentImportBatch,
} from "./incremental-service.js";

let maintenanceClient: DatabaseClient | undefined;
let databaseClient: DatabaseClient | undefined;
let temporaryDatabaseName = "";
let temporaryRoot = "";
let objectStore: LocalImmutableObjectStore | undefined;

function activeClient(): DatabaseClient {
  if (databaseClient === undefined) throw new Error("Integration database is unavailable.");
  return databaseClient;
}

function activeStore(): LocalImmutableObjectStore {
  if (objectStore === undefined) throw new Error("Integration object store is unavailable.");
  return objectStore;
}

async function createAdministrator(): Promise<{
  context: AuthorizationContext;
  principal: SessionPrincipal;
}> {
  const id = randomUUID();
  const principal: SessionPrincipal = {
    displayName: "Synthetic Import Administrator",
    email: `${id}@example.invalid`,
    id,
    role: "admin",
  };
  await activeClient().database.insert(appUsers).values({
    displayName: principal.displayName,
    email: principal.email,
    id,
    role: "admin",
  });
  const context = await createStudentImportAuthorizationContext(activeClient().database, principal);
  return { context, principal };
}

beforeAll(async () => {
  const base = parseDatabaseConfig();
  temporaryDatabaseName = `culiu_student_ingest_${randomUUID().replaceAll("-", "")}`;
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
    maxConnections: 4,
  });
  await runMigrations(databaseClient);
  temporaryRoot = await mkdtemp(join(tmpdir(), "culiu-student-ingest-"));
  objectStore = new LocalImmutableObjectStore(temporaryRoot);
});

afterAll(async () => {
  await databaseClient?.close();
  if (maintenanceClient !== undefined && temporaryDatabaseName !== "") {
    await maintenanceClient.pool.query(`drop database if exists "${temporaryDatabaseName}"`);
    await maintenanceClient.close();
  }
  if (temporaryRoot !== "") await rm(temporaryRoot, { force: true, recursive: true });
});

describe("basic student import workflow", () => {
  it("keeps the multi-student source restricted, redacts phones and materializes reviewed facts", async () => {
    const { context } = await createAdministrator();
    let outboundPrompt = "";
    const provider: JsonModelProvider = {
      generateJson(request) {
        outboundPrompt = request.userPrompt;
        return Promise.resolve({
          json: {
            candidates: [
              {
                displayLabel: "张同学 / G8",
                fields: [
                  {
                    confidence: "high",
                    fieldKey: "identity.chinese_name",
                    sourceLocator: { column: 1, row: 2 },
                    value: "张同学",
                  },
                  {
                    confidence: "high",
                    fieldKey: "education.grade",
                    sourceLocator: { column: 2, row: 2 },
                    value: "G8",
                  },
                  {
                    confidence: "high",
                    fieldKey: "contact.parent_phone",
                    sourceLocator: { column: 3, row: 2 },
                    value: "[PHONE_1]",
                  },
                ],
                sourceOrdinal: 1,
              },
            ],
          },
          model: "deepseek-v4-flash",
          providerRequestId: "synthetic-request",
          usage: {
            completionTokens: 40,
            promptCacheHitTokens: 0,
            promptCacheMissTokens: 120,
            promptTokens: 120,
            totalTokens: 160,
          },
        });
      },
    };
    const batch = await createBasicStudentImportBatch(
      activeClient().database,
      activeStore(),
      context,
      {
        content: Buffer.from("姓名,年级,家长电话\n张同学,G8,13800138000", "utf8"),
        fileName: "synthetic-students.csv",
        mimeType: "text/csv",
      },
    );
    const storedBatch = await activeClient()
      .database.select({ storageKey: studentImportBatches.storageKey })
      .from(studentImportBatches)
      .where(eq(studentImportBatches.id, batch.id));
    expect(storedBatch[0]?.storageKey).toMatch(/^student-import\//u);

    const extracted = await extractBasicStudentImportBatch(
      activeClient().database,
      activeStore(),
      provider,
      context,
      batch.id,
    );
    expect(outboundPrompt).not.toContain("13800138000");
    expect(extracted.status).toBe("review_ready");
    const candidate = extracted.candidates[0];
    if (candidate === undefined) throw new Error("Candidate was not extracted.");
    const decisions = candidate.suggestions.map((suggestion) => ({
      decision:
        suggestion.fieldKey === "education.grade" ? ("rejected" as const) : ("accepted" as const),
      suggestionId: suggestion.id,
    }));
    const applied = await applyBasicStudentImportCandidate(
      activeClient().database,
      activeStore(),
      context,
      { candidateId: candidate.id, decision: "create", fields: decisions },
    );
    expect(applied.studentId).toMatch(/^[0-9a-f-]{36}$/u);
    const studentId = applied.studentId;
    if (studentId === null) throw new Error("Student was not created.");
    const facts = await activeClient()
      .database.select({ fieldKey: studentFacts.fieldKey, value: studentFacts.value })
      .from(studentFacts)
      .where(eq(studentFacts.studentId, studentId));
    expect(facts).toEqual(
      expect.arrayContaining([
        { fieldKey: "identity.chinese_name", value: { text: "张同学" } },
        { fieldKey: "contact.parent_phone", value: { text: "13800138000" } },
      ]),
    );
    expect(facts.some((fact) => fact.fieldKey === "education.grade")).toBe(false);
    const evidence = await activeClient()
      .database.select({ storageKey: evidenceObjects.storageKey })
      .from(evidenceObjects)
      .where(eq(evidenceObjects.studentId, studentId));
    expect(evidence[0]?.storageKey).toMatch(new RegExp(`^student/${studentId}/`, "u"));
    await expect(
      readStudentImportBatch(activeClient().database, context, batch.id),
    ).resolves.toMatchObject({
      status: "applied",
    });
  });

  it("does not let a different administrator read another administrator's batch", async () => {
    const owner = await createAdministrator();
    const other = await createAdministrator();
    const batch = await createBasicStudentImportBatch(
      activeClient().database,
      activeStore(),
      owner.context,
      {
        content: Buffer.from("学员姓名：合成学生", "utf8"),
        fileName: "synthetic.txt",
        mimeType: "text/plain",
      },
    );
    await expect(
      readStudentImportBatch(activeClient().database, other.context, batch.id),
    ).rejects.toThrow("not found");
    await expect(
      createStudentImportAuthorizationContext(activeClient().database, {
        ...other.principal,
        role: "advisor",
      }),
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);
  });

  it("links a reviewed duplicate candidate to the detected existing student", async () => {
    const { context, principal } = await createAdministrator();
    const studentId = randomUUID();
    await activeClient()
      .database.insert(students)
      .values({
        id: studentId,
        ownerUserId: principal.id,
        privacyLevel: "restricted",
        publicCode: `SYN-LINK-${studentId.slice(0, 8)}`,
      });
    await activeClient()
      .database.insert(studentFacts)
      .values([
        {
          accessLevel: "restricted",
          confirmationStatus: "confirmed",
          fieldKey: "identity.chinese_name",
          id: randomUUID(),
          sourceType: "advisor",
          studentId,
          value: { text: "合成链接学生" },
        },
        {
          accessLevel: "restricted",
          confirmationStatus: "confirmed",
          fieldKey: "education.school",
          id: randomUUID(),
          sourceType: "advisor",
          studentId,
          value: { text: "合成链接学校" },
        },
      ]);
    const provider: JsonModelProvider = {
      generateJson() {
        return Promise.resolve({
          json: {
            candidates: [
              {
                displayLabel: "合成链接学生",
                fields: [
                  {
                    confidence: "high",
                    fieldKey: "identity.chinese_name",
                    sourceLocator: { end: 8, start: 0 },
                    value: "合成链接学生",
                  },
                  {
                    confidence: "high",
                    fieldKey: "education.school",
                    sourceLocator: { end: 17, start: 9 },
                    value: "合成链接学校",
                  },
                ],
                sourceOrdinal: 1,
              },
            ],
          },
          model: "deepseek-v4-flash",
          providerRequestId: "synthetic-link",
          usage: {
            completionTokens: 20,
            promptCacheHitTokens: 0,
            promptCacheMissTokens: 60,
            promptTokens: 60,
            totalTokens: 80,
          },
        });
      },
    };
    const batch = await createBasicStudentImportBatch(
      activeClient().database,
      activeStore(),
      context,
      {
        content: Buffer.from("学员姓名：合成链接学生\n就读学校：合成链接学校", "utf8"),
        fileName: "synthetic-link.txt",
        mimeType: "text/plain",
      },
    );
    const extracted = await extractBasicStudentImportBatch(
      activeClient().database,
      activeStore(),
      provider,
      context,
      batch.id,
    );
    const candidate = extracted.candidates[0];
    if (candidate === undefined) throw new Error("Link candidate was not extracted.");
    expect(candidate.possibleStudentId).toBe(studentId);
    await expect(
      applyBasicStudentImportCandidate(activeClient().database, activeStore(), context, {
        candidateId: candidate.id,
        decision: "link",
        fields: candidate.suggestions.map((suggestion) => ({
          decision: "accepted",
          suggestionId: suggestion.id,
        })),
      }),
    ).resolves.toEqual({ studentId });
    await expect(
      readStudentImportBatch(activeClient().database, context, batch.id),
    ).resolves.toMatchObject({
      candidates: [expect.objectContaining({ decision: "link" })],
      status: "applied",
    });
  });
});

describe("incremental student evidence workflow", () => {
  it("isolates the selected CSV column and applies one reviewed suggestion idempotently", async () => {
    const userId = randomUUID();
    const studentId = randomUUID();
    const principal: SessionPrincipal = {
      displayName: "Synthetic Advisor",
      email: `${userId}@example.invalid`,
      id: userId,
      role: "advisor",
    };
    const database = activeClient().database;
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
      publicCode: `SYN-${studentId}`,
    });
    await database.insert(studentAuthorizations).values({
      allowedActions: ["student:read", "student:write"],
      grantedByUserId: userId,
      maxAccessLevel: "sensitive",
      studentId,
      userId,
      validFrom: new Date(Date.now() - 60_000),
    });
    const context = await createStudentAuthorizationContext(database, principal, {
      accessLevel: "sensitive",
      action: "student:write",
      studentId,
    });
    const batch = await createIncrementalStudentImportBatch(
      database,
      activeStore(),
      context,
      {
        content: Buffer.from(
          "日期,课程内容,张三 G8,李四 G9\n2026-08-01,DFS,能够解释递归,缺席",
          "utf8",
        ),
        fileName: "synthetic-feedback.csv",
        mimeType: "text/csv",
      },
      { aliases: ["张三"], ownershipConfirmed: true },
    );
    let outbound = "";
    const provider: JsonModelProvider = {
      generateJson(request) {
        outbound = request.userPrompt;
        return Promise.resolve({
          json: {
            suggestions: [
              {
                confidence: "high",
                fieldKey: "learning.algorithm_reasoning",
                informationNature: "fact",
                sourceRef: "R2C3",
                value: { text: "能够解释递归" },
              },
            ],
          },
          model: "deepseek-v4-flash",
          providerRequestId: "incremental-synthetic",
          usage: {
            completionTokens: 20,
            promptCacheHitTokens: 0,
            promptCacheMissTokens: 80,
            promptTokens: 80,
            totalTokens: 100,
          },
        });
      },
    };
    const suggestions = await extractIncrementalStudentImportBatch(
      database,
      activeStore(),
      provider,
      context,
      batch.id,
    );
    expect(outbound).not.toContain("李四");
    expect(outbound).not.toContain("缺席");
    expect(outbound).not.toContain("张三");
    const suggestion = suggestions[0];
    if (suggestion === undefined) throw new Error("Suggestion was not extracted.");
    const createdAt = await database
      .select({ createdAt: studentFactSuggestions.createdAt })
      .from(studentFactSuggestions)
      .where(eq(studentFactSuggestions.id, suggestion.id));
    const expectedCreatedAt = createdAt[0]?.createdAt;
    if (expectedCreatedAt === undefined) throw new Error("Suggestion timestamp is missing.");
    const result = await decideIncrementalSuggestion(database, context, {
      decision: "accepted",
      expectedCreatedAt,
      suggestionId: suggestion.id,
    });
    expect(result.factId).toMatch(/^[0-9a-f-]{36}$/u);
    const facts = await database
      .select({ fieldKey: studentFacts.fieldKey, value: studentFacts.value })
      .from(studentFacts)
      .where(eq(studentFacts.studentId, studentId));
    expect(facts).toContainEqual({
      fieldKey: "learning.algorithm_reasoning",
      value: { text: "能够解释递归" },
    });
    await expect(
      decideIncrementalSuggestion(database, context, {
        decision: "accepted",
        expectedCreatedAt,
        suggestionId: suggestion.id,
      }),
    ).rejects.toThrow("stale or already decided");
  });
});
