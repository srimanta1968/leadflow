import { randomUUID } from 'crypto';

/**
 * Retry policy and idempotency keys.
 *
 * THE ONE RULE THIS FILE EXISTS FOR: the idempotency key is generated ONCE per
 * logical call and reused on every attempt. Regenerating it per attempt is the
 * classic way a "safe" retry creates duplicates — the upstream sees two distinct
 * keys, correctly concludes they are two distinct intentions, and writes two
 * records. The retry then looks like it worked, and the duplicate surfaces days
 * later as two leads for one form submission.
 *
 * That is why the key is minted in `beginAttemptSequence` rather than inside the
 * attempt loop, and why the loop takes the sequence as a parameter instead of
 * making its own.
 */

export interface RetryOptions {
  /** Total attempts including the first. 1 means no retry. */
  maxAttempts: number;
  /** First backoff, in ms. Doubles each attempt. */
  baseDelayMs: number;
  /** Ceiling on a single backoff, in ms. */
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 5_000,
};

/** Methods that change state, and therefore need an idempotency key to be retryable. */
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface AttemptSequence {
  /** Stable across every attempt. Never regenerate this. */
  idempotencyKey: string;
  correlationId: string;
  /** Set by the gateway when the caller supplied a parent, for lineage. */
  causationId: string | null;
}

/**
 * Mint the identity a logical call keeps for its whole life, retries included.
 *
 * A caller-supplied key always wins. That matters for replay: an inbound webhook
 * that arrives twice should present the SAME key on both deliveries, derived
 * from the provider's event id, so the second delivery is recognised upstream as
 * the same intention rather than a new one. A key we generated per call could
 * never do that — it is unique per process, which is precisely wrong here.
 */
export function beginAttemptSequence(input: {
  idempotencyKey?: string;
  correlationId?: string;
  causationId?: string | null;
}): AttemptSequence {
  return {
    idempotencyKey: input.idempotencyKey ?? randomUUID(),
    correlationId: input.correlationId ?? randomUUID(),
    causationId: input.causationId ?? null,
  };
}

/**
 * Whether another attempt is warranted.
 *
 * A mutating call with no idempotency key is NOT retried, even on a timeout.
 * A timeout is the one case where we genuinely cannot tell whether the write
 * landed, so retrying without a key is a coin-flip between "fixed it" and
 * "wrote it twice". Since `beginAttemptSequence` always produces a key this
 * should be unreachable, and it is kept as the guard that makes that guarantee
 * enforced rather than merely intended.
 */
export function shouldRetry(input: {
  method: string;
  status: number | null;
  attempt: number;
  options: RetryOptions;
  hasIdempotencyKey: boolean;
}): boolean {
  const { method, status, attempt, options, hasIdempotencyKey } = input;
  if (attempt >= options.maxAttempts) return false;
  if (MUTATING.has(method) && !hasIdempotencyKey) return false;

  // Transport failure or timeout.
  if (status === null) return true;
  // Told to back off, or the far side broke. Everything else in 4xx is our
  // fault and will fail identically however many times we send it.
  return status === 429 || status >= 500;
}

/**
 * Backoff for an attempt, with FULL jitter.
 *
 * Full jitter — a uniform draw from [0, window] rather than window ± a wobble —
 * because the failure mode being avoided is synchronisation. When an SDK comes
 * back after an outage, every caller that queued behind it retries at the same
 * computed instant and knocks it straight over again. Spreading uniformly across
 * the whole window is what actually breaks that lockstep; a small wobble around
 * a common centre does not.
 *
 * `random` is injectable so the distribution can be asserted instead of hoped for.
 */
export function backoffDelayMs(
  attempt: number,
  options: RetryOptions = DEFAULT_RETRY,
  random: () => number = Math.random,
): number {
  const window = Math.min(options.baseDelayMs * 2 ** Math.max(0, attempt - 1), options.maxDelayMs);
  return Math.floor(random() * window);
}

/** Promise-based sleep, separated so tests can substitute it. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
