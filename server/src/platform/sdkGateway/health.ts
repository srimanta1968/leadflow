import type { BreakerState, CircuitBreaker } from './circuitBreaker';

/**
 * Per-SDK health, for the RevOps provider-health panel.
 *
 * WHAT THIS IS NOT: an uptime monitor. It reports what LeadFlow has actually
 * observed while doing real work, which is the only thing that matters to an
 * operator asking "why did my capture not enrich?" A synthetic ping saying an
 * SDK is up while every real call 403s is worse than no panel at all — it moves
 * the investigation away from the fault.
 *
 * It follows that an SDK with no traffic reports `unknown`, never `healthy`.
 * Reporting green for something never called is the same lie in a quieter voice.
 */

export type HealthVerdict = 'healthy' | 'degraded' | 'unavailable' | 'unknown';

interface SdkStats {
  calls: number;
  failures: number;
  /** 4xx that are our fault — counted, but they do not make the SDK unhealthy. */
  callerFaults: number;
  lastStatus: number | null;
  lastCalledAt: number | null;
  /** Rolling window of recent durations, newest last. */
  recentDurationsMs: number[];
}

/** How many samples the latency window keeps. Enough for a median that moves. */
const WINDOW = 50;

function empty(): SdkStats {
  return {
    calls: 0,
    failures: 0,
    callerFaults: 0,
    lastStatus: null,
    lastCalledAt: null,
    recentDurationsMs: [],
  };
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

export interface SdkHealthEntry {
  sdk: string;
  verdict: HealthVerdict;
  circuit: BreakerState;
  calls: number;
  failures: number;
  callerFaults: number;
  failureRate: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  lastStatus: number | null;
  lastCalledAt: string | null;
  lastFailureReason: string | null;
  retryAfterMs: number | null;
}

export class SdkHealthRegistry {
  private readonly stats = new Map<string, SdkStats>();

  private record(sdk: string): SdkStats {
    const existing = this.stats.get(sdk);
    if (existing) return existing;
    const fresh = empty();
    this.stats.set(sdk, fresh);
    return fresh;
  }

  /**
   * Record one completed attempt.
   *
   * `callerFault` keeps a 400 out of the failure rate. A screen that sends a bad
   * payload in a loop would otherwise drive an SDK to "unavailable" and hide a
   * genuine outage somewhere else on the same panel.
   */
  observe(input: {
    sdk: string;
    status: number | null;
    durationMs: number;
    failed: boolean;
    callerFault: boolean;
    now?: number;
  }): void {
    const s = this.record(input.sdk);
    s.calls += 1;
    s.lastStatus = input.status;
    s.lastCalledAt = input.now ?? Date.now();
    if (input.failed) {
      if (input.callerFault) s.callerFaults += 1;
      else s.failures += 1;
    }
    s.recentDurationsMs.push(input.durationMs);
    if (s.recentDurationsMs.length > WINDOW) s.recentDurationsMs.shift();
  }

  /** The panel's payload. Sorted so the response is stable between calls. */
  snapshot(breaker: CircuitBreaker, now: number = Date.now()): SdkHealthEntry[] {
    const breakers = breaker.snapshot(now);
    const names = new Set([...this.stats.keys(), ...Object.keys(breakers)]);

    return [...names].sort().map((sdk) => {
      const s = this.stats.get(sdk) ?? empty();
      const b = breakers[sdk];
      const sorted = [...s.recentDurationsMs].sort((a, z) => a - z);
      // Denominator EXCLUDES caller faults, so the rate answers "how often did
      // this SDK fail us", not "how often did anything go wrong nearby".
      const attributable = s.calls - s.callerFaults;
      const failureRate = attributable > 0 ? s.failures / attributable : null;

      return {
        sdk,
        verdict: verdictFor(b?.state ?? 'closed', s.calls, failureRate),
        circuit: b?.state ?? 'closed',
        calls: s.calls,
        failures: s.failures,
        callerFaults: s.callerFaults,
        failureRate,
        p50Ms: percentile(sorted, 50),
        p95Ms: percentile(sorted, 95),
        lastStatus: s.lastStatus,
        lastCalledAt: s.lastCalledAt === null ? null : new Date(s.lastCalledAt).toISOString(),
        lastFailureReason: b?.lastFailureReason ?? null,
        retryAfterMs: b?.retryAfterMs ?? null,
      };
    });
  }

  reset(): void {
    this.stats.clear();
  }
}

/**
 * The verdict, from the circuit and the observed failure rate.
 *
 * An open circuit is `unavailable` regardless of the rate — the rate is stale by
 * definition once we stopped calling, and a panel that says "degraded, 12%
 * failures" while every request is being short-circuited is describing the past.
 */
export function verdictFor(
  circuit: BreakerState,
  calls: number,
  failureRate: number | null,
): HealthVerdict {
  if (circuit === 'open') return 'unavailable';
  if (circuit === 'half_open') return 'degraded';
  // Never called, so nothing is known. Not healthy.
  if (calls === 0) return 'unknown';
  /*
   * Answered every time, and every failure was OURS.
   *
   * This is the boot provisioners' steady state and it is the case the first
   * live run of this panel got wrong: sdk-consent and sdk-rebac had answered six
   * and nine times, promptly, each with a 409 meaning "already registered" — and
   * the panel called them `unknown` because the caller-fault denominator was
   * zero. Saying "we do not know" about a service that just answered nine times
   * is the same failure as saying "healthy" about one never called, pointing the
   * other way: it hides a working dependency behind a shrug, and an operator
   * scanning for the cause of an outage skips right past the SDKs that are fine.
   *
   * A 409 IS a successful conversation. The SDK understood the request, applied
   * its rules and answered correctly. That is exactly what healthy looks like.
   */
  if (failureRate === null) return 'healthy';
  if (failureRate >= 0.5) return 'unavailable';
  if (failureRate > 0) return 'degraded';
  return 'healthy';
}
