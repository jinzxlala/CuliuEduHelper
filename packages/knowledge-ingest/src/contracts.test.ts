import { describe, expect, it } from "vitest";

import { SourceFileSchema } from "./contracts.js";
import { INDEX_MAPPINGS, SOURCE_POLICIES } from "./mappings.js";

describe("knowledge ingest contracts", () => {
  it("keeps raw transcript indexing behind an explicit privacy gate", () => {
    expect(SOURCE_POLICIES).toContainEqual({
      allowed_index_targets: ["transcript_segments"],
      database_document_type: "transcript_json",
      index_policy: "privacy_review_required",
      privacy_classification: "restricted_source_evidence",
      role: "transcript_json",
    });
    expect(INDEX_MAPPINGS).toContainEqual(
      expect.objectContaining({
        required_gate: "privacy_review_and_anonymization",
        target_index: "transcript_segments",
      }),
    );
  });

  it("does not allow QA, SRT or text replicas to become index inputs", () => {
    for (const role of ["transcript_qa", "transcript_srt", "transcript_text"] as const) {
      const policy = SOURCE_POLICIES.find((candidate) => candidate.role === role);
      expect(policy).toMatchObject({ allowed_index_targets: [], index_policy: "validation_only" });
    }
  });

  it("rejects absolute, Windows-style and traversing manifest paths", () => {
    const source = {
      bytes: 1,
      content_sha256: "0".repeat(64),
      logical_path: "knowledge/analysis/source.md",
      mime_type: "text/markdown",
      relative_path: "source.md",
      role: "analysis_markdown",
      root_id: "analysis",
    };
    expect(SourceFileSchema.safeParse(source).success).toBe(true);
    expect(SourceFileSchema.safeParse({ ...source, logical_path: "C:\\source.md" }).success).toBe(
      false,
    );
    expect(SourceFileSchema.safeParse({ ...source, relative_path: "../source.md" }).success).toBe(
      false,
    );
    expect(
      SourceFileSchema.safeParse({ ...source, logical_path: "knowledge\\analysis\\source.md" })
        .success,
    ).toBe(false);
  });
});
