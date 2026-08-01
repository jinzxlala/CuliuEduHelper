import "server-only";

import { authenticateCredentials } from "@culiu/authorization";

import { createAuthOptions } from "./auth-options-factory";
import { getDatabaseClient } from "./database";

export const authOptions = createAuthOptions(
  {
    authenticate: async (credentials, requestCorrelationId) =>
      authenticateCredentials(getDatabaseClient().database, credentials, { requestCorrelationId }),
  },
  process.env,
);
