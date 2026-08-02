import { describe, expect, it } from "vitest";

import { redactParentPhones, restorePhoneToken } from "./privacy.js";

describe("student import outbound privacy", () => {
  it("removes parent phone numbers before model outbound and restores only known tokens", () => {
    const redacted = redactParentPhones("学生A 家长 138 0013 8000；学生B：+86-13912345678");

    expect(redacted.text).toBe("学生A 家长 [PHONE_1]；学生B：[PHONE_2]");
    expect(redacted.text).not.toContain("138");
    expect(restorePhoneToken("[PHONE_1]", redacted.phoneTokens)).toBe("13800138000");
    expect(() => restorePhoneToken("[PHONE_9]", redacted.phoneTokens)).toThrow("unknown");
  });
});
