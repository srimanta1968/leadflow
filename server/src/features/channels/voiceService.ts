import { dataService } from '../../services/DataService';
import { config } from '../../config/env';
import { SdkGatewayClient } from '../../platform/sdkGateway';

/**
 * The voice channel. SOP §07, §29.
 *
 * TWO GATES BEFORE THE DIAL AND ONE BEFORE THE RECORDING. Calling hours and DNC
 * decide whether the call may be placed at all; the consent basis decides
 * whether it may be recorded. They are separate because their remedies are: a
 * call outside hours can be made later, a DNC number never, and an unrecorded
 * call can proceed perfectly well as long as nobody claims otherwise.
 *
 * RECORDING IS NEVER ASSUMED. A rep who believes a call was recorded and finds
 * later that it was not has lost the evidence they were relying on, so the
 * verdict is returned before the call and stored on the row.
 */

/** Permitted calling hours in the contact's local time. */
export const CALLING_HOURS = { start: 8, end: 21, basis: 'recipient_local' };

export interface DialResult {
  allowed: boolean;
  refusal: string | null;
  callId: string | null;
  trackingNumber: string | null;
  recordingPermitted: boolean;
  recordingBasis: string | null;
  recordingRefusal: string | null;
  /** False when the provider could not be reached. The row still exists. */
  placed: boolean;
}

/** The hour in a named zone, falling back to UTC when the zone is unusable. */
function hourIn(zone: string | null, at: Date): number {
  if (!zone) return at.getUTCHours();
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: '2-digit', hour12: false }).formatToParts(at);
    return Number(parts.find((p) => p.type === 'hour')?.value ?? '12') % 24;
  } catch {
    return at.getUTCHours();
  }
}

/** Whether the number is on a do-not-call list. */
async function isDnc(subjectRef: string): Promise<boolean> {
  const rows = await dataService.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM leadflow_suppression_signal
      WHERE subject_ref = $1 AND channel IN ('call','all')`,
    [subjectRef]
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

/**
 * Ask sdk-consent whether this call may be recorded.
 *
 * AN UNREACHABLE CONSENT SERVICE MEANS NO RECORDING. The failure modes are not
 * symmetric: recording without a basis is a legal exposure in every two-party
 * jurisdiction, while not recording costs a transcript. Only one of those is
 * recoverable.
 */
async function recordingBasisFor(subjectRef: string): Promise<{ permitted: boolean; basis: string | null; refusal: string | null }> {
  if (!SdkGatewayClient.isConfigured()) {
    return { permitted: false, basis: null, refusal: 'The consent service is unreachable, so no recording basis could be verified. The call will not be recorded.' };
  }
  try {
    const result = await SdkGatewayClient.call<{ data?: { granted?: boolean; basis?: string; reason?: string } }>({
      sdk: 'sdk-consent',
      path: '/api/consents/check',
      method: 'POST',
      body: { tenant_id: config.projexCloud.tenantId, subject_ref: subjectRef, purpose: 'call_recording' },
    });
    if (!result.delivered) {
      return { permitted: false, basis: null, refusal: 'The consent service did not answer, so the call will not be recorded.' };
    }
    const bag = result.data?.data ?? {};
    if (bag.granted === true) return { permitted: true, basis: bag.basis ?? 'consent_receipt', refusal: null };
    return { permitted: false, basis: null, refusal: bag.reason ?? 'No recording consent is on file for this contact.' };
  } catch {
    return { permitted: false, basis: null, refusal: 'The consent check failed, so the call will not be recorded.' };
  }
}

/** A tracking number for this source, so a callback keeps its attribution. */
async function trackingNumberFor(subjectRef: string): Promise<string | null> {
  const rows = await dataService.query<{ phone_number: string }>(
    `SELECT t.phone_number
       FROM leadflow_tracking_number t
       LEFT JOIN leads l ON l.id::text = $2
      WHERE t.tenant_id = $1 AND t.released_at IS NULL
        AND (t.source_key IS NULL OR t.source_key = l.source)
      ORDER BY (t.source_key IS NOT NULL) DESC
      LIMIT 1`,
    [config.projexCloud.tenantId, subjectRef]
  );
  return rows[0]?.phone_number ?? null;
}

/** Place a call, after the gates. */
export async function dialCall(input: {
  subjectRef: string;
  toNumber: string;
  repUserId: string | null;
  recordingRequested: boolean;
  recipientTimezone: string | null;
}): Promise<DialResult> {
  const now = new Date();
  const hour = hourIn(input.recipientTimezone, now);

  const base: DialResult = {
    allowed: false, refusal: null, callId: null, trackingNumber: null,
    recordingPermitted: false, recordingBasis: null, recordingRefusal: null, placed: false,
  };

  if (hour < CALLING_HOURS.start || hour >= CALLING_HOURS.end) {
    return { ...base, refusal: `It is ${hour}:00 where this contact is. Calling is permitted between ${CALLING_HOURS.start}:00 and ${CALLING_HOURS.end}:00 local time.` };
  }
  if (await isDnc(input.subjectRef)) {
    return { ...base, refusal: 'This contact is on the do-not-call list. The dialer is disabled for them.' };
  }

  const recording = input.recordingRequested
    ? await recordingBasisFor(input.subjectRef)
    : { permitted: false, basis: null, refusal: 'Recording was not requested for this call.' };

  const trackingNumber = await trackingNumberFor(input.subjectRef);

  const rows = await dataService.query<{ call_id: string }>(
    `INSERT INTO leadflow_voice_call
       (tenant_id, subject_ref, rep_user_id, tracking_number, recording_requested,
        recording_permitted, recording_basis, recording_refusal)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING call_id`,
    [
      config.projexCloud.tenantId, input.subjectRef, input.repUserId, trackingNumber,
      input.recordingRequested, recording.permitted, recording.basis, recording.refusal,
    ]
  );
  const callId = rows[0].call_id;

  let placed = false;
  if (SdkGatewayClient.isConfigured()) {
    try {
      const result = await SdkGatewayClient.call<{ data?: { voice_call_id?: string } }>({
        sdk: 'connector-twilio-voice',
        path: '/api/voice/calls',
        method: 'POST',
        idempotencyKey: `dial:${callId}`,
        body: {
          tenant_id: config.projexCloud.tenantId, to: input.toNumber,
          from: trackingNumber, record: recording.permitted, subject_ref: input.subjectRef,
        },
      });
      placed = result.delivered;
      if (result.data?.data?.voice_call_id) {
        await dataService.query(
          `UPDATE leadflow_voice_call SET provider_call_ref = $2 WHERE call_id = $1`,
          [callId, result.data.data.voice_call_id]
        );
      }
    } catch {
      placed = false;
    }
  }

  return {
    allowed: true, refusal: null, callId, trackingNumber,
    recordingPermitted: recording.permitted, recordingBasis: recording.basis,
    recordingRefusal: recording.refusal, placed,
  };
}

/** Close a call out with its disposition, its NEXT and any voicemail. */
export async function recordCallDisposition(input: {
  callId: string;
  disposition: string;
  nextAction: string;
  voicemailTranscript: string | null;
  actorUserId: string | null;
}): Promise<{ found: boolean; voicemailLogged: boolean; attemptId: string | null; crmRecorded: boolean }> {
  const rows = await dataService.query<{ call_id: string; subject_ref: string; recording_permitted: boolean }>(
    `UPDATE leadflow_voice_call
        SET disposition = $2, voicemail_transcript = $3, ended_at = COALESCE(ended_at, now())
      WHERE call_id = $1
      RETURNING call_id, subject_ref, recording_permitted`,
    [input.callId, input.disposition, input.voicemailTranscript]
  );
  if (rows.length === 0) {
    return { found: false, voicemailLogged: false, attemptId: null, crmRecorded: false };
  }
  const call = rows[0];

  /*
   * THE VOICEMAIL AND THE ATTEMPT ARE ONE EVENT. Logging them separately leaves
   * a timeline with a call and an unattached transcript that a reader has to
   * correlate by timestamp — which they will get wrong on a busy day.
   */
  let attemptId: string | null = null;
  const attempt = await dataService.query<{ attempt_id: string }>(
    `INSERT INTO leadflow_contact_attempt
       (tenant_id, lead_id, rep_user_id, kind, context_reviewed, tracked_call_ref,
        disposition, next_action, satisfies_sla)
     SELECT $1, l.id, $3, $4, TRUE, $5, $6, $7, $8
       FROM leads l WHERE l.id::text = $2
     RETURNING attempt_id`,
    [
      config.projexCloud.tenantId, call.subject_ref, input.actorUserId,
      input.voicemailTranscript ? 'voicemail' : 'tracked_call',
      input.callId, input.disposition, input.nextAction,
      // A voicemail is an attempt but not a conversation, so it does not satisfy
      // the response SLA — the same rule the attempt service enforces.
      !input.voicemailTranscript,
    ]
  );
  attemptId = attempt[0]?.attempt_id ?? null;
  if (attemptId) {
    await dataService.query(`UPDATE leadflow_voice_call SET attempt_id = $2 WHERE call_id = $1`, [input.callId, attemptId]);
  }

  let crmRecorded = false;
  if (SdkGatewayClient.isConfigured()) {
    try {
      const result = await SdkGatewayClient.call({
        sdk: 'sdk-crm',
        path: input.voicemailTranscript ? '/api/crm/activities/voicemail' : '/api/crm/activities/call',
        method: 'POST',
        idempotencyKey: `call-activity:${input.callId}`,
        body: {
          tenant_id: config.projexCloud.tenantId, subject_ref: call.subject_ref,
          disposition: input.disposition, next_action: input.nextAction,
          transcript: input.voicemailTranscript, recorded: call.recording_permitted,
        },
      });
      crmRecorded = result.delivered;
    } catch {
      crmRecorded = false;
    }
  }

  return { found: true, voicemailLogged: Boolean(input.voicemailTranscript), attemptId, crmRecorded };
}
