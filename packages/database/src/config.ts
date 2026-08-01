import { z } from "zod";

const DatabaseConfigSchema = z.object({
  DATABASE_URL: z.url().refine((value) => value.startsWith("postgresql://"), {
    message: "DATABASE_URL must use the postgresql protocol",
  }),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
});

export interface DatabaseConfig {
  connectionString: string;
  maxConnections: number;
}

export function parseDatabaseConfig(environment: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const parsed = DatabaseConfigSchema.parse(environment);
  return {
    connectionString: parsed.DATABASE_URL,
    maxConnections: parsed.DATABASE_POOL_MAX,
  };
}
