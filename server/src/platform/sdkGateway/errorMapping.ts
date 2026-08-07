import { AppError, ErrorCodes, type ErrorCode } from '../../utils/errors';

/**
 * Mapping an upstream failure to a LeadFlow error code.
 *
 * The point is to stop every gateway failure arriving at the client as one
 * undifferentiated 502 UPSTREAM_UNAVAILABLE, which is what happened before: a
 * validation error we caused, a permission we lack, and an SDK that is actually
 * down all rendered as "ProjexCloud is unavailable". An operator reading that
 * cannot tell which of the three it is, and only one of them is worth paging
 * anybody about.
 */

/** Status the caller should see, and the code that goes with it. */
export interface MappedError {
  status: number;
  code: ErrorCode;
  message: string;
  /** True when this is our fault rather than the SDK's — see below. */
  callerFault: boolean;
  /**
   * What the GATEWAY answered, as distinct from what we return.
   *
   * Carried structurally because callers legitimately need it and the only other
   * way to get it was to regex the message prose. Two provisioners did exactly
   * that — `/returned (409|422)\b/` — to recognise "this already exists, carry
   * on". Rewording an error message then silently turned a benign duplicate into
   * a logged failure on every boot, with nothing failing to say so. A field
   * cannot rot that way; a sentence can.
   */
  upstreamStatus: number | null;
}

/** The shape put on AppError.details, so callers branch on data not prose. */
export interface UpstreamErrorDetails {
  sdk: string;
  upstreamStatus: number | null;
  callerFault: boolean;
}

/**
 * Reads the upstream status back off an error, whatever it is.
 *
 * Returns null when the error did not come from the gateway, so a caller asking
 * "was this a 409?" gets "no" rather than a crash.
 */
export function upstreamStatusOf(error: unknown): number | null {
  if (!(error instanceof AppError)) return null;
  const details = error.details as UpstreamErrorDetails | undefined;
  return details && typeof details.upstreamStatus === 'number' ? details.upstreamStatus : null;
}

/**
 * A 404 is two completely different events wearing the same number.
 *
 * `Route GET:/api/consents/purposes not found` is a MISCONFIGURATION — the path
 * is wrong, or the SDK is not mounted in this environment. Reporting it as
 * NOT_FOUND tells the caller "no such record", and they render an empty state
 * for data that exists. This is not hypothetical: every ProjexCloud call this
 * app made once 404'd on a bad path prefix and was swallowed by degrade-to-local
 * fallbacks, which is exactly why nobody noticed for months.
 *
 * A resource 404 is a genuine NOT_FOUND and must stay one.
 */
function isRouteNotFound(detail: string | null): boolean {
  if (!detail) return false;
  return /route\s+[A-Z]+:.*not found/i.test(detail) || /cannot (GET|POST|PUT|PATCH|DELETE)/i.test(detail);
}

export function mapUpstreamStatus(
  sdk: string,
  status: number | null,
  detail: string | null,
): MappedError {
  const suffix = detail ? `: ${detail}` : '';

  if (status === null) {
    return {
      status: 502,
      code: ErrorCodes.UPSTREAM_UNAVAILABLE,
      message: `ProjexCloud ${sdk} did not respond${suffix}`,
      callerFault: false,
      upstreamStatus: status,
    };
  }

  if (status === 400 || status === 422) {
    // Surfaced as 400, not 502. The payload we sent is wrong; calling that an
    // upstream outage sends an on-call engineer to look at a healthy service.
    return {
      status: 400,
      code: ErrorCodes.VALIDATION_ERROR,
      message: `ProjexCloud ${sdk} rejected the request${suffix}`,
      callerFault: true,
      upstreamStatus: status,
    };
  }

  if (status === 401) {
    // 502, deliberately. LeadFlow's credential is wrong or expired — that is an
    // operational fault on our side, and returning 401 to the end user would
    // tell them THEIR session is bad and send them to log in again, which fixes
    // nothing and loses their work.
    return {
      status: 502,
      code: ErrorCodes.UPSTREAM_UNAVAILABLE,
      message: `ProjexCloud ${sdk} rejected the LeadFlow credential${suffix}`,
      callerFault: false,
      upstreamStatus: status,
    };
  }

  if (status === 403) {
    return {
      status: 403,
      code: ErrorCodes.FORBIDDEN,
      message: `ProjexCloud ${sdk} refused the operation${suffix}`,
      callerFault: true,
      upstreamStatus: status,
    };
  }

  if (status === 404) {
    return isRouteNotFound(detail)
      ? {
          status: 502,
          code: ErrorCodes.UPSTREAM_UNAVAILABLE,
          message: `ProjexCloud ${sdk} has no such route — check the path or whether the SDK is mounted${suffix}`,
          callerFault: false,
          upstreamStatus: status,
        }
      : {
          status: 404,
          code: ErrorCodes.NOT_FOUND,
          message: `ProjexCloud ${sdk} has no such record${suffix}`,
          callerFault: true,
          upstreamStatus: status,
        };
  }

  if (status === 409) {
    return {
      status: 409,
      code: ErrorCodes.CONFLICT,
      message: `ProjexCloud ${sdk} reported a conflict${suffix}`,
      callerFault: true,
      upstreamStatus: status,
    };
  }

  if (status === 429) {
    return {
      status: 429,
      code: ErrorCodes.RATE_LIMITED,
      message: `ProjexCloud ${sdk} is rate limiting${suffix}`,
      callerFault: false,
      upstreamStatus: status,
    };
  }

  return {
    status: 502,
    code: ErrorCodes.UPSTREAM_UNAVAILABLE,
    message: `ProjexCloud ${sdk} returned ${status}${suffix}`,
    callerFault: status < 500,
    upstreamStatus: status,
  };
}

export function toAppError(mapped: MappedError, sdk: string): AppError {
  // The details ride along so callers branch on `upstreamStatus` rather than on
  // the wording of `message`. See MappedError.upstreamStatus for what that cost
  // the last time it was prose.
  const details: UpstreamErrorDetails = {
    sdk,
    upstreamStatus: mapped.upstreamStatus,
    callerFault: mapped.callerFault,
  };
  return new AppError(mapped.status, mapped.code, mapped.message, details);
}

/** Longest an upstream reason may be before it stops being a log line. */
const MAX_DETAIL_LENGTH = 500;

/**
 * Pulls the human-readable reason out of a gateway error body.
 *
 * The gateway is not uniform, so this reads the shapes it actually emits rather
 * than one canonical envelope:
 *
 *   { error: 'ValidationError', details: ['...'] }   <- the registry routes
 *   { error: 'InternalError' }                       <- catch-all handlers
 *   { error: { code, message } } / { message }       <- AppError-style SDKs
 *
 * Falls back to the raw text so an unrecognised shape still says something.
 */
export function extractUpstreamDetail(data: unknown, rawText: string): string | null {
  const clamp = (value: string): string | null => {
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.length > MAX_DETAIL_LENGTH ? `${trimmed.slice(0, MAX_DETAIL_LENGTH)}…` : trimmed;
  };

  if (data && typeof data === 'object') {
    const body = data as Record<string, unknown>;

    // `details` first: it is the specific reason, where `error` is only the
    // class of failure ('ValidationError' alone tells a caller nothing).
    if (Array.isArray(body.details)) {
      const joined = body.details.filter((d) => typeof d === 'string').join('; ');
      if (joined) return clamp(joined);
    }
    if (typeof body.message === 'string') return clamp(body.message);
    if (typeof body.error === 'string') return clamp(body.error);
    if (body.error && typeof body.error === 'object') {
      const nested = body.error as Record<string, unknown>;
      if (typeof nested.message === 'string') return clamp(nested.message);
      if (typeof nested.code === 'string') return clamp(nested.code);
    }
  }

  // Unparseable or unrecognised — the raw text beats nothing, clamped because an
  // HTML error page would otherwise land whole in the log.
  return clamp(rawText);
}
