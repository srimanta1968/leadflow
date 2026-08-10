import { NextFunction, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../../config/env';
import { AppError } from '../../utils/errors';
import { ALLOWED_ALGORITHMS, JwksCache } from './jwksCache';
import { OidcDiscovery } from './oidcDiscovery';
import { PlatformRequest, toPlatformSession } from './sessionContext';
import { linkPlatformIdentity } from './identityLinkage';
import type { AuthenticatedRequest } from '../../middleware/auth';

/**
 * Paths that carry no session because they are how a caller GETS one, plus the
 * unauthenticated capture endpoint.
 *
 * Kept here beside the guard rather than in the app wiring: this is the list of
 * things reachable without proving who you are, and it should be readable in
 * one place next to the code that enforces the rest. Prefix-matched against the
 * path WITHIN the /api mount.
 *
 * `/auth` covers register, login and refresh — the auth-bootstrap exemption
 * MUST-52 names. `/public` is the single unauthenticated write, the web-form
 * capture a prospect submits with no account at all.
 */
const PUBLIC_PATH_PREFIXES = ['/auth', '/public'] as const;

/** True when this path is reachable without a session. */
function isPublicPath(path: string): boolean {
  return PUBLIC_PATH_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`)
  );
}

/** Pull the bearer token out of the Authorization header, or null. */
function readBearerToken(req: PlatformRequest): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return null;
  }
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

/** The `kid` from the token header, without trusting anything else in it. */
function readKeyId(token: string): string | null {
  // decode({complete:true}) parses WITHOUT verifying, which is only safe for
  // deciding WHICH KEY to verify with — the result is used for nothing else,
  // and a wrong guess simply fails the signature check a moment later.
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || typeof decoded === 'string') {
    return null;
  }
  const kid = decoded.header.kid;
  return typeof kid === 'string' && kid.length > 0 ? kid : null;
}

/**
 * Verify one bearer token against ProjexCloud and return its session.
 *
 * Exposed separately from the middleware so the verification rules can be
 * asserted directly, without standing up an Express app to reach them.
 *
 * @param token Raw JWT, without the `Bearer ` prefix.
 * @throws AppError(401 INVALID_TOKEN) when the token fails any check.
 * @throws AppError(502 UPSTREAM_UNAVAILABLE) when the issuer cannot be reached.
 */
export async function verifyPlatformToken(token: string) {
  const metadata = await OidcDiscovery.metadata();
  const key = await JwksCache.getKey(readKeyId(token), metadata.jwksUri);

  let claims: Record<string, unknown>;
  try {
    claims = jwt.verify(token, key, {
      // Every one of these is a rejection this middleware is required to make,
      // and each is passed EXPLICITLY rather than left to the library's
      // defaults, because the default for an option you did not pass is to not
      // check it at all.
      algorithms: [...ALLOWED_ALGORITHMS],
      issuer: metadata.issuer,
      audience: config.projexCloud.identity.audience,
      clockTolerance: config.projexCloud.identity.clockToleranceSec,
    }) as Record<string, unknown>;
  } catch (error) {
    // The reason is deliberately NOT echoed to the caller. "wrong audience"
    // and "expired" tell an attacker which knob to turn next; the log keeps it
    // for the operator who has to diagnose a genuine misconfiguration.
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[platformAuth] token rejected:', message);
    throw AppError.invalidToken();
  }

  const result = toPlatformSession(claims);
  if ('error' in result) {
    console.warn('[platformAuth] token verified but unusable:', result.error);
    throw AppError.invalidToken();
  }
  return result.session;
}

/**
 * Reject any request whose bearer token does not verify against ProjexCloud.
 *
 * Mounted BEFORE the routers, so a token that is expired, issued by the wrong
 * party, or minted for a different audience never reaches a handler — the
 * handler is not the place to discover the caller was not authenticated.
 *
 * LeadFlow holds no identity state of its own: no password, no session row, no
 * role table. This middleware is the entire trust decision, which is why it
 * fails CLOSED. If the issuer cannot be reached the request is refused rather
 * than admitted on the strength of an unverified token — an outage must not
 * become an authentication bypass, and that trade is the one place where
 * "degrade, never fail" (which the SDK gateway callers follow) is the wrong
 * instinct: a dashboard may show stale numbers during an outage, but nobody may
 * be let in unverified during one.
 *
 * Inert while no issuer is configured, so the app keeps serving its own
 * locally-issued tokens until the platform identity provider is wired up.
 */
export function platformSession(
  req: PlatformRequest & AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): void {
  if (!JwksCache.isConfigured() || isPublicPath(req.path)) {
    next();
    return;
  }

  const token = readBearerToken(req);
  if (!token) {
    next(AppError.unauthenticated('Authorization header with a bearer token is required'));
    return;
  }

  verifyPlatformToken(token)
    .then((session) => {
      req.platformSession = session;

      /*
       * BIND THE LOCAL ROW TO THE PLATFORM IDENTITY LAYERS, once we know them.
       *
       * `007_persona_identity` added platform_person_id, platform_persona_id and
       * platform_tenant_id to `users` and NOTHING wrote them - the architecture
       * was in the migration and absent from the data. This is the one place
       * where the local user and the platform session are both in hand, so it is
       * the only honest place to record the correspondence.
       *
       * FIRE AND FORGET, DELIBERATELY. The linkage is bookkeeping: a request
       * must not fail, or wait, because a correspondence could not be written.
       * The failure is logged rather than swallowed silently, because a linkage
       * that never lands leaves a column that looks populated for some users and
       * not others - and that is harder to notice than one that is empty
       * throughout.
       */
      const localUserId = req.session?.userId;
      if (localUserId) {
        void linkPlatformIdentity(localUserId, session).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error('[sessionMiddleware] identity linkage deferred:', message);
        });
      }

      next();
    })
    .catch(next);
}

/**
 * Guard requiring the caller to hold one of `roles`.
 *
 * Mounted after `platformSession`. Absent roles are a refusal, never a pass:
 * a token that names none is a caller with no permissions, not an unrestricted
 * one.
 */
export function requirePlatformRole(...roles: string[]) {
  return (req: PlatformRequest, _res: Response, next: NextFunction): void => {
    const session = req.platformSession;
    if (!session) {
      next(AppError.unauthenticated());
      return;
    }
    if (!session.roles.some((role) => roles.includes(role))) {
      next(AppError.forbidden(`This action requires one of: ${roles.join(', ')}`));
      return;
    }
    next();
  };
}
