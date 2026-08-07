import { describe, expect, it } from "vitest";

import { parseKnowledgePublicationSearchTaskConfig } from "./meilisearch-task-config";

describe("knowledge publication Meilisearch task configuration", () => {
  it("defaults to a ten-minute publication timeout", () => {
    expect(parseKnowledgePublicationSearchTaskConfig({})).toEqual({
      pollingIntervalMs: 500,
      timeoutMs: 600_000,
    });
  });

  it("accepts an explicit production timeout and polling interval", () => {
    expect(
      parseKnowledgePublicationSearchTaskConfig({
        MEILI_TASK_POLL_INTERVAL_MS: "750",
        MEILI_TASK_TIMEOUT_MS: "900000",
      }),
    ).toEqual({ pollingIntervalMs: 750, timeoutMs: 900_000 });
  });

  it("rejects a publication timeout shorter than sixty seconds", () => {
    expect(() =>
      parseKnowledgePublicationSearchTaskConfig({ MEILI_TASK_TIMEOUT_MS: "59999" }),
    ).toThrow();
  });
});
