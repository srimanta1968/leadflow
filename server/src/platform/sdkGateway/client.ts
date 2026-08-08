import { config } from '../../config/env';
import { AppError, ErrorCodes } from '../../utils/errors';
import { CircuitBreaker, countsAgainstCircuit } from './circuitBreaker';
import { SdkHealthRegistry } from './health';
import { extractUpstreamDetail, mapUpstreamStatus, toAppError } from './errorMapping';
import { callSummary, redact } from './redaction';
import {
  DEFAULT_RETRY,
  backoffDelayMs,
  beginAttemptSequence,
  newSpanId,
  shouldRetry,
  sleep,
  type RetryOptions,
} from './retry';

/** Options accepted by a single SDK gateway call. */
export interface SdkCallOptions {
  /** SDK package name, e.g. `sdk-source-record`. Used for the circuit and the panel. */
  sdk: string;
  /** Path within the gateway, e.g. `/api/source-records`. */
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /**
   * Idempotency key. Supply one derived from the caller's own event identity —
   * a provider event id, a capture id — whenever the same logical intention can
   * arrive twice. When omitted the gateway mints one, which protects retries
   * within a single call but cannot recognise a replay across two.
   */
  idempotencyKey?: string;
  /** Correlation id, so an upstream trace joins the LeadFlow trace. */
  correlationId?: string;
  /** The event that caused this call, for lineage in sdk-trace. */
  causationId?: string | null;
  timeoutMs?: number;
  retry?: Partial<RetryOptions>;
}

export interface SdkCallResult<T> {
  /** True when the gateway answered; false when LeadFlow fell back locally. */
  delivered: boolean;
  status: number | null;
  data: T | null;
  /** The key actually sent, so a caller can record what it claimed upstream. */
  idempotencyKey?: string;
  correlationId?: string;
}

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

/** Returns the parsed body, or null when it is not JSON at all. */
function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The one client for every ProjexCloud SDK call.
 *
 * LeadFlow holds no horizontal capability of its own — contact, consent,
 * assignment, SLA, sequence and audit state all live behind this gateway. It is
 * therefore the single place where a credential, a retry, a circuit and a log
 * line are decided, and `sdkGatewayBoundary.test.ts` fails the build if any
 * other module opens an HTTP connection to a ProjexCloud host.
 *
 * WHAT IT GUARANTEES, in the order the acceptance criteria ask for them:
 *
 *   1. The idempotency key is minted ONCE per logical call, in
 *      `beginAttemptSequence`, and the retry loop reuses it. Regenerating per
 *      attempt is what turns a safe retry into a duplicate write.
 *   2. The circuit is per SDK and recovers through a single half-open probe.
 *   3. Nothing reaches a log without going through `redact`.
 *   4. Failures map to specific LeadFlow codes rather than one blanket 502.
 *
 * When `PROJEXCLOUD_GATEWAY_URL` is unset the client reports itself unconfigured
 * rather than throwing, so callers can apply their documented local fallback.
 * A configured-but-failing gateway is a real error.
 */
export class SdkGatewayClient {
  /** Shared so every caller sees the same circuit and the same panel. */
  static readonly breaker = new CircuitBreaker();
  static readonly health = new SdkHealthRegistry();

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
   * A `pk_live_`/`pk_test_` API key is treated as the `client_secret` for a
   * client-credentials exchange, which returns a short-lived token carrying the
   * tenant, the app and a synthetic service persona. Anything not `pk_`-prefixed
   * is assumed to already be a token and is passed through, which is the path
   * this deployment takes — `PROJEXCLOUD_API_KEY` here is a tenant JWT.
   *
   * The exchange is kept because it is the credential shape a NEW tenant is
   * issued. ProjexCloud has since taught the gateway to accept a `pk_` key as a
   * bearer directly (`authOrApiKey`), so the exchange is now a fallback rather
   * than the only way in; it costs one extra round trip on a cold start and
   * nothing thereafter, and removing it would strand any deployment still
   * configured against the older behaviour.
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
        console.error(`[sdkGateway] key exchange returned ${response.status}`);
        return null;
      }

      const body = (await response.json()) as { access_token?: string; expires_in?: number };
      if (!body.access_token) return null;

      SdkGatewayClient.machineToken = {
        accessToken: body.access_token,
        // Default an hour when the gateway does not say; the skew above means a
        // wrong guess costs an extra exchange rather than a failed request.
        expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
      };
      return body.access_token;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[sdkGateway] key exchange failed:', message);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Call an SDK endpoint through the gateway.
   *
   * @returns `{ delivered:false }` when the gateway is not configured.
   * @throws AppError mapped from the upstream status — see errorMapping.ts.
   */
  static async call<T>(options: SdkCallOptions): Promise<SdkCallResult<T>> {
    if (!SdkGatewayClient.isConfigured()) {
      return { delivered: false, status: null, data: null };
    }

    // MINTED ONCE, OUTSIDE THE LOOP. This single placement is the whole of
    // acceptance criterion 1 — every attempt below sends this same key, so a
    // retry after a timeout is recognised upstream as the same intention rather
    // than a second one.
    const sequence = beginAttemptSequence(options);
    const retry: RetryOptions = { ...DEFAULT_RETRY, ...options.retry };

    // The SDK name is NOT a URL segment. The gateway exposes every SDK's routes
    // under one flat namespace and decides which SDK serves a path itself, so
    // `sdk` is documentation of who owns the endpoint — used for the circuit,
    // the panel and errors — rather than part of the address.
    const url = `${config.projexCloud.gatewayUrl.replace(/\/$/, '')}${options.path}`;

    let lastMapped: ReturnType<typeof mapUpstreamStatus> | null = null;

    for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
      const permission = SdkGatewayClient.breaker.canRequest(options.sdk);
      if (!permission.allowed) {
        // FAIL FAST, and say so specifically. The point of an open circuit is
        // that the caller learns immediately instead of waiting out a timeout
        // we already know will happen.
        throw new AppError(
          503,
          ErrorCodes.UPSTREAM_UNAVAILABLE,
          `ProjexCloud ${options.sdk} is unavailable — circuit open, not retrying`,
        );
      }

      const startedAt = Date.now();
      const outcome = await SdkGatewayClient.attempt<T>(url, options, sequence);
      const durationMs = Date.now() - startedAt;

      if (outcome.ok) {
        SdkGatewayClient.breaker.onSuccess(options.sdk);
        SdkGatewayClient.health.observe({
          sdk: options.sdk,
          status: outcome.status,
          durationMs,
          failed: false,
          callerFault: false,
        });
        return {
          delivered: true,
          status: outcome.status,
          data: outcome.data,
          idempotencyKey: sequence.idempotencyKey,
          correlationId: sequence.correlationId,
        };
      }

      const mapped = mapUpstreamStatus(options.sdk, outcome.status, outcome.detail);
      lastMapped = mapped;

      // Only genuine SDK failures move the circuit. A 400 or a 403 is ours.
      if (countsAgainstCircuit(outcome.status)) {
        SdkGatewayClient.breaker.onFailure(options.sdk, mapped.message);
      } else {
        SdkGatewayClient.breaker.onSuccess(options.sdk);
      }

      SdkGatewayClient.health.observe({
        sdk: options.sdk,
        status: outcome.status,
        durationMs,
        failed: true,
        callerFault: mapped.callerFault,
      });

      console.error(
        '[sdkGateway] call failed',
        JSON.stringify(
          callSummary({
            sdk: options.sdk,
            method: options.method,
            path: options.path,
            status: outcome.status,
            attempt,
            durationMs,
            correlationId: sequence.correlationId,
            traceId: sequence.traceId,
            body: options.body,
          }),
        ),
      );

      const again = shouldRetry({
        method: options.method,
        status: outcome.status,
        attempt,
        options: retry,
        hasIdempotencyKey: Boolean(sequence.idempotencyKey),
      });
      if (!again) break;

      await sleep(backoffDelayMs(attempt, retry));
    }

    throw toAppError(
      lastMapped ?? mapUpstreamStatus(options.sdk, null, 'no attempt completed'),
      options.sdk,
    );
  }

  /** One HTTP attempt. Returns rather than throws, so the loop owns control flow. */
  private static async attempt<T>(
    url: string,
    options: SdkCallOptions,
    sequence: {
      idempotencyKey: string;
      correlationId: string;
      traceId: string;
      causationId: string | null;
    },
  ): Promise<
    | { ok: true; status: number; data: T | null }
    | { ok: false; status: number | null; detail: string | null }
  > {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? config.projexCloud.timeoutMs,
    );

    try {
      const bearer = await SdkGatewayClient.bearerValue();
      if (!bearer) {
        return { ok: false, status: null, detail: 'could not obtain a ProjexCloud credential' };
      }

      // The gateway authenticates LeadFlow-the-application, not the end user.
      // The caller's session JWT is deliberately NOT forwarded: it is minted by
      // LeadFlow's own auth for LeadFlow's own routes, the gateway is not its
      // audience, and passing a user-bearer token to a third party widens its
      // blast radius for no gain. Scope travels in x-tenant-id / x-app-id.
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearer}`,
        'Idempotency-Key': sequence.idempotencyKey,
        // BOTH NAMES, ON PURPOSE. x-correlation-id is LeadFlow's own and every
        // log line here quotes it; x-trace-id and traceparent are what
        // ProjexCloud's tracing hook actually reads. They carry the SAME
        // identity in two encodings, so their server log and ours join on one
        // id instead of each holding half a thread.
        //
        // The span id is per ATTEMPT while the trace id is per call, which is
        // the correct shape: a retry is a new span of the same trace, and it
        // mirrors the idempotency key staying constant across attempts.
        'x-correlation-id': sequence.correlationId,
        'x-trace-id': sequence.traceId,
        traceparent: `00-${sequence.traceId}-${newSpanId()}-01`,
      };
      if (sequence.causationId) headers['x-causation-id'] = sequence.causationId;
      // Scope headers are sent only when configured: an empty header is worse
      // than an absent one, because a gateway reading `x-tenant-id: ''` may
      // resolve it to no tenant and answer with an empty result set that looks
      // like a legitimate "nothing found" rather than a misconfiguration.
      if (config.projexCloud.tenantId) headers['x-tenant-id'] = config.projexCloud.tenantId;
      if (config.projexCloud.appId) headers['x-app-id'] = config.projexCloud.appId;

      const response = await fetch(url, {
        method: options.method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });

      const text = await response.text();
      // Tolerant on purpose. A non-JSON error body — an nginx HTML 502 page, a
      // proxy timeout — must not cost us the status code, which is the one thing
      // still worth having when the body is unreadable.
      const data = text ? (safeJsonParse(text) as T | null) : null;

      if (!response.ok) {
        return { ok: false, status: response.status, detail: extractUpstreamDetail(data, text) };
      }
      return { ok: true, status: response.status, data };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // status null means transport: DNS, refused, or our own abort on timeout.
      return { ok: false, status: null, detail: message };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** The provider-health panel's payload. */
  static healthSnapshot(): ReturnType<SdkHealthRegistry['snapshot']> {
    return SdkGatewayClient.health.snapshot(SdkGatewayClient.breaker);
  }

  /** Drop circuit and health state. Tests only. */
  static resetTelemetry(): void {
    SdkGatewayClient.breaker.reset();
    SdkGatewayClient.health.reset();
  }
}

export { redact };
