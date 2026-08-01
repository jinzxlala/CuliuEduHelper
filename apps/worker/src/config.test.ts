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
    ).toMatchObject({ profileModelProvider: "deepseek", queueName: "synthetic-queue" });
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
  });
});
