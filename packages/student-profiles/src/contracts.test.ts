import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  PROFILE_REDACTION_VERSION,
  PROFILE_PROMPT_VERSION,
  PROFILE_SCHEMA_VERSION,
  PROFILE_SYSTEM_PROMPT,
  ProfileDraftOutputSchema,
  ProfileRevisionInputSchema,
  ProfileTransitionInputSchema,
  estimateDeepSeekFlashCostMicrosCny,
  isProfileOutboundFieldAllowed,
  sanitizeProfileFactValue,
  validateProfileOutputAgainstSnapshot,
  type ProfileDraftOutput,
  type ProfileInputSnapshotPayload,
} from "./contracts.js";

function snapshot(): ProfileInputSnapshotPayload {
  return {
    facts: [
      {
        evidence: [{ locatorId: "00000000-0000-4000-8000-000000000030", relation: "supports" }],
        factId: "00000000-0000-4000-8000-000000000031",
        fieldKey: "academic.gpa",
        sourceType: "evidence",
        value: { text: "Synthetic GPA 3.8" },
      },
    ],
    redactionVersion: PROFILE_REDACTION_VERSION,
  };
}

function output(locatorId = "00000000-0000-4000-8000-000000000030"): ProfileDraftOutput {
  const categories = [
    "academic_foundation",
    "interest_thread",
    "experience_connections",
    "responsibility_impact",
    "interdisciplinary_ai_depth",
    "behavioral_evidence",
    "gaps_contradictions_risks",
    "one_sentence_label",
  ] as const;
  return {
    claims: categories.map((category) => ({
      category,
      confidence: "medium" as const,
      evidence: [{ locatorId, relation: "supports" as const }],
      informationNature:
        category === "one_sentence_label" ? ("inference" as const) : ("fact" as const),
      statement: `Synthetic ${category}`,
    })),
    questionsToConfirm: [
      { question: "Confirm the academic trend?", relatedFieldKeys: ["academic.gpa"] },
    ],
    schemaVersion: PROFILE_SCHEMA_VERSION,
  };
}

describe("profile contracts", () => {
  it("freezes the v3 prompt rules for array shape, claim coverage and label semantics", () => {
    expect(PROFILE_PROMPT_VERSION).toBe("profile-draft-prompt.v3");
    expect(PROFILE_SYSTEM_PROMPT).toContain("claims value must be a JSON array");
    expect(PROFILE_SYSTEM_PROMPT).toContain("exactly one claim for each listed category");
    expect(PROFILE_SYSTEM_PROMPT).toContain("one_sentence_label claim is always an inference");
  });

  it("normalizes an exact category-keyed claims object without relaxing claim validation", () => {
    const valid = output();
    const keyedClaims = Object.fromEntries(valid.claims.map((claim) => [claim.category, claim]));
    expect(
      validateProfileOutputAgainstSnapshot({ ...valid, claims: keyedClaims }, snapshot()).claims,
    ).toHaveLength(8);
    expect(() =>
      validateProfileOutputAgainstSnapshot(
        {
          ...valid,
          claims: { ...keyedClaims, academic_foundation: undefined },
        },
        snapshot(),
      ),
    ).toThrow();
  });

  it("requires all eight sections and evidence for every non-missing claim", () => {
    expect(ProfileDraftOutputSchema.parse(output()).claims).toHaveLength(8);
    expect(() =>
      ProfileDraftOutputSchema.parse({ ...output(), claims: output().claims.slice(1) }),
    ).toThrow();
    expect(() =>
      ProfileDraftOutputSchema.parse({
        ...output(),
        claims: output().claims.map((claim, index) =>
          index === 0 ? { ...claim, evidence: [] } : claim,
        ),
      }),
    ).toThrow();
  });

  it("rejects hallucinated locator and field references", () => {
    expect(() => validateProfileOutputAgainstSnapshot(output(randomUUID()), snapshot())).toThrow(
      /outside the frozen input snapshot/u,
    );
    expect(() =>
      validateProfileOutputAgainstSnapshot(
        {
          ...output(),
          questionsToConfirm: [
            { question: "Synthetic question", relatedFieldKeys: ["identity.name"] },
          ],
        },
        snapshot(),
      ),
    ).toThrow(/outside the frozen input snapshot/u);
  });

  it("uses an explicit outbound field allowlist", () => {
    expect(isProfileOutboundFieldAllowed("academic.gpa")).toBe(true);
    expect(isProfileOutboundFieldAllowed("interest.robotics")).toBe(true);
    expect(isProfileOutboundFieldAllowed("identity.name")).toBe(false);
    expect(isProfileOutboundFieldAllowed("health.notes")).toBe(false);
  });

  it("removes sensitive keys and replaces direct identifiers", () => {
    const sanitized = sanitizeProfileFactValue(
      {
        email: "student@example.com",
        nested: { family_income: "secret", text: "student_demo_001 +8613812345678" },
        text: "Contact student@example.com with ID 11010519491231002X",
      },
      "student_demo_001",
    );
    expect(JSON.stringify(sanitized)).not.toContain("student@example.com");
    expect(JSON.stringify(sanitized)).not.toContain("13812345678");
    expect(JSON.stringify(sanitized)).not.toContain("11010519491231002X");
    expect(JSON.stringify(sanitized)).not.toContain("family_income");
    expect(JSON.stringify(sanitized)).toContain("[STUDENT]");
  });

  it("records a deterministic current pricing estimate", () => {
    expect(
      estimateDeepSeekFlashCostMicrosCny({
        completionTokens: 100,
        promptCacheHitTokens: 100,
        promptCacheMissTokens: 100,
        promptTokens: 200,
        totalTokens: 300,
      }),
    ).toBe(302);
  });

  it("validates complete advisor revisions and strict transition commands", () => {
    expect(
      ProfileRevisionInputSchema.parse({
        claims: output().claims,
        expectedSourceUpdatedAt: "2026-08-02T12:00:00.000Z",
        questionsToConfirm: [],
      }).questionsToConfirm,
    ).toEqual([]);
    expect(() =>
      ProfileRevisionInputSchema.parse({
        claims: output().claims.map((claim) =>
          claim.category === "one_sentence_label"
            ? { ...claim, informationNature: "advisor_judgment" }
            : claim,
        ),
        expectedSourceUpdatedAt: "2026-08-02T12:00:00.000Z",
        questionsToConfirm: [],
      }),
    ).toThrow(/label must be marked as an inference/u);
    expect(
      ProfileTransitionInputSchema.parse({
        action: "return",
        expectedUpdatedAt: "2026-08-02T12:00:00.000Z",
        reason: "Needs a clearer evidence statement.",
      }).action,
    ).toBe("return");
    expect(() =>
      ProfileTransitionInputSchema.parse({
        action: "return",
        expectedUpdatedAt: "2026-08-02T12:00:00.000Z",
        reason: "",
      }),
    ).toThrow();
  });
});
