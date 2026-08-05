import "server-only";

import {
  createDatabaseClient,
  parseDatabaseConfig,
  type DatabaseClient,
} from "@culiu/database/runtime";

const globalDatabase = globalThis as typeof globalThis & {
  culiuKnowledgeDatabaseClient?: DatabaseClient;
};

export function getDatabaseClient(): DatabaseClient {
  globalDatabase.culiuKnowledgeDatabaseClient ??= createDatabaseClient(
    parseDatabaseConfig({
      ...process.env,
      DATABASE_URL: process.env.KNOWLEDGE_DATABASE_URL ?? process.env.DATABASE_URL,
      DATABASE_POOL_MAX: process.env.KNOWLEDGE_DATABASE_POOL_MAX ?? process.env.DATABASE_POOL_MAX,
    }),
  );
  return globalDatabase.culiuKnowledgeDatabaseClient;
}
