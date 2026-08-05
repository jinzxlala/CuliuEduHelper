import { describe, expect, it } from "vitest";

import {
  hoursToMinutes,
  linesFromInput,
  minuteToTime,
  minutesToHours,
  tagsFromInput,
} from "./course-catalog-form";

describe("course catalog form helpers", () => {
  it("normalizes human-entered lists without duplicates", () => {
    expect(linesFromInput("目标一\n\n目标二\n目标一")).toEqual(["目标一", "目标二"]);
  });

  it("normalizes comma and whitespace separated stable tags", () => {
    expect(tagsFromInput("Programming, ai-tools  programming，data_science")).toEqual([
      "programming",
      "ai-tools",
      "data_science",
    ]);
  });

  it("converts business-facing hours and time values", () => {
    expect(hoursToMinutes("2.5")).toBe(150);
    expect(minutesToHours(150)).toBe("2.5");
    expect(minuteToTime(545)).toBe("09:05");
  });
});
