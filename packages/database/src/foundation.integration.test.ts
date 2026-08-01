import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { checkDatabaseConnection, createDatabaseClient, type DatabaseClient } from "./client.js";
import { parseDatabaseConfig } from "./config.js";
import { REDACTED_FIXTURE_IDS, seedRedactedFixtures } from "./fixtures.js";
import { runMigrations } from "./migrate.js";

let client: DatabaseClient | undefined;

function activeClient(): DatabaseClient {
  if (client === undefined) {
    throw new Error("Database integration client was not initialized.");
  }
  return client;
}

async function withRollback(test: (transaction: PoolClient) => Promise<void>): Promise<void> {
  const transaction = await activeClient().pool.connect();
  try {
    await transaction.query("begin");
    await test(transaction);
  } finally {
    await transaction.query("rollback");
    transaction.release();
  }
}

async function insertSyntheticUserAndStudent(
  transaction: PoolClient,
): Promise<{ studentId: string; userId: string }> {
  const userId = randomUUID();
  const studentId = randomUUID();
  await transaction.query(
    'insert into "app_user" ("id", "email", "display_name", "role") values ($1, $2, $3, $4)',
    [userId, `${userId}@example.invalid`, "Synthetic Advisor", "advisor"],
  );
  await transaction.query(
    'insert into "student" ("id", "public_code", "owner_user_id") values ($1, $2, $3)',
    [studentId, `student_${studentId}`, userId],
  );
  return { studentId, userId };
}

beforeAll(async () => {
  client = createDatabaseClient(parseDatabaseConfig());
  await runMigrations(client);
});

afterAll(async () => {
  if (client) {
    await client.close();
  }
});

describe("foundation migration", () => {
  it("is repeatable and the database is reachable", async () => {
    const databaseClient = activeClient();
    await runMigrations(databaseClient);
    await checkDatabaseConnection(databaseClient);
  });

  it("seeds only idempotent redacted fixtures", async () => {
    const databaseClient = activeClient();
    await seedRedactedFixtures(databaseClient.database);
    await seedRedactedFixtures(databaseClient.database);

    const result = await databaseClient.pool.query<{ count: string }>(
      'select count(*)::text as count from "student" where "id" = $1',
      [REDACTED_FIXTURE_IDS.student],
    );
    expect(result.rows[0]?.count).toBe("1");
  });

  it("rejects a knowledge source document carrying a student identifier", async () => {
    await withRollback(async (transaction) => {
      const { studentId } = await insertSyntheticUserAndStudent(transaction);
      await expect(
        transaction.query(
          'insert into "source_document" ("data_domain", "student_id", "source_path", "content_hash", "document_type", "mime_type") values ($1, $2, $3, $4, $5, $6)',
          [
            "knowledge",
            studentId,
            "fixtures/invalid.md",
            "d".repeat(64),
            "analysis_markdown",
            "text/markdown",
          ],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });
  });

  it("rejects evidence links across students", async () => {
    await withRollback(async (transaction) => {
      const first = await insertSyntheticUserAndStudent(transaction);
      const second = await insertSyntheticUserAndStudent(transaction);
      const evidenceObjectId = randomUUID();
      const locatorId = randomUUID();
      const factId = randomUUID();
      const digest = "e".repeat(64);

      await transaction.query(
        'insert into "evidence_object" ("id", "data_domain", "student_id", "content_hash", "storage_key", "uploaded_by_user_id", "access_level") values ($1, $2, $3, $4, $5, $6, $7)',
        [
          evidenceObjectId,
          "student",
          second.studentId,
          digest,
          `student/${second.studentId}/ee/${digest}`,
          second.userId,
          "sensitive",
        ],
      );
      await transaction.query(
        'insert into "evidence_locator" ("id", "evidence_object_id", "locator_type", "locator") values ($1, $2, $3, $4)',
        [locatorId, evidenceObjectId, "record_field", { field: "synthetic" }],
      );
      await transaction.query(
        'insert into "student_fact" ("id", "student_id", "field_key", "value", "source_type") values ($1, $2, $3, $4, $5)',
        [factId, first.studentId, "synthetic_fact", { value: "synthetic" }, "evidence"],
      );

      await expect(
        transaction.query(
          'insert into "fact_evidence" ("student_fact_id", "evidence_locator_id", "relation") values ($1, $2, $3)',
          [factId, locatorId, "supports"],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });
  });

  it("prevents evidence objects from being updated in place", async () => {
    await withRollback(async (transaction) => {
      const { studentId, userId } = await insertSyntheticUserAndStudent(transaction);
      const evidenceObjectId = randomUUID();
      const digest = "f".repeat(64);
      await transaction.query(
        'insert into "evidence_object" ("id", "data_domain", "student_id", "content_hash", "storage_key", "uploaded_by_user_id", "access_level") values ($1, $2, $3, $4, $5, $6, $7)',
        [
          evidenceObjectId,
          "student",
          studentId,
          digest,
          `student/${studentId}/ff/${digest}`,
          userId,
          "sensitive",
        ],
      );

      await expect(
        transaction.query('update "evidence_object" set "access_level" = $1 where "id" = $2', [
          "restricted",
          evidenceObjectId,
        ]),
      ).rejects.toMatchObject({ code: "55000" });
    });
  });
});
