import { createPublicKey, KeyObject } from 'crypto';
import { config } from '../../config/env';
import { AppError, ErrorCodes } from '../../utils/errors';

/** One key as `sdk-identity` publishes it in its JWKS document. */
interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
}

interface JwksDocument {
  keys?: Jwk[];
}

/**
 * The signing algorithms LeadFlow will accept, as an ALLOWLIST.
 *
 * This is the single most important line in the module. `jsonwebtoken` will
 * otherwise honour the `alg` in the token's own header, which lets an attacker
 * choose it — the classic attacks being `none` (no signature at all) and
 * downgrading RS256 to HS256 so the RSA PUBLIC key, which is published in the
 * JWKS for anyone to read, gets used as an HMAC secret. Both are defeated by
 * refusing to let the token nominate its own verification scheme.
 */
const ALLOWED_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384'] as const;

/**
 * Minimum gap between key-set fetches triggered by an unrecognised `kid`.
 *
 * Rotation has to force a re-read — that is the whole point — but an unknown
 * kid is also trivially forgeable, so an attacker could otherwise turn a stream
 * of junk tokens into a stream of outbound requests to the issuer. Cheap
 * amplification against our own identity provider. The cooldown keeps rotation
 * responsive while capping that at one fetch per window.
 */
const REFETCH_COOLDOWN_MS = 30_000;

interface CachedKeySet {
  keys: Map<string, KeyObject>;
  /** When the set was fetched, for TTL expiry. */
  fetchedAt: number;
}

/**
 * The issuer's public signing keys, cached and refreshed on rotation.
 *
 * Verification needs a key per request, and fetching one per request would put
 * the identity provider in the hot path of every call LeadFlow serves — it
 * would become both a latency tax and a shared point of failure. So the set is
 * cached, and the cache is invalidated by two things: age, and being asked for
 * a `kid` it does not hold.
 *
 * That second trigger is what makes ROTATION work without operator action. When
 * `sdk-identity` starts signing with a new key, the first token carrying the new
 * `kid` misses the cache, forces a re-read, and succeeds. Tokens still in flight
 * under the OLD key keep verifying too, because a published JWKS carries the
 * outgoing key alongside the incoming one — which is precisely why this reads
 * the whole set rather than a single current key.
 */
export class JwksCache {
  private static cache: CachedKeySet | null = null;
  /**
   * When a MISS last forced a re-read. Deliberately not touched by ordinary
   * loads: seeding it from the first successful fetch would put the very next
   * rotation inside the cooldown and delay it by a full window, which is the
   * opposite of what the miss trigger is for.
   */
  private static lastMissRefetchAt = 0;
  /** De-duplicates concurrent fetches so a cold start issues ONE request. */
  private static inFlight: Promise<CachedKeySet> | null = null;

  /** True when an issuer is configured and token verification is expected. */
  static isConfigured(): boolean {
    return Boolean(config.projexCloud.identity.issuerUrl);
  }

  /** Drop the cached set. Exposed for tests and for a forced re-read. */
  static reset(): void {
    JwksCache.cache = null;
    JwksCache.lastMissRefetchAt = 0;
    JwksCache.inFlight = null;
  }

  /**
   * The verification key for one `kid`.
   *
   * @param kid Key id from the token header, or null when it carries none.
   * @returns The public key to verify with.
   * @throws AppError(401 INVALID_TOKEN) when the issuer publishes no such key.
   * @throws AppError(502 UPSTREAM_UNAVAILABLE) when the key set cannot be read.
   */
  static async getKey(kid: string | null, jwksUri: string): Promise<KeyObject> {
    let set = await JwksCache.load(jwksUri);

    if (kid && !set.keys.has(kid)) {
      // Unknown kid: either a rotation we have not seen, or a forged header.
      // Re-read once, subject to the cooldown, and let the miss stand if the
      // issuer still does not publish it.
      const now = Date.now();
      if (now - JwksCache.lastMissRefetchAt >= REFETCH_COOLDOWN_MS) {
        JwksCache.lastMissRefetchAt = now;
        JwksCache.cache = null;
        set = await JwksCache.load(jwksUri);
      }
    }

    if (kid) {
      const key = set.keys.get(kid);
      if (!key) {
        throw AppError.invalidToken('Session token was signed by an unrecognised key');
      }
      return key;
    }

    // No kid in the header. Legal only while the issuer publishes exactly one
    // key — with several, "which one" is a guess, and guessing which key
    // verifies a signature is how a verifier ends up accepting the wrong one.
    if (set.keys.size !== 1) {
      throw AppError.invalidToken(
        'Session token carries no key id and the issuer publishes more than one key'
      );
    }
    return set.keys.values().next().value as KeyObject;
  }

  /** The cached set, re-fetching when absent or past its TTL. */
  private static async load(jwksUri: string): Promise<CachedKeySet> {
    const cached = JwksCache.cache;
    if (cached && Date.now() - cached.fetchedAt < config.projexCloud.identity.jwksTtlMs) {
      return cached;
    }

    // A cold cache under load would otherwise send one request per concurrent
    // caller; they all wait on the same promise instead.
    if (JwksCache.inFlight) {
      return JwksCache.inFlight;
    }

    JwksCache.inFlight = JwksCache.fetch(jwksUri)
      .then((set) => {
        JwksCache.cache = set;
        return set;
      })
      .finally(() => {
        JwksCache.inFlight = null;
      });

    return JwksCache.inFlight;
  }

  /** Read and parse the key set. */
  private static async fetch(jwksUri: string): Promise<CachedKeySet> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.projexCloud.timeoutMs);

    try {
      const response = await fetch(jwksUri, { signal: controller.signal });
      if (!response.ok) {
        throw new AppError(
          502,
          ErrorCodes.UPSTREAM_UNAVAILABLE,
          `sdk-identity JWKS returned ${response.status}`
        );
      }

      const document = (await response.json()) as JwksDocument;
      const keys = new Map<string, KeyObject>();

      for (const jwk of document.keys ?? []) {
        // Signing keys only. A JWKS may also carry encryption keys, and using
        // one of those to verify a signature is a category error.
        if (jwk.use && jwk.use !== 'sig') {
          continue;
        }
        if (jwk.alg && !ALLOWED_ALGORITHMS.includes(jwk.alg as (typeof ALLOWED_ALGORITHMS)[number])) {
          continue;
        }
        if (!jwk.kid) {
          continue;
        }
        try {
          keys.set(jwk.kid, createPublicKey({ key: jwk as never, format: 'jwk' }));
        } catch {
          // One malformed key must not cost us the others: a rotation that
          // published a bad entry would otherwise lock every user out.
          continue;
        }
      }

      if (keys.size === 0) {
        throw new AppError(
          502,
          ErrorCodes.UPSTREAM_UNAVAILABLE,
          'sdk-identity published no usable signing keys'
        );
      }

      return { keys, fetchedAt: Date.now() };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error('[JwksCache] could not read the issuer key set:', message);
      throw new AppError(
        502,
        ErrorCodes.UPSTREAM_UNAVAILABLE,
        'sdk-identity key set is unavailable'
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

export { ALLOWED_ALGORITHMS };
