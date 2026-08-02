import { config } from '../../config/env';
import { AppError, ErrorCodes } from '../../utils/errors';

/** The subset of the OIDC discovery document LeadFlow actually uses. */
export interface OidcMetadata {
  /** Exact string every token's `iss` must equal. */
  issuer: string;
  /** Where the signing keys live. */
  jwksUri: string;
}

interface DiscoveryResponse {
  issuer?: string;
  jwks_uri?: string;
}

/**
 * The issuer's published configuration, read once and cached for the process.
 *
 * Discovery is what keeps the `jwks_uri` from being a second thing to configure
 * and keep in step — the issuer states where its keys live and LeadFlow follows,
 * so moving them is the issuer's business alone.
 *
 * The ISSUER STRING is taken from here rather than from our own config on
 * purpose. `iss` has to be compared against what the provider actually asserts;
 * deriving it from a locally-typed URL invites a mismatch of exactly the kind
 * (a trailing slash, http vs https) that gets "fixed" by loosening the check
 * until it stops comparing anything.
 *
 * AUDIENCE is deliberately NOT read here: OIDC does not publish it, because
 * audience identifies the CLIENT, not the issuer. It comes from config.
 *
 * Cached without a TTL. This document changes on the order of never, and unlike
 * the key set there is no rotation to track — a stale `jwks_uri` would surface
 * immediately as a failed key fetch rather than silently accepting anything.
 */
export class OidcDiscovery {
  private static cache: OidcMetadata | null = null;
  private static inFlight: Promise<OidcMetadata> | null = null;

  /** Drop the cached document. Exposed for tests. */
  static reset(): void {
    OidcDiscovery.cache = null;
    OidcDiscovery.inFlight = null;
  }

  /**
   * Read (or return the cached) issuer metadata.
   *
   * @throws AppError(502 UPSTREAM_UNAVAILABLE) when discovery cannot be read or
   *         comes back without the two fields verification depends on.
   */
  static async metadata(): Promise<OidcMetadata> {
    if (OidcDiscovery.cache) {
      return OidcDiscovery.cache;
    }
    if (OidcDiscovery.inFlight) {
      return OidcDiscovery.inFlight;
    }

    OidcDiscovery.inFlight = OidcDiscovery.fetch()
      .then((metadata) => {
        OidcDiscovery.cache = metadata;
        return metadata;
      })
      .finally(() => {
        OidcDiscovery.inFlight = null;
      });

    return OidcDiscovery.inFlight;
  }

  private static async fetch(): Promise<OidcMetadata> {
    const base = config.projexCloud.identity.issuerUrl.replace(/\/$/, '');
    const url = `${base}/.well-known/openid-configuration`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.projexCloud.timeoutMs);

    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new AppError(
          502,
          ErrorCodes.UPSTREAM_UNAVAILABLE,
          `sdk-identity discovery returned ${response.status}`
        );
      }

      const body = (await response.json()) as DiscoveryResponse;

      // Both are load-bearing. Defaulting either one would mean verifying
      // against something nobody chose — the failure mode being a verifier that
      // accepts tokens from an issuer it was never pointed at.
      if (!body.issuer || !body.jwks_uri) {
        throw new AppError(
          502,
          ErrorCodes.UPSTREAM_UNAVAILABLE,
          'sdk-identity discovery is missing issuer or jwks_uri'
        );
      }

      return { issuer: body.issuer, jwksUri: body.jwks_uri };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error('[OidcDiscovery] could not read the issuer configuration:', message);
      throw new AppError(
        502,
        ErrorCodes.UPSTREAM_UNAVAILABLE,
        'sdk-identity discovery is unavailable'
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
