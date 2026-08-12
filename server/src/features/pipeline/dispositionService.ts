import { dataService } from '../../services/DataService';
import { config } from '../../config/env';
import { SdkGatewayClient } from '../../platform/sdkGateway';
import { CLOSE_REASONS, DISPOSITION_CODES } from '../../config/verticalProfile';

/**
 * Dispositions that DRIVE automation, and the Closed-Lost capture. SOP §07, §15.
 *
 * A DISPOSITION IS NOT A LABEL. Recording "no answer" is supposed to send the
 * approved follow-up within two minutes; recording "wrong number" is supposed to
 * suppress the channel and open a Data Repair case. A taxonomy that only
 * describes what happened leaves every one of those to a human who is already on
 * the next call.
 *
 * EXACTLY ONCE. Each automation claims its slot by INSERTing a dedupe key into
 * leadflow_disposition_event, which carries a UNIQUE index — so a rep who logs
 * "no answer" twice, or a retry after a timeout, cannot send the prospect two
 * follow-ups. A refused insert means the automation already ran.
 */

/** What a disposition sets off. */
export interface AutomationAction {
  kind: string;
  detail: string;
  /** False when the upstream that would perform it could not be reached. */
  performed: boolean;
}

export const DISPOSITION_KEYS = DISPOSITION_CODES.map((d) => d.key);
export const CLOSE_REASON_KEYS = CLOSE_REASONS.map((r) => r.key);

/** SOP §15's seven close-lost codes, which the record must use. */
export const LOST_REASON_CODES = ['NO_FIT', 'TIMING', 'BUDGET', 'FEATURE', 'RIVAL', 'TRUST', 'NO_REPLY'] as const;
export type LostReasonCode = (typeof LOST_REASON_CODES)[number];

const call = async (sdk: string, path: string, body: unknown, idempotencyKey: string): Promise<boolean> => {
  if (!SdkGatewayClient.isConfigured()) return false;
  try {
    const result = await SdkGatewayClient.call({ sdk, path, method: 'POST', idempotencyKey, body });
    return result.delivered;
  } catch {
    return false;
  }
};

/**
 * The follow-up window SOP §07 sets for an unanswered call.
 *
 * Two minutes is short enough that the prospect still remembers the missed call
 * and long enough that a rep who dialled by mistake can undo it.
 */
export const NO_ANSWER_FOLLOW_UP_MINUTES = 2;

/**
 * Run the automation a disposition implies.
 *
 * THE DEDUPE KEY IS PART OF THE CONTRACT, not an implementation detail: it is
 * what makes "no duplicate sends" true rather than likely. Keyed on the record
 * and the automation rather than on the disposition row, so logging the same
 * outcome twice is one send while two genuinely different outcomes are two.
 */
export async function runDispositionAutomation(input: {
  subjectRef: string;
  codeKey: string;
  actorUserId: string | null;
  scheduledAt?: string | null;
}): Promise<{ actions: AutomationAction[]; alreadyRan: boolean; eventId: string | null }> {
  const actions: AutomationAction[] = [];
  const dedupeKey = `${input.codeKey}`;

  const claimed = await dataService.query<{ event_id: string }>(
    `INSERT INTO leadflow_disposition_event (tenant_id, subject_ref, code_key, dedupe_key, created_by, actions)
     VALUES ($1,$2,$3,$4,$5,'[]'::jsonb)
     ON CONFLICT (tenant_id, subject_ref, dedupe_key) DO NOTHING
     RETURNING event_id`,
    [config.projexCloud.tenantId, input.subjectRef, input.codeKey, dedupeKey, input.actorUserId]
  );

  if (claimed.length === 0) {
    // Already ran for this record. Reported rather than silently repeated.
    return { actions: [], alreadyRan: true, eventId: null };
  }
  const eventId = claimed[0].event_id;

  switch (input.codeKey) {
    case 'CONNECTED':
    case 'CALLBACK_REQUESTED': {
      // Pause prospecting: automation must not keep chasing somebody a human is
      // already talking to.
      actions.push({
        kind: 'sequence.pause',
        detail: 'Active prospecting paused — a human is in conversation.',
        performed: await call('sdk-sequence', '/api/sequences/enrollments/pause',
          { tenant_id: config.projexCloud.tenantId, subject_ref: input.subjectRef, reason: 'human_conversation' },
          `disp-pause:${input.subjectRef}:${input.codeKey}`),
      });
      if (input.scheduledAt) {
        actions.push({
          kind: 'task.create',
          detail: `Callback task created for ${input.scheduledAt}.`,
          performed: await call('sdk-crm', '/api/crm/activities',
            { tenant_id: config.projexCloud.tenantId, subject_ref: input.subjectRef, kind: 'callback', due_at: input.scheduledAt },
            `disp-task:${input.subjectRef}:${input.codeKey}`),
        });
      }
      break;
    }
    case 'NO_ANSWER':
    case 'VOICEMAIL': {
      /*
       * AC1 of #118 — the approved email plus eligible SMS within two minutes,
       * with no duplicate. Eligibility is NOT decided here: the send is handed to
       * the channel decision engine, which runs the consent, suppression and
       * quiet-hours checks. Deciding it here would put a second, weaker copy of
       * that logic in front of the customer.
       */
      const sendAt = new Date(Date.now() + NO_ANSWER_FOLLOW_UP_MINUTES * 60_000).toISOString();
      actions.push({
        kind: 'email.send',
        detail: `Approved no-answer email queued for ${sendAt} (T+${NO_ANSWER_FOLLOW_UP_MINUTES}m).`,
        performed: await call('sdk-notification', '/api/notifications',
          { tenant_id: config.projexCloud.tenantId, subject_ref: input.subjectRef, channels: ['email'], template: 'no_answer_follow_up', send_at: sendAt },
          `disp-email:${input.subjectRef}:no_answer`),
      });
      actions.push({
        kind: 'sms.send_if_eligible',
        detail: 'SMS queued subject to the channel decision engine — consent, suppression and quiet hours are checked there, not here.',
        performed: await call('sdk-notification', '/api/notifications',
          { tenant_id: config.projexCloud.tenantId, subject_ref: input.subjectRef, channels: ['sms'], template: 'no_answer_follow_up', send_at: sendAt, require_eligibility: true },
          `disp-sms:${input.subjectRef}:no_answer`),
      });
      break;
    }
    case 'WRONG_NUMBER':
    case 'BOUNCED': {
      /* AC2 of #118 — suppress the bad channel AND open a Data Repair case. Both:
         suppressing without a case leaves nobody to fix the record, and a case
         without suppression keeps dialling the wrong person meanwhile. */
      const channel = input.codeKey === 'BOUNCED' ? 'email' : 'sms,call';
      actions.push({
        kind: 'suppression.apply',
        detail: `${channel} suppressed for this record — the contact point is wrong, not merely unanswered.`,
        performed: await call('sdk-deliverability', '/api/suppressions',
          { tenant_id: config.projexCloud.tenantId, subject_ref: input.subjectRef, channel, reason: input.codeKey.toLowerCase() },
          `disp-suppress:${input.subjectRef}:${input.codeKey}`),
      });
      actions.push({
        kind: 'case.open',
        detail: 'Data Repair case opened so somebody corrects the contact point.',
        performed: await call('sdk-incident', '/api/incidents',
          { tenant_id: config.projexCloud.tenantId, kind: 'data_repair', severity: 'low', title: 'Contact point is wrong', affected_refs: [input.subjectRef] },
          `disp-case:${input.subjectRef}:${input.codeKey}`),
      });
      break;
    }
    case 'OPTED_OUT': {
      actions.push({
        kind: 'sequence.cancel',
        detail: 'Sequence cancelled outright — automation never argues with a human who has said stop.',
        performed: await call('sdk-sequence', '/api/sequences/enrollments/cancel',
          { tenant_id: config.projexCloud.tenantId, subject_ref: input.subjectRef, reason: 'opted_out' },
          `disp-cancel:${input.subjectRef}:opted_out`),
      });
      actions.push({
        kind: 'suppression.apply',
        detail: 'Suppression applied across every channel.',
        performed: await call('sdk-deliverability', '/api/suppressions',
          { tenant_id: config.projexCloud.tenantId, subject_ref: input.subjectRef, channel: 'all', reason: 'opted_out' },
          `disp-suppress:${input.subjectRef}:opted_out`),
      });
      break;
    }
    default:
      actions.push({
        kind: 'none',
        detail: `${input.codeKey} is recorded for reporting and drives no automation.`,
        performed: true,
      });
  }

  await dataService.query(
    `UPDATE leadflow_disposition_event SET actions = $2::jsonb WHERE event_id = $1`,
    [eventId, JSON.stringify(actions)]
  );

  return { actions, alreadyRan: false, eventId };
}

/** The Closed-Lost capture SOP §15 requires. */
export async function captureClosedLost(input: {
  subjectRef: string;
  reasonCode: string;
  prospectWording: string;
  offerVersion: string;
  competingOption?: string | null;
  learningNote?: string | null;
  revisitAt?: string | null;
  closedBy: string | null;
}): Promise<{ captureId: string | null; alreadyCaptured: boolean }> {
  const rows = await dataService.query<{ capture_id: string }>(
    `INSERT INTO leadflow_close_capture
       (tenant_id, subject_ref, reason_code, prospect_wording, offer_version,
        competing_option, learning_note, revisit_at, closed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9)
     ON CONFLICT (tenant_id, subject_ref) DO NOTHING
     RETURNING capture_id`,
    [
      config.projexCloud.tenantId, input.subjectRef, input.reasonCode,
      input.prospectWording, input.offerVersion,
      input.competingOption ?? null, input.learningNote ?? null,
      input.revisitAt ?? null, input.closedBy,
    ]
  );
  return { captureId: rows[0]?.capture_id ?? null, alreadyCaptured: rows.length === 0 };
}

/** Record a capability this deal depends on, and its real status. */
export async function recordFeatureDependency(input: {
  subjectRef: string;
  capability: string;
  status: 'available' | 'in_development' | 'roadmap' | 'not_planned';
  promisedDate?: string | null;
  note?: string | null;
}): Promise<void> {
  await dataService.query(
    `INSERT INTO leadflow_feature_dependency (tenant_id, subject_ref, capability, status, promised_date, note)
     VALUES ($1,$2,$3,$4,$5::date,$6)
     ON CONFLICT (tenant_id, subject_ref, capability)
     DO UPDATE SET status = EXCLUDED.status, promised_date = EXCLUDED.promised_date, note = EXCLUDED.note`,
    [
      config.projexCloud.tenantId, input.subjectRef, input.capability,
      input.status, input.promisedDate ?? null, input.note ?? null,
    ]
  );
}
