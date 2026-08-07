import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

import { parseWorkerRuntimeConfig } from "./config.js";

const baseEnvironment = {
  KNOWLEDGE_ANALYSIS_ROOT: resolve("synthetic/analysis"),
  KNOWLEDGE_MANIFEST_PATH: resolve("synthetic/manifest.json"),
  KNOWLEDGE_TRANSCRIPT_2025_ROOT: resolve("synthetic/2025"),
  KNOWLEDGE_TRANSCRIPT_2026_ROOT: resolve("synthetic/2026"),
  LOCAL_STORAGE_ROOT: resolve("synthetic/storage"),
};

describe("worker profile model configuration", () => {
  it("defaults to DeepSeek and accepts an isolated queue name", () => {
    expect(
      parseWorkerRuntimeConfig({ ...baseEnvironment, CULIU_TASK_QUEUE_NAME: "synthetic-queue" }),
    ).toMatchObject({
      knowledgeEmbeddersEnabled: true,
      knowledgeExtractionModelProvider: "deepseek",
      knowledgeStartupReconcileEnabled: true,
      meilisearchTaskPollingIntervalMs: 500,
      meilisearchTaskTimeoutMs: 600_000,
      profileModelProvider: "deepseek",
      queueName: "synthetic-queue",
    });
  });

  it("allows isolated test workers to skip shared knowledge index reconciliation", () => {
    expect(
      parseWorkerRuntimeConfig({
        ...baseEnvironment,
        KNOWLEDGE_STARTUP_RECONCILE_ENABLED: "false",
        NODE_ENV: "test",
      }).knowledgeStartupReconcileEnabled,
    ).toBe(false);
    expect(() =>
      parseWorkerRuntimeConfig({
        ...baseEnvironment,
        KNOWLEDGE_STARTUP_RECONCILE_ENABLED: "no",
        NODE_ENV: "test",
      }),
    ).toThrow();
    expect(() =>
      parseWorkerRuntimeConfig({
        ...baseEnvironment,
        KNOWLEDGE_STARTUP_RECONCILE_ENABLED: "false",
        NODE_ENV: "production",
      }),
    ).toThrow(/only be disabled in test mode/u);
  });

  it("supports a keyword-only production deployment and bounded Meilisearch waits", () => {
    expect(
      parseWorkerRuntimeConfig({
        ...baseEnvironment,
        KNOWLEDGE_EMBEDDERS_ENABLED: "false",
        MEILI_TASK_POLL_INTERVAL_MS: "1000",
        MEILI_TASK_TIMEOUT_MS: "900000",
        NODE_ENV: "production",
      }),
    ).toMatchObject({
      knowledgeEmbeddersEnabled: false,
      meilisearchTaskPollingIntervalMs: 1_000,
      meilisearchTaskTimeoutMs: 900_000,
    });

    expect(() =>
      parseWorkerRuntimeConfig({
        ...baseEnvironment,
        KNOWLEDGE_EMBEDDERS_ENABLED: "yes",
      }),
    ).toThrow();
    expect(() =>
      parseWorkerRuntimeConfig({
        ...baseEnvironment,
        MEILI_TASK_POLL_INTERVAL_MS: "50",
      }),
    ).toThrow();
  });

  it("allows the deterministic provider only outside production", () => {
    expect(
      parseWorkerRuntimeConfig({
        ...baseEnvironment,
        NODE_ENV: "test",
        PROFILE_MODEL_PROVIDER: "mock",
      }).profileModelProvider,
    ).toBe("mock");
    expect(() =>
      parseWorkerRuntimeConfig({
        ...baseEnvironment,
        NODE_ENV: "production",
        PROFILE_MODEL_PROVIDER: "mock",
      }),
    ).toThrow(/forbidden/u);
    expect(
      parseWorkerRuntimeConfig({
        ...baseEnvironment,
        KNOWLEDGE_EXTRACTION_MODEL_PROVIDER: "mock",
        NODE_ENV: "test",
      }).knowledgeExtractionModelProvider,
    ).toBe("mock");
    expect(() =>
      parseWorkerRuntimeConfig({
        ...baseEnvironment,
        KNOWLEDGE_EXTRACTION_MODEL_PROVIDER: "mock",
        NODE_ENV: "production",
      }),
    ).toThrow(/forbidden/u);
  });
});
