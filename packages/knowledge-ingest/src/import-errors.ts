import type { SourceRole } from "./contracts.js";

export type KnowledgeImportStage =
  | "authorization"
  | "validation"
  | "storage"
  | "database"
  | "search"
  | "finalize"
  | "complete";

export type KnowledgeImportErrorCode =
  | "authorization_denied"
  | "database_failed"
  | "manifest_identity_mismatch"
  | "search_publication_failed"
  | "source_integrity_failed"
  | "source_read_failed"
  | "storage_failed"
  | "unexpected_import_failure";

export interface KnowledgeImportErrorOptions extends ErrorOptions {
  readonly sourceKey?: string;
  readonly sourceRole?: SourceRole;
}

export class KnowledgeImportError extends Error {
  public readonly code: KnowledgeImportErrorCode;
  public readonly sourceKey: string | undefined;
  public readonly sourceRole: SourceRole | undefined;
  public readonly stage: KnowledgeImportStage;

  public constructor(
    code: KnowledgeImportErrorCode,
    stage: KnowledgeImportStage,
    message: string,
    options: KnowledgeImportErrorOptions = {},
  ) {
    super(message, options);
    this.name = "KnowledgeImportError";
    this.code = code;
    this.stage = stage;
    this.sourceKey = options.sourceKey;
    this.sourceRole = options.sourceRole;
  }
}

export interface SafeImportFailure {
  readonly code: KnowledgeImportErrorCode;
  readonly sourceKey?: string;
  readonly sourceRole?: SourceRole;
  readonly stage: KnowledgeImportStage;
  readonly summary: string;
}

function safeSummary(message: string): string {
  return message
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 2_048);
}

export function describeImportFailure(
  error: unknown,
  fallbackStage: KnowledgeImportStage,
): SafeImportFailure {
  if (error instanceof KnowledgeImportError) {
    return {
      code: error.code,
      stage: error.stage,
      summary: safeSummary(error.message),
      ...(error.sourceKey === undefined ? {} : { sourceKey: error.sourceKey }),
      ...(error.sourceRole === undefined ? {} : { sourceRole: error.sourceRole }),
    };
  }
  return {
    code: "unexpected_import_failure",
    stage: fallbackStage,
    summary: "Unexpected knowledge import failure.",
  };
}
