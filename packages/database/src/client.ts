import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import type { DatabaseConfig } from "./config.js";
import * as schema from "./schema.js";

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseClient {
  close: () => Promise<void>;
  database: Database;
  pool: Pool;
}

export function createDatabaseClient(config: DatabaseConfig): DatabaseClient {
  const pool = new Pool({
    connectionString: config.connectionString,
    max: config.maxConnections,
  });

  return {
    close: async () => pool.end(),
    database: drizzle(pool, { schema }),
    pool,
  };
}

export async function checkDatabaseConnection(client: DatabaseClient): Promise<void> {
  await client.pool.query("select 1 as available");
}
