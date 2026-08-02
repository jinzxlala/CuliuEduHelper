import { describe, expect, it, vi } from "vitest";

import { loadPublishedKnowledgeStatistics } from "./knowledge-statistics";

describe("published knowledge statistics", () => {
  it("returns the current published batch counts", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ case_count: 169, lecture_count: 48 }],
    });

    await expect(loadPublishedKnowledgeStatistics({ query })).resolves.toEqual({
      cases: 169,
      lectures: 48,
    });
    expect(query).toHaveBeenCalledOnce();
  });

  it("uses zero only when no published batch exists and rejects malformed rows", async () => {
    await expect(
      loadPublishedKnowledgeStatistics({ query: vi.fn().mockResolvedValue({ rows: [] }) }),
    ).resolves.toEqual({ cases: 0, lectures: 0 });
    await expect(
      loadPublishedKnowledgeStatistics({
        query: vi.fn().mockResolvedValue({ rows: [{ case_count: -1, lecture_count: 48 }] }),
      }),
    ).rejects.toThrow();
  });
});
