/**
 * The single LeadFlow error-code vocabulary.
 *
 * One condition maps to exactly one SCREAMING_SNAKE_CASE code across the whole
 * project. Handlers return the code in the response body so clients can branch
 * on it; api_definitions reference the same constants in `errorCases`.
 *
 * Before adding a code here, check whether an existing one already names the
 * condition — do not ship both ADMIN_REQUIRED and NOT_ADMIN.
 */
export const ErrorCodes = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  EMAIL_ALREADY_EXISTS: 'EMAIL_ALREADY_EXISTS',
  USERNAME_ALREADY_EXISTS: 'USERNAME_ALREADY_EXISTS',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  ACCOUNT_INACTIVE: 'ACCOUNT_INACTIVE',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_TOKEN: 'INVALID_TOKEN',
  FORBIDDEN: 'FORBIDDEN',
  /**
   * The caller MAY take this action, but not alone — a second party must sign
   * off first.
   *
   * Distinct from FORBIDDEN, and the distinction is the entire reason the policy
   * model has three effects rather than two. SOP §28's wording is "cannot do
   * without approval", which is an escalation path, not a prohibition. A client
   * that reads this as FORBIDDEN tells the user they may not do something they
   * may in fact do, and people who are told that reliably find a way around the
   * product instead of through it.
   */
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  UPSTREAM_UNAVAILABLE: 'UPSTREAM_UNAVAILABLE',
  /**
   * The route exists but this deployment does not provide it — currently only
   * local password auth, once ProjexCloud is the identity authority.
   *
   * Distinct from FORBIDDEN, which says the CALLER may not do it: retrying with
   * a better credential fixes a 403 and can never fix this. Distinct from
   * NOT_FOUND, which would tell a client the endpoint does not exist when the
   * useful answer is that it exists and authentication happens elsewhere.
   */
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/**
 * An error that carries the HTTP status and the machine-readable code the
 * client should branch on. Anything thrown that is not an AppError is treated
 * as INTERNAL_ERROR by the error handler and never leaks its message.
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: ErrorCode;
  public readonly details?: unknown;

  constructor(statusCode: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, AppError.prototype);
  }

  static badRequest(message: string, details?: unknown): AppError {
    return new AppError(400, ErrorCodes.VALIDATION_ERROR, message, details);
  }

  static unauthenticated(message = 'Authentication required'): AppError {
    return new AppError(401, ErrorCodes.UNAUTHENTICATED, message);
  }

  static invalidToken(message = 'Session token is invalid or expired'): AppError {
    return new AppError(401, ErrorCodes.INVALID_TOKEN, message);
  }

  static invalidCredentials(message = 'Email or password is incorrect'): AppError {
    return new AppError(401, ErrorCodes.INVALID_CREDENTIALS, message);
  }

  static forbidden(message = 'You do not have permission to perform this action'): AppError {
    return new AppError(403, ErrorCodes.FORBIDDEN, message);
  }

  static notFound(message = 'Resource not found'): AppError {
    return new AppError(404, ErrorCodes.NOT_FOUND, message);
  }

  static conflict(code: ErrorCode, message: string): AppError {
    return new AppError(409, code, message);
  }
}
