/**
 * One circuit breaker per ProjexCloud SDK.
 *
 * PER SDK, NOT PER GATEWAY. The gateway fronts sixty-odd SDKs behind one origin,
 * and they fail independently — sdk-research going down must not stop
 * sdk-source-record from accepting captures. A single breaker on the origin
 * would take the whole platform out because one enrichment provider is slow,
 * which is the failure this pattern exists to prevent rather than cause.
 */

/** What the breaker will let a caller do right now. */
export type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerOptions {
  /** Consecutive qualifying failures before the circuit opens. */
  threshold: number;
  /** How long it stays open before a probe is allowed, in ms. */
  cooldownMs: number;
  /**
   * Ceiling on the cooldown as it backs off, in ms. Each failed probe doubles
   * the wait, so an SDK that is down for an hour is not probed 3,600 times.
   */
  maxCooldownMs: number;
}

export const DEFAULT_BREAKER: BreakerOptions = {
  threshold: 5,
  cooldownMs: 10_000,
  maxCooldownMs: 300_000,
};

interface BreakerRecord {
  state: BreakerState;
  consecutiveFailures: number;
  /** Epoch ms at which a probe becomes allowed. */
  openedUntil: number;
  /** The cooldown currently in force, doubling per failed probe. */
  currentCooldownMs: number;
  /** True while a half-open probe is in flight — admits exactly one. */
  probeInFlight: boolean;
  lastFailureReason: string | null;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  /** Lifetime counters, for the provider-health panel. */
  totals: { success: number; failure: number; shortCircuited: number };
}

function empty(): BreakerRecord {
  return {
    state: 'closed',
    consecutiveFailures: 0,
    openedUntil: 0,
    currentCooldownMs: 0,
    probeInFlight: false,
    lastFailureReason: null,
    lastFailureAt: null,
    lastSuccessAt: null,
    totals: { success: 0, failure: 0, shortCircuited: 0 },
  };
}

/**
 * Whether a failure should count against the circuit.
 *
 * A 4xx IS NOT AN SDK OUTAGE. A 400 means our payload is wrong, a 403 means our
 * persona lacks a grant, a 404 means the record is not there — all of which the
 * SDK answered correctly and promptly. Counting them would let one malformed
 * caller open the circuit on a perfectly healthy SDK and take the feature out
 * for everybody, which is strictly worse than the 400 it started from.
 *
 * 429 is the exception: it is the SDK telling us to back off, and backing off is
 * exactly what an open circuit does.
 */
export function countsAgainstCircuit(status: number | null): boolean {
  if (status === null) return true;      // transport failure or timeout
  if (status === 429) return true;
  return status >= 500;
}

export class CircuitBreaker {
  private readonly records = new Map<string, BreakerRecord>();

  constructor(private readonly options: BreakerOptions = DEFAULT_BREAKER) {}

  private record(sdk: string): BreakerRecord {
    const existing = this.records.get(sdk);
    if (existing) return existing;
    const fresh = empty();
    this.records.set(sdk, fresh);
    return fresh;
  }

  /**
   * Ask permission to call an SDK.
   *
   * `now` is a parameter rather than a call to Date.now() so the half-open
   * transition can be tested without sleeping. A breaker whose recovery path is
   * only reachable by waiting ten real seconds is a breaker whose recovery path
   * does not get tested.
   */
  canRequest(sdk: string, now: number = Date.now()): { allowed: boolean; state: BreakerState } {
    const r = this.record(sdk);

    if (r.state === 'closed') return { allowed: true, state: 'closed' };

    if (r.state === 'open') {
      if (now < r.openedUntil) {
        r.totals.shortCircuited += 1;
        return { allowed: false, state: 'open' };
      }
      // Cooldown elapsed: promote to half-open and let this caller be the probe.
      r.state = 'half_open';
      r.probeInFlight = true;
      return { allowed: true, state: 'half_open' };
    }

    // half_open — EXACTLY ONE probe at a time. Without this guard a burst of
    // traffic arriving the instant the cooldown expires all becomes a "probe",
    // and the SDK we are trying not to overwhelm gets the full load back.
    if (r.probeInFlight) {
      r.totals.shortCircuited += 1;
      return { allowed: false, state: 'half_open' };
    }
    r.probeInFlight = true;
    return { allowed: true, state: 'half_open' };
  }

  /** Report a completed call. */
  onSuccess(sdk: string, now: number = Date.now()): void {
    const r = this.record(sdk);
    r.state = 'closed';
    r.consecutiveFailures = 0;
    r.currentCooldownMs = 0;
    r.openedUntil = 0;
    r.probeInFlight = false;
    r.lastSuccessAt = now;
    r.totals.success += 1;
  }

  /**
   * Report a failure. Only call this for failures that pass
   * `countsAgainstCircuit` — a 4xx belongs in the health totals, not here.
   */
  onFailure(sdk: string, reason: string, now: number = Date.now()): void {
    const r = this.record(sdk);
    r.totals.failure += 1;
    r.lastFailureReason = reason;
    r.lastFailureAt = now;

    if (r.state === 'half_open') {
      // The probe failed. Straight back to open with a LONGER cooldown, rather
      // than another threshold-length run of failures first — we already know it
      // is down, and re-proving it costs the caller `threshold` more timeouts.
      r.currentCooldownMs = Math.min(
        Math.max(r.currentCooldownMs, this.options.cooldownMs) * 2,
        this.options.maxCooldownMs,
      );
      r.state = 'open';
      r.openedUntil = now + r.currentCooldownMs;
      r.probeInFlight = false;
      return;
    }

    r.consecutiveFailures += 1;
    r.probeInFlight = false;
    if (r.consecutiveFailures >= this.options.threshold) {
      r.currentCooldownMs = this.options.cooldownMs;
      r.state = 'open';
      r.openedUntil = now + r.currentCooldownMs;
    }
  }

  /** A read-only snapshot for the provider-health panel. */
  snapshot(now: number = Date.now()): Record<string, {
    state: BreakerState;
    consecutiveFailures: number;
    retryAfterMs: number | null;
    lastFailureReason: string | null;
    lastFailureAt: string | null;
    lastSuccessAt: string | null;
    totals: { success: number; failure: number; shortCircuited: number };
  }> {
    const out: ReturnType<CircuitBreaker['snapshot']> = {};
    for (const [sdk, r] of this.records) {
      out[sdk] = {
        state: r.state,
        consecutiveFailures: r.consecutiveFailures,
        retryAfterMs: r.state === 'open' ? Math.max(0, r.openedUntil - now) : null,
        lastFailureReason: r.lastFailureReason,
        lastFailureAt: r.lastFailureAt === null ? null : new Date(r.lastFailureAt).toISOString(),
        lastSuccessAt: r.lastSuccessAt === null ? null : new Date(r.lastSuccessAt).toISOString(),
        totals: { ...r.totals },
      };
    }
    return out;
  }

  /** Drop all state. For tests and for an operator forcing a retry. */
  reset(sdk?: string): void {
    if (sdk) this.records.delete(sdk);
    else this.records.clear();
  }
}
