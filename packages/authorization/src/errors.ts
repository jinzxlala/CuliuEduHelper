export class AuthorizationDeniedError extends Error {
  readonly code = "AUTHORIZATION_DENIED";

  constructor() {
    super("The requested operation is not authorized.");
    this.name = "AuthorizationDeniedError";
  }
}

export class InitialAdminAlreadyExistsError extends Error {
  readonly code = "INITIAL_ADMIN_ALREADY_EXISTS";

  constructor() {
    super("An interactive password account already exists; initial bootstrap is disabled.");
    this.name = "InitialAdminAlreadyExistsError";
  }
}
