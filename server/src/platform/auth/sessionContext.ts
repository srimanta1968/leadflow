import { Request } from 'express';

/**
 * Who is making this request, as ProjexCloud asserts it.
 *
 * Every field here comes from a VERIFIED token. Nothing is read from a header,
 * a query parameter or a body — those are caller-controlled, and an identity a
 * caller can state for itself is not an identity.
 *
 * The shape mirrors the platform's own model rather than LeadFlow's local
 * `users` row, because these are different things: a `person` is the human
 * across every vertical, a `persona` is the role they are acting through in
 * this tenant right now, and one person may hold several. Flattening the two
 * would make "which hat is this operator wearing" unanswerable, which is the
 * question the permission matrix is built on.
 */
export interface PlatformSession {
  /** Tenant the request acts within. Every scoped query must filter on it. */
  tenantId: string;
  /** Stable identifier for the human. */
  personId: string;
  /**
   * The persona the human is acting through, when the token names one. Null for
   * a token issued to a person who has not selected one.
   */
  personaId: string | null;
  /** Role labels granted to that persona. Never empty-checked into an admin. */
  roles: string[];
  /** Business unit scope, when the tenant is subdivided. */
  businessUnitId: string | null;
  /** Raw `sub`, kept for correlation with upstream audit entries. */
  subject: string;
  /** Token expiry as epoch seconds, for downstream cache lifetimes. */
  expiresAt: number;
}

/** An Express request that has passed the platform session middleware. */
export interface PlatformRequest extends Request {
  platformSession?: PlatformSession;
}

/**
 * Claim names accepted for each field.
 *
 * Listed rather than assumed because token vocabularies drift: a claim may be
 * namespaced in one deployment and bare in another, and silently reading
 * `undefined` would hand every handler a session with no tenant — which fails
 * open, not closed. Order is preference.
 */
const CLAIM_ALIASES = {
  tenantId: ['tenant_id', 'tid', 'https://projexcloud.com/tenant_id'],
  personId: ['person_id', 'pid', 'https://projexcloud.com/person_id'],
  personaId: ['persona_id', 'https://projexcloud.com/persona_id'],
  businessUnitId: ['business_unit_id', 'bu_id', 'https://projexcloud.com/business_unit_id'],
  roles: ['roles', 'role_labels', 'https://projexcloud.com/roles'],
} as const;

/** First present, non-empty string among the aliases. */
function readString(claims: Record<string, unknown>, aliases: readonly string[]): string | null {
  for (const alias of aliases) {
    const value = claims[alias];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return null;
}

/**
 * Role labels, from either an array or a space-delimited string.
 *
 * Both encodings are in the wild — `scope` style is space-delimited, most role
 * claims are arrays — and accepting only one would drop the caller's roles
 * without saying so, which reads downstream as "this user has no permissions".
 */
function readRoles(claims: Record<string, unknown>): string[] {
  for (const alias of CLAIM_ALIASES.roles) {
    const value = claims[alias];
    if (Array.isArray(value)) {
      return value.filter((role): role is string => typeof role === 'string' && role.length > 0);
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim().split(/\s+/);
    }
  }
  return [];
}

/**
 * Turn verified claims into a session, or explain what is missing.
 *
 * @param claims The verified JWT payload.
 * @returns The session, or a reason string naming the absent claim.
 */
export function toPlatformSession(
  claims: Record<string, unknown>
): { session: PlatformSession } | { error: string } {
  const tenantId = readString(claims, CLAIM_ALIASES.tenantId);
  const personId = readString(claims, CLAIM_ALIASES.personId);
  const subject = typeof claims.sub === 'string' ? claims.sub : null;

  // A token that verifies but names no tenant cannot be scoped, and a request
  // that cannot be scoped must not run: the alternative is a query that reads
  // across tenants because its filter was undefined.
  if (!tenantId) {
    return { error: 'Session token names no tenant' };
  }
  // person_id may legitimately be absent on a machine token; sub still
  // identifies the caller, so fall back rather than refusing outright.
  const resolvedPerson = personId ?? subject;
  if (!resolvedPerson) {
    return { error: 'Session token names no subject' };
  }

  return {
    session: {
      tenantId,
      personId: resolvedPerson,
      personaId: readString(claims, CLAIM_ALIASES.personaId),
      roles: readRoles(claims),
      businessUnitId: readString(claims, CLAIM_ALIASES.businessUnitId),
      subject: subject ?? resolvedPerson,
      expiresAt: typeof claims.exp === 'number' ? claims.exp : 0,
    },
  };
}
