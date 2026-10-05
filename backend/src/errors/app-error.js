export class AppError extends Error {
  statusCode;
  code;
  constructor(message, statusCode, code) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.name = new.target.name;
  }
}
export class NotFoundError extends AppError {
  constructor(resource) {
    super(`${resource} was not found`, 404, "NOT_FOUND");
  }
}
export class ConflictError extends AppError {
  constructor(message, code = "CONFLICT") {
    super(message, 409, code);
  }
}
/** A dependency OrchestrOS needs is present in the design but not reachable now. */
export class ServiceUnavailableError extends AppError {
  constructor(message, code = "SERVICE_UNAVAILABLE") {
    super(message, 503, code);
  }
}
