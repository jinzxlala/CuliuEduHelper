import { randomUUID } from "node:crypto";

import {
  createDatabaseClient,
  parseDatabaseConfig,
  REDACTED_FIXTURE_IDS,
  runMigrations,
  seedRedactedFixtures,
} from "@culiu/database";
import { KnowledgeImporter } from "@culiu/knowledge-ingest";
import {
  createMeilisearchClient,
  KnowledgeIndexManager,
  parseMeilisearchAdminConfig,
} from "@culiu/search";
import { LocalImmutableObjectStore } from "@culiu/storage";
import {
  createRedisConnection,
  createTaskQueue,
  createTaskWorker,
  enqueueTask,
  parseRedisUrl,
  type KnowledgeImportTask,
} from "@culiu/tasks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseWorkerRuntimeConfig } from "./config.js";
import { buildWorkerHealth } from "./health.js";
import {
  createKnowledgeImportTaskHandler,
  type KnowledgeImportAuditEvent,
} from "./knowledge-import-handler.js";

const databaseClient = createDatabaseClient(parseDatabaseConfig());

beforeAll(async () => {
  await runMigrations(databaseClient);
  await seedRedactedFixtures(databaseClient.database);
});

afterAll(async () => {
  await databaseClient.close();
});

async function waitForFailedJob(
  queue: ReturnType<typeof createTaskQueue>,
  jobId: string,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const job = await queue.getJob(jobId);
    if ((await job?.getState()) === "failed") return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  throw new Error("Timed out waiting for the intentionally invalid import to exhaust retries.");
}

async function runFailureScenario(initialAttempts: 0 | 1 | 3): Promise<void> {
  const runtime = parseWorkerRuntimeConfig();
  const redisUrl = parseRedisUrl();
  const queueConnection = createRedisConnection(redisUrl);
  const workerConnection = createRedisConnection(redisUrl);
  const queueName = `culiu-knowledge-failure-${randomUUID()}`;
  const queue = createTaskQueue({ connection: queueConnection, queueName });
  const indexManager = new KnowledgeIndexManager({
    client: createMeilisearchClient(parseMeilisearchAdminConfig()),
  });
  const importer = new KnowledgeImporter({
    databaseClient,
    indexPublisher: indexManager,
    manifestPath: runtime.manifestPath,
    objectStore: new LocalImmutableObjectStore(runtime.localStorageRoot),
    sourceRoots: runtime.sourceRoots,
  });
  const auditEvents: KnowledgeImportAuditEvent[] = [];
  const worker = createTaskWorker({
    connection: workerConnection,
    handlers: {
      "knowledge.extract": () => Promise.resolve({ skipped: true }),
      "knowledge.import": createKnowledgeImportTaskHandler({
        auditWriter: (event) => {
          auditEvents.push(event);
          return Promise.resolve();
        },
        databaseClient,
        importer,
      }),
      "profile.draft": () => Promise.resolve({ skipped: true }),
      "system.probe": () => Promise.resolve(buildWorkerHealth()),
    },
    queueName,
  });
  const taskId = randomUUID();
  const correlationId = randomUUID();
  const corpusHash = randomUUID().replaceAll("-", "").repeat(2);
  const task: KnowledgeImportTask = {
    authorization: {
      contextHash: "d".repeat(64),
      contextId: REDACTED_FIXTURE_IDS.knowledgeAuthorizationContext,
    },
    idempotencyKey: `knowledge_failure_${randomUUID().replaceAll("-", "")}`,
    payload: {
      correlationId,
      corpusHash,
      corpusId: "eduknow_knowledge_sources_v1",
      manifestVersion: "1.0.0",
      mappingVersion: "1.0.0",
      sourceProfile: "eduknow-local-v1",
    },
    taskId,
    taskName: "knowledge.import",
  };

  try {
    if (initialAttempts > 0) {
      await databaseClient.pool.query(
        `insert into background_job
          (id, task_name, authorization_context_id, idempotency_key,
           status, attempts, started_at, claim_token, lease_expires_at)
         values ($1, 'knowledge.import', $2, $3, 'running', $4, now(), $5, now() - interval '1 second')`,
        [taskId, task.authorization.contextId, task.idempotencyKey, initialAttempts, randomUUID()],
      );
    }

    const jobId = await enqueueTask(queue, task);
    await waitForFailedJob(queue, jobId);
    const jobResult = await databaseClient.pool.query<{
      attempts: number;
      error_code: string;
      status: string;
    }>("select status, attempts, error_code from background_job where id = $1", [taskId]);
    const importResult = await databaseClient.pool.query<{
      attempt_count: string;
      case_count: string;
      lecture_count: string;
      safe_failure_count: string;
      source_count: string;
      status: string;
    }>(
      `select batch.status,
              count(distinct attempt.id)::text as attempt_count,
              count(distinct source.source_document_id)::text as source_count,
              count(distinct lecture.lecture_id)::text as lecture_count,
              count(distinct case_version.case_id)::text as case_count,
              count(distinct attempt.id) filter (
                where attempt.status = 'failed'
                  and attempt.error_code = 'manifest_identity_mismatch'
              )::text as safe_failure_count
         from knowledge_import_batch batch
         left join knowledge_import_attempt attempt on attempt.batch_id = batch.id
         left join knowledge_import_source source on source.batch_id = batch.id
         left join knowledge_lecture_version lecture on lecture.batch_id = batch.id
         left join knowledge_case_version case_version on case_version.batch_id = batch.id
        where batch.corpus_hash = $1
        group by batch.status`,
      [corpusHash],
    );
    const failureSummaries = await databaseClient.pool.query<{ failure_summary: string }>(
      `select failure_summary from knowledge_import_attempt
        where batch_id in (select id from knowledge_import_batch where corpus_hash = $1)
        order by attempt_number`,
      [corpusHash],
    );
    if (initialAttempts === 3) {
      expect(jobResult.rows[0]).toEqual({
        attempts: 3,
        error_code: "worker_lease_expired",
        status: "failed",
      });
      expect(importResult.rows).toHaveLength(0);
      expect(failureSummaries.rows).toHaveLength(0);
      expect(
        auditEvents.filter(
          (event) =>
            event.objectId === taskId && event.details.errorCode === "worker_lease_expired",
        ),
      ).toHaveLength(1);
      return;
    }
    const expectedImportAttempts = 3 - initialAttempts;

    expect(jobResult.rows[0]).toEqual({
      attempts: 3,
      error_code: "manifest_identity_mismatch",
      status: "failed",
    });
    expect(importResult.rows[0]).toEqual({
      attempt_count: String(expectedImportAttempts),
      case_count: "0",
      lecture_count: "0",
      safe_failure_count: String(expectedImportAttempts),
      source_count: "0",
      status: "failed",
    });
    expect(failureSummaries.rows).toHaveLength(expectedImportAttempts);
    for (const row of failureSummaries.rows) {
      expect(row.failure_summary).not.toMatch(/[A-Za-z]:[\\/]|\/(?:source|workspace)\//u);
    }
  } finally {
    await worker.close();
    await queue.obliterate({ force: true });
    await queue.close();
    await Promise.all([queueConnection.quit(), workerConnection.quit()]);
    await databaseClient.pool.query(
      "delete from knowledge_import_attempt where batch_id in (select id from knowledge_import_batch where corpus_hash = $1)",
      [corpusHash],
    );
    await databaseClient.pool.query("delete from background_job where id = $1", [taskId]);
    await databaseClient.pool.query("delete from knowledge_import_batch where corpus_hash = $1", [
      corpusHash,
    ]);
  }
}

describe("knowledge import worker failure audit", () => {
  it("records three safe failed attempts and no business documents", async () => {
    await runFailureScenario(0);
  }, 30_000);

  it("reclaims a running database job after a simulated worker crash", async () => {
    await runFailureScenario(1);
  }, 30_000);

  it("terminalizes an expired final-attempt lease with an audit event", async () => {
    await runFailureScenario(3);
  }, 30_000);
});
