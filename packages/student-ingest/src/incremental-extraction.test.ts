import type { JsonModelProvider } from "@culiu/ai";
import { describe, expect, it } from "vitest";

import {
  extractIncrementalFactSuggestions,
  isolateStudentCsv,
  paragraphMaterial,
  redactSelectedStudentMaterial,
} from "./incremental-extraction.js";

describe("incremental student evidence isolation", () => {
  it("keeps common course cells and exactly one selected student column", () => {
    const material = isolateStudentCsv(
      "日期,课程内容,张三 G8,李四 G9,\n2026-08-01,DFS,理解递归,缺席,",
      ["张三"],
    );
    expect(material.text).toContain("[R2C1] 2026-08-01");
    expect(material.text).toContain("[R2C2] DFS");
    expect(material.text).toContain("[R2C3] 理解递归");
    expect(material.text).not.toContain("李四");
    expect(material.text).not.toContain("缺席");
  });

  it("requires one unambiguous selected column", () => {
    expect(() => isolateStudentCsv("课程,张三,张三反馈\nDFS,A,B", ["张三"])).toThrow(
      "exactly one column",
    );
  });

  it("redacts selected identity and direct identifiers before model outbound", () => {
    const material = redactSelectedStudentMaterial(
      paragraphMaterial("张三 家长 13800138000 邮箱 parent@example.com 编码 STU-ABCD1234"),
      ["张三"],
    );
    expect(material.text).not.toMatch(/张三|13800138000|parent@example\.com|STU-ABCD1234/u);
    expect(material.text).toContain("[STUDENT]");
  });

  it("rejects a model source reference outside the isolated material", async () => {
    const provider: JsonModelProvider = {
      generateJson: () =>
        Promise.resolve({
          json: {
            suggestions: [
              {
                confidence: "high",
                fieldKey: "learning.algorithm_reasoning",
                informationNature: "fact",
                sourceRef: "P9",
                value: { text: "能解释 DFS" },
              },
            ],
          },
          model: "deepseek-v4-flash",
          providerRequestId: "synthetic",
          usage: {
            completionTokens: 1,
            promptCacheHitTokens: 0,
            promptCacheMissTokens: 1,
            promptTokens: 1,
            totalTokens: 2,
          },
        }),
    };
    await expect(
      extractIncrementalFactSuggestions(provider, paragraphMaterial("目标学生材料")),
    ).rejects.toThrow("outside");
  });
});
