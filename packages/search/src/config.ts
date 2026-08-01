import { Meilisearch } from "meilisearch";
import { z } from "zod";

const HttpUrlSchema = z
  .url()
  .refine((value) => value.startsWith("http://") || value.startsWith("https://"), {
    message: "Meilisearch host must use http:// or https://",
  });

const ApiKeySchema = z.string().min(16);

const SearchEnvironmentSchema = z.object({
  MEILI_HOST: HttpUrlSchema.default("http://127.0.0.1:7700"),
  MEILI_MASTER_KEY: ApiKeySchema.optional(),
  MEILI_SEARCH_API_KEY: ApiKeySchema.optional(),
});

const AdminEnvironmentSchema = z.object({
  MEILI_ADMIN_API_KEY: ApiKeySchema.optional(),
  MEILI_HOST: HttpUrlSchema.default("http://127.0.0.1:7700"),
  MEILI_MASTER_KEY: ApiKeySchema.optional(),
});

export interface MeilisearchClientConfig {
  apiKey: string;
  host: string;
}

export function parseMeilisearchSearchConfig(
  environment: NodeJS.ProcessEnv = process.env,
): MeilisearchClientConfig {
  const parsed = SearchEnvironmentSchema.parse(environment);
  const apiKey = parsed.MEILI_SEARCH_API_KEY ?? parsed.MEILI_MASTER_KEY;
  if (apiKey === undefined) {
    throw new Error("MEILI_SEARCH_API_KEY or MEILI_MASTER_KEY is required on the server.");
  }
  return { apiKey, host: parsed.MEILI_HOST };
}

export function parseMeilisearchAdminConfig(
  environment: NodeJS.ProcessEnv = process.env,
): MeilisearchClientConfig {
  const parsed = AdminEnvironmentSchema.parse(environment);
  const apiKey = parsed.MEILI_ADMIN_API_KEY ?? parsed.MEILI_MASTER_KEY;
  if (apiKey === undefined) {
    throw new Error("MEILI_ADMIN_API_KEY or MEILI_MASTER_KEY is required for index management.");
  }
  return { apiKey, host: parsed.MEILI_HOST };
}

export function createMeilisearchClient(config: MeilisearchClientConfig): Meilisearch {
  return new Meilisearch({ apiKey: config.apiKey, host: config.host });
}
