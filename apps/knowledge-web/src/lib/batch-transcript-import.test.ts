import { describe, expect, it } from "vitest";

import {
  MAX_TRANSCRIPT_BATCH_FILES,
  runTranscriptImportBatch,
  TRANSCRIPT_BATCH_CONCURRENCY,
} from "./batch-transcript-import";

describe("runTranscriptImportBatch", () => {
  it("limits concurrent submissions and preserves input order", async () => {
    let active = 0;
    let maximumActive = 0;
    const results = await runTranscriptImportBatch([1, 2, 3, 4, 5, 6, 7], async (item) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return item * 10;
    });

    expect(maximumActive).toBe(TRANSCRIPT_BATCH_CONCURRENCY);
    expect(results.map((result) => result.status)).toEqual(Array(7).fill("fulfilled"));
    expect(results.map((result) => (result.status === "fulfilled" ? result.value : null))).toEqual([
      10, 20, 30, 40, 50, 60, 70,
    ]);
  });

  it("isolates one failed file and continues the remaining submissions", async () => {
    const settled: string[] = [];
    const results = await runTranscriptImportBatch(
      ["one.md", "broken.docx", "three.md"],
      (item) =>
        item === "broken.docx" ? Promise.reject(new Error("invalid file")) : Promise.resolve(item),
      {
        onSettled: (result) => {
          settled.push(`${String(result.index)}:${result.status}`);
        },
      },
    );

    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect(settled).toHaveLength(3);
  });

  it("rejects an empty batch or a batch above the safety limit before submitting", async () => {
    let submitted = 0;
    const submit = (item: number): Promise<number> => {
      submitted += 1;
      return Promise.resolve(item);
    };

    await expect(runTranscriptImportBatch([], submit)).rejects.toThrow("At least one");
    await expect(
      runTranscriptImportBatch(
        Array.from({ length: MAX_TRANSCRIPT_BATCH_FILES + 1 }, (_, i) => i),
        submit,
      ),
    ).rejects.toThrow("At most");
    expect(submitted).toBe(0);
  });
});
