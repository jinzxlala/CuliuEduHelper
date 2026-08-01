import { createDatabaseClient, parseDatabaseConfig } from "@culiu/database";
import {
  createMeilisearchClient,
  DEFAULT_KNOWLEDGE_INDEX_NAMES,
  parseMeilisearchAdminConfig,
} from "@culiu/search";

interface CountRow {
  readonly count: string;
}

async function main(): Promise<void> {
  const databaseClient = createDatabaseClient(parseDatabaseConfig());
  const searchClient = createMeilisearchClient(parseMeilisearchAdminConfig());
  try {
    const [batches, jobs, attempts, lectures, cases, sources] = await Promise.all([
      databaseClient.pool.query(
        `select id, corpus_hash, mapping_version, status, is_current, lecture_count,
                case_count, transcript_segment_count, published_at
           from knowledge_import_batch
          order by created_at desc
          limit 5`,
      ),
      databaseClient.pool.query(
        `select id, task_name, status, attempts, max_attempts, error_code, result_reference
           from background_job
          where task_name = 'knowledge.import'
          order by created_at desc
          limit 5`,
      ),
      databaseClient.pool.query(
        `select batch_id, attempt_number, status, stage, error_code, failure_summary
           from knowledge_import_attempt
          order by started_at desc
          limit 5`,
      ),
      databaseClient.pool.query<CountRow>(
        `select count(*)::text as count
           from knowledge_lecture_version lecture
           join knowledge_import_batch batch on batch.id = lecture.batch_id
          where batch.is_current = true`,
      ),
      databaseClient.pool.query<CountRow>(
        `select count(*)::text as count
           from knowledge_case_version case_version
           join knowledge_import_batch batch on batch.id = case_version.batch_id
          where batch.is_current = true`,
      ),
      databaseClient.pool.query<CountRow>(
        `select count(*)::text as count
           from knowledge_import_source source
           join knowledge_import_batch batch on batch.id = source.batch_id
          where batch.is_current = true`,
      ),
    ]);
    const [lectureIndex, caseIndex, transcriptIndex] = await Promise.all([
      searchClient.index(DEFAULT_KNOWLEDGE_INDEX_NAMES.lectures).getStats(),
      searchClient.index(DEFAULT_KNOWLEDGE_INDEX_NAMES.cases).getStats(),
      searchClient.index(DEFAULT_KNOWLEDGE_INDEX_NAMES.transcriptSegments).getStats(),
    ]);
    process.stdout.write(
      `${JSON.stringify({
        attempts: attempts.rows,
        batches: batches.rows,
        currentCounts: {
          cases: Number(cases.rows[0]?.count ?? 0),
          lectures: Number(lectures.rows[0]?.count ?? 0),
          sources: Number(sources.rows[0]?.count ?? 0),
        },
        jobs: jobs.rows,
        searchCounts: {
          cases: caseIndex.numberOfDocuments,
          lectures: lectureIndex.numberOfDocuments,
          transcriptSegments: transcriptIndex.numberOfDocuments,
        },
      })}\n`,
    );
  } finally {
    await databaseClient.close();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Knowledge import status failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
