import { z } from "zod";

export const StorageDomainSchema = z.enum(["knowledge", "student"]);
export type StorageDomain = z.infer<typeof StorageDomainSchema>;

export const StoredObjectReferenceSchema = z
  .object({
    domain: StorageDomainSchema,
    key: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    size: z.number().int().nonnegative(),
    studentId: z.uuid().optional(),
  })
  .superRefine((value, context) => {
    if (value.domain === "student" && value.studentId === undefined) {
      context.addIssue({
        code: "custom",
        message: "student storage requires a studentId",
        path: ["studentId"],
      });
    }

    if (value.domain === "knowledge" && value.studentId !== undefined) {
      context.addIssue({
        code: "custom",
        message: "knowledge storage cannot carry a studentId",
        path: ["studentId"],
      });
    }
  });

export type StoredObjectReference = z.infer<typeof StoredObjectReferenceSchema>;

export const StoreObjectInputSchema = z
  .object({
    content: z.instanceof(Uint8Array),
    domain: StorageDomainSchema,
    studentId: z.uuid().optional(),
  })
  .superRefine((value, context) => {
    if (value.domain === "student" && value.studentId === undefined) {
      context.addIssue({ code: "custom", message: "studentId is required", path: ["studentId"] });
    }

    if (value.domain === "knowledge" && value.studentId !== undefined) {
      context.addIssue({
        code: "custom",
        message: "studentId is forbidden for knowledge objects",
        path: ["studentId"],
      });
    }
  });

export type StoreObjectInput = z.infer<typeof StoreObjectInputSchema>;
