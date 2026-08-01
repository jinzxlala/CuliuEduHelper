import { REDACTED_FIXTURE_IDS } from "@culiu/database";
import { describe, expect, it } from "vitest";

import { resolveKnowledgeImportAuthorization } from "./import-authorization.js";

describe("resolveKnowledgeImportAuthorization", () => {
  it("accepts an explicit frozen authorization context", () => {
    const contextId = "12345678-1234-4123-8123-123456789abc";
    const contextHash = "a".repeat(64);
    expect(
      resolveKnowledgeImportAuthorization({
        KNOWLEDGE_IMPORT_AUTHORIZATION_CONTEXT_HASH: contextHash,
        KNOWLEDGE_IMPORT_AUTHORIZATION_CONTEXT_ID: contextId,
      }),
    ).toEqual({ contextHash, contextId });
  });

  it("allows the redacted fixture only after explicit local opt-in", () => {
    expect(
      resolveKnowledgeImportAuthorization({
        KNOWLEDGE_ALLOW_REDACTED_FIXTURE_AUTH: "true",
        NODE_ENV: "development",
      }),
    ).toEqual({
      contextHash: "d".repeat(64),
      contextId: REDACTED_FIXTURE_IDS.knowledgeAuthorizationContext,
    });
  });

  it("rejects redacted fixture authorization in production", () => {
    expect(() =>
      resolveKnowledgeImportAuthorization({
        KNOWLEDGE_ALLOW_REDACTED_FIXTURE_AUTH: "true",
        NODE_ENV: "production",
      }),
    ).toThrow("allowed only in development or test");
  });

  it("rejects fixture opt-in when NODE_ENV is missing", () => {
    expect(() =>
      resolveKnowledgeImportAuthorization({
        KNOWLEDGE_ALLOW_REDACTED_FIXTURE_AUTH: "true",
      }),
    ).toThrow("allowed only in development or test");
  });

  it("rejects known fixture values supplied as explicit production configuration", () => {
    expect(() =>
      resolveKnowledgeImportAuthorization({
        KNOWLEDGE_IMPORT_AUTHORIZATION_CONTEXT_HASH: "d".repeat(64),
        KNOWLEDGE_IMPORT_AUTHORIZATION_CONTEXT_ID:
          REDACTED_FIXTURE_IDS.knowledgeAuthorizationContext,
        NODE_ENV: "production",
      }),
    ).toThrow("must use the explicit local-development opt-in");
  });

  it("fails closed when no authorization is configured", () => {
    expect(() => resolveKnowledgeImportAuthorization({})).toThrow(
      "Knowledge import authorization is not configured",
    );
  });
});
