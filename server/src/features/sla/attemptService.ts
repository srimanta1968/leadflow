import { dataService } from '../../services/DataService';
import { config } from '../../config/env';

/**
 * The VALID HUMAN ATTEMPT rule, and what it refuses. SOP §04 and §21.
 *
 * THE WHOLE SLA TURNS ON THIS. A rep reviewed the context, initiated a TRACKED
 * call from the approved number or dialer, allowed a reliable disposition,
 * logged the exact outcome and confirmed NEXT. A task click or a bulk email does
 * NOT satisfy the clock however many of them there are — and the refusal is
 * TYPED, so a caller learns which requirement was missing rather than being told
 * "invalid".
 *
 * Without this the SLA measures activity instead of contact, and a queue can be
 * cleared to 100% attainment by a rep who clicked twelve tasks and spoke to
 * nobody. That is the failure mode the rule exists to make impossible.
 */

/** What a rep did. Only the first two can ever satisfy the clock. */
export const ATTEMPT_KINDS = [
  'tracked_call',
  'manual_call',
  'task_click',
  'bulk_email',
  'individual_email',
  'sms',
  'voicemail',
] as const;

export type AttemptKind = (typeof ATTEMPT_KINDS)[number];

/** Kinds that can satisfy the SLA, given the rest of the evidence. */
const SATISFYING_KINDS: readonly AttemptKind[] = ['tracked_call', 'manual_call'];

/** Why an attempt did not count. Machine-readable so a client can branch. */
export type RefusalCode =
  | 'KIND_CANNOT_SATISFY'
  | 'NO_TRACKED_CALL'
  | 'NO_DISPOSITION'
  | 'NO_NEXT_ACTION'
  | 'CONTEXT_NOT_REVIEWED';

export interface AttemptEvidence {
  kind: AttemptKind;
  contextReviewed: boolean;
  trackedCallRef?: string | null;
  disposition?: string | null;
  nextAction?: string | null;
}

export interface AttemptVerdict {
  satisfies: boolean;
  code: RefusalCode | null;
  reason: string | null;
}

/**
 * Whether one attempt satisfies the clock.
 *
 * ORDERED SO THE MESSAGE IS USEFUL. The kind is checked first because "a bulk
 * email cannot satisfy the SLA" is a different conversation from "your call had
 * no disposition" — telling a rep who sent a mass mailshot that they forgot a
 * disposition would imply that adding one would have worked.
 */
export function evaluateAttempt(evidence: AttemptEvidence): AttemptVerdict {
  if (!SATISFYING_KINDS.includes(evidence.kind)) {
    return {
      satisfies: false,
      code: 'KIND_CANNOT_SATISFY',
      reason: `A ${evidence.kind.replace('_', ' ')} does not satisfy the response SLA. SOP §04 requires a tracked call from the approved number or dialer; activity is not contact.`,
    };
  }
  if (!evidence.contextReviewed) {
    return {
      satisfies: false,
      code: 'CONTEXT_NOT_REVIEWED',
      reason: 'The attempt does not record that the rep reviewed the context before calling.',
    };
  }
  if (!evidence.trackedCallRef || evidence.trackedCallRef.trim() === '') {
    return {
      satisfies: false,
      code: 'NO_TRACKED_CALL',
      reason: 'No tracked call reference. An untracked call cannot be verified against the dialer, so it cannot be counted.',
    };
  }
  if (!evidence.disposition || evidence.disposition.trim() === '') {
    return {
      satisfies: false,
      code: 'NO_DISPOSITION',
      reason: 'No disposition logged. The exact outcome is what makes the attempt auditable.',
    };
  }
  if (!evidence.nextAction || evidence.nextAction.trim() === '') {
    return {
      satisfies: false,
      code: 'NO_NEXT_ACTION',
      reason: 'No NEXT confirmed. SOP §04 requires the rep to leave the record with a next action.',
    };
  }
  return { satisfies: true, code: null, reason: null };
}

/** Record the attempt, whether or not it counted. */
export async function recordAttempt(input: {
  leadId: string;
  repUserId: string | null;
  evidence: AttemptEvidence;
  verdict: AttemptVerdict;
  occurredAt?: string;
}): Promise<string> {
  const rows = await dataService.query<{ attempt_id: string }>(
    `INSERT INTO leadflow_contact_attempt
       (tenant_id, lead_id, rep_user_id, kind, context_reviewed, tracked_call_ref,
        disposition, next_action, satisfies_sla, refusal_reason, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, COALESCE($11::timestamptz, now()))
     RETURNING attempt_id`,
    [
      config.projexCloud.tenantId,
      input.leadId,
      input.repUserId,
      input.evidence.kind,
      input.evidence.contextReviewed,
      input.evidence.trackedCallRef ?? null,
      input.evidence.disposition ?? null,
      input.evidence.nextAction ?? null,
      input.verdict.satisfies,
      input.verdict.reason,
      input.occurredAt ?? null,
    ]
  );
  return rows[0].attempt_id;
}

/**
 * Stamp the first response, but only for an attempt that actually counted.
 *
 * COALESCE so the FIRST valid attempt wins: a second call an hour later must not
 * rewrite the response time and turn a met SLA into a different number.
 */
export async function stampFirstResponse(leadId: string, at: string): Promise<void> {
  await dataService.query(
    `UPDATE leads SET first_response_at = COALESCE(first_response_at, $2::timestamptz), updated_at = now()
      WHERE id = $1`,
    [leadId, at]
  );
}

/** Record a breach with its mandatory reason and recovery. */
export async function recordBreach(input: {
  leadId: string;
  reasonCode: string;
  reasonDetail?: string | null;
  recoveryAction: string;
  recoveredByUserId?: string | null;
  systemic: boolean;
  incidentRef?: string | null;
  sourceTimestamp?: string | null;
  dueAt?: string | null;
}): Promise<{ breachId: string | null; alreadyRecorded: boolean }> {
  const rows = await dataService.query<{ breach_id: string }>(
    `INSERT INTO leadflow_sla_breach
       (tenant_id, lead_id, reason_code, reason_detail, recovery_action,
        recovered_by_user_id, systemic, incident_ref, source_timestamp, due_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (lead_id) DO NOTHING
     RETURNING breach_id`,
    [
      config.projexCloud.tenantId,
      input.leadId,
      input.reasonCode,
      input.reasonDetail ?? null,
      input.recoveryAction,
      input.recoveredByUserId ?? null,
      input.systemic,
      input.incidentRef ?? null,
      input.sourceTimestamp ?? null,
      input.dueAt ?? null,
    ]
  );
  return { breachId: rows[0]?.breach_id ?? null, alreadyRecorded: rows.length === 0 };
}

/** One slice of the attainment report. */
export interface AttainmentSlice {
  key: string;
  closed: number;
  met: number;
  breached: number;
  attainment_rate: number | null;
}

export interface AttainmentReport {
  window_days: number;
  overall: AttainmentSlice;
  by_source: AttainmentSlice[];
  by_rep: AttainmentSlice[];
  by_day: AttainmentSlice[];
  by_hour: AttainmentSlice[];
  median_first_attempt_minutes: number | null;
  p95_first_attempt_minutes: number | null;
  misses: {
    lead_id: string;
    reason_code: string;
    recovery_action: string;
    systemic: boolean;
    breached_at: string;
  }[];
  target_rate: number;
  meets_target: boolean;
}

/** The 95% business-hours target. */
export const ATTAINMENT_TARGET = 0.95;

const rate = (met: number, closed: number): number | null => (closed === 0 ? null : met / closed);

/**
 * The attainment report.
 *
 * EVERY MISS CARRIES ITS CAUSE AND RECOVERY, because a percentage on its own
 * changes nobody's behaviour. The breach table makes both mandatory, so a miss
 * without them cannot exist to be reported.
 *
 * PERCENTILES FROM THE ATTEMPT LEDGER, not from first_response_at, because the
 * ledger knows which attempts actually COUNTED — measuring from a task click
 * would report a median first attempt that nobody ever made.
 */
export async function attainment(windowDays = 30): Promise<AttainmentReport> {
  const rows = await dataService.query<{
    lead_id: string;
    source: string | null;
    owner_user_id: string | null;
    responded_at: string | null;
    source_timestamp: string | null;
    breached: boolean;
    minutes: string | null;
  }>(
    `SELECT l.id AS lead_id, l.source, l.owner_user_id,
            a.first_valid_at AS responded_at, l.source_timestamp,
            (b.breach_id IS NOT NULL) AS breached,
            EXTRACT(EPOCH FROM (a.first_valid_at - l.source_timestamp))/60 AS minutes
       FROM leads l
       LEFT JOIN LATERAL (
         SELECT MIN(occurred_at) AS first_valid_at
           FROM leadflow_contact_attempt c
          WHERE c.lead_id = l.id AND c.satisfies_sla = true
       ) a ON true
       LEFT JOIN leadflow_sla_breach b ON b.lead_id = l.id
      WHERE l.source_timestamp >= now() - ($1 || ' days')::interval
        AND (a.first_valid_at IS NOT NULL OR b.breach_id IS NOT NULL)`,
    [String(windowDays)]
  );

  const group = (keyOf: (r: (typeof rows)[number]) => string): AttainmentSlice[] => {
    const map = new Map<string, { closed: number; met: number; breached: number }>();
    for (const row of rows) {
      const key = keyOf(row) || 'unknown';
      const bag = map.get(key) ?? { closed: 0, met: 0, breached: 0 };
      bag.closed += 1;
      if (row.breached) bag.breached += 1;
      else bag.met += 1;
      map.set(key, bag);
    }
    return [...map.entries()].map(([key, v]) => ({
      key, closed: v.closed, met: v.met, breached: v.breached, attainment_rate: rate(v.met, v.closed),
    }));
  };

  const minutes = rows
    .map((r) => (r.minutes === null ? null : Number(r.minutes)))
    .filter((m): m is number => m !== null && Number.isFinite(m))
    .sort((a, b) => a - b);
  const pct = (p: number): number | null =>
    minutes.length === 0 ? null : Math.round(minutes[Math.min(minutes.length - 1, Math.floor(minutes.length * p))]);

  const closed = rows.length;
  const breached = rows.filter((r) => r.breached).length;
  const met = closed - breached;

  const breaches = await dataService.query<{
    lead_id: string; reason_code: string; recovery_action: string; systemic: boolean; breached_at: string;
  }>(
    `SELECT lead_id, reason_code, recovery_action, systemic, breached_at
       FROM leadflow_sla_breach
      WHERE breached_at >= now() - ($1 || ' days')::interval
      ORDER BY breached_at DESC LIMIT 500`,
    [String(windowDays)]
  );

  const overallRate = rate(met, closed);
  return {
    window_days: windowDays,
    overall: { key: 'overall', closed, met, breached, attainment_rate: overallRate },
    by_source: group((r) => r.source ?? 'unknown'),
    by_rep: group((r) => r.owner_user_id ?? 'unassigned'),
    by_day: group((r) => (r.source_timestamp ?? '').slice(0, 10)),
    by_hour: group((r) => (r.source_timestamp ?? '').slice(11, 13)),
    median_first_attempt_minutes: pct(0.5),
    p95_first_attempt_minutes: pct(0.95),
    misses: breaches,
    target_rate: ATTAINMENT_TARGET,
    // Null attainment is NOT a pass. An empty window has not met the target, it
    // has said nothing about it, and reporting true would be a green light
    // nobody earned.
    meets_target: overallRate !== null && overallRate >= ATTAINMENT_TARGET,
  };
}
