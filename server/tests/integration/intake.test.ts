import { randomUUID } from 'crypto';
import { config } from '../../src/config/env';
import { IntakeService } from '../../src/features/intake/intakeService';
import { signPayload, verifySignature } from '../../src/features/intake/signatureVerifier';
import { SdkGatewayClient } from '../../src/services/projexcloud/SdkGatewayClient';
import { dataService } from '../../src/services/DataService';

/**
 * Universal intake.
 *
 * Integration, because both guarantees that matter are enforced by database
 * constraints: the replay key on (platform, source_event_id) and the outage
 * queue's own uniqueness. A mocked data layer would assert the mock behaves as
 * written rather than that the constraints hold, and the constraints ARE the
 * feature.
 */

const PLATFORM = 'web_form';

/** Cleared up-front, not in afterAll: the global afterAll closes the pool. */
beforeAll(async () => {
  await dataService.query("DELETE FROM intake_outage_queue WHERE source_event_id LIKE 'it-%'", []);
  await dataService.query("DELETE FROM intake_event WHERE source_event_id LIKE 'it-%'", []);
});

function signal(overrides: Record<string, unknown> = {}) {
  return {
    platform: PLATFORM,
    sourceEventId: `it-${randomUUID()}`,
    signalKind: 'lead' as const,
    occurredAt: new Date().toISOString(),
    rawPayload: { name: 'Priya Raman', email: 'priya@example.test' },
    contactHints: null,
    campaign: null,
    permissionFields: null,
    transcript: null,
    ...overrides,
  };
}

describe('a replayed event creates exactly one of everything', () => {
  it('accepts the first delivery and recognises the second as a replay', async () => {
    const event = signal();

    const first = await IntakeService.accept(event);
    const second = await IntakeService.accept(event);

    expect(first.outcome).toBe('accepted');
    expect(first.replay).toBe(false);
    // The SOP's explicit go-live requirement: a redelivered webhook must not
    // produce a second lead, task, message or payment.
    expect(second.replay).toBe(true);
  });

  it('writes exactly ONE archive row however many times it is delivered', async () => {
    const event = signal();
    await IntakeService.accept(event);
    await IntakeService.accept(event);
    await IntakeService.accept(event);

    const rows = await dataService.query(
      'SELECT 1 FROM intake_event WHERE platform = $1 AND source_event_id = $2',
      [event.platform, event.sourceEventId]
    );
    expect(rows).toHaveLength(1);
  });

  it('returns the SAME lead id on a replay', async () => {
    const event = signal();
    const first = await IntakeService.accept(event);
    const second = await IntakeService.accept(event);

    expect(second.leadId).toBe(first.leadId);
  });

  it('keys on platform AND event id, so two platforms may share an id', async () => {
    const sharedId = `it-${randomUUID()}`;
    const a = await IntakeService.accept(signal({ sourceEventId: sharedId, platform: 'web_form' }));
    const b = await IntakeService.accept(signal({ sourceEventId: sharedId, platform: 'facebook' }));

    // A source event id is only unique within the platform that minted it. Key
    // on the id alone and the second provider's real signal is suppressed as a
    // duplicate — invisibly, because it looks exactly like a retry.
    expect(a.replay).toBe(false);
    expect(b.replay).toBe(false);
  });
});

describe('the raw event is archived even when rejected', () => {
  it('archives a signal refused for an unknown platform', async () => {
    const eventId = `it-${randomUUID()}`;
    const result = await IntakeService.accept(
      signal({ platform: 'carrier_pigeon', sourceEventId: eventId })
    );

    expect(result.outcome).toBe('rejected');
    expect(result.archived).toBe(true);

    const rows = await dataService.query<{ outcome: string; rejection_reason: string }>(
      'SELECT outcome, rejection_reason FROM intake_event WHERE source_event_id = $1',
      [eventId]
    );
    // "Never arrived" and "arrived and was discarded" are different incidents.
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('rejected');
    expect(rows[0].rejection_reason).toContain('platform');
  });

  it('archives the raw payload, not a summary of it', async () => {
    const eventId = `it-${randomUUID()}`;
    await IntakeService.accept(
      signal({
        sourceEventId: eventId,
        signalKind: 'telepathy',
        rawPayload: { odd: 'shape', nested: { kept: true } },
      })
    );

    const rows = await dataService.query<{ raw_payload: Record<string, unknown> }>(
      'SELECT raw_payload FROM intake_event WHERE source_event_id = $1',
      [eventId]
    );
    // The archive is only useful during an incident if it holds what actually
    // arrived — including the part that made it unprocessable.
    expect(rows[0].raw_payload).toMatchObject({ odd: 'shape', nested: { kept: true } });
  });

  it('records the signature state alongside the outcome', async () => {
    const eventId = `it-${randomUUID()}`;
    await IntakeService.accept(signal({ sourceEventId: eventId }), 'bad_signature');

    const rows = await dataService.query<{ signature_state: string }>(
      'SELECT signature_state FROM intake_event WHERE source_event_id = $1',
      [eventId]
    );
    // An unsigned event that was archived and refused is a different security
    // fact from one that verified. The archive has to be able to say which.
    expect(rows[0].signature_state).toBe('bad_signature');
  });
});

describe('signature verification', () => {
  const SECRET = 'test-intake-secret';

  beforeEach(() => {
    process.env.INTAKE_SECRET_WEB_FORM = SECRET;
  });

  afterEach(() => {
    delete process.env.INTAKE_SECRET_WEB_FORM;
  });

  it('accepts a correctly signed body', () => {
    const body = JSON.stringify({ hello: 'world' });
    const result = verifySignature('web_form', body, signPayload(SECRET, body));

    expect(result.ok).toBe(true);
    expect(result.state).toBe('verified');
  });

  it('accepts the sha256= prefix several providers send', () => {
    const body = JSON.stringify({ hello: 'world' });
    const result = verifySignature('web_form', body, `sha256=${signPayload(SECRET, body)}`);

    // Rejecting the prefix would present as a bad secret rather than a format
    // detail, and send someone rotating keys that are perfectly fine.
    expect(result.ok).toBe(true);
  });

  it('REJECTS an unsigned request', () => {
    const result = verifySignature('web_form', '{}', undefined);

    expect(result.ok).toBe(false);
    expect(result.state).toBe('unsigned');
  });

  it('REJECTS a wrongly-signed request', () => {
    const result = verifySignature('web_form', '{"a":1}', signPayload(SECRET, '{"a":2}'));

    expect(result.ok).toBe(false);
    expect(result.state).toBe('bad_signature');
  });

  it('REJECTS a platform with no configured secret', () => {
    const result = verifySignature('never_configured', '{}', 'anything');

    // Accepting here would mean anything posted to /intake/webhooks/anything
    // lands. An unconfigured integration should be a 401 somebody notices.
    expect(result.ok).toBe(false);
    expect(result.state).toBe('unknown_platform');
  });

  it('gives the SAME message for a wrong signature and a wrong length', () => {
    const wrongLength = verifySignature('web_form', '{}', 'abc');
    const wrongValue = verifySignature('web_form', '{}', 'f'.repeat(64));

    // Distinguishing them would let a caller narrow their search.
    expect(wrongLength.detail).toBe(wrongValue.detail);
  });

  it('distinguishes UNSIGNED from wrongly-signed, which are different faults', () => {
    const unsigned = verifySignature('web_form', '{}', undefined);
    const wrong = verifySignature('web_form', '{}', 'f'.repeat(64));

    // Unsigned is usually a misconfigured sender; wrong is usually a stale
    // secret after rotation, or someone probing. Different people fix those.
    expect(unsigned.state).not.toBe(wrong.state);
  });
});

describe('the outage queue and backfill', () => {
  afterEach(() => {
    config.projexCloud.gatewayUrl = '';
    config.projexCloud.apiKey = '';
    jest.restoreAllMocks();
  });

  it('DEFERS rather than rejects when a downstream is unavailable', async () => {
    config.projexCloud.gatewayUrl = 'https://gateway.test';
    config.projexCloud.apiKey = 'token';
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(SdkGatewayClient, 'call').mockRejectedValue(new Error('sdk down'));

    const event = signal();
    const result = await IntakeService.accept(event);

    // The signal was good and the platform did nothing wrong. Losing it because
    // our dependency was restarting would be our fault presented as theirs.
    expect(result.outcome).toBe('deferred');
    expect(result.archived).toBe(true);

    const queued = await dataService.query(
      'SELECT 1 FROM intake_outage_queue WHERE source_event_id = $1 AND drained_at IS NULL',
      [event.sourceEventId]
    );
    expect(queued).toHaveLength(1);
  });

  it('BACKFILLS by event id from the archive after recovery', async () => {
    config.projexCloud.gatewayUrl = 'https://gateway.test';
    config.projexCloud.apiKey = 'token';
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const call = jest.spyOn(SdkGatewayClient, 'call').mockRejectedValue(new Error('sdk down'));

    const event = signal();
    await IntakeService.accept(event);

    // Dependency recovers.
    call.mockResolvedValue({ delivered: true, status: 201, data: null } as never);
    const result = await IntakeService.backfill('sdk-source-record');

    expect(result.drained).toBeGreaterThanOrEqual(1);

    const rows = await dataService.query<{ outcome: string; lead_id: string | null }>(
      'SELECT outcome, lead_id FROM intake_event WHERE source_event_id = $1',
      [event.sourceEventId]
    );
    // Replayed from the ARCHIVED payload — providers expire their retry
    // windows, so by the time an outage is fixed the archive is often the only
    // copy that still exists.
    expect(rows[0].outcome).toBe('accepted');
    expect(rows[0].lead_id).toBeTruthy();
  });

  it('marks the queue entry drained rather than deleting it', async () => {
    config.projexCloud.gatewayUrl = 'https://gateway.test';
    config.projexCloud.apiKey = 'token';
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const call = jest.spyOn(SdkGatewayClient, 'call').mockRejectedValue(new Error('down'));

    const event = signal();
    await IntakeService.accept(event);
    call.mockResolvedValue({ delivered: true, status: 201, data: null } as never);
    await IntakeService.backfill('sdk-source-record');

    const rows = await dataService.query<{ drained_at: Date | null }>(
      'SELECT drained_at FROM intake_outage_queue WHERE source_event_id = $1',
      [event.sourceEventId]
    );
    // "This event was delayed four hours by an outage" is exactly what someone
    // asks afterwards, and a deleted row cannot answer it.
    expect(rows[0].drained_at).not.toBeNull();
  });

  it('drains ONLY what was blocked on the recovered dependency', async () => {
    config.projexCloud.gatewayUrl = 'https://gateway.test';
    config.projexCloud.apiKey = 'token';
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const call = jest.spyOn(SdkGatewayClient, 'call').mockRejectedValue(new Error('down'));

    const event = signal();
    await IntakeService.accept(event);
    call.mockResolvedValue({ delivered: true, status: 201, data: null } as never);

    // A different dependency recovering must not retry events still waiting on
    // one that is down.
    const other = await IntakeService.backfill('sdk-notification');
    expect(other.drained).toBe(0);

    const rows = await dataService.query<{ drained_at: Date | null }>(
      'SELECT drained_at FROM intake_outage_queue WHERE source_event_id = $1',
      [event.sourceEventId]
    );
    expect(rows[0].drained_at).toBeNull();
  });

  it('does not queue the same event twice during a prolonged outage', async () => {
    config.projexCloud.gatewayUrl = 'https://gateway.test';
    config.projexCloud.apiKey = 'token';
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(SdkGatewayClient, 'call').mockRejectedValue(new Error('down'));

    const event = signal();
    await IntakeService.accept(event);
    // The provider retries while we are still down. The second delivery is a
    // replay, so it does no work — but even if it reached the queue it must not
    // create a second entry.
    await IntakeService.accept(event);

    const rows = await dataService.query(
      'SELECT 1 FROM intake_outage_queue WHERE source_event_id = $1',
      [event.sourceEventId]
    );
    expect(rows).toHaveLength(1);
  });
});
