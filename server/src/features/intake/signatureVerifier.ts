import crypto from 'crypto';

/** What verification concluded. Recorded on the archive row, not inferred. */
export type SignatureState = 'verified' | 'unsigned' | 'bad_signature' | 'unknown_platform';

export interface VerificationResult {
  state: SignatureState;
  /** True only for `verified`. */
  ok: boolean;
  /** For the operator reading an incident, not for branching. */
  detail: string;
}

/**
 * Per-platform signing secrets, from the environment.
 *
 * A platform with NO configured secret is `unknown_platform`, and is REFUSED
 * rather than waved through. The alternative — accept anything from a platform
 * we have no secret for — means the moment someone posts to
 * `/intake/webhooks/anything`, it lands. An unconfigured integration should be
 * a 401 that gets noticed, not an open door that does not.
 */
function secretFor(platform: string): string | null {
  const key = `INTAKE_SECRET_${platform.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const value = process.env[key];
  return value && value.length > 0 ? value : null;
}

/**
 * Verify a webhook signature.
 *
 * HMAC-SHA256 over the RAW body. The raw bytes matter: re-serialising parsed
 * JSON reorders keys and changes whitespace, so a signature computed over the
 * re-serialised form fails for payloads that are perfectly valid. That failure
 * is intermittent — it depends on the sender's key order — which makes it one
 * of the worst kinds to debug.
 *
 * COMPARED IN CONSTANT TIME. A plain `===` leaks, through timing, how many
 * leading bytes of a guess were right, which turns forging a signature from
 * infeasible into a few thousand requests. `timingSafeEqual` also needs equal
 * lengths, so the length check comes first and deliberately does not
 * short-circuit on content.
 *
 * @param platform Which provider claims to have sent this.
 * @param rawBody The exact bytes received.
 * @param provided The signature header the sender supplied.
 */
export function verifySignature(
  platform: string,
  rawBody: string,
  provided: string | undefined
): VerificationResult {
  const secret = secretFor(platform);
  if (!secret) {
    return {
      state: 'unknown_platform',
      ok: false,
      detail: `No signing secret is configured for '${platform}', so its signature cannot be checked.`,
    };
  }

  if (!provided || provided.trim().length === 0) {
    return {
      state: 'unsigned',
      ok: false,
      // Distinct from a WRONG signature on purpose. Unsigned usually means a
      // misconfigured sender; wrong usually means a stale secret after a
      // rotation, or someone probing. Different people fix those.
      detail: 'The request carried no signature header.',
    };
  }

  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  // Strip an optional `sha256=` prefix — several providers send it that way,
  // and rejecting it would look like a bad secret rather than a format detail.
  const candidate = provided.replace(/^sha256=/i, '').trim();

  if (candidate.length !== expected.length) {
    return {
      state: 'bad_signature',
      ok: false,
      detail: 'The signature did not match the payload.',
    };
  }

  const matches = crypto.timingSafeEqual(
    Buffer.from(candidate, 'utf8'),
    Buffer.from(expected, 'utf8')
  );

  return matches
    ? { state: 'verified', ok: true, detail: 'Signature verified.' }
    : {
        state: 'bad_signature',
        ok: false,
        // The SAME message as a length mismatch. Telling a caller which way it
        // failed hands them a way to narrow the search.
        detail: 'The signature did not match the payload.',
      };
}

/** Compute a signature, for tests and for outbound calls. */
export function signPayload(secret: string, rawBody: string): string {
  return crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}
