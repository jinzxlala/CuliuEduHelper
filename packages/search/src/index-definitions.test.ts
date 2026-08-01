import { describe, expect, it } from "vitest";

import { KnowledgeIndexNamesSchema } from "./index-definitions.js";

describe("KnowledgeIndexNamesSchema", () => {
  it("accepts three distinct safe index names", () => {
    expect(
      KnowledgeIndexNamesSchema.parse({
        cases: "test_cases",
        lectures: "test_lectures",
        transcriptSegments: "test_transcript_segments",
      }),
    ).toEqual({
      cases: "test_cases",
      lectures: "test_lectures",
      transcriptSegments: "test_transcript_segments",
    });
  });

  it("rejects colliding or oversized index names", () => {
    expect(() =>
      KnowledgeIndexNamesSchema.parse({
        cases: "shared_index",
        lectures: "shared_index",
        transcriptSegments: "transcript_segments",
      }),
    ).toThrow();
    expect(() =>
      KnowledgeIndexNamesSchema.parse({
        cases: "c".repeat(451),
        lectures: "lectures",
        transcriptSegments: "transcript_segments",
      }),
    ).toThrow();
  });
});
