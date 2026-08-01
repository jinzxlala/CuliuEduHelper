export class ProfileDraftConflictError extends Error {
  override readonly name = "ProfileDraftConflictError";
}

export class ProfileDraftInputError extends Error {
  override readonly name = "ProfileDraftInputError";
}

export class ProfileDraftNotFoundError extends Error {
  override readonly name = "ProfileDraftNotFoundError";
}

export class ProfileDraftProcessingError extends Error {
  readonly code: string;
  override readonly name = "ProfileDraftProcessingError";

  constructor(code: string) {
    super("Profile draft processing failed.");
    this.code = code;
  }
}

export class ProfileWorkflowConflictError extends Error {
  override readonly name = "ProfileWorkflowConflictError";
}

export class ProfileWorkflowNotFoundError extends Error {
  override readonly name = "ProfileWorkflowNotFoundError";
}
