import {
  CircuitBreaker,
  DEFAULT_RETRY,
  backoffDelayMs,
  beginAttemptSequence,
  countsAgainstCircuit,
  extractUpstreamDetail,
  mapUpstreamStatus,
  redact,
  redactHeaders,
  shouldRetry,
  SdkHealthRegistry,
  verdictFor,
} from '../../src/platform/sdkGateway';

/**
 * The gateway's guarantees, exercised as pure logic.
 *
 * Every one of these is reachable without a socket, which is the point: the
 * behaviour that matters here — a key that survives a retry, a circuit that
 * admits exactly one probe, a log line that carries no email address — is
 * decision-making, not I/O. Testing it through a mocked `fetch` would test the
 * mock.
 */

describe('idempotency keys survive retries', () => {
  it('mints one key and one correlation id for the whole call', () => {
    const a = beginAttemptSequence({});
    const b = beginAttemptSequence({});
    // Distinct calls get distinct identities...
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
    expect(a.correlationId).not.toBe(b.correlationId);
    expect(a.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('prefers a caller-supplied key, which is what makes REPLAY work', () => {
    // The critical case. A webhook that arrives twice must present the SAME key
    // both times, derived from the provider's event id. A key we generated per
    // call is unique per process — precisely the wrong property here.
    const first = beginAttemptSequence({ idempotencyKey: 'stripe:evt_123' });
    const redelivery = beginAttemptSequence({ idempotencyKey: 'stripe:evt_123' });
    expect(first.idempotencyKey).toBe(redelivery.idempotencyKey);
  });

  it('retries a mutating call ONLY when it carries a key', () => {
    const base = { status: null, attempt: 1, options: DEFAULT_RETRY };
    // A timeout is the one case where we cannot tell whether the write landed.
    // Retrying without a key is a coin flip between "fixed it" and "wrote twice".
    expect(shouldRetry({ ...base, method: 'POST', hasIdempotencyKey: false })).toBe(false);
    expect(shouldRetry({ ...base, method: 'POST', hasIdempotencyKey: true })).toBe(true);
    // A GET changes nothing, so it is safe regardless.
    expect(shouldRetry({ ...base, method: 'GET', hasIdempotencyKey: false })).toBe(true);
  });

  it('does not retry what will fail identically', () => {
    const base = { method: 'GET', attempt: 1, options: DEFAULT_RETRY, hasIdempotencyKey: true };
    expect(shouldRetry({ ...base, status: 400 })).toBe(false);
    expect(shouldRetry({ ...base, status: 403 })).toBe(false);
    expect(shouldRetry({ ...base, status: 404 })).toBe(false);
    // Told to back off, or the far side broke.
    expect(shouldRetry({ ...base, status: 429 })).toBe(true);
    expect(shouldRetry({ ...base, status: 503 })).toBe(true);
    // And it stops at the cap.
    expect(shouldRetry({ ...base, status: 503, attempt: DEFAULT_RETRY.maxAttempts })).toBe(false);
  });

  it('spreads backoff across the whole window rather than around a centre', () => {
    // FULL jitter. The failure being avoided is synchronisation: when an SDK
    // recovers, every caller queued behind it retries at the same computed
    // instant and knocks it over again. A uniform draw from [0, window] breaks
    // that lockstep; a small wobble around a common centre does not.
    expect(backoffDelayMs(1, DEFAULT_RETRY, () => 0)).toBe(0);
    expect(backoffDelayMs(1, DEFAULT_RETRY, () => 0.999)).toBeLessThan(DEFAULT_RETRY.baseDelayMs);
    // The window doubles per attempt...
    expect(backoffDelayMs(3, DEFAULT_RETRY, () => 0.5)).toBeGreaterThan(
      backoffDelayMs(1, DEFAULT_RETRY, () => 0.5),
    );
    // ...and is capped, so attempt 20 is not a 58-hour wait.
    expect(backoffDelayMs(20, DEFAULT_RETRY, () => 0.999)).toBeLessThanOrEqual(DEFAULT_RETRY.maxDelayMs);
  });
});

describe('the circuit breaker opens, probes once, and recovers', () => {
  const options = { threshold: 3, cooldownMs: 1_000, maxCooldownMs: 8_000 };

  it('opens only after sustained failure, and short-circuits while open', () => {
    const breaker = new CircuitBreaker(options);
    const t0 = 1_000_000;

    for (let i = 0; i < options.threshold - 1; i += 1) {
      expect(breaker.canRequest('sdk-research', t0).allowed).toBe(true);
      breaker.onFailure('sdk-research', 'timeout', t0);
    }
    // Still closed one failure short — a couple of blips is not an outage.
    expect(breaker.canRequest('sdk-research', t0).state).toBe('closed');

    breaker.onFailure('sdk-research', 'timeout', t0);
    const blocked = breaker.canRequest('sdk-research', t0);
    expect(blocked).toEqual({ allowed: false, state: 'open' });
  });

  it('admits EXACTLY ONE probe when the cooldown expires', () => {
    const breaker = new CircuitBreaker(options);
    const t0 = 1_000_000;
    for (let i = 0; i < options.threshold; i += 1) breaker.onFailure('sdk-research', 'down', t0);

    const after = t0 + options.cooldownMs + 1;
    const probe = breaker.canRequest('sdk-research', after);
    expect(probe).toEqual({ allowed: true, state: 'half_open' });

    // THE GUARD THAT MATTERS. Without it, a burst arriving the instant the
    // cooldown expires all becomes a "probe" and the SDK we are trying not to
    // overwhelm gets the full load back.
    expect(breaker.canRequest('sdk-research', after).allowed).toBe(false);
    expect(breaker.canRequest('sdk-research', after).allowed).toBe(false);
  });

  it('closes on a successful probe and re-opens with a LONGER wait on a failed one', () => {
    const breaker = new CircuitBreaker(options);
    const t0 = 1_000_000;
    for (let i = 0; i < options.threshold; i += 1) breaker.onFailure('sdk-research', 'down', t0);

    // Failed probe: straight back to open, waiting twice as long — we already
    // know it is down, and re-proving it costs `threshold` more timeouts.
    const firstProbeAt = t0 + options.cooldownMs + 1;
    breaker.canRequest('sdk-research', firstProbeAt);
    breaker.onFailure('sdk-research', 'still down', firstProbeAt);
    expect(breaker.canRequest('sdk-research', firstProbeAt + options.cooldownMs).allowed).toBe(false);

    // Successful probe: fully closed, counters cleared.
    const secondProbeAt = firstProbeAt + options.cooldownMs * 2 + 1;
    expect(breaker.canRequest('sdk-research', secondProbeAt).state).toBe('half_open');
    breaker.onSuccess('sdk-research', secondProbeAt);
    expect(breaker.canRequest('sdk-research', secondProbeAt).state).toBe('closed');
  });

  it('is PER SDK, so one bad provider does not take the platform out', () => {
    const breaker = new CircuitBreaker(options);
    const t0 = 1_000_000;
    for (let i = 0; i < options.threshold; i += 1) breaker.onFailure('sdk-research', 'down', t0);
    expect(breaker.canRequest('sdk-research', t0).allowed).toBe(false);
    // Captures keep working while enrichment is down. A single breaker on the
    // origin would be the outage this pattern exists to prevent.
    expect(breaker.canRequest('sdk-source-record', t0).allowed).toBe(true);
  });

  it('never counts a 4xx as an outage', () => {
    // A 400 means our payload is wrong; a 403 means our persona lacks a grant.
    // The SDK answered correctly and promptly in both cases, and letting one
    // malformed caller open the circuit would take the feature out for everybody.
    expect(countsAgainstCircuit(400)).toBe(false);
    expect(countsAgainstCircuit(403)).toBe(false);
    expect(countsAgainstCircuit(404)).toBe(false);
    expect(countsAgainstCircuit(429)).toBe(true);   // told to back off
    expect(countsAgainstCircuit(503)).toBe(true);
    expect(countsAgainstCircuit(null)).toBe(true);  // transport / timeout
  });
});

describe('redaction happens before anything is logged', () => {
  it('drops every credential-bearing header', () => {
    const headers = redactHeaders({
      Authorization: 'Bearer eyJhbGciOi.secret.value',
      'x-api-key': 'pk_live_abc',
      'Idempotency-Key': 'stripe:evt_123',
      'x-tenant-id': 'tenant-7',
    });
    expect(headers.Authorization).toBe('[redacted]');
    expect(headers['x-api-key']).toBe('[redacted]');
    // The idempotency key is often derived from a provider event id, so logging
    // it leaks the upstream identifier. The correlation id is the thread to pull.
    expect(headers['Idempotency-Key']).toBe('[redacted]');
    expect(headers['x-tenant-id']).toBe('tenant-7');
  });

  it('denies by key name rather than blocklisting what somebody thought of', () => {
    const out = redact({
      lead_id: 'lead-1',
      status: 'accepted',
      email: 'dana@example.com',
      full_name: 'Dana Okafor',
      // The field an SDK adds tomorrow. A blocklist would let this straight
      // through until somebody noticed; deny-by-default does not.
      newly_added_pii_field: '+44 7700 900123',
    }) as Record<string, unknown>;

    expect(out.lead_id).toBe('lead-1');
    expect(out.status).toBe('accepted');
    expect(out.email).toBe('[redacted]');
    expect(out.full_name).toBe('[redacted]');
    expect(out.newly_added_pii_field).toBe('[redacted]');
  });

  it('walks nested shapes and summarises long arrays', () => {
    const out = redact({
      wrapper: { lead_id: 'lead-2', phone: '+44 7700 900123' },
      records: Array.from({ length: 30 }, (_, i) => ({ id: `r${i}`, ssn: '123-45-6789' })),
    }) as Record<string, unknown>;

    expect((out.wrapper as Record<string, unknown>).lead_id).toBe('lead-2');
    expect((out.wrapper as Record<string, unknown>).phone).toBe('[redacted]');
    // Length is diagnostic ("we sent 30 records"); the records are not.
    const records = out.records as unknown[];
    expect(records).toHaveLength(21);
    expect(records[20]).toBe('[+10 more]');
    expect((records[0] as Record<string, unknown>).ssn).toBe('[redacted]');
  });

  it('NEVER mutates the input, which would send [redacted] to the gateway', () => {
    const payload = { email: 'dana@example.com', lead_id: 'lead-3' };
    redact(payload);
    // The redacted copy is built while the real payload is still on its way out.
    expect(payload.email).toBe('dana@example.com');
  });
});

describe('upstream failures map to codes an operator can act on', () => {
  it('separates our fault from theirs', () => {
    expect(mapUpstreamStatus('sdk-x', 400, 'name is required')).toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
      callerFault: true,
    });
    expect(mapUpstreamStatus('sdk-x', 503, null)).toMatchObject({
      status: 502,
      code: 'UPSTREAM_UNAVAILABLE',
      callerFault: false,
    });
  });

  it('answers 502 for a rejected LeadFlow credential, never 401', () => {
    // Returning 401 to the end user would tell them THEIR session is bad and
    // send them to log in again, which fixes nothing and loses their work.
    expect(mapUpstreamStatus('sdk-x', 401, 'Invalid or expired token')).toMatchObject({
      status: 502,
      code: 'UPSTREAM_UNAVAILABLE',
    });
  });

  it('tells a missing ROUTE apart from a missing RECORD', () => {
    // Both are 404 and they mean opposite things. Reporting a bad path as
    // NOT_FOUND renders an empty state for data that exists — which is exactly
    // how a wrong path prefix went unnoticed here for months.
    const badPath = mapUpstreamStatus('sdk-x', 404, 'Route GET:/api/consents/purposes not found');
    expect(badPath).toMatchObject({ status: 502, code: 'UPSTREAM_UNAVAILABLE' });

    const noRecord = mapUpstreamStatus('sdk-x', 404, 'source record not found');
    expect(noRecord).toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('reads the detail out of the shapes the gateway actually emits', () => {
    expect(extractUpstreamDetail({ error: 'ValidationError', details: ['a', 'b'] }, '')).toBe('a; b');
    expect(extractUpstreamDetail({ message: 'nope' }, '')).toBe('nope');
    expect(extractUpstreamDetail({ error: { code: 'X', message: 'deep' } }, '')).toBe('deep');
    // Unparseable body: the raw text beats nothing...
    expect(extractUpstreamDetail(null, '<html>502 Bad Gateway</html>')).toBe('<html>502 Bad Gateway</html>');
    // ...clamped, so an HTML error page does not land whole in the log.
    expect(extractUpstreamDetail(null, 'x'.repeat(900))).toHaveLength(501);
  });
});

describe('health reports what was observed, never what was assumed', () => {
  it('calls an untouched SDK unknown rather than healthy', () => {
    // Green for something never called is the same lie in a quieter voice.
    expect(verdictFor('closed', 0, null)).toBe('unknown');
    // But an SDK that ANSWERED, even only with 4xx, is demonstrably up. Caught
    // by the first live run: the boot provisioners' 409s left sdk-consent and
    // sdk-rebac reporting `unknown` after nine prompt replies each.
    expect(verdictFor('closed', 9, null)).toBe('healthy');
    expect(verdictFor('closed', 10, 0)).toBe('healthy');
    expect(verdictFor('closed', 10, 0.1)).toBe('degraded');
    expect(verdictFor('closed', 10, 0.8)).toBe('unavailable');
    // An open circuit is unavailable whatever the rate says — the rate is stale
    // by definition once we stopped calling.
    expect(verdictFor('open', 10, 0)).toBe('unavailable');
    expect(verdictFor('half_open', 10, 0)).toBe('degraded');
  });

  it('keeps our own bad payloads out of the SDK failure rate', () => {
    const health = new SdkHealthRegistry();
    const breaker = new CircuitBreaker();
    health.observe({ sdk: 'sdk-a', status: 200, durationMs: 10, failed: false, callerFault: false });
    health.observe({ sdk: 'sdk-a', status: 400, durationMs: 5, failed: true, callerFault: true });
    health.observe({ sdk: 'sdk-a', status: 400, durationMs: 5, failed: true, callerFault: true });

    const [entry] = health.snapshot(breaker);
    expect(entry.calls).toBe(3);
    expect(entry.callerFaults).toBe(2);
    // A screen sending a bad payload in a loop must not drive an SDK to
    // "unavailable" and hide a genuine outage elsewhere on the same panel.
    expect(entry.failureRate).toBe(0);
    expect(entry.verdict).toBe('healthy');
  });

  it('reports latency percentiles from real calls', () => {
    const health = new SdkHealthRegistry();
    const breaker = new CircuitBreaker();
    for (const ms of [10, 20, 30, 40, 1000]) {
      health.observe({ sdk: 'sdk-b', status: 200, durationMs: ms, failed: false, callerFault: false });
    }
    const [entry] = health.snapshot(breaker);
    expect(entry.p50Ms).toBe(30);
    expect(entry.p95Ms).toBe(1000);
  });
});
