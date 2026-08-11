import { dataService } from '../../services/DataService';

/**
 * The local operational answer to "may we still contact this person?".
 *
 * WHY THIS IS LOCAL AT ALL, when sdk-deliverability owns the provider-side
 * suppression list: the acceptance criterion is that a STOP produces zero
 * further automated sends WITHIN ONE TICK. An upstream call cannot promise
 * that. It can be slow, rate-limited, circuit-broken or simply unconfigured in
 * this deployment — and every one of those failure modes resolves, in the
 * composer, to "we could not check", which is `review` rather than a hard stop.
 * Review is the right answer for an unknown. It is the WRONG answer for
 * somebody who has already texted STOP, because a human triaging the review
 * queue may well approve it.
 *
 * So the stop is written down here, synchronously, before the ingest endpoint
 * answers. The channel-decision composer then reads it first and denies
 * outright. The upstream suppression list is still authoritative for the
 * PROVIDER's behaviour and is reconciled against daily; this is what makes the
 * platform's own behaviour immediate.
 */

export type SuppressionChannel = 'email' | 'sms' | 'call' | 'social' | 'push' | 'all';

export type StopSignal =
  | 'sms_stop'
  | 'sms_help'
  | 'email_unsubscribe'
  | 'spam_complaint'
  | 'hard_bounce'
  | 'dnc_registration'
  | 'wrong_number'
  | 'staff_revocation'
  | 'release';

export type SuppressionSource = 'provider' | 'staff' | 'subject' | 'reconciliation';

const CHANNELS: Exclude<SuppressionChannel, 'all'>[] = ['email', 'sms', 'call', 'social', 'push'];

/**
 * Which channels each signal stops.
 *
 * THE TWO ENTRIES WORTH ARGUING ABOUT:
 *
 * `sms_stop` stops EVERYTHING, not just SMS. Somebody who replies STOP has not
 * said "stop texting me, but email is fine" — they have said stop. Reading it
 * narrowly is how a person who opted out receives a marketing email the next
 * morning and complains to a regulator instead of to us. The task's acceptance
 * criterion says the same thing in operational terms: zero further automated
 * sends on ANY channel.
 *
 * `sms_help` stops NOTHING. HELP is a request for information, and the carrier
 * requires an auto-reply to it. Treating it as an opt-out would suppress
 * somebody for asking a question. It is recorded because the auto-reply is a
 * send that must be attributable, not because it suppresses.
 */
const SIGNAL_SCOPE: Record<Exclude<StopSignal, 'release'>, SuppressionChannel[]> = {
  sms_stop: ['all'],
  sms_help: [],
  email_unsubscribe: ['email'],
  spam_complaint: ['email'],
  hard_bounce: ['email'],
  // A DNC registration is about being telephoned, which covers both the voice
  // call and the text message; it says nothing about email.
  dnc_registration: ['call', 'sms'],
  // The number belongs to somebody else entirely. Continuing to use it is
  // contacting a person who never had any relationship with the tenant.
  wrong_number: ['call', 'sms'],
  staff_revocation: ['all'],
};

export interface RecordSignalInput {
  tenantId?: string | null;
  subjectRef: string;
  signal: StopSignal;
  source: SuppressionSource;
  /** Only meaningful for `release`, and for signals scoped to one channel. */
  channel?: SuppressionChannel;
  reason?: string;
  receiptRef?: string;
  /** When the SUBJECT acted, if that is not now. */
  occurredAt?: string;
  correlationId?: string;
  recordedBy?: string | null;
}

export interface SuppressionState {
  channel: Exclude<SuppressionChannel, 'all'>;
  suppressed: boolean;
  signal: StopSignal | null;
  source: SuppressionSource | null;
  reason: string | null;
  since: string | null;
}

/** The channels a signal suppresses, expanded from 'all'. */
export function channelsFor(signal: StopSignal, channel?: SuppressionChannel): string[] {
  if (signal === 'release') {
    return channel && channel !== 'all' ? [channel] : [...CHANNELS];
  }
  const scope = SIGNAL_SCOPE[signal];
  if (scope.length === 0) return [];
  if (scope.includes('all')) return [...CHANNELS];
  // A signal with its own scope is never widened by the caller naming a
  // channel — a hard bounce is about email whatever the request says.
  return scope.filter((c): c is Exclude<SuppressionChannel, 'all'> => c !== 'all');
}

/**
 * Write the signal down. One row per channel it speaks for, so the composer's
 * read is a single indexed lookup rather than a scope calculation at send time.
 */
export async function recordSignal(
  input: RecordSignalInput,
): Promise<{ signalId: string | null; channels: string[] }> {
  const channels = channelsFor(input.signal, input.channel);
  if (channels.length === 0) {
    // HELP, and nothing else today. Recorded nowhere because it suppresses
    // nothing; the caller still gets a truthful answer about what happened.
    return { signalId: null, channels: [] };
  }

  const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
  const params: unknown[] = [];
  const tuples: string[] = [];
  for (const channel of channels) {
    const b = params.length;
    tuples.push(
      `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10})`,
    );
    params.push(
      input.tenantId ?? null, input.subjectRef, channel, input.signal, input.source,
      input.reason ?? null, input.receiptRef ?? null, occurredAt,
      input.correlationId ?? null, input.recordedBy ?? null,
    );
  }

  const rows = await dataService.query<{ id: string }>(
    `INSERT INTO leadflow_suppression_signal
       (tenant_id, subject_ref, channel, signal, source, reason, receipt_ref,
        occurred_at, correlation_id, recorded_by)
     VALUES ${tuples.join(',')}
     RETURNING id`,
    params,
  );

  return { signalId: rows[0].id, channels };
}

/**
 * The current state per channel, derived from the ledger.
 *
 * MOST-RESTRICTIVE WINS, and the implementation is the ORDER BY rather than a
 * comparison in application code. Two sources can disagree — the provider's
 * webhook says suppressed, a staff member has just pressed release, a
 * reconciliation has inserted a stop dated yesterday — and the rule is that a
 * suppression beats a release at the SAME instant. `signal = 'release'` sorts
 * last within a timestamp, so a stop and a release recorded in the same tick
 * resolve to suppressed. That is the only safe tie-break: the cost of holding
 * a message that could have gone is an inconvenience, and the cost of sending
 * one that should have been held is a breach.
 */
export async function effectiveState(
  subjectRef: string,
  tenantId?: string | null,
): Promise<SuppressionState[]> {
  const rows = await dataService.query<{
    channel: string; signal: StopSignal; source: SuppressionSource;
    reason: string | null; occurred_at: Date;
  }>(
    `SELECT DISTINCT ON (channel) channel, signal, source, reason, occurred_at
       FROM leadflow_suppression_signal
      WHERE subject_ref = $1
        AND ($2::text IS NULL OR tenant_id IS NOT DISTINCT FROM $2::text)
      ORDER BY channel, occurred_at DESC, (signal = 'release') ASC, recorded_at DESC`,
    [subjectRef, tenantId ?? null],
  );

  const byChannel = new Map(rows.map((r) => [r.channel, r]));
  return CHANNELS.map((channel) => {
    const row = byChannel.get(channel);
    if (!row) {
      return { channel, suppressed: false, signal: null, source: null, reason: null, since: null };
    }
    return {
      channel,
      suppressed: row.signal !== 'release',
      signal: row.signal,
      source: row.source,
      reason: row.reason,
      since: new Date(row.occurred_at).toISOString(),
    };
  });
}

/**
 * The single question the channel-decision composer asks, kept to one indexed
 * row because it runs on every send decision and on every subject of a 100,000
 * audience.
 */
export async function isSuppressed(
  subjectRef: string,
  channel: string,
  tenantId?: string | null,
): Promise<{ suppressed: boolean; signal: StopSignal | null; since: string | null }> {
  const row = await dataService.queryOne<{ signal: StopSignal; occurred_at: Date }>(
    `SELECT signal, occurred_at
       FROM leadflow_suppression_signal
      WHERE subject_ref = $1 AND channel = $2
        AND ($3::text IS NULL OR tenant_id IS NOT DISTINCT FROM $3::text)
      ORDER BY occurred_at DESC, (signal = 'release') ASC, recorded_at DESC
      LIMIT 1`,
    [subjectRef, channel, tenantId ?? null],
  );
  if (!row || row.signal === 'release') {
    return { suppressed: false, signal: null, since: null };
  }
  return {
    suppressed: true,
    signal: row.signal,
    since: new Date(row.occurred_at).toISOString(),
  };
}

/**
 * The same question for a whole audience, in ONE query.
 *
 * Without this the bulk channel-decision endpoint would issue 100,000 lookups
 * to answer a campaign — reintroducing per-subject round trips into the exact
 * path that was rebuilt to remove them.
 */
export async function suppressedSet(
  subjects: { subjectRef: string; channel: string }[],
  tenantId?: string | null,
): Promise<Map<string, { signal: StopSignal; since: string }>> {
  const out = new Map<string, { signal: StopSignal; since: string }>();
  if (subjects.length === 0) return out;
  const refs = [...new Set(subjects.map((s) => s.subjectRef))];
  const rows = await dataService.query<{
    subject_ref: string; channel: string; signal: StopSignal; occurred_at: Date;
  }>(
    `SELECT DISTINCT ON (subject_ref, channel) subject_ref, channel, signal, occurred_at
       FROM leadflow_suppression_signal
      WHERE subject_ref = ANY($1::text[])
        AND ($2::text IS NULL OR tenant_id IS NOT DISTINCT FROM $2::text)
      ORDER BY subject_ref, channel, occurred_at DESC, (signal = 'release') ASC, recorded_at DESC`,
    [refs, tenantId ?? null],
  );
  for (const row of rows) {
    // The SIGNAL is carried, not just the fact of suppression: the composer
    // picks the sentence an operator reads from it, and a bulk decision that
    // lost it would tell a whole campaign "somebody here recorded that we must
    // not contact them" when the truth was a hard bounce.
    if (row.signal === 'release') continue;
    out.set(suppressionKey(row.subject_ref, row.channel), {
      signal: row.signal,
      since: new Date(row.occurred_at).toISOString(),
    });
  }
  return out;
}

export const suppressionKey = (subjectRef: string, channel: string): string =>
  `${subjectRef}::${channel}`;
