import { REDACTED_FIXTURE_IDS } from "@culiu/database";
import { AuthorizationSnapshotReferenceSchema } from "@culiu/tasks";

export interface KnowledgeImportAuthorization {
  readonly contextHash: string;
  readonly contextId: string;
}

export function resolveKnowledgeImportAuthorization(
  environment: NodeJS.ProcessEnv = process.env,
): KnowledgeImportAuthorization {
  const contextId = environment.KNOWLEDGE_IMPORT_AUTHORIZATION_CONTEXT_ID?.trim();
  const contextHash = environment.KNOWLEDGE_IMPORT_AUTHORIZATION_CONTEXT_HASH?.trim();

  if (contextId !== undefined || contextHash !== undefined) {
    const explicit = AuthorizationSnapshotReferenceSchema.parse({ contextHash, contextId });
    if (
      explicit.contextId === REDACTED_FIXTURE_IDS.knowledgeAuthorizationContext ||
      explicit.contextHash === "d".repeat(64)
    ) {
      throw new Error(
        "Redacted fixture authorization must use the explicit local-development opt-in.",
      );
    }
    return explicit;
  }

  if (environment.KNOWLEDGE_ALLOW_REDACTED_FIXTURE_AUTH === "true") {
    if (!["development", "test"].includes(environment.NODE_ENV ?? "")) {
      throw new Error("Redacted fixture authorization is allowed only in development or test.");
    }
    return {
      contextHash: "d".repeat(64),
      contextId: REDACTED_FIXTURE_IDS.knowledgeAuthorizationContext,
    };
  }

  throw new Error(
    "Knowledge import authorization is not configured. Provide a frozen context ID/hash, or explicitly enable the redacted fixture for local development.",
  );
}
