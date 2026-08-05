import { describe, expect, it } from "vitest";

import { selectCaseEvidenceWindows } from "./case-evidence-windows.js";

describe("case evidence windows", () => {
  it("keeps timestamped student narratives and excludes unrelated promotion", () => {
    const transcript = [
      "# 虚构讲座",
      "`[00:00:01.000 - 00:00:03.000]` 欢迎关注直播并扫码报名。",
      "`[00:01:00.000 - 00:01:05.000]` 我们有一位学生A最初对城市问题感兴趣。",
      "`[00:01:05.000 - 00:01:12.000]` 他随后完成了数据研究项目。",
      "`[00:01:12.000 - 00:01:20.000]` 项目使用公开数据并形成研究报告。",
      "`[00:20:00.000 - 00:20:05.000]` 机构现有十个校区。",
    ].join("\n");

    const selected = selectCaseEvidenceWindows(transcript, { contextLines: 2 });

    expect(selected).toContain("一位学生A");
    expect(selected).toContain("数据研究项目");
    expect(selected).not.toContain("机构现有十个校区");
  });

  it("returns an empty input when no timestamped individual case marker exists", () => {
    expect(selectCaseEvidenceWindows("`[00:00:01.000 - 00:00:03.000]` 这是学校介绍。")).toBe("");
  });
});
