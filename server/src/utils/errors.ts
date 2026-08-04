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
   * A capture arrived with no usable origin class.
   *
   * 422, not 400, and its own code rather than VALIDATION_ERROR. The request is
   * well-formed; what it lacks is provenance, and provenance is the one thing
   * this system refuses to infer. Origin class decides where a record sits on
   * the trust ladder, so defaulting it would write a claim nobody made —
   * USER_PROVIDED promotes untrusted data, UNKNOWN_QUARANTINED looks cautious
   * while still fabricating the fact. A caller who guessed a value needs to be
   * told the guess is not acceptable, not that their syntax is off.
   */
  ORIGIN_CLASS_REQUIRED: 'ORIGIN_CLASS_REQUIRED',
  /**
   * A browser capture arrived without the operator confirming the preview.
   *
   * 422, not 400: the payload is well-formed and the refusal is about consent.
   * A capture the operator never saw and approved is exactly the background
   * harvesting this feature exists to make impossible, so the endpoint refuses
   * it rather than trusting the client to have asked.
   */
  CONFIRMATION_REQUIRED: 'CONFIRMATION_REQUIRED',
  /**
   * A payload carried something that must never leave the page.
   *
   * Cookies, tokens, passwords, hidden inputs. REJECTED rather than stripped —
   * stripping would accept the request and silently discard the one piece of
   * evidence that a client is reading what it must not. A guardrail that
   * quietly cleans up after a misbehaving client cannot tell you it is
   * misbehaving.
   */
  FORBIDDEN_FIELD: 'FORBIDDEN_FIELD',
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
  /**
   * A research source outside the permitted registry was requested.
   *
   * 422, not 400: the payload is well-formed and the refusal is about policy.
   * REFUSED rather than skipped — a silently dropped source produces a proposal
   * that looks fully researched while missing exactly the thing the rep would
   * have wanted to know, and the draft gives no sign either way.
   */
  RESEARCH_SOURCE_NOT_PERMITTED: 'RESEARCH_SOURCE_NOT_PERMITTED',
  /**
   * A draft said something the approved offer does not support.
   *
   * A roadmap date, an unapproved discount, a promised result, a price outside
   * the approved offer version. REJECTED rather than quietly edited: a silently
   * corrected draft teaches nobody that the generator is producing unusable
   * copy, and the next one will do it again.
   */
  OFFER_TRUTH_VIOLATION: 'OFFER_TRUTH_VIOLATION',
  /**
   * Call content was requested without a verified recording consent basis.
   *
   * 422 when registering a call without one, 403 when reading a scorecard —
   * the first is a malformed intent the caller can fix, the second is a refusal
   * to act on data we hold.
   *
   * Failing closed is right HERE and is not a general rule. Where a policy is
   * merely unreachable, denying invents a restriction nobody wrote (see the
   * capture domain policy, which needed an explicit configured id for exactly
   * that reason). Here the restriction IS written — the SOP requires
   * recording-consent rules to be followed — so an unverifiable basis means
   * processing must not proceed. A revocation we cannot see is precisely the
   * case this protects against.
   */
  RECORDING_CONSENT_MISSING: 'RECORDING_CONSENT_MISSING',
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
