import { createDatabaseClient } from "../client.js";
import { parseDatabaseConfig } from "../config.js";
import { seedRedactedFixtures } from "../fixtures.js";

const client = createDatabaseClient(parseDatabaseConfig());

try {
  await seedRedactedFixtures(client.database);
  console.log("Redacted development fixtures are present.");
} finally {
  await client.close();
}
