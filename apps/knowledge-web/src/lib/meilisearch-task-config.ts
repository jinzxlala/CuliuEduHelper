import { z } from "zod";

const KnowledgePublicationSearchTaskEnvironmentSchema = z.object({
  MEILI_TASK_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(5_000).default(500),
  MEILI_TASK_TIMEOUT_MS: z.coerce.number().int().min(60_000).max(3_600_000).default(600_000),
});

export interface KnowledgePublicationSearchTaskConfig {
  readonly pollingIntervalMs: number;
  readonly timeoutMs: number;
}

export function parseKnowledgePublicationSearchTaskConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): KnowledgePublicationSearchTaskConfig {
  const parsed = KnowledgePublicationSearchTaskEnvironmentSchema.parse(environment);
  return {
    pollingIntervalMs: parsed.MEILI_TASK_POLL_INTERVAL_MS,
    timeoutMs: parsed.MEILI_TASK_TIMEOUT_MS,
  };
}
