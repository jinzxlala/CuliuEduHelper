import type { JsonModelProvider } from "@culiu/ai";
import { describe, expect, it } from "vitest";

import { extractBasicStudentCandidates } from "./basic-extraction.js";
import { redactParentPhones } from "./privacy.js";

describe("basic student extraction", () => {
  it("validates structured output and restores locally held phone values", async () => {
    let outbound = "";
    const provider: JsonModelProvider = {
      generateJson(request) {
        outbound = request.userPrompt;
        return Promise.resolve({
          json: {
            candidates: [
              {
                displayLabel: "张同学 / G8",
                fields: [
                  {
                    confidence: "high",
                    fieldKey: "identity.chinese_name",
                    sourceLocator: { end: 3, start: 0 },
                    value: "张同学",
                  },
                  {
                    confidence: "high",
                    fieldKey: "contact.parent_phone",
                    sourceLocator: { end: 21, start: 10 },
                    value: "[PHONE_1]",
                  },
                ],
                sourceOrdinal: 1,
              },
            ],
          },
          model: "deepseek-v4-flash",
          providerRequestId: "request-1",
          usage: {
            completionTokens: 30,
            promptCacheHitTokens: 0,
            promptCacheMissTokens: 100,
            promptTokens: 100,
            totalTokens: 130,
          },
        });
      },
    };

    const extracted = await extractBasicStudentCandidates(
      provider,
      redactParentPhones("张同学 家长电话 13800138000"),
    );

    expect(outbound).not.toContain("13800138000");
    expect(extracted.modelOutput.candidates[0]?.fields[1]?.value).toBe("13800138000");
  });

  it("rejects invented fields and unknown phone placeholders", async () => {
    const provider: JsonModelProvider = {
      generateJson() {
        return Promise.resolve({
          json: {
            candidates: [
              {
                displayLabel: "student",
                fields: [
                  {
                    confidence: "high",
                    fieldKey: "contact.parent_phone",
                    sourceLocator: { end: 3, start: 0 },
                    value: "[PHONE_99]",
                  },
                ],
                sourceOrdinal: 1,
              },
            ],
          },
          model: "deepseek-v4-flash",
          providerRequestId: "request-2",
          usage: {
            completionTokens: 1,
            promptCacheHitTokens: 0,
            promptCacheMissTokens: 1,
            promptTokens: 1,
            totalTokens: 2,
          },
        });
      },
    };

    await expect(
      extractBasicStudentCandidates(provider, redactParentPhones("no phone")),
    ).rejects.toThrow("unknown phone placeholder");
  });
});
