import { describe, expect, it } from "vitest";

import {
  generateWeeklyOccurrences,
  normalizeStableCode,
  normalizeTag,
  timeToMinutes,
  uniqueNonEmptyLines,
} from "./scheduling-form";

describe("scheduling form helpers", () => {
  it("converts browser time values and rejects invalid times", () => {
    expect(timeToMinutes("08:30")).toBe(510);
    expect(timeToMinutes("24:00")).toBeNaN();
  });

  it("normalizes human-entered codes, tags, and roster lines", () => {
    expect(normalizeStableCode("  class 2026 a ")).toBe("CLASS_2026_A");
    expect(normalizeTag("AI Project")).toBe("ai-project");
    expect(uniqueNonEmptyLines("学生 A\n\n学生 B\n学生 A")).toEqual(["学生 A", "学生 B"]);
  });

  it("generates every matching weekday inside the class date range", () => {
    expect(
      generateWeeklyOccurrences({
        endDate: "2026-09-30",
        endTime: "11:00",
        startDate: "2026-09-01",
        startTime: "09:00",
        weekday: 6,
      }),
    ).toEqual([
      { endTime: "11:00", sessionDate: "2026-09-05", startTime: "09:00" },
      { endTime: "11:00", sessionDate: "2026-09-12", startTime: "09:00" },
      { endTime: "11:00", sessionDate: "2026-09-19", startTime: "09:00" },
      { endTime: "11:00", sessionDate: "2026-09-26", startTime: "09:00" },
    ]);
  });
});
