export type KnowledgeSourceErrorCode =
  | "duplicate_source"
  | "invalid_analysis"
  | "invalid_configuration"
  | "invalid_source"
  | "missing_source"
  | "source_set_mismatch"
  | "unexpected_source";

export class KnowledgeSourceError extends Error {
  public readonly code: KnowledgeSourceErrorCode;

  public constructor(code: KnowledgeSourceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "KnowledgeSourceError";
    this.code = code;
  }
}
