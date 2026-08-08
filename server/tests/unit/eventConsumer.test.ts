import crypto from 'crypto';
import { dataService } from '../../src/services/DataService';
import {
  advancePipeline,
  apply,
  emptyState,
  fold,
  ingest,
  projectionFingerprint,
  rebuildPipeline,
  verifyDelivery,
  type DomainEvent,
} from '../../src/platform/events';

/**
 * The four guarantees, in the order the criteria state them.
 *
 * The headline one — "killing the consumer mid-stream and restarting produces
 * byte-identical projection state" — is exercised for real against the live
 * database rather than argued for: events are ingested, the consumer is advanced
 * partway, abandoned, and advanced again from a cold checkpoint read, and the
 * fingerprint is compared with the same stream folded in one pass.
 */

const RUN = crypto.randomUUID().slice(0, 8);
const subject = (n: number): string => `subj-${RUN}-${n}`;

function event(n: number, type: string, subjectId: string, payload: Record<string, unknown> = {}): DomainEvent {
  return {
    eventId: `evt-${RUN}-${n}`,
    eventType: type,
    sequence: n,
    occurredAt: `2026-08-0${(n % 9) + 1}T10:00:00.000Z`,
    subjectType: 'lead',
    subjectId,
    tenantId: null,
    payload,
  };
}

/** The stream every restart test replays. Deliberately interleaves subjects. */
function stream(): DomainEvent[] {
  const a = subject(1);
  const b = subject(2);
  return [
    event(1, 'assignment.owner_assigned.v1', a, { owner_id: 'rep-1', backup_owner_id: 'rep-2' }),
    event(2, 'crm.deal.stage_changed.v1', b, { to_stage: 'ATTEMPTING_CONTACT' }),
    event(3, 'sla.rung_fired.v1', a, { rung: 'at_risk', due_at: '2026-08-02T12:00:00.000Z' }),
    event(4, 'scheduling.booking_created.v1', b, { starts_at: '2026-08-05T15:00:00.000Z' }),
    event(5, 'deliverability.reply_received.v1', a, { channel: 'email' }),
    event(6, 'crm.deal.stage_changed.v1', a, { to_stage: 'CONNECTED_QUALIFYING' }),
    event(7, 'scheduling.booking_no_show.v1', b, {}),
    event(8, 'payment.succeeded.v1', b, {}),
    event(9, 'crm.deal.closed_won.v1', b, { reason_key: 'WON_STANDARD' }),
  ];
}

async function ingestAll(events: DomainEvent[]): Promise<void> {
  for (const e of events) {
    await ingest({
      eventId: e.eventId,
      eventType: e.eventType,
      tenantId: e.tenantId,
      occurredAt: e.occurredAt,
      subjectType: e.subjectType,
      subjectId: e.subjectId,
      payload: e.payload,
      signatureVerified: true,
    });
  }
}

/*
 * Cleanup runs BEFORE, not after.
 *
 * tests/setup.ts registers a root-level afterAll that closes the pool, and root
 * afterAll hooks run in registration order — so setup's ran first and any
 * cleanup here hit "Cannot use a pool after calling end on the pool". Deleting
 * on the way IN is both correct and better: it also clears rows a previously
 * killed run left behind, which is exactly the situation this file creates.
 */
beforeAll(async () => {
  await dataService.query(`DELETE FROM leadflow_event_log WHERE event_id LIKE 'evt-%'`);
  await dataService.query(`DELETE FROM leadflow_pipeline_projection WHERE subject_id LIKE 'subj-%'`);
  await dataService.query(`DELETE FROM leadflow_event_dead_letter WHERE event_id LIKE 'evt-%'`);
});

/* ------------------------------------------- the fold, with no database at all */

describe('the projection is a pure fold', () => {
  it('produces the same state however the events are batched', () => {
    // The property the restart guarantee rests on. If folding 9 events in one
    // pass differs from 4-then-5, no amount of careful restart handling saves us.
    const all = stream().filter((e) => e.subjectId === subject(1));
    const oneGo = fold(all);
    const inTwo = fold(all.slice(2), fold(all.slice(0, 2)) ?? undefined);
    expect(inTwo).toEqual(oneGo);
  });

  it('DROPS an event that arrives after a later one, rather than rewinding', () => {
    // At-least-once says nothing about order. Without the sequence guard a
    // delayed stage_changed lands after closed_won and moves a won deal back to
    // Contacted — silently, and only under load.
    const won = fold([
      event(9, 'crm.deal.closed_won.v1', subject(1), { reason_key: 'WON_STANDARD' }),
    ])!;
    const late = apply(won, event(6, 'crm.deal.stage_changed.v1', subject(1), { to_stage: 'NURTURE' }));
    expect(late.stageKey).toBe('CLOSED_WON_ONBOARDING_PENDING');
    expect(late).toBe(won);
  });

  it('ignores an unknown event type instead of failing on it', () => {
    // ProjexCloud adding an event type must not dead-letter a stream we are
    // otherwise handling correctly.
    const before = emptyState('s', 'lead', null);
    const after = apply(before, event(1, 'something.brand.new.v1', 's', {}));
    expect(after.stageKey).toBeNull();
    // The sequence still advances, or the checkpoint would stall on it forever.
    expect(after.lastSequence).toBe(1);
  });

  it('never lets a complaint look like engagement', () => {
    const replied = fold([event(1, 'deliverability.reply_received.v1', 's', { channel: 'email' })])!;
    expect(replied.slaState).toBe('responded');
    const complained = apply(replied, event(2, 'deliverability.complaint.v1', 's', {}));
    expect(complained.lastReplyChannel).toBe('complaint');
  });

  it('does not move ownership on a REJECTED handoff', () => {
    const owned = fold([event(1, 'assignment.owner_assigned.v1', 's', { owner_id: 'rep-1' })])!;
    const rejected = apply(owned, event(2, 'handoff.rejected.v1', 's', { reason: 'wrong territory' }));
    // Still rep-1's, and the queue is told why rather than silently leaving it
    // with somebody who declined it.
    expect(rejected.ownerId).toBe('rep-1');
    expect(rejected.nextAction).toContain('wrong territory');
  });
});

/* ------------------------------------------------- idempotency and restart */

describe('the consumer is idempotent and restartable', () => {
  it('records an event once however many times it is delivered', async () => {
    const events = stream();
    await ingestAll(events);
    const first = await dataService.query<{ n: string }>(
      `SELECT count(*)::int AS n FROM leadflow_event_log WHERE event_id LIKE $1`, [`evt-${RUN}-%`]);

    // Redelivered in full, which is what at-least-once means in practice.
    await ingestAll(events);
    await ingestAll(events);
    const after = await dataService.query<{ n: string }>(
      `SELECT count(*)::int AS n FROM leadflow_event_log WHERE event_id LIKE $1`, [`evt-${RUN}-%`]);

    expect(Number(first[0].n)).toBe(events.length);
    expect(Number(after[0].n)).toBe(events.length);
  });

  it('reports a redelivery as a duplicate rather than throwing', async () => {
    const [one] = stream();
    const again = await ingest({
      eventId: one.eventId, eventType: one.eventType, tenantId: null,
      occurredAt: one.occurredAt, subjectType: 'lead', subjectId: one.subjectId,
      payload: one.payload, signatureVerified: true,
    });
    // A redelivery is NORMAL. Treating the routine case as an error fills the
    // log with noise that hides the real ones.
    expect(again).toMatchObject({ accepted: false, duplicate: true });
  });

  it('KILLED MID-STREAM AND RESTARTED, lands byte-identically', async () => {
    // The acceptance criterion, run for real.
    await rebuildPipeline();
    const complete = await projectionFingerprint();
    expect(complete).not.toBe('empty');

    // Now simulate the kill: wipe the projection, reset the checkpoint, and
    // advance in small batches, abandoning between each — exactly what a process
    // dying between batches leaves behind.
    await dataService.query(`DELETE FROM leadflow_pipeline_projection`);
    await dataService.query(
      `UPDATE leadflow_projection_checkpoint SET last_sequence = 0 WHERE projection_name = 'pipeline'`);

    let guard = 0;
    for (;;) {
      const pass = await advancePipeline(2);   // two at a time, then "die"
      if (pass.to <= pass.from || (guard += 1) > 200) break;
    }

    // Byte-identical, not merely equivalent.
    expect(await projectionFingerprint()).toBe(complete);
  });

  it('rebuilds from the log without any manual patching', async () => {
    const before = await projectionFingerprint();
    // The honest fix for a projection bug: recompute from what actually
    // happened. A hand-patched derived table agrees with nothing afterwards.
    await dataService.query(
      `UPDATE leadflow_pipeline_projection SET stage_key = 'CORRUPTED' WHERE subject_id LIKE $1`,
      [`subj-${RUN}-%`]);
    expect(await projectionFingerprint()).not.toBe(before);

    await rebuildPipeline();
    expect(await projectionFingerprint()).toBe(before);
  });

  it('never projects an event whose signature did not verify', async () => {
    const forged = `evt-${RUN}-forged`;
    await ingest({
      eventId: forged, eventType: 'crm.deal.closed_won.v1', tenantId: null,
      occurredAt: '2026-08-09T10:00:00.000Z', subjectType: 'lead',
      subjectId: subject(1), payload: { reason_key: 'WON_STANDARD' },
      signatureVerified: false,
    });
    await advancePipeline();

    const rows = await dataService.query<{ stage_key: string | null }>(
      `SELECT stage_key FROM leadflow_pipeline_projection WHERE subject_id = $1`, [subject(1)]);
    // Recorded as evidence that something tried, never treated as a fact.
    expect(rows[0]?.stage_key).not.toBe('CLOSED_WON_ONBOARDING_PENDING');
    await dataService.query(`DELETE FROM leadflow_event_log WHERE event_id = $1`, [forged]);
  });
});

/* ------------------------------------------------------ delivery signatures */

describe('inbound deliveries are verified the way ProjexCloud signs them', () => {
  const secret = 'whsec_test_value';
  const eventId = 'evt-sig-1';
  const rawBody = '{"event_type":"crm.deal.closed_won.v1","subject_id":"lead-9"}';

  /** Built exactly as sdk-webhook's hmacSigner does: ts.eventId.body */
  const sign = (ts: number, body = rawBody, id = eventId, key = secret): string =>
    `t=${ts},v1=${crypto.createHmac('sha256', key).update(`${ts}.${id}.${body}`, 'utf8').digest('hex')}`;

  const now = 1_800_000_000;

  it('accepts a correctly signed delivery', () => {
    const r = verifyDelivery({
      rawBody, eventId, algo: 'hmac-sha256', secret,
      signatureHeader: sign(now), nowSeconds: now,
    });
    expect(r).toMatchObject({ ok: true, state: 'verified' });
  });

  it('rejects a body that was altered after signing', () => {
    const header = sign(now);
    const r = verifyDelivery({
      rawBody: rawBody.replace('lead-9', 'lead-8'),
      eventId, algo: 'hmac-sha256', secret, signatureHeader: header, nowSeconds: now,
    });
    expect(r).toMatchObject({ ok: false, state: 'bad_signature' });
  });

  it('rejects a body re-attributed to a DIFFERENT event id', () => {
    // The event id is inside the signed string, which is what stops a captured
    // delivery being replayed as some other event — and it is the id we
    // deduplicate on, so the two cannot be separated.
    const r = verifyDelivery({
      rawBody, eventId: 'evt-sig-2', algo: 'hmac-sha256', secret,
      signatureHeader: sign(now), nowSeconds: now,
    });
    expect(r.ok).toBe(false);
  });

  it('rejects a stale delivery even when the signature is perfect', () => {
    // A replay guard separate from validity: the signature of a captured
    // delivery stays correct forever, because the body never changed.
    const r = verifyDelivery({
      rawBody, eventId, algo: 'hmac-sha256', secret,
      signatureHeader: sign(now - 3600), nowSeconds: now,
    });
    expect(r).toMatchObject({ ok: false, state: 'stale' });
  });

  it('FAILS CLOSED when no secret is configured', () => {
    // Accepting on the grounds that we cannot check would let anybody who finds
    // the URL write into the projections.
    const r = verifyDelivery({
      rawBody, eventId, algo: 'hmac-sha256', secret: '',
      signatureHeader: sign(now), nowSeconds: now,
    });
    expect(r).toMatchObject({ ok: false, state: 'not_configured' });
  });

  it('rejects a malformed header instead of crashing on it', () => {
    for (const header of ['', 'garbage', 't=abc,v1=xyz', 'v1=deadbeef']) {
      expect(verifyDelivery({
        rawBody, eventId, algo: 'hmac-sha256', secret,
        signatureHeader: header, nowSeconds: now,
      }).ok).toBe(false);
    }
  });
});
