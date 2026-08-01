import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  GoldSetCorpusMismatchError,
  assertGoldSetMatchesSourceManifest,
  loadAndVerifySearchGoldSet,
  parseSearchGoldSet,
} from "./gold-set.js";

const COMMITTED_GOLD_SET_URL = new URL("../../../knowledge/search-gold.v1.json", import.meta.url);
const COMMITTED_MANIFEST_URL = new URL(
  "../../../knowledge/source-manifest.v1.json",
  import.meta.url,
);

async function committedGoldSetValue(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(COMMITTED_GOLD_SET_URL, "utf8")) as Record<string, unknown>;
}

describe("search gold set", () => {
  it("validates the committed 50-query draft against the exact source corpus", async () => {
    const goldSet = await loadAndVerifySearchGoldSet(
      COMMITTED_GOLD_SET_URL,
      COMMITTED_MANIFEST_URL,
    );

    expect(goldSet.queries).toHaveLength(50);
    expect(goldSet.approval).toEqual({
      reviewed_at: null,
      reviewed_by: null,
      status: "draft",
    });
    expect(goldSet.queries.filter((query) => query.critical)).toHaveLength(17);
    expect(new Set(goldSet.queries.map((query) => query.id))).toHaveLength(50);
  });

  it("rejects a fixture with fewer than 50 queries", async () => {
    const candidate = await committedGoldSetValue();
    const queries = candidate.queries;
    if (!Array.isArray(queries)) throw new Error("Invalid committed fixture test setup.");
    candidate.queries = queries.slice(0, 49);

    expect(() => parseSearchGoldSet(candidate)).toThrow();
  });

  it("cannot weaken the critical, filter, latency or Top-5 thresholds", async () => {
    const candidate = await committedGoldSetValue();
    candidate.thresholds = {
      critical_hit_rate_min: 0.99,
      filter_accuracy_min: 0.99,
      p95_latency_ms_max: 501,
      top_5_hit_rate_min: 0.84,
    };

    expect(() => parseSearchGoldSet(candidate)).toThrow();
  });

  it("requires named, timestamped human review before approval", async () => {
    const candidate = await committedGoldSetValue();
    candidate.approval = {
      reviewed_at: null,
      reviewed_by: null,
      status: "approved",
    };

    expect(() => parseSearchGoldSet(candidate)).toThrow();
  });

  it("rejects expected IDs that do not belong to the target index", async () => {
    const candidate = await committedGoldSetValue();
    const queries = candidate.queries;
    if (!Array.isArray(queries) || typeof queries[0] !== "object" || queries[0] === null) {
      throw new Error("Invalid committed fixture test setup.");
    }
    (queries[0] as Record<string, unknown>).expected_hit_ids = ["case_wrong_target_001"];

    expect(() => parseSearchGoldSet(candidate)).toThrow();
  });

  it("rejects duplicate search inputs disguised by different query IDs", async () => {
    const candidate = await committedGoldSetValue();
    const queries = candidate.queries;
    if (
      !Array.isArray(queries) ||
      typeof queries[0] !== "object" ||
      queries[0] === null ||
      typeof queries[1] !== "object" ||
      queries[1] === null
    ) {
      throw new Error("Invalid committed fixture test setup.");
    }
    const replacement = structuredClone(queries[0]) as Record<string, unknown>;
    replacement.id = (queries[1] as Record<string, unknown>).id;
    queries[1] = replacement;

    expect(() => parseSearchGoldSet(candidate)).toThrow();
  });

  it("requires hard-filter tags to correspond to active filters", async () => {
    const candidate = await committedGoldSetValue();
    const queries = candidate.queries;
    const queryValues: unknown[] = Array.isArray(queries) ? (queries as unknown[]) : [];
    const filteredQuery = queryValues.find(
      (query) =>
        typeof query === "object" &&
        query !== null &&
        Array.isArray((query as Record<string, unknown>).tags) &&
        ((query as Record<string, unknown>).tags as unknown[]).includes("hard_filter"),
    );
    if (typeof filteredQuery !== "object" || filteredQuery === null) {
      throw new Error("Invalid committed fixture test setup.");
    }
    const input = (filteredQuery as Record<string, unknown>).input;
    if (typeof input !== "object" || input === null) {
      throw new Error("Invalid committed fixture test setup.");
    }
    (input as Record<string, unknown>).filters = {};

    expect(() => parseSearchGoldSet(candidate)).toThrow();
  });

  it("rejects a gold set bound to a different corpus identity", async () => {
    const goldSet = parseSearchGoldSet(await committedGoldSetValue());

    expect(() => {
      assertGoldSetMatchesSourceManifest(goldSet, {
        ...goldSet.corpus,
        corpus_hash: "0".repeat(64),
      });
    }).toThrow(GoldSetCorpusMismatchError);
  });
});
