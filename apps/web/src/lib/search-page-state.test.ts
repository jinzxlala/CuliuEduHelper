import { SEARCH_HIGHLIGHT_END, SEARCH_HIGHLIGHT_START } from "@culiu/search";
import { describe, expect, it } from "vitest";

import {
  buildSearchHref,
  formatTimestamp,
  parseSearchPageState,
  splitHighlightedText,
} from "./search-page-state";

describe("search page state", () => {
  it("normalizes untrusted URL values and bounds pagination", () => {
    expect(
      parseSearchPageState({
        confidence: ["high", "invalid", "high"],
        from: "2026-13-40",
        page: "99999",
        q: `  ${"问".repeat(600)}  `,
        school: ["MIT", " MIT ", ""],
        sort: "title:asc",
        type: "cases",
      }),
    ).toMatchObject({
      confidence: ["high"],
      page: 1_001,
      query: "问".repeat(500),
      schools: ["MIT"],
      target: "cases",
    });
  });

  it("normalizes an inverted valid lecture date range", () => {
    const state = parseSearchPageState({ from: "2026-06-30", to: "2025-01-01" });
    expect(state.dateFrom).toBe("2025-01-01");
    expect(state.dateTo).toBe("2026-06-30");
  });

  it("preserves query but clears incompatible facets when switching target", () => {
    const state = parseSearchPageState({
      page: "3",
      q: "跨学科",
      school: "MIT",
      sort: "date:desc",
    });
    expect(buildSearchHref(state, { target: "cases" })).toBe(
      "/search?type=cases&q=%E8%B7%A8%E5%AD%A6%E7%A7%91",
    );
  });
});

describe("safe highlighted text", () => {
  it("returns React-safe text parts without interpreting HTML", () => {
    const value = `<img src=x onerror=alert(1)>${SEARCH_HIGHLIGHT_START}人工智能${SEARCH_HIGHLIGHT_END}`;
    expect(splitHighlightedText(value)).toEqual([
      { highlighted: false, text: "<img src=x onerror=alert(1)>" },
      { highlighted: true, text: "人工智能" },
    ]);
  });

  it("truncates content without leaking private highlight markers", () => {
    const value = `${SEARCH_HIGHLIGHT_START}人工智能${SEARCH_HIGHLIGHT_END}教育规划`;
    expect(splitHighlightedText(value, 5)).toEqual([
      { highlighted: true, text: "人工智能" },
      { highlighted: false, text: "教" },
      { highlighted: false, text: "…" },
    ]);
  });
});

describe("timestamp formatting", () => {
  it("formats minute and hour positions", () => {
    expect(formatTimestamp(65.9)).toBe("01:05");
    expect(formatTimestamp(3_661)).toBe("01:01:01");
  });
});
