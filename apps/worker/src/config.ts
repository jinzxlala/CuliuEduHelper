import { isAbsolute } from "node:path";

import { z } from "zod";

const AbsolutePathSchema = z.string().min(1).refine(isAbsolute, {
  message: "worker knowledge paths must be absolute server-side paths",
});

const BooleanEnvironmentSchema = z.enum(["true", "false"]).transform((value) => value === "true");

const WorkerEnvironmentSchema = z.object({
  CULIU_TASK_QUEUE_NAME: z.string().trim().min(1).max(128).optional(),
  KNOWLEDGE_ANALYSIS_ROOT: AbsolutePathSchema,
  KNOWLEDGE_MANIFEST_PATH: AbsolutePathSchema,
  KNOWLEDGE_TRANSCRIPT_2025_ROOT: AbsolutePathSchema,
  KNOWLEDGE_TRANSCRIPT_2026_ROOT: AbsolutePathSchema,
  LOCAL_STORAGE_ROOT: AbsolutePathSchema,
  KNOWLEDGE_EXTRACTION_MODEL_PROVIDER: z.enum(["deepseek", "mock"]).default("deepseek"),
  KNOWLEDGE_EMBEDDERS_ENABLED: BooleanEnvironmentSchema.default(true),
  MEILI_TASK_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(5_000).default(500),
  MEILI_TASK_TIMEOUT_MS: z.coerce.number().int().min(60_000).max(3_600_000).default(600_000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PROFILE_MODEL_PROVIDER: z.enum(["deepseek", "mock"]).default("deepseek"),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
});

export interface WorkerRuntimeConfig {
  readonly concurrency: number;
  readonly knowledgeEmbeddersEnabled: boolean;
  readonly localStorageRoot: string;
  readonly knowledgeExtractionModelProvider: "deepseek" | "mock";
  readonly manifestPath: string;
  readonly meilisearchTaskPollingIntervalMs: number;
  readonly meilisearchTaskTimeoutMs: number;
  readonly profileModelProvider: "deepseek" | "mock";
  readonly queueName: string | undefined;
  readonly sourceRoots: Readonly<Record<string, string>>;
}

export function parseWorkerRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): WorkerRuntimeConfig {
  const parsed = WorkerEnvironmentSchema.parse(environment);
  if (
    parsed.NODE_ENV === "production" &&
    (parsed.PROFILE_MODEL_PROVIDER === "mock" ||
      parsed.KNOWLEDGE_EXTRACTION_MODEL_PROVIDER === "mock")
  ) {
    throw new Error("Mock model providers are forbidden in production.");
  }
  return {
    concurrency: parsed.WORKER_CONCURRENCY,
    knowledgeEmbeddersEnabled: parsed.KNOWLEDGE_EMBEDDERS_ENABLED,
    knowledgeExtractionModelProvider: parsed.KNOWLEDGE_EXTRACTION_MODEL_PROVIDER,
    localStorageRoot: parsed.LOCAL_STORAGE_ROOT,
    manifestPath: parsed.KNOWLEDGE_MANIFEST_PATH,
    meilisearchTaskPollingIntervalMs: parsed.MEILI_TASK_POLL_INTERVAL_MS,
    meilisearchTaskTimeoutMs: parsed.MEILI_TASK_TIMEOUT_MS,
    profileModelProvider: parsed.PROFILE_MODEL_PROVIDER,
    queueName: parsed.CULIU_TASK_QUEUE_NAME,
    sourceRoots: {
      analysis: parsed.KNOWLEDGE_ANALYSIS_ROOT,
      transcripts_2025: parsed.KNOWLEDGE_TRANSCRIPT_2025_ROOT,
      transcripts_2026: parsed.KNOWLEDGE_TRANSCRIPT_2026_ROOT,
    },
  };
}
