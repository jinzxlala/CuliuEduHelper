import "server-only";

import { getActiveInteractivePrincipal, type SessionPrincipal } from "@culiu/authorization";
import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";

import { authOptions } from "./auth-options";
import { getDatabaseClient } from "./database";

export async function getActiveSessionPrincipal(): Promise<SessionPrincipal | null> {
  const session = await getServerSession(authOptions);
  if (session?.user.id === undefined) {
    return null;
  }
  return getActiveInteractivePrincipal(getDatabaseClient().database, session.user.id);
}

export async function requireActiveSessionPrincipal(): Promise<SessionPrincipal> {
  const principal = await getActiveSessionPrincipal();
  if (principal === null) {
    redirect("/login");
  }
  return principal;
}
