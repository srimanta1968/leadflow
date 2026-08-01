import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/env';
import { AppError } from '../utils/errors';
import { SessionClaims } from '../types';

/** A request that has passed `authenticate` and carries verified claims. */
export interface AuthenticatedRequest extends Request {
  session?: SessionClaims;
}

/**
 * Verify a LeadFlow session token.
 *
 * This is the seam ProjexCloud takes over: today the token is signed with the
 * local session secret, and the JWKS-backed verifier introduced by the identity
 * spine replaces the body of this function without changing its signature or
 * any caller.
 *
 * @param token Raw JWT, without the `Bearer ` prefix.
 * @returns The verified claims.
 * @throws AppError(401 INVALID_TOKEN) when the token is malformed or expired.
 */
export function verifySessionToken(token: string): SessionClaims {
  try {
    const decoded = jwt.verify(token, config.jwt.secret) as jwt.JwtPayload;
    if (!decoded.userId || !decoded.email || !decoded.role) {
      throw AppError.invalidToken('Session token is missing required claims');
    }
    return {
      userId: String(decoded.userId),
      email: String(decoded.email),
      role: String(decoded.role),
    };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw AppError.invalidToken();
  }
}

/** Pull the bearer token out of the Authorization header, or null. */
function readBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return null;
  }
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Guard that rejects any request without a valid session token.
 * Attaches the verified claims to `req.session` for downstream handlers.
 */
export function authenticate(req: AuthenticatedRequest, _res: Response, next: NextFunction): void {
  try {
    const token = readBearerToken(req);
    if (!token) {
      throw AppError.unauthenticated('Authorization header with a bearer token is required');
    }
    req.session = verifySessionToken(token);
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Guard that additionally requires the caller to hold one of `roles`.
 * Must be mounted after `authenticate`.
 *
 * @param roles Role names accepted on this route.
 */
export function authorizeRole(...roles: string[]) {
  return (req: AuthenticatedRequest, _res: Response, next: NextFunction): void => {
    if (!req.session) {
      next(AppError.unauthenticated());
      return;
    }
    if (!roles.includes(req.session.role)) {
      next(AppError.forbidden(`This action requires one of: ${roles.join(', ')}`));
      return;
    }
    next();
  };
}
