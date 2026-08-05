import "server-only";

import {
  createDatabaseClient,
  parseDatabaseConfig,
  type DatabaseClient,
} from "@culiu/database/runtime";

const globalDatabase = globalThis as typeof globalThis & {
  culiuOperationsDatabaseClient?: DatabaseClient;
};

export function getDatabaseClient(): DatabaseClient {
  globalDatabase.culiuOperationsDatabaseClient ??= createDatabaseClient(
    parseDatabaseConfig({
      ...process.env,
      DATABASE_URL: process.env.OPERATIONS_DATABASE_URL ?? process.env.DATABASE_URL,
      DATABASE_POOL_MAX: process.env.OPERATIONS_DATABASE_POOL_MAX ?? process.env.DATABASE_POOL_MAX,
    }),
  );
  return globalDatabase.culiuOperationsDatabaseClient;
}
