import { createDatabaseClient, parseDatabaseConfig } from "@culiu/database";
import { z } from "zod";

import { createInitialAdmin } from "../initial-admin.js";

const ArgumentsSchema = z
  .object({
    displayName: z.string().trim().min(1),
    email: z.email(),
  })
  .strict();

function readArguments(argv: readonly string[]): z.infer<typeof ArgumentsSchema> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--")) {
      throw new Error(
        "Usage: --email <address> --display-name <name>; provide the password through CULIU_BOOTSTRAP_ADMIN_PASSWORD.",
      );
    }
    values.set(key, value);
  }
  return ArgumentsSchema.parse({
    displayName: values.get("--display-name"),
    email: values.get("--email"),
  });
}

async function main(): Promise<void> {
  const arguments_ = readArguments(process.argv.slice(2));
  const password = process.env.CULIU_BOOTSTRAP_ADMIN_PASSWORD;
  if (password === undefined || password.length === 0) {
    throw new Error("CULIU_BOOTSTRAP_ADMIN_PASSWORD must be set for this one-time command.");
  }

  const client = createDatabaseClient(parseDatabaseConfig());
  try {
    await createInitialAdmin(client.database, { ...arguments_, password });
    console.log("Initial administrator created. The bootstrap command is now locked.");
  } finally {
    await client.close();
  }
}

await main();
