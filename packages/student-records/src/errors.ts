export class StudentRecordConflictError extends Error {
  public constructor(message = "The student record conflicts with its current version.") {
    super(message);
    this.name = "StudentRecordConflictError";
  }
}

export class StudentRecordNotFoundError extends Error {
  public constructor() {
    super("The requested student record was not found.");
    this.name = "StudentRecordNotFoundError";
  }
}
