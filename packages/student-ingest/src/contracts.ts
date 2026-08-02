import { z } from "zod";

export const MAX_STUDENT_IMPORT_BYTES = 20 * 1024 * 1024;

export const StudentImportFormatSchema = z.enum(["csv", "docx", "markdown", "text"]);
export type StudentImportFormat = z.infer<typeof StudentImportFormatSchema>;

export const StudentBaseFieldKeySchema = z.enum([
  "identity.chinese_name",
  "identity.english_name",
  "education.grade",
  "identity.birth_date",
  "education.school",
  "contact.parent_phone",
]);
export type StudentBaseFieldKey = z.infer<typeof StudentBaseFieldKeySchema>;

export const ImportSourceLocatorSchema = z
  .object({
    column: z.number().int().positive().optional(),
    end: z.number().int().positive().optional(),
    row: z.number().int().positive().optional(),
    start: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const isCell = value.row !== undefined && value.column !== undefined;
    const isRange = value.start !== undefined && value.end !== undefined && value.end > value.start;
    if (!isCell && !isRange) {
      context.addIssue({ code: "custom", message: "A source locator must be a cell or range." });
    }
  });
export type ImportSourceLocator = z.infer<typeof ImportSourceLocatorSchema>;

export const StudentImportUploadSchema = z
  .object({
    content: z
      .instanceof(Uint8Array)
      .refine((value) => value.byteLength > 0, "Import files must not be empty.")
      .refine(
        (value) => value.byteLength <= MAX_STUDENT_IMPORT_BYTES,
        `Import files must not exceed ${String(MAX_STUDENT_IMPORT_BYTES)} bytes.`,
      ),
    fileName: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine((value) => !value.includes("/") && !value.includes("\\"), "Use a basename only."),
    mimeType: z.string().trim().toLowerCase().min(1).max(255),
  })
  .strict();
export type StudentImportUpload = z.infer<typeof StudentImportUploadSchema>;

const ModelFieldSchema = z
  .object({
    confidence: z.enum(["high", "medium", "low", "unknown"]),
    fieldKey: StudentBaseFieldKeySchema,
    sourceLocator: ImportSourceLocatorSchema,
    value: z.string().trim().min(1).max(1000),
  })
  .strict();

export const BasicStudentImportModelOutputSchema = z
  .object({
    candidates: z
      .array(
        z
          .object({
            displayLabel: z.string().trim().min(1).max(200),
            fields: z.array(ModelFieldSchema).min(1).max(6),
            sourceOrdinal: z.number().int().positive(),
          })
          .strict()
          .superRefine((candidate, context) => {
            const keys = candidate.fields.map((field) => field.fieldKey);
            if (new Set(keys).size !== keys.length) {
              context.addIssue({ code: "custom", message: "Candidate field keys must be unique." });
            }
          }),
      )
      .min(1)
      .max(500),
  })
  .strict()
  .superRefine((value, context) => {
    const ordinals = value.candidates.map((candidate) => candidate.sourceOrdinal);
    if (new Set(ordinals).size !== ordinals.length) {
      context.addIssue({ code: "custom", message: "Candidate ordinals must be unique." });
    }
  });

export type BasicStudentImportModelOutput = z.infer<typeof BasicStudentImportModelOutputSchema>;

export interface ParsedStudentImportDocument {
  readonly format: StudentImportFormat;
  readonly modelText: string;
  readonly rows: readonly (readonly string[])[];
}

export interface RedactedStudentImport {
  readonly phoneTokens: ReadonlyMap<string, string>;
  readonly text: string;
}
