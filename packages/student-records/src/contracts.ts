import { AccessLevelSchema } from "@culiu/authorization";
import { z } from "zod";

export const MAX_EVIDENCE_BYTES = 20 * 1024 * 1024;
export const MAX_FACT_VALUE_BYTES = 16 * 1024;

const ForbiddenObjectKeys = new Set(["__proto__", "constructor", "prototype"]);

function containsForbiddenObjectKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((entry) => containsForbiddenObjectKey(entry));
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, entry]) => ForbiddenObjectKeys.has(key) || containsForbiddenObjectKey(entry),
  );
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) < 32) return true;
  }
  return false;
}

export const StudentFactFieldKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9_.-]*$/u, "Use a stable lowercase namespaced field key.");

export const StudentFactValueSchema = z
  .record(z.string().min(1).max(128), z.json())
  .refine((value) => !containsForbiddenObjectKey(value), "Unsafe object keys are forbidden.")
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_FACT_VALUE_BYTES,
    `Fact values must not exceed ${String(MAX_FACT_VALUE_BYTES)} UTF-8 bytes.`,
  );

export const FactSourceTypeSchema = z.enum(["advisor", "student", "parent", "evidence"]);
export const FactConfirmationInputSchema = z.enum(["unconfirmed", "confirmed"]);
export const EvidenceRelationSchema = z.enum(["supports", "contradicts", "partially_supports"]);

const PageLocatorSchema = z
  .object({
    endPage: z.number().int().positive().optional(),
    page: z.number().int().positive(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.endPage !== undefined && value.endPage < value.page) {
      context.addIssue({
        code: "custom",
        message: "endPage must not be before page.",
        path: ["endPage"],
      });
    }
  });

const ParagraphLocatorSchema = z.object({ paragraph: z.number().int().positive() }).strict();
const CharacterRangeLocatorSchema = z
  .object({ end: z.number().int().positive(), start: z.number().int().nonnegative() })
  .strict()
  .refine((value) => value.end > value.start, {
    message: "Character range end must be after start.",
    path: ["end"],
  });
const CellLocatorSchema = z
  .object({
    column: z.number().int().positive(),
    row: z.number().int().positive(),
    sheet: z.string().trim().min(1).max(128).optional(),
  })
  .strict();
const TimestampLocatorSchema = z
  .object({ endMs: z.number().int().positive(), startMs: z.number().int().nonnegative() })
  .strict()
  .refine((value) => value.endMs > value.startMs, {
    message: "Timestamp end must be after start.",
    path: ["endMs"],
  });
const RecordFieldLocatorSchema = z.object({ field: z.string().trim().min(1).max(256) }).strict();

export const EvidenceLocatorInputSchema = z.discriminatedUnion("locatorType", [
  z.object({ locator: PageLocatorSchema, locatorType: z.literal("page") }).strict(),
  z.object({ locator: ParagraphLocatorSchema, locatorType: z.literal("paragraph") }).strict(),
  z
    .object({ locator: CharacterRangeLocatorSchema, locatorType: z.literal("character_range") })
    .strict(),
  z.object({ locator: CellLocatorSchema, locatorType: z.literal("cell") }).strict(),
  z.object({ locator: TimestampLocatorSchema, locatorType: z.literal("timestamp") }).strict(),
  z.object({ locator: RecordFieldLocatorSchema, locatorType: z.literal("record_field") }).strict(),
]);
export type EvidenceLocatorInput = z.infer<typeof EvidenceLocatorInputSchema>;

const EvidenceLinkInputSchema = z
  .object({
    evidenceLocatorId: z.uuid(),
    relation: EvidenceRelationSchema,
  })
  .strict();

export const CreateStudentFactInputSchema = z
  .object({
    accessLevel: AccessLevelSchema.default("sensitive"),
    confirmationStatus: FactConfirmationInputSchema.default("unconfirmed"),
    evidenceLinks: z.array(EvidenceLinkInputSchema).max(25).default([]),
    fieldKey: StudentFactFieldKeySchema,
    sourceType: FactSourceTypeSchema,
    supersedesFactId: z.uuid().optional(),
    validFrom: z.date().optional(),
    value: StudentFactValueSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const locatorIds = value.evidenceLinks.map((link) => link.evidenceLocatorId);
    if (new Set(locatorIds).size !== locatorIds.length) {
      context.addIssue({
        code: "custom",
        message: "Evidence locators must be unique within a fact.",
        path: ["evidenceLinks"],
      });
    }
    if (value.sourceType === "evidence" && value.evidenceLinks.length === 0) {
      context.addIssue({
        code: "custom",
        message: "Evidence-sourced facts require at least one evidence locator.",
        path: ["evidenceLinks"],
      });
    }
  });
export type CreateStudentFactInput = z.input<typeof CreateStudentFactInputSchema>;

export const RegisterStudentEvidenceInputSchema = z
  .object({
    accessLevel: AccessLevelSchema.default("sensitive"),
    content: z
      .instanceof(Uint8Array)
      .refine((value) => value.byteLength > 0, "Evidence files must not be empty.")
      .refine(
        (value) => value.byteLength <= MAX_EVIDENCE_BYTES,
        `Evidence files must not exceed ${String(MAX_EVIDENCE_BYTES)} bytes.`,
      ),
    fileName: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine(
        (value) =>
          !value.includes("\\") && !value.includes("/") && !containsControlCharacter(value),
        "File names must be basename-only.",
      ),
    locators: z.array(EvidenceLocatorInputSchema).min(1).max(25),
    mimeType: z
      .string()
      .trim()
      .toLowerCase()
      .min(1)
      .max(255)
      .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u),
    supersedesEvidenceId: z.uuid().optional(),
  })
  .strict();
export type RegisterStudentEvidenceInput = z.input<typeof RegisterStudentEvidenceInputSchema>;

export const InvalidateStudentEvidenceInputSchema = z
  .object({
    evidenceObjectId: z.uuid(),
    reason: z.string().trim().min(1).max(512),
  })
  .strict();
export type InvalidateStudentEvidenceInput = z.input<typeof InvalidateStudentEvidenceInputSchema>;
