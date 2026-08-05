import "server-only";

import { authenticateCredentials } from "@culiu/authorization";

import { createAuthOptions } from "./auth-options-factory";
import { getDatabaseClient } from "./database";

export const authOptions = createAuthOptions(
  {
    authenticate: async (credentials, requestCorrelationId) =>
      authenticateCredentials(getDatabaseClient().database, credentials, { requestCorrelationId }),
  },
  {
    ...process.env,
    CULIU_AUTH_COOKIE_NAME:
      process.env.OPERATIONS_AUTH_COOKIE_NAME ?? "culiu-operations.session-token",
    NEXTAUTH_SECRET: process.env.OPERATIONS_NEXTAUTH_SECRET ?? process.env.NEXTAUTH_SECRET,
    NEXTAUTH_URL: process.env.OPERATIONS_NEXTAUTH_URL ?? process.env.NEXTAUTH_URL,
  },
);
