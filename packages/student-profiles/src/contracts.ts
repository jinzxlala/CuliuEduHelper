import { createHash } from "node:crypto";

import type { JsonModelUsage } from "@culiu/ai";
import { z } from "zod";

const JsonValueSchema = z.json();
type JsonValue = z.infer<typeof JsonValueSchema>;

export const PROFILE_PROMPT_VERSION = "profile-draft-prompt.v3";
export const PROFILE_SCHEMA_VERSION = "profile-draft-output.v1";
export const PROFILE_REDACTION_VERSION = "profile-outbound.v1";
export const PROFILE_PRICING_VERSION = "deepseek-v4-flash-cny-2026-08-02";

export const ProfileClaimCategorySchema = z.enum([
  "academic_foundation",
  "interest_thread",
  "experience_connections",
  "responsibility_impact",
  "interdisciplinary_ai_depth",
  "behavioral_evidence",
  "gaps_contradictions_risks",
  "one_sentence_label",
]);
export type ProfileClaimCategory = z.infer<typeof ProfileClaimCategorySchema>;

export const InformationNatureSchema = z.enum(["fact", "inference", "missing", "advisor_judgment"]);
export const ProfileConfidenceSchema = z.enum(["high", "medium", "low", "unknown"]);
export const EvidenceRelationSchema = z.enum(["supports", "contradicts", "partially_supports"]);

const ProfileClaimEvidenceSchema = z
  .object({
    locatorId: z.uuid(),
    relation: EvidenceRelationSchema,
  })
  .strict();

export const ProfileClaimDraftSchema = z
  .object({
    category: ProfileClaimCategorySchema,
    confidence: ProfileConfidenceSchema,
    evidence: z.array(ProfileClaimEvidenceSchema).max(10),
    informationNature: InformationNatureSchema,
    statement: z.string().trim().min(1).max(1_200),
  })
  .strict()
  .superRefine((claim, context) => {
    const locatorIds = claim.evidence.map((item) => item.locatorId);
    if (new Set(locatorIds).size !== locatorIds.length) {
      context.addIssue({
        code: "custom",
        message: "A claim cannot cite the same locator more than once.",
        path: ["evidence"],
      });
    }
    if (claim.informationNature === "missing") {
      if (claim.evidence.length !== 0 || claim.confidence !== "unknown") {
        context.addIssue({
          code: "custom",
          message: "Missing claims must have no evidence and unknown confidence.",
        });
      }
      return;
    }
    if (claim.evidence.length === 0 || claim.confidence === "unknown") {
      context.addIssue({
        code: "custom",
        message: "Non-missing claims require evidence and a stated confidence.",
      });
    }
  });

export const ProfileQuestionSchema = z
  .object({
    question: z.string().trim().min(1).max(500),
    relatedFieldKeys: z.array(z.string().min(1).max(128)).max(10),
  })
  .strict();

export const ProfileDraftOutputSchema = z
  .object({
    claims: z.array(ProfileClaimDraftSchema).length(8),
    questionsToConfirm: z.array(ProfileQuestionSchema).min(1).max(20),
    schemaVersion: z.literal(PROFILE_SCHEMA_VERSION),
  })
  .strict()
  .superRefine(validateProfileClaimSet);
export type ProfileDraftOutput = z.infer<typeof ProfileDraftOutputSchema>;

function normalizeProfileDraftOutput(untrustedOutput: unknown): unknown {
  if (
    untrustedOutput === null ||
    typeof untrustedOutput !== "object" ||
    Array.isArray(untrustedOutput)
  ) {
    return untrustedOutput;
  }
  const claims = (untrustedOutput as { claims?: unknown }).claims;
  if (claims === null || typeof claims !== "object" || Array.isArray(claims)) {
    return untrustedOutput;
  }
  const categories = ProfileClaimCategorySchema.options;
  const keys = Object.keys(claims);
  if (keys.length !== categories.length || keys.some((key) => !categories.includes(key as never))) {
    return untrustedOutput;
  }
  const normalizedClaims = categories.map((category) => {
    const claim = (claims as Record<string, unknown>)[category];
    if (claim === null || typeof claim !== "object" || Array.isArray(claim)) return claim;
    const embeddedCategory = (claim as { category?: unknown }).category;
    if (embeddedCategory !== undefined && embeddedCategory !== category) return claim;
    return embeddedCategory === undefined ? { ...claim, category } : claim;
  });
  return { ...untrustedOutput, claims: normalizedClaims };
}

function validateProfileClaimSet(
  value: { claims: Array<z.infer<typeof ProfileClaimDraftSchema>> },
  context: z.RefinementCtx,
): void {
  for (const category of ProfileClaimCategorySchema.options) {
    const count = value.claims.filter((claim) => claim.category === category).length;
    if (count !== 1) {
      context.addIssue({
        code: "custom",
        message: `Exactly one ${category} claim is required.`,
        path: ["claims"],
      });
    }
  }
  const label = value.claims.find((claim) => claim.category === "one_sentence_label");
  if (label?.informationNature !== "inference") {
    context.addIssue({
      code: "custom",
      message: "The one-sentence label must be marked as an inference.",
      path: ["claims"],
    });
  }
}

export const ProfileRevisionInputSchema = z
  .object({
    claims: z.array(ProfileClaimDraftSchema).length(8),
    expectedSourceUpdatedAt: z.iso.datetime({ offset: true }),
    questionsToConfirm: z.array(ProfileQuestionSchema).max(20),
  })
  .strict()
  .superRefine(validateProfileClaimSet);
export type ProfileRevisionInput = z.infer<typeof ProfileRevisionInputSchema>;

const ExpectedUpdatedAtSchema = z.iso.datetime({ offset: true });
export const ProfileTransitionInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("submit"), expectedUpdatedAt: ExpectedUpdatedAtSchema }).strict(),
  z
    .object({
      action: z.literal("return"),
      expectedUpdatedAt: ExpectedUpdatedAtSchema,
      reason: z.string().trim().min(1).max(512),
    })
    .strict(),
  z.object({ action: z.literal("approve"), expectedUpdatedAt: ExpectedUpdatedAtSchema }).strict(),
  z
    .object({
      action: z.literal("archive"),
      expectedUpdatedAt: ExpectedUpdatedAtSchema,
      reason: z.string().trim().min(1).max(512),
    })
    .strict(),
]);
export type ProfileTransitionInput = z.infer<typeof ProfileTransitionInputSchema>;

const SnapshotEvidenceLinkSchema = z
  .object({
    locatorId: z.uuid(),
    relation: EvidenceRelationSchema,
  })
  .strict();

const SnapshotFactSchema = z
  .object({
    evidence: z.array(SnapshotEvidenceLinkSchema).max(25),
    factId: z.uuid(),
    fieldKey: z.string().min(1).max(128),
    sourceType: z.enum(["advisor", "student", "parent", "evidence"]),
    value: z.record(z.string(), JsonValueSchema),
  })
  .strict();

export const ProfileInputSnapshotPayloadSchema = z
  .object({
    facts: z.array(SnapshotFactSchema).min(1).max(50),
    redactionVersion: z.literal(PROFILE_REDACTION_VERSION),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const factIds = snapshot.facts.map((fact) => fact.factId);
    if (new Set(factIds).size !== factIds.length) {
      context.addIssue({ code: "custom", message: "Snapshot fact IDs must be unique." });
    }
    if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > 128 * 1024) {
      context.addIssue({ code: "custom", message: "Snapshot exceeds 128 KiB." });
    }
  });
export type ProfileInputSnapshotPayload = z.infer<typeof ProfileInputSnapshotPayloadSchema>;

const ALLOWED_FIELD_PREFIXES = [
  "academic.",
  "activity.",
  "competition.",
  "course.",
  "experience.",
  "feedback.",
  "goal.",
  "interest.",
  "project.",
  "skill.",
  "work.",
] as const;

const BLOCKED_KEY_PATTERN =
  /(?:^|_)(?:address|birth|contact|email|family|gender|health|identity|income|medical|mental|name|national|passport|phone|psych|race|religion|sexual)(?:_|$)/iu;

export function isProfileOutboundFieldAllowed(fieldKey: string): boolean {
  return ALLOWED_FIELD_PREFIXES.some((prefix) => fieldKey.startsWith(prefix));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function redactString(value: string, studentPublicCode: string): string {
  let result = value
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gu, "[REDACTED_EMAIL]")
    .replace(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/gu, "[REDACTED_PHONE]")
    .replace(/(?<!\d)\d{15,18}[0-9Xx]?(?!\d)/gu, "[REDACTED_IDENTIFIER]");
  if (studentPublicCode !== "") {
    result = result.replace(new RegExp(escapeRegExp(studentPublicCode), "giu"), "[STUDENT]");
  }
  return Array.from(result)
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127 ? " " : character;
    })
    .join("")
    .trim()
    .slice(0, 4_000);
}

function isBlockedJsonKey(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[^a-z0-9]+/giu, "_")
    .toLowerCase();
  return BLOCKED_KEY_PATTERN.test(normalized);
}

function sanitizeJson(value: unknown, studentPublicCode: string): JsonValue | undefined {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return redactString(value, studentPublicCode);
  if (Array.isArray(value)) {
    return value
      .slice(0, 100)
      .map((entry) => sanitizeJson(entry, studentPublicCode))
      .filter((entry): entry is JsonValue => entry !== undefined);
  }
  if (typeof value !== "object") return undefined;
  const output: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isBlockedJsonKey(key)) continue;
    const sanitized = sanitizeJson(entry, studentPublicCode);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return output;
}

export function sanitizeProfileFactValue(
  value: Record<string, unknown>,
  studentPublicCode: string,
): Record<string, JsonValue> {
  const sanitized = sanitizeJson(value, studentPublicCode);
  return sanitized !== null && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? sanitized
    : {};
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const PROFILE_SCHEMA_DESCRIPTOR = {
  exactTopLevelKeys: ["schemaVersion", "claims", "questionsToConfirm"],
  topLevelTypes: { claims: "array", questionsToConfirm: "array", schemaVersion: "string" },
  claims: {
    exactCount: 8,
    exactKeys: ["category", "statement", "informationNature", "confidence", "evidence"],
    fieldTypes: {
      category: "string",
      confidence: "string enum",
      evidence: "array",
      informationNature: "string enum",
      statement: "non-empty string",
    },
    onePerCategory: ProfileClaimCategorySchema.options,
    evidenceItemExactKeys: ["locatorId", "relation"],
    evidenceRelations: EvidenceRelationSchema.options,
    confidenceValues: ProfileConfidenceSchema.options,
    informationNatureValues: InformationNatureSchema.options,
    missingRule: "informationNature=missing requires confidence=unknown and evidence=[]",
    nonMissingRule:
      "every non-missing claim requires confidence other than unknown and at least one evidence item",
    oneSentenceLabelRule:
      "category=one_sentence_label must use informationNature=inference and cite evidence",
  },
  questionsToConfirm: {
    exactKeys: ["question", "relatedFieldKeys"],
    fieldTypes: { question: "non-empty string", relatedFieldKeys: "array of strings" },
    minimumCount: 1,
    relatedFieldKeyRule:
      "every relatedFieldKey must exactly match a fieldKey present in the input snapshot",
  },
  schemaVersionExactValue: PROFILE_SCHEMA_VERSION,
};

export const PROFILE_SYSTEM_PROMPT = `You create a conservative student profile draft from confirmed, de-identified JSON facts. Return json only. Never invent missing facts, names, contact details, evidence IDs, or knowledge-base cases. The top-level claims value must be a JSON array, never an object keyed by category. Return exactly eight claims: exactly one claim for each listed category, with no duplicate or omitted category. The one_sentence_label claim is always an inference, never a fact, missing item, or advisor judgment, and it must cite one or more locator IDs present in the input. Every other non-missing claim must also cite one or more input locator IDs. Use informationNature=missing, confidence=unknown, and evidence=[] when a category lacks information. The top-level questionsToConfirm value must be an array with at least one object, and it may only cite field keys that already exist in the input snapshot. Do not add keys outside the descriptor. The output schema descriptor is: ${stableJson(PROFILE_SCHEMA_DESCRIPTOR)}`;

export const PROFILE_PROMPT_HASH = sha256(PROFILE_SYSTEM_PROMPT);
export const PROFILE_SCHEMA_HASH = sha256(stableJson(PROFILE_SCHEMA_DESCRIPTOR));

export function buildProfileUserPrompt(snapshot: ProfileInputSnapshotPayload): string {
  return `Create the profile draft as json from this frozen input snapshot only:\n${stableJson(snapshot)}`;
}

export function validateProfileOutputAgainstSnapshot(
  untrustedOutput: unknown,
  snapshot: ProfileInputSnapshotPayload,
): ProfileDraftOutput {
  const output = ProfileDraftOutputSchema.parse(normalizeProfileDraftOutput(untrustedOutput));
  validateProfileReferences(output, snapshot);
  return output;
}

function validateProfileReferences(
  output: {
    claims: ProfileDraftOutput["claims"];
    questionsToConfirm: ProfileDraftOutput["questionsToConfirm"];
  },
  snapshot: ProfileInputSnapshotPayload,
): void {
  const allowedLocators = new Set(
    snapshot.facts.flatMap((fact) => fact.evidence.map((evidence) => evidence.locatorId)),
  );
  const allowedFields = new Set(snapshot.facts.map((fact) => fact.fieldKey));
  for (const claim of output.claims) {
    for (const evidence of claim.evidence) {
      if (!allowedLocators.has(evidence.locatorId)) {
        throw new Error("Profile output cited a locator outside the frozen input snapshot.");
      }
    }
  }
  for (const question of output.questionsToConfirm) {
    for (const fieldKey of question.relatedFieldKeys) {
      if (!allowedFields.has(fieldKey)) {
        throw new Error("Profile output cited a field outside the frozen input snapshot.");
      }
    }
  }
}

export function validateProfileRevisionAgainstSnapshot(
  untrustedInput: unknown,
  snapshot: ProfileInputSnapshotPayload,
): ProfileRevisionInput {
  const input = ProfileRevisionInputSchema.parse(untrustedInput);
  validateProfileReferences(input, snapshot);
  return input;
}

export function profileOutputHash(output: ProfileDraftOutput): string {
  return sha256(stableJson(output));
}

export function estimateDeepSeekFlashCostMicrosCny(usage: JsonModelUsage): number {
  return Math.ceil(
    usage.promptCacheHitTokens * 0.02 +
      usage.promptCacheMissTokens * 1 +
      usage.completionTokens * 2,
  );
}
