import { describe, expect, it } from "vitest";

import {
  AuthorizationContextSchema,
  StrongPasswordSchema,
  accessLevelRank,
  type AuthorizationContext,
} from "./contracts.js";
import { assertAuthorizationContext, calculateAuthorizationContextHash } from "./context.js";
import { AuthorizationDeniedError } from "./errors.js";
import { hashPassword, verifyPassword } from "./password.js";

const ACTOR_ID = "10000000-0000-4000-8000-000000000001";
const STUDENT_ID = "10000000-0000-4000-8000-000000000002";
const OTHER_STUDENT_ID = "10000000-0000-4000-8000-000000000003";
const CONTEXT_ID = "10000000-0000-4000-8000-000000000004";

function validContext(): AuthorizationContext {
  const input = {
    actorUserId: ACTOR_ID,
    allowedActions: ["student:read"],
    createdAt: new Date("2026-08-02T00:00:00.000Z"),
    expiresAt: new Date("2026-08-02T00:15:00.000Z"),
    id: CONTEXT_ID,
    maxAccessLevel: "sensitive" as const,
    studentId: STUDENT_ID,
  };
  return AuthorizationContextSchema.parse({
    ...input,
    contextHash: calculateAuthorizationContextHash(input),
  });
}

describe("password policy and hashing", () => {
  it("enforces the bootstrap password policy", () => {
    expect(StrongPasswordSchema.safeParse("short").success).toBe(false);
    expect(StrongPasswordSchema.safeParse("alllowercasebutlong1!").success).toBe(false);
    expect(StrongPasswordSchema.safeParse("Valid-Bootstrap-2026!").success).toBe(true);
  });

  it("uses Argon2id and rejects malformed or incorrect hashes", async () => {
    const password = "Valid-Bootstrap-2026!";
    const passwordHash = await hashPassword(password);
    expect(passwordHash).toMatch(/^\$argon2id\$/u);
    await expect(verifyPassword(passwordHash, password)).resolves.toBe(true);
    await expect(verifyPassword(passwordHash, "Wrong-Bootstrap-2026!")).resolves.toBe(false);
    await expect(verifyPassword("not-an-argon-hash", password)).resolves.toBe(false);
  });
});

describe("authorization context", () => {
  it("uses a monotonic access-level order", () => {
    expect(accessLevelRank.internal).toBeLessThan(accessLevelRank.sensitive);
    expect(accessLevelRank.sensitive).toBeLessThan(accessLevelRank.restricted);
  });

  it("accepts an intact, current, minimum-scope context", () => {
    const context = validContext();
    expect(
      assertAuthorizationContext(context, {
        action: "student:read",
        accessLevel: "sensitive",
        actorUserId: ACTOR_ID,
        now: new Date("2026-08-02T00:05:00.000Z"),
        studentId: STUDENT_ID,
      }),
    ).toEqual(context);
  });

  it.each([
    ["cross-student target", { studentId: OTHER_STUDENT_ID }],
    ["action escalation", { action: "student:write" }],
    ["access escalation", { accessLevel: "restricted" as const }],
    ["actor substitution", { actorUserId: OTHER_STUDENT_ID }],
    ["expired context", { now: new Date("2026-08-02T00:15:00.000Z") }],
  ])("rejects %s", (_label, override) => {
    expect(() =>
      assertAuthorizationContext(validContext(), {
        action: "student:read",
        accessLevel: "sensitive",
        actorUserId: ACTOR_ID,
        now: new Date("2026-08-02T00:05:00.000Z"),
        studentId: STUDENT_ID,
        ...override,
      }),
    ).toThrow(AuthorizationDeniedError);
  });

  it("rejects a modified context even when the requested scope matches the modification", () => {
    const context = { ...validContext(), studentId: OTHER_STUDENT_ID };
    expect(() =>
      assertAuthorizationContext(context, {
        action: "student:read",
        accessLevel: "sensitive",
        now: new Date("2026-08-02T00:05:00.000Z"),
        studentId: OTHER_STUDENT_ID,
      }),
    ).toThrow(AuthorizationDeniedError);
  });
});
