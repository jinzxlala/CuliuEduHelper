import { and, isNotNull, ne, sql } from "drizzle-orm";
import { appUsers, type Database } from "@culiu/database/runtime";

import {
  InitialAdminInputSchema,
  type InitialAdminInput,
  SessionPrincipalSchema,
} from "./contracts.js";
import { InitialAdminAlreadyExistsError } from "./errors.js";
import { hashPassword } from "./password.js";

const INITIAL_ADMIN_LOCK_KEY = 1_923_548_701;

export async function createInitialAdmin(
  database: Database,
  input: InitialAdminInput,
): Promise<{ id: string }> {
  const parsed = InitialAdminInputSchema.parse(input);
  const passwordHash = await hashPassword(parsed.password);

  return database.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(${INITIAL_ADMIN_LOCK_KEY})`);
    const existing = await transaction
      .select({ id: appUsers.id })
      .from(appUsers)
      .where(and(isNotNull(appUsers.passwordHash), ne(appUsers.role, "service")))
      .limit(1);
    if (existing.length > 0) {
      throw new InitialAdminAlreadyExistsError();
    }

    const rows = await transaction
      .insert(appUsers)
      .values({
        displayName: parsed.displayName,
        email: parsed.email,
        passwordHash,
        role: "admin",
      })
      .returning({ id: appUsers.id });
    const account = rows[0];
    if (account === undefined) {
      throw new Error("Initial administrator creation returned no account.");
    }

    SessionPrincipalSchema.parse({
      displayName: parsed.displayName,
      email: parsed.email,
      id: account.id,
      role: "admin",
    });
    return account;
  });
}
