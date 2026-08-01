import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { appUsers, auditEvents, type Database } from "@culiu/database/runtime";
import { z } from "zod";

import {
  CredentialInputSchema,
  InteractiveUserRoleSchema,
  SessionPrincipalSchema,
  type CredentialInput,
  type SessionPrincipal,
} from "./contracts.js";
import { getDummyPasswordHash, verifyPassword } from "./password.js";

export async function getActiveInteractivePrincipal(
  database: Database,
  actorUserId: string,
): Promise<SessionPrincipal | null> {
  const parsedActorUserId = z.uuid().safeParse(actorUserId);
  if (!parsedActorUserId.success) {
    return null;
  }
  const rows = await database
    .select({
      displayName: appUsers.displayName,
      email: appUsers.email,
      id: appUsers.id,
      role: appUsers.role,
    })
    .from(appUsers)
    .where(and(eq(appUsers.id, parsedActorUserId.data), eq(appUsers.active, true)))
    .limit(1);
  const account = rows[0];
  if (account === undefined || !InteractiveUserRoleSchema.safeParse(account.role).success) {
    return null;
  }
  return SessionPrincipalSchema.parse(account);
}

export async function authenticateCredentials(
  database: Database,
  input: CredentialInput,
  options: { requestCorrelationId?: string } = {},
): Promise<SessionPrincipal | null> {
  const parsed = CredentialInputSchema.safeParse(input);
  const dummyHash = await getDummyPasswordHash();
  const requestCorrelationId = options.requestCorrelationId ?? randomUUID();

  if (!parsed.success) {
    await recordLoginAudit(database, {
      accountId: null,
      requestCorrelationId,
      result: "denied",
    });
    return null;
  }

  const rows = await database
    .select({
      active: appUsers.active,
      displayName: appUsers.displayName,
      email: appUsers.email,
      id: appUsers.id,
      passwordHash: appUsers.passwordHash,
      role: appUsers.role,
    })
    .from(appUsers)
    .where(eq(sql<string>`lower(${appUsers.email})`, parsed.data.email))
    .limit(1);
  const account = rows[0];
  const passwordMatches = await verifyPassword(
    account?.passwordHash ?? dummyHash,
    parsed.data.password,
  );
  const role = InteractiveUserRoleSchema.safeParse(account?.role);
  const accepted =
    account !== undefined &&
    account.active &&
    account.passwordHash !== null &&
    role.success &&
    passwordMatches;

  await recordLoginAudit(database, {
    accountId: account?.id ?? null,
    requestCorrelationId,
    result: accepted ? "allowed" : "denied",
  });

  if (!accepted) {
    return null;
  }

  return SessionPrincipalSchema.parse({
    displayName: account.displayName,
    email: account.email,
    id: account.id,
    role: role.data,
  });
}

async function recordLoginAudit(
  database: Database,
  input: { accountId: string | null; requestCorrelationId: string; result: "allowed" | "denied" },
): Promise<void> {
  await database.insert(auditEvents).values({
    action: "auth.login",
    actorType: input.accountId === null ? "service" : "user",
    actorUserId: input.accountId,
    details: {},
    objectId: "interactive-session",
    objectType: "authentication",
    requestCorrelationId: input.requestCorrelationId,
    result: input.result,
  });
}
