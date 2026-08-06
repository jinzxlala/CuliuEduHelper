import { describe, expect, it } from "vitest";

import { knowledgeTranscriptProcessingStage } from "./transcript-workflow.js";

describe("knowledgeTranscriptProcessingStage", () => {
  it("distinguishes model extraction from reviewed draft publication", () => {
    expect(knowledgeTranscriptProcessingStage("processing", false)).toBe("extracting");
    expect(knowledgeTranscriptProcessingStage("processing", true)).toBe("publishing");
  });

  it("does not report a processing stage for stable states", () => {
    expect(knowledgeTranscriptProcessingStage("queued", false)).toBeNull();
    expect(knowledgeTranscriptProcessingStage("draft_ready", true)).toBeNull();
    expect(knowledgeTranscriptProcessingStage("published", true)).toBeNull();
    expect(knowledgeTranscriptProcessingStage("failed", false)).toBeNull();
  });
});
