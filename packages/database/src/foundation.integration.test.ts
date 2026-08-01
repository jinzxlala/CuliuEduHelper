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
  await seedRedactedFixtures(client.database);
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

    const serviceContext = await databaseClient.pool.query<{
      allowed_actions: string[];
      role: string;
      student_id: string | null;
    }>(
      `select context.allowed_actions, context.student_id, actor.role
         from authorization_context_snapshot context
         join app_user actor on actor.id = context.actor_user_id
        where context.id = $1`,
      [REDACTED_FIXTURE_IDS.knowledgeAuthorizationContext],
    );
    expect(serviceContext.rows[0]).toEqual({
      allowed_actions: ["knowledge.import"],
      role: "service",
      student_id: null,
    });
  });

  it("keeps transcript publication blocked at the database boundary", async () => {
    await withRollback(async (transaction) => {
      await expect(
        transaction.query(
          `insert into knowledge_import_batch
            (corpus_id, corpus_hash, manifest_version, mapping_version,
             expected_lecture_count, transcript_segment_count)
           values ($1, $2, $3, $4, $5, $6)`,
          ["privacy_gate_fixture", "1".repeat(64), "1.0.0", "1.0.0", 48, 1],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });
  });

  it("allows only one published batch to be current", async () => {
    await withRollback(async (transaction) => {
      await transaction.query(
        "update knowledge_import_batch set is_current = false where is_current = true",
      );
      await transaction.query(
        `insert into knowledge_import_batch
          (corpus_id, corpus_hash, manifest_version, mapping_version, status,
           is_current, expected_lecture_count, published_at)
         values ($1, $2, $3, $4, 'published', true, 48, now())`,
        ["current_fixture_one", "2".repeat(64), "1.0.0", "1.0.0"],
      );
      await expect(
        transaction.query(
          `insert into knowledge_import_batch
            (corpus_id, corpus_hash, manifest_version, mapping_version, status,
             is_current, expected_lecture_count, published_at)
           values ($1, $2, $3, $4, 'published', true, 48, now())`,
          ["current_fixture_two", "3".repeat(64), "1.0.0", "1.0.0"],
        ),
      ).rejects.toMatchObject({ code: "23505" });
    });
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

  it("rejects student-domain sources and evidence in knowledge import relations", async () => {
    await withRollback(async (transaction) => {
      const { studentId, userId } = await insertSyntheticUserAndStudent(transaction);
      const batchId = randomUUID();
      const studentSourceId = randomUUID();
      const knowledgeSourceId = randomUUID();
      const studentEvidenceId = randomUUID();
      const knowledgeEvidenceId = randomUUID();
      const studentDigest = randomUUID().replaceAll("-", "").repeat(2);
      const knowledgeDigest = randomUUID().replaceAll("-", "").repeat(2);

      await transaction.query(
        `insert into knowledge_import_batch
          (id, corpus_id, corpus_hash, manifest_version, mapping_version, expected_lecture_count)
         values ($1, $2, $3, '1.0.0', '1.0.0', 48)`,
        [batchId, `domain_fixture_${batchId.replaceAll("-", "")}`, knowledgeDigest],
      );
      await transaction.query(
        `insert into source_document
          (id, data_domain, student_id, source_path, content_hash, document_type, mime_type)
         values ($1, 'student', $2, 'fixtures/student.md', $3, 'attachment', 'text/markdown'),
                ($4, 'knowledge', null, 'knowledge/analysis/fixture.md', $5,
                 'analysis_markdown', 'text/markdown')`,
        [studentSourceId, studentId, studentDigest, knowledgeSourceId, knowledgeDigest],
      );
      await transaction.query(
        `insert into evidence_object
          (id, data_domain, student_id, content_hash, storage_key, uploaded_by_user_id, access_level)
         values ($1, 'student', $2, $3, $4, $5, 'sensitive'),
                ($6, 'knowledge', null, $7, $8, $9, 'internal')`,
        [
          studentEvidenceId,
          studentId,
          studentDigest,
          `student/${studentId}/aa/${studentDigest}`,
          userId,
          knowledgeEvidenceId,
          knowledgeDigest,
          `knowledge/aa/${knowledgeDigest}`,
          REDACTED_FIXTURE_IDS.knowledgeServiceUser,
        ],
      );

      await transaction.query("savepoint student_source_check");
      await expect(
        transaction.query(
          `insert into knowledge_import_source
            (batch_id, lecture_id, source_role, source_document_id, evidence_object_id,
             source_key, logical_path, root_id, byte_count)
           values ($1, 'lecture_fixture', 'analysis_markdown', $2, $3,
                   'fixture', 'knowledge/analysis/fixture.md', 'analysis', 1)`,
          [batchId, studentSourceId, knowledgeEvidenceId],
        ),
      ).rejects.toMatchObject({ code: "23503" });
      await transaction.query("rollback to savepoint student_source_check");

      await transaction.query("savepoint student_evidence_check");
      await expect(
        transaction.query(
          `insert into knowledge_import_source
            (batch_id, lecture_id, source_role, source_document_id, evidence_object_id,
             source_key, logical_path, root_id, byte_count)
           values ($1, 'lecture_fixture', 'analysis_markdown', $2, $3,
                   'fixture', 'knowledge/analysis/fixture.md', 'analysis', 1)`,
          [batchId, knowledgeSourceId, studentEvidenceId],
        ),
      ).rejects.toMatchObject({ code: "23503" });
      await transaction.query("rollback to savepoint student_evidence_check");
    });
  });

  it("prevents published knowledge versions and source mappings from mutating", async () => {
    await withRollback(async (transaction) => {
      const batchId = randomUUID();
      const sourceId = randomUUID();
      const evidenceId = randomUUID();
      const lectureId = `lecture_${randomUUID().replaceAll("-", "")}`;
      const caseId = `case_${randomUUID().replaceAll("-", "")}`;
      const digest = randomUUID().replaceAll("-", "").repeat(2);
      const sourcePath = `knowledge/analysis/${lectureId}.md`;

      await transaction.query(
        `insert into knowledge_import_batch
          (id, corpus_id, corpus_hash, manifest_version, mapping_version, expected_lecture_count)
         values ($1, $2, $3, '1.0.0', '1.0.0', 48)`,
        [batchId, `immutable_${batchId.replaceAll("-", "")}`, digest],
      );
      await transaction.query(
        `insert into source_document
          (id, data_domain, source_path, content_hash, document_type, mime_type)
         values ($1, 'knowledge', $2, $3, 'analysis_markdown', 'text/markdown')`,
        [sourceId, sourcePath, digest],
      );
      await transaction.query(
        `insert into evidence_object
          (id, data_domain, content_hash, storage_key, uploaded_by_user_id, access_level)
         values ($1, 'knowledge', $2, $3, $4, 'internal')`,
        [evidenceId, digest, `knowledge/aa/${digest}`, REDACTED_FIXTURE_IDS.knowledgeServiceUser],
      );
      await transaction.query(
        `insert into knowledge_import_source
          (batch_id, lecture_id, source_role, source_document_id, evidence_object_id,
           source_key, logical_path, root_id, byte_count)
         values ($1, $2, 'analysis_markdown', $3, $4, 'fixture', $5, 'analysis', 1)`,
        [batchId, lectureId, sourceId, evidenceId, sourcePath],
      );
      await transaction.query(
        `insert into knowledge_lecture_version
          (batch_id, lecture_id, source_document_id, title, summary, trend_text,
           ai_cross_disciplinary_text, failure_text, speakers, schools, majors, source_path)
         values ($1, $2, $3, 'Fixture', '', '', '', '', '{}', '{}', '{}', $4)`,
        [batchId, lectureId, sourceId, sourcePath],
      );
      await transaction.query(
        `insert into knowledge_case_version
          (batch_id, case_id, lecture_id, source_document_id, case_type, academic_label,
           background, admission_result, schools, research_methods, activity_types,
           ai_domains, confidence, evidence_boundary, timestamp_refs)
         values ($1, $2, $3, $4, 'student_case', '', '', '', '{}', '{}', '{}', '{}',
                 'unknown', '', '[]'::jsonb)`,
        [batchId, caseId, lectureId, sourceId],
      );
      await transaction.query(
        `update knowledge_import_batch
            set status = 'published', published_at = now()
          where id = $1`,
        [batchId],
      );

      const protectedStatements: Array<{ parameters: unknown[]; sql: string }> = [
        {
          parameters: [batchId],
          sql: "update knowledge_import_batch set status = 'failed', published_at = null where id = $1",
        },
        {
          parameters: [batchId],
          sql: "delete from knowledge_import_batch where id = $1",
        },
        {
          parameters: [batchId, lectureId],
          sql: "update knowledge_lecture_version set summary = 'changed' where batch_id = $1 and lecture_id = $2",
        },
        {
          parameters: [batchId, caseId],
          sql: "delete from knowledge_case_version where batch_id = $1 and case_id = $2",
        },
        {
          parameters: [batchId, lectureId],
          sql: "delete from knowledge_import_source where batch_id = $1 and lecture_id = $2",
        },
      ];
      for (const [index, statement] of protectedStatements.entries()) {
        const savepoint = `published_immutable_${String(index)}`;
        await transaction.query(`savepoint ${savepoint}`);
        await expect(transaction.query(statement.sql, statement.parameters)).rejects.toMatchObject({
          code: "55000",
        });
        await transaction.query(`rollback to savepoint ${savepoint}`);
      }
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
