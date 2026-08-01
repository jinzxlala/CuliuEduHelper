import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import type { DatabaseClient } from "./client.js";

const defaultMigrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

export async function runMigrations(
  client: DatabaseClient,
  migrationsFolder: string = defaultMigrationsFolder,
): Promise<void> {
  await migrate(client.database, { migrationsFolder });
}
