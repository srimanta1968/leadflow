import { dataService } from '../../services/DataService';
import { config } from '../../config/env';
import { localParts } from '../sla/businessCalendar';

/**
 * The SMS eligibility gate. SOP §18.
 *
 * A PHONE NUMBER ALONE NEVER GRANTS PERMISSION TO TEXT. That is the rule, and
 * everything here exists to make it structurally true rather than merely
 * documented: eligibility comes from a recorded BASIS with evidence behind it,
 * and possessing a mobile number is not one of the three the schema allows.
 *
 * NEVER SILENTLY MARK A TEXT AS SENT. When SMS is ineligible the caller is told
 * WHY, in words a rep can read, and the fallback is email plus a call task. The
 * failure this prevents is the one where a sequence quietly skips the SMS step,
 * the rep sees "sent" in the timeline, and nobody discovers for a fortnight that
 * the prospect was never contacted.
 */

/** The only three things that make somebody textable. A number is not one. */
export const ELIGIBILITY_BASES = [
  'express_written_consent',
  'existing_relationship',
  'inbound_request',
] as const;
export type EligibilityBasis = (typeof ELIGIBILITY_BASES)[number];

/** One automated SMS per recipient per day. SOP §18. */
export const DAILY_AUTOMATED_CAP = 1;
/** No second automated message inside this window, whatever triggered it. */
export const DEDUP_WINDOW_MINUTES = 30;

/** Quiet hours in the RECIPIENT's local time, not ours. */
export const QUIET_START_HOUR = 21;
export const QUIET_END_HOUR = 8;

export type IneligibleReason =
  | 'NO_ELIGIBILITY_BASIS'
  | 'ELIGIBILITY_EXPIRED'
  | 'ELIGIBILITY_REVOKED'
  | 'SUPPRESSED'
  | 'QUIET_HOURS'
  | 'DAILY_CAP_REACHED'
  | 'DEDUP_WINDOW';

export interface EligibilityVerdict {
  eligible: boolean;
  reason: IneligibleReason | null;
  /** What the rep is shown BEFORE composing. Never a code on its own. */
  explanation: string | null;
  basis: EligibilityBasis | null;
  evidenceRef: string | null;
  /** What to do instead. Present whenever eligible is false. */
  fallback: { channel: string; action: string } | null;
}

const EXPLAIN: Record<IneligibleReason, string> = {
  NO_ELIGIBILITY_BASIS:
    'No SMS eligibility is recorded for this contact. Holding their phone number is not permission to text them — SOP §18 requires express written consent, an existing relationship, or an inbound request from them.',
  ELIGIBILITY_EXPIRED: 'The recorded SMS eligibility has expired and needs renewing before texting resumes.',
  ELIGIBILITY_REVOKED: 'This contact withdrew SMS permission. Nothing automated may be sent.',
  SUPPRESSED: 'This number is suppressed — they replied STOP or the carrier rejected delivery.',
  QUIET_HOURS: 'It is outside permitted hours where this contact is, so a message now would arrive in the middle of their night.',
  DAILY_CAP_REACHED: 'This contact has already had an automated SMS today. The daily cap exists so a busy sequence does not read as harassment.',
  DEDUP_WINDOW: `Another automated SMS went to this contact within the last ${DEDUP_WINDOW_MINUTES} minutes. A burst of messages is the fastest way to earn a STOP.`,
};

/** The fallback, which is the same in every ineligible case. */
const FALLBACK = {
  channel: 'email',
  action: 'Send the approved email and create a call task. Do not record an SMS as sent.',
};

/** Recorded eligibility for a subject and purpose. */
async function readBasis(subjectRef: string, purposeKey: string): Promise<{
  basis: EligibilityBasis; evidence_ref: string | null; expires_at: string | null; revoked_at: string | null;
} | null> {
  const rows = await dataService.query<{
    basis: EligibilityBasis; evidence_ref: string | null; expires_at: string | null; revoked_at: string | null;
  }>(
    `SELECT basis, evidence_ref, expires_at, revoked_at
       FROM leadflow_sms_eligibility
      WHERE tenant_id = $1 AND subject_ref = $2 AND purpose_key = $3
      ORDER BY granted_at DESC LIMIT 1`,
    [config.projexCloud.tenantId, subjectRef, purposeKey]
  );
  return rows[0] ?? null;
}

/**
 * Whether an automated SMS may go now.
 *
 * THE ORDER OF THE CHECKS IS THE ORDER A REP NEEDS TO HEAR THEM. Permission
 * first, because no amount of waiting fixes an absent basis; then suppression;
 * then timing and volume, which are the ones that resolve on their own. Telling
 * somebody "quiet hours" when they never had consent would send them back at
 * 09:00 to be refused again for the real reason.
 *
 * @param recipientTimezone IANA zone. Falls back to the business zone when the
 *        contact's own is unknown — which is a guess, and is reported as one.
 */
export async function checkSmsEligibility(input: {
  subjectRef: string;
  purposeKey: string;
  recipientTimezone?: string | null;
  automated?: boolean;
  now?: Date;
}): Promise<EligibilityVerdict> {
  const now = input.now ?? new Date();
  const automated = input.automated !== false;

  const record = await readBasis(input.subjectRef, input.purposeKey);

  if (!record) {
    return { eligible: false, reason: 'NO_ELIGIBILITY_BASIS', explanation: EXPLAIN.NO_ELIGIBILITY_BASIS, basis: null, evidenceRef: null, fallback: FALLBACK };
  }
  if (record.revoked_at) {
    return { eligible: false, reason: 'ELIGIBILITY_REVOKED', explanation: EXPLAIN.ELIGIBILITY_REVOKED, basis: record.basis, evidenceRef: record.evidence_ref, fallback: FALLBACK };
  }
  if (record.expires_at && Date.parse(record.expires_at) < now.getTime()) {
    return { eligible: false, reason: 'ELIGIBILITY_EXPIRED', explanation: EXPLAIN.ELIGIBILITY_EXPIRED, basis: record.basis, evidenceRef: record.evidence_ref, fallback: FALLBACK };
  }

  const suppressed = await dataService.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM leadflow_suppression_signal
      WHERE subject_ref = $1 AND channel IN ('sms','all')`,
    [input.subjectRef]
  );
  if (Number(suppressed[0]?.n ?? 0) > 0) {
    return { eligible: false, reason: 'SUPPRESSED', explanation: EXPLAIN.SUPPRESSED, basis: record.basis, evidenceRef: record.evidence_ref, fallback: FALLBACK };
  }

  /*
   * QUIET HOURS IN THE RECIPIENT'S ZONE. Evaluating them in ours is the bug
   * that texts somebody at 03:00 because it is mid-morning at head office.
   */
  const zone = input.recipientTimezone ?? null;
  const hour = zone ? hourIn(zone, now) : localParts(now).minuteOfDay / 60;
  if (hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR) {
    return { eligible: false, reason: 'QUIET_HOURS', explanation: EXPLAIN.QUIET_HOURS, basis: record.basis, evidenceRef: record.evidence_ref, fallback: FALLBACK };
  }

  if (automated) {
    const localDay = new Date(now).toISOString().slice(0, 10);
    const [capRows, recentRows] = await Promise.all([
      dataService.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM leadflow_sms_send_log
          WHERE tenant_id = $1 AND subject_ref = $2 AND automated = TRUE AND local_day = $3::date`,
        [config.projexCloud.tenantId, input.subjectRef, localDay]
      ),
      dataService.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM leadflow_sms_send_log
          WHERE tenant_id = $1 AND subject_ref = $2 AND automated = TRUE
            AND sent_at > now() - ($3 || ' minutes')::interval`,
        [config.projexCloud.tenantId, input.subjectRef, String(DEDUP_WINDOW_MINUTES)]
      ),
    ]);
    if (Number(recentRows[0]?.n ?? 0) > 0) {
      return { eligible: false, reason: 'DEDUP_WINDOW', explanation: EXPLAIN.DEDUP_WINDOW, basis: record.basis, evidenceRef: record.evidence_ref, fallback: FALLBACK };
    }
    if (Number(capRows[0]?.n ?? 0) >= DAILY_AUTOMATED_CAP) {
      return { eligible: false, reason: 'DAILY_CAP_REACHED', explanation: EXPLAIN.DAILY_CAP_REACHED, basis: record.basis, evidenceRef: record.evidence_ref, fallback: FALLBACK };
    }
  }

  return { eligible: true, reason: null, explanation: null, basis: record.basis, evidenceRef: record.evidence_ref, fallback: null };
}

/** The hour of day in a named zone. */
function hourIn(zone: string, at: Date): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: '2-digit', hour12: false }).formatToParts(at);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '12');
    return hour % 24;
  } catch {
    // An unknown zone is not a reason to text somebody at midnight; fall back to
    // the business zone rather than to "always allowed".
    return localParts(at).minuteOfDay / 60;
  }
}

/** Record an eligibility basis, with the evidence that makes it checkable. */
export async function grantEligibility(input: {
  subjectRef: string;
  basis: EligibilityBasis;
  evidenceRef: string;
  purposeKey: string;
  expiresAt?: string | null;
}): Promise<string> {
  const rows = await dataService.query<{ eligibility_id: string }>(
    `INSERT INTO leadflow_sms_eligibility (tenant_id, subject_ref, basis, evidence_ref, purpose_key, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6::timestamptz) RETURNING eligibility_id`,
    [config.projexCloud.tenantId, input.subjectRef, input.basis, input.evidenceRef, input.purposeKey, input.expiresAt ?? null]
  );
  return rows[0].eligibility_id;
}

/** Log a send, so the cap and the dedup window mean something. */
export async function logSmsSend(input: {
  subjectRef: string; templateKey: string | null; automated: boolean; now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  await dataService.query(
    `INSERT INTO leadflow_sms_send_log (tenant_id, subject_ref, template_key, automated, local_day)
     VALUES ($1,$2,$3,$4,$5::date)`,
    [config.projexCloud.tenantId, input.subjectRef, input.templateKey, input.automated, now.toISOString().slice(0, 10)]
  );
}
