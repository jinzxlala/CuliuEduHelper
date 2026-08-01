import { isAbsolute } from "node:path";

import { z } from "zod";

const AbsolutePathSchema = z.string().min(1).refine(isAbsolute, {
  message: "worker knowledge paths must be absolute server-side paths",
});

const WorkerEnvironmentSchema = z.object({
  KNOWLEDGE_ANALYSIS_ROOT: AbsolutePathSchema,
  KNOWLEDGE_MANIFEST_PATH: AbsolutePathSchema,
  KNOWLEDGE_TRANSCRIPT_2025_ROOT: AbsolutePathSchema,
  KNOWLEDGE_TRANSCRIPT_2026_ROOT: AbsolutePathSchema,
  LOCAL_STORAGE_ROOT: AbsolutePathSchema,
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
});

export interface WorkerRuntimeConfig {
  readonly concurrency: number;
  readonly localStorageRoot: string;
  readonly manifestPath: string;
  readonly sourceRoots: Readonly<Record<string, string>>;
}

export function parseWorkerRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): WorkerRuntimeConfig {
  const parsed = WorkerEnvironmentSchema.parse(environment);
  return {
    concurrency: parsed.WORKER_CONCURRENCY,
    localStorageRoot: parsed.LOCAL_STORAGE_ROOT,
    manifestPath: parsed.KNOWLEDGE_MANIFEST_PATH,
    sourceRoots: {
      analysis: parsed.KNOWLEDGE_ANALYSIS_ROOT,
      transcripts_2025: parsed.KNOWLEDGE_TRANSCRIPT_2025_ROOT,
      transcripts_2026: parsed.KNOWLEDGE_TRANSCRIPT_2026_ROOT,
    },
  };
}
