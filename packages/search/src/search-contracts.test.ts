import { describe, expect, it } from "vitest";

import {
  CaseSearchInputSchema,
  LectureSearchInputSchema,
  TranscriptSearchInputSchema,
} from "./search-contracts.js";

describe("search input contracts", () => {
  it("applies bounded pagination defaults", () => {
    expect(LectureSearchInputSchema.parse({}).limit).toBe(20);
    expect(() => LectureSearchInputSchema.parse({ limit: 51 })).toThrow();
    expect(() => LectureSearchInputSchema.parse({ offset: 10_001 })).toThrow();
  });

  it("rejects reversed lecture date filters", () => {
    expect(() =>
      LectureSearchInputSchema.parse({
        filters: { dateFrom: "2026-08-01", dateTo: "2026-07-01" },
      }),
    ).toThrow();
  });

  it("rejects unconfigured facets and sorts", () => {
    expect(() => CaseSearchInputSchema.parse({ facets: ["student_name"] })).toThrow();
    expect(() => TranscriptSearchInputSchema.parse({ sort: "lecture_id:asc" })).toThrow();
  });
});
