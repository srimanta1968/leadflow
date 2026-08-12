import { dataService } from '../../services/DataService';
import { config } from '../../config/env';
import { degradingRead } from '../../platform/sdkGateway/degradingRead';
import { applyStop } from './sequenceExecutor';

/**
 * Inbound signals: replies, bounces and SMS keywords, turned into stops.
 *
 * A PULL, NOT A SUBSCRIPTION, and that is upstream's shape rather than a
 * shortcut. sdk-deliverability emits no domain events at all — it exposes
 * `GET /api/deliverability/reply-events` and `/bounce-events`, and
 * sdk-notification exposes `GET /api/notifications/sms-inbound`. There is
 * nothing to subscribe to, so this polls and drives the stop rules from what it
 * finds. If those services ever emit, the existing webhook receiver can call the
 * same `handleSignal` and this poller becomes redundant rather than wrong.
 *
 * THIS IS THE PIECE THAT MAKES THE CADENCE HONEST. Without it every stop rule is
 * correct and unreachable: a prospect could reply, bounce or text STOP and the
 * sequence would keep sending, because the only caller of `applyStop` was a
 * human recording it after the fact.
 *
 * IDEMPOTENT BY WATERMARK. Each source is polled from the last event this
 * process consumed, and every stop is keyed on the enrolment and signal, so a
 * re-poll that sees the same event again stops nothing twice.
 */

/** Where each source got to, so a re-poll does not re-handle old events. */
async function watermark(source: string): Promise<string | null> {
  const rows = await dataService.query<{ detail: string }>(
    `SELECT detail FROM leadflow_sequence_guard_log
      WHERE tenant_id = $1 AND guard = 'inbound_watermark' AND outcome = 'allowed'
        AND detail LIKE $2
      ORDER BY created_at DESC LIMIT 1`,
    [config.projexCloud.tenantId, `${source}:%`]
  );
  const detail = rows[0]?.detail;
  return detail ? detail.slice(source.length + 1) : null;
}

async function setWatermark(source: string, at: string): Promise<void> {
  await dataService.query(
    `INSERT INTO leadflow_sequence_guard_log (tenant_id, guard, outcome, detail)
     VALUES ($1, 'inbound_watermark', 'allowed', $2)`,
    [config.projexCloud.tenantId, `${source}:${at}`]
  );
}

/** The active enrolment for a subject, if any. */
async function enrollmentFor(subjectRef: string): Promise<string | null> {
  const rows = await dataService.query<{ enrollment_id: string }>(
    `SELECT enrollment_id FROM leadflow_sequence_enrollment
      WHERE tenant_id = $1 AND subject_ref = $2 AND status IN ('active','paused')
      ORDER BY enrolled_at DESC LIMIT 1`,
    [config.projexCloud.tenantId, subjectRef]
  );
  return rows[0]?.enrollment_id ?? null;
}

/**
 * Resolve a contact point back to a LeadFlow record.
 *
 * MATCHES ON THE CANONICAL COLUMNS the capture pipeline already normalises into,
 * rather than on the raw string. An address that arrived as "Bob@Example.COM "
 * and a reply from "bob@example.com" are the same person, and matching raw text
 * would miss the stop entirely — which is the one failure this whole module
 * exists to prevent.
 */
async function subjectForContact(address: string | null, phone: string | null): Promise<string | null> {
  if (!address && !phone) return null;
  const rows = await dataService.query<{ id: string }>(
    `SELECT id FROM leads
      WHERE ($1::text IS NOT NULL AND (canonical_email = lower(btrim($1)) OR lower(email) = lower(btrim($1))))
         OR ($2::text IS NOT NULL AND canonical_phone = regexp_replace($2, '[^0-9]', '', 'g'))
      ORDER BY created_at DESC LIMIT 1`,
    [address, phone]
  );
  return rows[0]?.id ?? null;
}

export interface SignalOutcome {
  source: string;
  subjectRef: string | null;
  signal: string;
  applied: boolean;
  reason: string | null;
}

/**
 * Turn one inbound signal into a stop.
 *
 * SHARED BY THE POLLER AND THE WEBHOOK RECEIVER. When ProjexCloud starts
 * emitting these as events, the receiver calls this and nothing else changes.
 */
export async function handleSignal(input: {
  source: string;
  signal: string;
  address?: string | null;
  phone?: string | null;
  subjectRef?: string | null;
  detail?: string | null;
}): Promise<SignalOutcome> {
  const subjectRef = input.subjectRef ?? (await subjectForContact(input.address ?? null, input.phone ?? null));
  if (!subjectRef) {
    return { source: input.source, subjectRef: null, signal: input.signal, applied: false, reason: 'no matching record' };
  }

  const enrollmentId = await enrollmentFor(subjectRef);
  if (!enrollmentId) {
    return { source: input.source, subjectRef, signal: input.signal, applied: false, reason: 'no active enrolment' };
  }

  const result = await applyStop({
    enrollmentId, signal: input.signal, detail: input.detail ?? null, actorUserId: null,
  });
  return {
    source: input.source, subjectRef, signal: input.signal,
    applied: result.found, reason: result.reason,
  };
}

/** One poll of every inbound source. */
export async function pollInboundSignals(): Promise<{
  polled: string[];
  outcomes: SignalOutcome[];
  stopped: number;
  upstream: Record<string, boolean>;
}> {
  const outcomes: SignalOutcome[] = [];
  const upstream: Record<string, boolean> = {};
  const tenant = encodeURIComponent(config.projexCloud.tenantId);

  /* ------------------------------------------------------------- replies */
  const replies = await degradingRead<Record<string, unknown>[]>(
    'sdk-deliverability',
    `/api/deliverability/reply-events?tenant_id=${tenant}&limit=200`,
    [],
    (body) => {
      const bag = (body ?? {}) as Record<string, unknown>;
      return Array.isArray(bag.events) ? (bag.events as Record<string, unknown>[]) : [];
    }
  );
  upstream['reply-events'] = replies.available;
  const replyMark = await watermark('reply');
  let newestReply = replyMark;
  for (const event of replies.value) {
    const at = String(event.created_at ?? event.received_at ?? '');
    if (replyMark && at && at <= replyMark) continue;
    if (!newestReply || (at && at > newestReply)) newestReply = at;
    outcomes.push(await handleSignal({
      source: 'reply-events',
      // A REPLY IS A HUMAN TALKING. Every generic step after it argues with them.
      signal: 'inbound_reply',
      address: (event.from_address as string) ?? null,
      detail: (event.subject as string) ?? null,
    }));
  }
  if (newestReply && newestReply !== replyMark) await setWatermark('reply', newestReply);

  /* ------------------------------------------------------------- bounces */
  const bounces = await degradingRead<Record<string, unknown>[]>(
    'sdk-deliverability',
    `/api/deliverability/bounce-events?tenant_id=${tenant}&limit=200`,
    [],
    (body) => {
      const bag = (body ?? {}) as Record<string, unknown>;
      return Array.isArray(bag.events) ? (bag.events as Record<string, unknown>[]) : [];
    }
  );
  upstream['bounce-events'] = bounces.available;
  const bounceMark = await watermark('bounce');
  let newestBounce = bounceMark;
  for (const event of bounces.value) {
    const at = String(event.created_at ?? event.received_at ?? '');
    if (bounceMark && at && at <= bounceMark) continue;
    if (!newestBounce || (at && at > newestBounce)) newestBounce = at;
    const classification = String(event.classification ?? '').toLowerCase();
    /*
     * A SOFT BOUNCE IS NOT A DEAD CHANNEL. Only a hard bounce or a complaint
     * stops the cadence; a full mailbox that clears next week should not
     * permanently end the relationship. Upstream already applied its own
     * suppression — this mirrors the CONSEQUENCE for the sequence.
     */
    if (classification !== 'hard' && classification !== 'complaint' && classification !== 'hard_bounce') continue;
    outcomes.push(await handleSignal({
      source: 'bounce-events', signal: 'hard_bounce',
      address: (event.address as string) ?? null,
      detail: `${classification}${event.event_type ? ` (${String(event.event_type)})` : ''}`,
    }));
  }
  if (newestBounce && newestBounce !== bounceMark) await setWatermark('bounce', newestBounce);

  /* --------------------------------------------------------- sms inbound */
  const sms = await degradingRead<Record<string, unknown>[]>(
    'sdk-notification',
    `/api/notifications/sms-inbound?tenant_id=${tenant}&limit=200`,
    [],
    (body) => {
      const bag = (body ?? {}) as Record<string, unknown>;
      return Array.isArray(bag.messages) ? (bag.messages as Record<string, unknown>[]) : [];
    }
  );
  upstream['sms-inbound'] = sms.available;
  const smsMark = await watermark('sms');
  let newestSms = smsMark;
  for (const message of sms.value) {
    const at = String(message.created_at ?? message.received_at ?? '');
    if (smsMark && at && at <= smsMark) continue;
    if (!newestSms || (at && at > newestSms)) newestSms = at;
    const intent = String(message.intent ?? '').toLowerCase();
    /*
     * STOP OUTRANKS EVERYTHING. An opt-out is not a reply to be paused on — it
     * ends contact on every channel, so it maps to opt_out rather than to
     * inbound_reply. HELP is answered by the provider auto-reply and is
     * explicitly NOT a stop: asking for help is not asking to be left alone.
     */
    if (intent === 'help') continue;
    const signal = intent === 'stop' || intent === 'opt_out' ? 'opt_out' : 'inbound_reply';
    outcomes.push(await handleSignal({
      source: 'sms-inbound', signal,
      phone: (message.from_phone as string) ?? (message.phone as string) ?? null,
      detail: intent || 'inbound sms',
    }));
  }
  if (newestSms && newestSms !== smsMark) await setWatermark('sms', newestSms);

  return {
    polled: ['reply-events', 'bounce-events', 'sms-inbound'],
    outcomes,
    stopped: outcomes.filter((o) => o.applied).length,
    upstream,
  };
}
