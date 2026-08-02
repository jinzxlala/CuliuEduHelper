import {
  checkDatabaseConnection,
  createDatabaseClient,
  parseDatabaseConfig,
} from "@culiu/database";
import { DeepSeekJsonModelProvider, parseDeepSeekGatewayConfig } from "@culiu/ai";
import {
  checkHighsRuntime,
  executeCourseRecommendationTask,
  executeTimetableSolveTask,
} from "@culiu/course-planning";
import {
  createDeterministicMockKnowledgeExtractionProvider,
  executeKnowledgeTranscriptExtraction,
  KnowledgeImporter,
} from "@culiu/knowledge-ingest";
import {
  createMeilisearchClient,
  KnowledgeIndexManager,
  parseMeilisearchAdminConfig,
} from "@culiu/search";
import { LocalImmutableObjectStore } from "@culiu/storage";
import {
  createDeterministicMockProfileProvider,
  executeProfileDraftTask,
} from "@culiu/student-profiles";
import {
  executeBasicStudentImportTask,
  executeIncrementalStudentImportTask,
} from "@culiu/student-ingest";
import {
  checkRedisConnection,
  createRedisConnection,
  createTaskWorker,
  parseRedisUrl,
} from "@culiu/tasks";

import { buildWorkerHealth } from "./health.js";
import { createKnowledgeImportTaskHandler } from "./knowledge-import-handler.js";
import { parseWorkerRuntimeConfig } from "./config.js";

export async function runWorker(): Promise<void> {
  const runtime = parseWorkerRuntimeConfig();
  const databaseClient = createDatabaseClient(parseDatabaseConfig());
  const redis = createRedisConnection(parseRedisUrl());
  const indexManager = new KnowledgeIndexManager({
    client: createMeilisearchClient(parseMeilisearchAdminConfig()),
  });
  const objectStore = new LocalImmutableObjectStore(runtime.localStorageRoot);
  const importer = new KnowledgeImporter({
    databaseClient,
    indexPublisher: indexManager,
    manifestPath: runtime.manifestPath,
    objectStore,
    sourceRoots: runtime.sourceRoots,
  });
  const profileProvider =
    runtime.profileModelProvider === "mock"
      ? createDeterministicMockProfileProvider()
      : new DeepSeekJsonModelProvider(parseDeepSeekGatewayConfig());
  const knowledgeExtractionProvider =
    runtime.knowledgeExtractionModelProvider === "mock"
      ? createDeterministicMockKnowledgeExtractionProvider()
      : new DeepSeekJsonModelProvider(parseDeepSeekGatewayConfig());

  try {
    await checkDatabaseConnection(databaseClient);
    await checkRedisConnection(redis);
    await indexManager.ensureKnowledgeIndexes();
    await checkHighsRuntime();
    await importer.reconcileCurrentPublication();

    const worker = createTaskWorker({
      concurrency: runtime.concurrency,
      connection: redis,
      ...(runtime.queueName === undefined ? {} : { queueName: runtime.queueName }),
      handlers: {
        "knowledge.extract": async (task) => {
          if (task.taskName !== "knowledge.extract") throw new Error("Unexpected task type.");
          return executeKnowledgeTranscriptExtraction(
            databaseClient,
            task,
            knowledgeExtractionProvider,
          );
        },
        "knowledge.import": createKnowledgeImportTaskHandler({ databaseClient, importer }),
        "profile.draft": async (task) => {
          if (task.taskName !== "profile.draft") throw new Error("Unexpected task type.");
          return executeProfileDraftTask(databaseClient.database, task, profileProvider);
        },
        "student.basic.extract": async (task) => {
          if (task.taskName !== "student.basic.extract") throw new Error("Unexpected task type.");
          return executeBasicStudentImportTask(
            databaseClient.database,
            objectStore,
            new DeepSeekJsonModelProvider(parseDeepSeekGatewayConfig()),
            task,
          );
        },
        "student.evidence.extract": async (task) => {
          if (task.taskName !== "student.evidence.extract") {
            throw new Error("Unexpected task type.");
          }
          return executeIncrementalStudentImportTask(
            databaseClient.database,
            objectStore,
            new DeepSeekJsonModelProvider(parseDeepSeekGatewayConfig()),
            task,
          );
        },
        "course.recommendation.generate": async (task) => {
          if (task.taskName !== "course.recommendation.generate") {
            throw new Error("Unexpected task type.");
          }
          return executeCourseRecommendationTask(
            databaseClient.database,
            task,
            new DeepSeekJsonModelProvider(parseDeepSeekGatewayConfig()),
          );
        },
        "timetable.solve": async (task) => {
          if (task.taskName !== "timetable.solve") throw new Error("Unexpected task type.");
          return executeTimetableSolveTask(databaseClient.database, task);
        },
        "system.probe": () => Promise.resolve(buildWorkerHealth()),
      },
    });
    worker.on("error", (error) => {
      process.stderr.write(`Worker runtime error: ${error.name}\n`);
    });

    let shutdownStarted = false;
    const shutdown = async (): Promise<void> => {
      if (shutdownStarted) return;
      shutdownStarted = true;
      try {
        await worker.close();
      } finally {
        await Promise.allSettled([redis.quit(), databaseClient.close()]);
      }
    };
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
    process.stdout.write(`${JSON.stringify(buildWorkerHealth())}\n`);
  } catch (error) {
    redis.disconnect();
    await databaseClient.close().catch(() => undefined);
    throw error;
  }
}
