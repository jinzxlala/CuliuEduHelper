export class CourseCatalogAuthorizationError extends Error {
  public constructor() {
    super("The current account is not authorized for this course catalog operation.");
    this.name = "CourseCatalogAuthorizationError";
  }
}

export class CourseCatalogConflictError extends Error {
  public constructor(message = "The course catalog conflicts with its current version.") {
    super(message);
    this.name = "CourseCatalogConflictError";
  }
}

export class CourseCatalogNotFoundError extends Error {
  public constructor() {
    super("The requested course catalog record was not found.");
    this.name = "CourseCatalogNotFoundError";
  }
}

export class CourseRuleConfigurationError extends Error {
  public readonly issues: readonly string[];

  public constructor(issues: readonly string[]) {
    super("The approved course rule set is internally inconsistent.");
    this.name = "CourseRuleConfigurationError";
    this.issues = [...issues];
  }
}
