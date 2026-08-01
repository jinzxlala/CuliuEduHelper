import { z } from "zod";

export const UserRoleSchema = z.enum(["admin", "advisor", "auditor", "service"]);
export type UserRole = z.infer<typeof UserRoleSchema>;

export const InteractiveUserRoleSchema = z.enum(["admin", "advisor", "auditor"]);
export type InteractiveUserRole = z.infer<typeof InteractiveUserRoleSchema>;

export const AccessLevelSchema = z.enum(["internal", "sensitive", "restricted"]);
export type AccessLevel = z.infer<typeof AccessLevelSchema>;

export const StudentActionSchema = z.enum([
  "student:read",
  "student:write",
  "student:profile:generate",
  "student:authorize",
  "student:audit",
]);
export type StudentAction = z.infer<typeof StudentActionSchema>;

export const AuthorizationContextSchema = z
  .object({
    actorUserId: z.uuid(),
    allowedActions: z.array(z.string().min(1)).min(1),
    contextHash: z.string().regex(/^[0-9a-f]{64}$/u),
    createdAt: z.date(),
    expiresAt: z.date(),
    id: z.uuid(),
    maxAccessLevel: AccessLevelSchema,
    studentId: z.uuid().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.expiresAt <= value.createdAt) {
      context.addIssue({
        code: "custom",
        message: "Authorization context expiry must be after creation.",
        path: ["expiresAt"],
      });
    }
  });

export type AuthorizationContext = z.infer<typeof AuthorizationContextSchema>;

export const SessionPrincipalSchema = z
  .object({
    displayName: z.string().trim().min(1).max(200),
    email: z.email().transform((value) => value.toLowerCase()),
    id: z.uuid(),
    role: InteractiveUserRoleSchema,
  })
  .strict();

export type SessionPrincipal = z.infer<typeof SessionPrincipalSchema>;

export const CredentialInputSchema = z
  .object({
    email: z
      .email()
      .max(320)
      .transform((value) => value.trim().toLowerCase()),
    password: z.string().min(1).max(1024),
  })
  .strict();

export type CredentialInput = z.input<typeof CredentialInputSchema>;

export const StrongPasswordSchema = z
  .string()
  .min(14, "Password must contain at least 14 characters.")
  .max(128, "Password must contain at most 128 characters.")
  .regex(/[a-z]/u, "Password must contain a lowercase letter.")
  .regex(/[A-Z]/u, "Password must contain an uppercase letter.")
  .regex(/[0-9]/u, "Password must contain a number.")
  .regex(/[^A-Za-z0-9]/u, "Password must contain a symbol.");

export const InitialAdminInputSchema = z
  .object({
    displayName: z.string().trim().min(1).max(200),
    email: z
      .email()
      .max(320)
      .transform((value) => value.trim().toLowerCase()),
    password: StrongPasswordSchema,
  })
  .strict();

export type InitialAdminInput = z.input<typeof InitialAdminInputSchema>;

export const accessLevelRank: Readonly<Record<AccessLevel, number>> = {
  internal: 0,
  restricted: 2,
  sensitive: 1,
};
