import "server-only";

import {
  createDatabaseClient,
  parseDatabaseConfig,
  type DatabaseClient,
} from "@culiu/database/runtime";

const globalDatabase = globalThis as typeof globalThis & {
  culiuDatabaseClient?: DatabaseClient;
};

export function getDatabaseClient(): DatabaseClient {
  globalDatabase.culiuDatabaseClient ??= createDatabaseClient(parseDatabaseConfig());
  return globalDatabase.culiuDatabaseClient;
}
