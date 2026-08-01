import { randomUUID } from "node:crypto";

import {
  appUsers,
  auditEvents,
  createDatabaseClient,
  parseDatabaseConfig,
  runMigrations,
  studentAuthorizations,
  studentFacts,
  students,
  type Database,
  type DatabaseClient,
} from "@culiu/database";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { authenticateCredentials } from "./authentication.js";
import {
  createStudentAuthorizationContext,
  createStudentDirectoryContext,
  listAuthorizedStudents,
  loadAuthorizationContext,
  readStudentOverview,
} from "./authorization-service.js";
import type { AccessLevel, SessionPrincipal, StudentAction } from "./contracts.js";
import { AuthorizationDeniedError, InitialAdminAlreadyExistsError } from "./errors.js";
import { createInitialAdmin } from "./initial-admin.js";
import { hashPassword } from "./password.js";

class RollbackTestError extends Error {}
let client: DatabaseClient | undefined;

function activeClient(): DatabaseClient {
  if (client === undefined) {
    throw new Error("Authorization integration database was not initialized.");
  }
  return client;
}

async function withRollback(test: (database: Database) => Promise<void>): Promise<void> {
  try {
    await activeClient().database.transaction(async (transaction) => {
      await test(transaction);
      throw new RollbackTestError();
    });
  } catch (error) {
    if (!(error instanceof RollbackTestError)) {
      throw error;
    }
  }
}

interface FixtureOptions {
  active?: boolean;
  allowedActions?: StudentAction[];
  expiresAt?: Date | null;
  maxAccessLevel?: AccessLevel;
  passwordHash?: string | null;
  privacyLevel?: AccessLevel;
  role?: "admin" | "advisor" | "auditor" | "service";
  validFrom?: Date;
  withGrant?: boolean;
}

async function createFixture(
  database: Database,
  options: FixtureOptions = {},
): Promise<{ principal: SessionPrincipal; studentId: string }> {
  const userId = randomUUID();
  const studentId = randomUUID();
  const role = options.role ?? "advisor";
  await database.insert(appUsers).values({
    active: options.active ?? true,
    displayName: "Synthetic Authorization User",
    email: `${userId}@example.invalid`,
    id: userId,
    passwordHash: options.passwordHash ?? null,
    role,
  });
  await database.insert(students).values({
    id: studentId,
    ownerUserId: userId,
    privacyLevel: options.privacyLevel ?? "sensitive",
    publicCode: `student_${studentId.replaceAll("-", "")}`,
  });
  if (options.withGrant ?? true) {
    await database.insert(studentAuthorizations).values({
      allowedActions: options.allowedActions ?? ["student:read"],
      expiresAt: options.expiresAt,
      grantedByUserId: userId,
      maxAccessLevel: options.maxAccessLevel ?? "sensitive",
      studentId,
      userId,
      validFrom: options.validFrom ?? new Date(Date.now() - 60_000),
    });
  }
  return {
    principal: {
      displayName: "Synthetic Authorization User",
      email: `${userId}@example.invalid`,
      id: userId,
      role: role === "service" ? "advisor" : role,
    },
    studentId,
  };
}

beforeAll(async () => {
  client = createDatabaseClient(parseDatabaseConfig());
  await runMigrations(client);
});

afterAll(async () => {
  await client?.close();
});

describe("credential authentication", () => {
  it("accepts only an active interactive account with the correct Argon2id password", async () => {
    await withRollback(async (database) => {
      const password = "Synthetic-Login-2026!";
      const passwordHash = await hashPassword(password);
      const fixture = await createFixture(database, { passwordHash });

      await expect(
        authenticateCredentials(database, {
          email: fixture.principal.email.toUpperCase(),
          password,
        }),
      ).resolves.toEqual(fixture.principal);
      await expect(
        authenticateCredentials(database, {
          email: fixture.principal.email,
          password: "Wrong-Synthetic-2026!",
        }),
      ).resolves.toBeNull();

      const events = await database
        .select({ result: auditEvents.result })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.actorUserId, fixture.principal.id),
            eq(auditEvents.action, "auth.login"),
          ),
        );
      expect(events.map((event) => event.result).sort()).toEqual(["allowed", "denied"]);
    });
  });

  it.each([
    ["inactive account", { active: false, role: "advisor" as const }],
    ["service account", { active: true, role: "service" as const }],
  ])("rejects an %s", async (_label, accountOptions) => {
    await withRollback(async (database) => {
      const password = "Synthetic-Login-2026!";
      const fixture = await createFixture(database, {
        ...accountOptions,
        passwordHash: await hashPassword(password),
      });
      await expect(
        authenticateCredentials(database, { email: fixture.principal.email, password }),
      ).resolves.toBeNull();
    });
  });

  it("does not allow a passwordless fixture or disclose an unknown account", async () => {
    await withRollback(async (database) => {
      const fixture = await createFixture(database);
      await expect(
        authenticateCredentials(database, {
          email: fixture.principal.email,
          password: "Any-Synthetic-2026!",
        }),
      ).resolves.toBeNull();
      await expect(
        authenticateCredentials(database, {
          email: `${randomUUID()}@example.invalid`,
          password: "Any-Synthetic-2026!",
        }),
      ).resolves.toBeNull();
    });
  });
});

describe("student authorization boundary", () => {
  it("creates a minimum-scope context and reads only the authorized student", async () => {
    await withRollback(async (database) => {
      const fixture = await createFixture(database);
      await database.insert(studentFacts).values({
        confirmationStatus: "confirmed",
        fieldKey: "synthetic_interest",
        sourceType: "advisor",
        studentId: fixture.studentId,
        value: { topic: "robotics" },
      });
      const context = await createStudentAuthorizationContext(database, fixture.principal, {
        action: "student:read",
        accessLevel: "sensitive",
        studentId: fixture.studentId,
      });

      expect(context.allowedActions).toEqual(["student:read"]);
      const overview = await readStudentOverview(database, context);
      expect(overview.id).toBe(fixture.studentId);
      expect(overview.facts).toHaveLength(1);
      expect(overview.facts[0]?.value).toEqual({ topic: "robotics" });
    });
  });

  it("lists only students with a current readable grant and sufficient level", async () => {
    await withRollback(async (database) => {
      const fixture = await createFixture(database);
      const noGrant = await createFixture(database, { withGrant: false });
      await database.insert(studentAuthorizations).values({
        allowedActions: ["student:read"],
        grantedByUserId: noGrant.principal.id,
        maxAccessLevel: "sensitive",
        studentId: noGrant.studentId,
        userId: fixture.principal.id,
      });
      const context = await createStudentDirectoryContext(database, fixture.principal);
      const students_ = await listAuthorizedStudents(database, context);

      expect(students_.map((student) => student.id).sort()).toEqual(
        [fixture.studentId, noGrant.studentId].sort(),
      );
      const otherPrincipalContext = await createStudentDirectoryContext(
        database,
        noGrant.principal,
      );
      await expect(listAuthorizedStudents(database, otherPrincipalContext)).resolves.toEqual([]);
    });
  });

  it("denies owners and administrators without an explicit grant", async () => {
    await withRollback(async (database) => {
      const owner = await createFixture(database, { withGrant: false });
      await expect(
        createStudentAuthorizationContext(database, owner.principal, {
          action: "student:read",
          accessLevel: "sensitive",
          studentId: owner.studentId,
        }),
      ).rejects.toBeInstanceOf(AuthorizationDeniedError);

      const administrator = await createFixture(database, { role: "admin", withGrant: false });
      await expect(
        createStudentAuthorizationContext(database, administrator.principal, {
          action: "student:read",
          accessLevel: "sensitive",
          studentId: administrator.studentId,
        }),
      ).rejects.toBeInstanceOf(AuthorizationDeniedError);
    });
  });

  it.each([
    [
      "wrong action",
      {
        allowedActions: ["student:write"] as StudentAction[],
        maxAccessLevel: "sensitive" as const,
      },
    ],
    [
      "insufficient access level",
      { allowedActions: ["student:read"] as StudentAction[], maxAccessLevel: "internal" as const },
    ],
  ])("denies a grant with %s", async (_label, grantOptions) => {
    await withRollback(async (database) => {
      const fixture = await createFixture(database, grantOptions);
      await expect(
        createStudentAuthorizationContext(database, fixture.principal, {
          action: "student:read",
          accessLevel: "sensitive",
          studentId: fixture.studentId,
        }),
      ).rejects.toBeInstanceOf(AuthorizationDeniedError);
    });
  });

  it("denies expired and not-yet-valid grants", async () => {
    await withRollback(async (database) => {
      const now = new Date("2026-08-02T12:00:00.000Z");
      const expired = await createFixture(database, {
        expiresAt: new Date("2026-08-02T11:00:00.000Z"),
        validFrom: new Date("2026-08-02T10:00:00.000Z"),
      });
      const future = await createFixture(database, {
        validFrom: new Date("2026-08-02T13:00:00.000Z"),
      });
      for (const fixture of [expired, future]) {
        await expect(
          createStudentAuthorizationContext(database, fixture.principal, {
            action: "student:read",
            accessLevel: "sensitive",
            now,
            studentId: fixture.studentId,
          }),
        ).rejects.toBeInstanceOf(AuthorizationDeniedError);
      }
    });
  });

  it("rejects cross-student and context-hash parameter tampering", async () => {
    await withRollback(async (database) => {
      const first = await createFixture(database);
      const second = await createFixture(database);
      const context = await createStudentAuthorizationContext(database, first.principal, {
        action: "student:read",
        accessLevel: "sensitive",
        studentId: first.studentId,
      });

      await expect(
        readStudentOverview(database, { ...context, studentId: second.studentId }),
      ).rejects.toBeInstanceOf(AuthorizationDeniedError);
      await expect(
        loadAuthorizationContext(database, {
          contextHash: "0".repeat(64),
          id: context.id,
        }),
      ).rejects.toBeInstanceOf(AuthorizationDeniedError);
    });
  });

  it("invalidates an existing context when its current grant is revoked", async () => {
    await withRollback(async (database) => {
      const fixture = await createFixture(database);
      const context = await createStudentAuthorizationContext(database, fixture.principal, {
        action: "student:read",
        accessLevel: "sensitive",
        studentId: fixture.studentId,
      });
      await database
        .delete(studentAuthorizations)
        .where(
          and(
            eq(studentAuthorizations.userId, fixture.principal.id),
            eq(studentAuthorizations.studentId, fixture.studentId),
          ),
        );

      await expect(readStudentOverview(database, context)).rejects.toBeInstanceOf(
        AuthorizationDeniedError,
      );
    });
  });

  it("invalidates an existing context when the student privacy level exceeds the grant", async () => {
    await withRollback(async (database) => {
      const fixture = await createFixture(database);
      const context = await createStudentAuthorizationContext(database, fixture.principal, {
        action: "student:read",
        accessLevel: "sensitive",
        studentId: fixture.studentId,
      });
      await database
        .update(students)
        .set({ privacyLevel: "restricted" })
        .where(eq(students.id, fixture.studentId));

      await expect(readStudentOverview(database, context)).rejects.toBeInstanceOf(
        AuthorizationDeniedError,
      );
    });
  });
});

describe("initial administrator bootstrap", () => {
  it("creates exactly one password account even when passwordless fixtures exist", async () => {
    await withRollback(async (database) => {
      await database.update(appUsers).set({ passwordHash: null });
      const administrator = await createInitialAdmin(database, {
        displayName: "Synthetic Initial Admin",
        email: `${randomUUID()}@example.invalid`,
        password: "Synthetic-Admin-2026!",
      });
      expect(administrator.id).toMatch(/^[0-9a-f-]{36}$/u);
      await expect(
        createInitialAdmin(database, {
          displayName: "Second Synthetic Admin",
          email: `${randomUUID()}@example.invalid`,
          password: "Synthetic-Admin-2026!",
        }),
      ).rejects.toBeInstanceOf(InitialAdminAlreadyExistsError);
    });
  });
});
