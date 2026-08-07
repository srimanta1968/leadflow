/**
 * The ProjexCloud SDK gateway — the ONLY way out of this process to ProjexCloud.
 *
 * Everything a call to another company's service needs to be safe lives here and
 * nowhere else: the credential, the idempotency key, the retry policy, the
 * circuit breaker, redaction before logging, and the mapping from an upstream
 * status to a LeadFlow error code. `tests/unit/sdkGatewayBoundary.test.ts` fails
 * the build if another module opens an HTTP connection to a ProjexCloud host,
 * because every one of those guarantees is lost the moment somebody writes a
 * bare `fetch` "just for this one call".
 */
export { SdkGatewayClient } from './client';
export type { SdkCallOptions, SdkCallResult } from './client';
export { sdkHealthRoutes } from './healthController';
export { CircuitBreaker, countsAgainstCircuit, DEFAULT_BREAKER } from './circuitBreaker';
export type { BreakerState } from './circuitBreaker';
export { SdkHealthRegistry, verdictFor } from './health';
export type { HealthVerdict, SdkHealthEntry } from './health';
export {
  beginAttemptSequence,
  backoffDelayMs,
  shouldRetry,
  DEFAULT_RETRY,
} from './retry';
export type { AttemptSequence, RetryOptions } from './retry';
export { mapUpstreamStatus, extractUpstreamDetail, toAppError, upstreamStatusOf } from './errorMapping';
export type { MappedError, UpstreamErrorDetails } from './errorMapping';
export { redact, redactHeaders, callSummary } from './redaction';
