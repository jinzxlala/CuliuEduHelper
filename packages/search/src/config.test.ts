import { describe, expect, it } from "vitest";

import { parseMeilisearchAdminConfig, parseMeilisearchSearchConfig } from "./config.js";

describe("Meilisearch server configuration", () => {
  it("uses a scoped search key before the local master key", () => {
    expect(
      parseMeilisearchSearchConfig({
        MEILI_MASTER_KEY: "master-key-long-enough",
        MEILI_SEARCH_API_KEY: "search-key-long-enough",
      }).apiKey,
    ).toBe("search-key-long-enough");
  });

  it("uses a scoped admin key before the local master key", () => {
    expect(
      parseMeilisearchAdminConfig({
        MEILI_ADMIN_API_KEY: "admin-key-long-enough",
        MEILI_MASTER_KEY: "master-key-long-enough",
      }).apiKey,
    ).toBe("admin-key-long-enough");
  });

  it("rejects missing server-side credentials", () => {
    expect(() => parseMeilisearchSearchConfig({})).toThrow();
    expect(() => parseMeilisearchAdminConfig({})).toThrow();
  });
});
