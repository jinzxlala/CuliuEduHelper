import {
  checkDatabaseConnection,
  createDatabaseClient,
  parseDatabaseConfig,
} from "@culiu/database";
import { KnowledgeImporter } from "@culiu/knowledge-ingest";
import {
  createMeilisearchClient,
  KnowledgeIndexManager,
  parseMeilisearchAdminConfig,
} from "@culiu/search";
import { LocalImmutableObjectStore } from "@culiu/storage";
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
  const importer = new KnowledgeImporter({
    databaseClient,
    indexPublisher: indexManager,
    manifestPath: runtime.manifestPath,
    objectStore: new LocalImmutableObjectStore(runtime.localStorageRoot),
    sourceRoots: runtime.sourceRoots,
  });

  try {
    await checkDatabaseConnection(databaseClient);
    await checkRedisConnection(redis);
    await indexManager.ensureKnowledgeIndexes();
    await importer.reconcileCurrentPublication();

    const worker = createTaskWorker({
      concurrency: runtime.concurrency,
      connection: redis,
      handlers: {
        "knowledge.import": createKnowledgeImportTaskHandler({ databaseClient, importer }),
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
