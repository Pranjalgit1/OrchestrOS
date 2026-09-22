export class AppError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(`${resource} was not found`, 404, "NOT_FOUND");
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code = "CONFLICT") {
    super(message, 409, code);
  }
}

/** A dependency OrchestrOS needs is present in the design but not reachable now. */
export class ServiceUnavailableError extends AppError {
  constructor(message: string, code = "SERVICE_UNAVAILABLE") {
    super(message, 503, code);
  }
}
