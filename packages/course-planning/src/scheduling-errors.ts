export class SchedulingAuthorizationError extends Error {
  constructor() {
    super("Scheduling administration is restricted to administrators.");
    this.name = "SchedulingAuthorizationError";
  }
}

export class SchedulingNotFoundError extends Error {
  constructor() {
    super("Scheduling resource was not found.");
    this.name = "SchedulingNotFoundError";
  }
}

export class SchedulingConflictError extends Error {
  constructor(message = "Scheduling resource changed; reload and retry.") {
    super(message);
    this.name = "SchedulingConflictError";
  }
}
