import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { EXPECTED_LECTURE_COUNT, SOURCE_ROLES } from "./contracts.js";
import { verifyKnowledgeSourceManifest } from "./manifest.js";

const COMMITTED_MANIFEST_URL = new URL(
  "../../../knowledge/source-manifest.v1.json",
  import.meta.url,
);

describe("committed knowledge source manifest", () => {
  it("is valid, complete and free of host paths or source body text", async () => {
    const serialized = await readFile(COMMITTED_MANIFEST_URL, "utf8");
    const manifest = verifyKnowledgeSourceManifest(JSON.parse(serialized) as unknown);

    expect(manifest.lecture_count).toBe(EXPECTED_LECTURE_COUNT);
    expect(manifest.lectures).toHaveLength(EXPECTED_LECTURE_COUNT);
    expect(manifest.lectures.flatMap((lecture) => lecture.sources)).toHaveLength(
      EXPECTED_LECTURE_COUNT * SOURCE_ROLES.length,
    );
    expect(manifest.boundary_rules).toEqual({
      manifest_contains_body_content: false,
      manifest_purpose: "verified_inventory_import_entrypoint",
      raw_embedded_paths_are_excluded: true,
      source_files_read_only: true,
      student_data_allowed: false,
    });
    expect(serialized).not.toMatch(/[A-Za-z]:[\\/]/u);
    expect(serialized).not.toContain("source_json");
    expect(serialized).not.toContain("generated_at");
    expect(serialized).not.toContain("original_text");
  });
});
