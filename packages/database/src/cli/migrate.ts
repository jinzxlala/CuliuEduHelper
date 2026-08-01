import { createDatabaseClient } from "../client.js";
import { parseDatabaseConfig } from "../config.js";
import { runMigrations } from "../migrate.js";

const client = createDatabaseClient(parseDatabaseConfig());

try {
  await runMigrations(client);
  console.log("Database migrations applied successfully.");
} finally {
  await client.close();
}
