import { config } from '../../config/env';
import { AppError, ErrorCodes } from '../../utils/errors';

/** Options accepted by a single SDK gateway call. */
export interface SdkCallOptions {
  /** SDK package name, e.g. `sdk-lead-capture`. */
  sdk: string;
  /** Path within that SDK, e.g. `/v1/captures`. */
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /**
   * Idempotency key. Any call that creates or mutates state must supply one so
   * a retry after a timeout cannot produce a duplicate record upstream.
   */
  idempotencyKey?: string;
  /** Correlation id propagated so an upstream trace joins the LeadFlow trace. */
  correlationId?: string;
  timeoutMs?: number;
}

export interface SdkCallResult<T> {
  /** True when the gateway answered; false when LeadFlow fell back locally. */
  delivered: boolean;
  status: number | null;
  data: T | null;
}

/**
 * Thin client for the ProjexCloud SDK gateway.
 *
 * LeadFlow holds no horizontal capability of its own — contact, consent,
 * assignment, SLA, sequence and audit state all live behind this gateway. Every
 * mutating call carries an idempotency key and a correlation id.
 *
 * Authentication is an API key, not a user token: see the header block in
 * `call` for why the caller's session JWT is not forwarded.
 *
 * When `PROJEXCLOUD_GATEWAY_URL` is unset the client reports itself
 * unconfigured rather than throwing, so callers can apply their documented
 * local fallback (see `LeadCaptureService`). A configured-but-failing gateway
 * is a real error and surfaces as UPSTREAM_UNAVAILABLE.
 */
/** A machine token obtained by exchanging an API key. */
interface MachineToken {
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/**
 * How early a token is treated as expired.
 *
 * Refreshing exactly at expiry loses the race against a request already in
 * flight: the token is valid when we check and rejected by the time the gateway
 * reads it. Sixty seconds is comfortably longer than any single call.
 */
const TOKEN_SKEW_MS = 60_000;

export class SdkGatewayClient {
  /** True when a gateway URL and API key are both present in the environment. */
  static isConfigured(): boolean {
    return Boolean(config.projexCloud.gatewayUrl && config.projexCloud.apiKey);
  }

  private static machineToken: MachineToken | null = null;
  /** De-duplicates concurrent exchanges so a cold start trades ONE key. */
  private static exchangeInFlight: Promise<string | null> | null = null;

  /** Drop the cached machine token. Exposed for tests and forced re-auth. */
  static resetCredential(): void {
    SdkGatewayClient.machineToken = null;
    SdkGatewayClient.exchangeInFlight = null;
  }

  /**
   * The bearer value to send.
   *
   * A `pk_live_`/`pk_test_` API KEY is not a bearer credential — the gateway
   * answers 403 when one is sent directly. It is the `client_secret` for a
   * client-credentials exchange, which returns a short-lived token carrying the
   * tenant, the app and a synthetic service persona.
   *
   * Verified against the live gateway:
   *   Authorization: Bearer <tenant JWT>        -> 200
   *   Authorization: Bearer <pk_test_ key>      -> 403
   *   POST /api/auth/token {client_credentials} -> access_token  (actor kind: service)
   *
   * Anything that is NOT pk_-prefixed is assumed to already be a token and is
   * passed through, so a deployment configured with a tenant JWT keeps working.
   *
   * EXCHANGING IS NOT ENOUGH ON ITS OWN. The synthetic persona the token names
   * starts with no grants, and authority is resolved from the persona at request
   * time rather than from the credential — so a freshly exchanged token still
   * gets 403 until that persona is granted a role template. That grant is
   * provisioning, not something this client can do for itself.
   */
  private static async bearerValue(): Promise<string | null> {
    const configured = config.projexCloud.apiKey;

    if (!configured.startsWith('pk_live_') && !configured.startsWith('pk_test_')) {
      return configured;
    }

    const cached = SdkGatewayClient.machineToken;
    if (cached && Date.now() < cached.expiresAt - TOKEN_SKEW_MS) {
      return cached.accessToken;
    }

    if (SdkGatewayClient.exchangeInFlight) {
      return SdkGatewayClient.exchangeInFlight;
    }

    SdkGatewayClient.exchangeInFlight = SdkGatewayClient.exchangeKey(configured).finally(() => {
      SdkGatewayClient.exchangeInFlight = null;
    });

    return SdkGatewayClient.exchangeInFlight;
  }

  /** Trade the API key for a short-lived machine token. */
  private static async exchangeKey(apiKey: string): Promise<string | null> {
    const url = `${config.projexCloud.gatewayUrl.replace(/\/$/, '')}/api/auth/token`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.projexCloud.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'client_credentials',
          // The application owns the key, so the application id is the client.
          client_id: config.projexCloud.appId,
          client_secret: apiKey,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        console.error(`[SdkGatewayClient] key exchange returned ${response.status}`);
        return null;
      }

      const body = (await response.json()) as { access_token?: string; expires_in?: number };
      if (!body.access_token) {
        return null;
      }

      SdkGatewayClient.machineToken = {
        accessToken: body.access_token,
        // Default an hour when the gateway does not say; the skew above means a
        // wrong guess costs an extra exchange rather than a failed request.
        expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
      };
      return body.access_token;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[SdkGatewayClient] key exchange failed:', message);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Call an SDK endpoint through the gateway.
   *
   * @returns `{ delivered:false }` when the gateway is not configured.
   * @throws AppError(502 UPSTREAM_UNAVAILABLE) when a configured gateway fails.
   */
  static async call<T>(options: SdkCallOptions): Promise<SdkCallResult<T>> {
    if (!SdkGatewayClient.isConfigured()) {
      return { delivered: false, status: null, data: null };
    }

    // The SDK name is NOT a URL segment. The gateway exposes every SDK's routes
    // under one flat namespace and decides which SDK serves a path itself, so
    // `sdk` here is documentation of who owns the endpoint — used in errors and
    // logs — rather than part of the address.
    //
    // Verified against the local gateway rather than assumed:
    //   {base}/api/source-records                 -> 200
    //   {base}/sdk-source-record/api/source-records -> 404
    //   {base}/sdk-source-record/v1/source-records  -> 404
    //
    // The previous form inserted `/${options.sdk}` and produced the second of
    // those, so every ProjexCloud call this app has ever made returned 404 and
    // was swallowed by the callers' degrade-to-local paths — which is exactly
    // why nobody noticed.
    const url = `${config.projexCloud.gatewayUrl.replace(/\/$/, '')}${options.path}`;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? config.projexCloud.timeoutMs
    );

    // The gateway authenticates LeadFlow-the-application, not the end user.
    //
    // This call is server-to-server: the credential is the issued API key, and
    // the scope it acts within is carried by x-tenant-id (and x-app-id where the
    // gateway distinguishes several apps under one tenant). The caller's session
    // JWT is deliberately NOT forwarded — it is minted by LeadFlow's own auth for
    // LeadFlow's own routes, the gateway is not its audience, and passing a
    // user-bearer token to a third party widens its blast radius for no gain.
    // `Authorization: Bearer`, not `x-api-key`. Verified against the local
    // gateway rather than assumed:
    //   Authorization: Bearer <tenant JWT>  -> 200
    //   Authorization: Bearer <pk_live key> -> 403  (recognised, not authorised)
    //   x-api-key: <key>                    -> 401  (header not recognised)
    //
    // So the configured credential must be a token the gateway ACCEPTS: a
    // tenant-scoped JWT, or a key exchanged for one via POST /api/auth/token.
    // A bare pk_live_ key sent directly is refused — it is the client_secret
    // for that exchange, not a bearer credential.
    //
    // NOTE the tenant-scoping trap: the token from POST /api/auth/login carries
    // tenant_id: null and is refused by tenant-scoped routes, while the token
    // from POST /api/auth/signup-tenant carries the tenant. Two identities, and
    // only one of them works here.
    const bearer = await SdkGatewayClient.bearerValue();
    if (!bearer) {
      throw new AppError(
        502,
        ErrorCodes.UPSTREAM_UNAVAILABLE,
        'Could not obtain a ProjexCloud credential'
      );
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearer}`,
    };
    // Scope headers are sent only when configured, because an empty header is
    // worse than an absent one: a gateway that reads `x-tenant-id: ''` may
    // resolve it to no tenant and answer with an empty result set that looks
    // like a legitimate "nothing found" rather than a misconfiguration.
    if (config.projexCloud.tenantId) {
      headers['x-tenant-id'] = config.projexCloud.tenantId;
    }
    if (config.projexCloud.appId) {
      headers['x-app-id'] = config.projexCloud.appId;
    }
    if (options.idempotencyKey) {
      headers['Idempotency-Key'] = options.idempotencyKey;
    }
    if (options.correlationId) {
      headers['x-correlation-id'] = options.correlationId;
    }

    try {
      const response = await fetch(url, {
        method: options.method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });

      const text = await response.text();
      const data = text ? (JSON.parse(text) as T) : null;

      if (!response.ok) {
        throw new AppError(
          502,
          ErrorCodes.UPSTREAM_UNAVAILABLE,
          `ProjexCloud ${options.sdk} returned ${response.status}`
        );
      }

      return { delivered: true, status: response.status, data };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[SdkGatewayClient] ${options.sdk}${options.path} failed:`, message);
      throw new AppError(
        502,
        ErrorCodes.UPSTREAM_UNAVAILABLE,
        `ProjexCloud ${options.sdk} is unavailable`
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
