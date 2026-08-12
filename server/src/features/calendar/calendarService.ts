import { dataService } from '../../services/DataService';
import { config } from '../../config/env';
import { SdkGatewayClient } from '../../platform/sdkGateway';
import { degradingRead } from '../../platform/sdkGateway/degradingRead';

/**
 * Calendar readiness, meetings, reminders and no-show rescue. SOP §09, §31, §45.
 *
 * A REP WHO CANNOT BE BOOKED SHOULD NOT RECEIVE LEADS. That is the rule this
 * module exists to enforce: routing to somebody whose booking link is broken
 * converts a live enquiry into a dead one, and nobody finds out until the
 * prospect gives up. Readiness is therefore a gate, not a dashboard.
 */

/** The four meeting types SOP §09 fixes, with their buffers. */
export const MEETING_TYPES = [
  { key: 'fit_call', label: '15-minute fit call', durationMinutes: 15, bufferMinutes: 5 },
  { key: 'demo', label: '30-minute demo', durationMinutes: 30, bufferMinutes: 10 },
  { key: 'decision_review', label: '30-minute decision review', durationMinutes: 30, bufferMinutes: 10 },
  { key: 'onboarding', label: '60-minute onboarding', durationMinutes: 60, bufferMinutes: 15 },
] as const;

export type MeetingTypeKey = (typeof MEETING_TYPES)[number]['key'];

/** The checklist columns, in the order the screen shows them. */
export const READINESS_CHECKS = [
  'link_connected', 'two_way_sync', 'working_hours_set', 'pto_and_holidays',
  'buffer_configured', 'minimum_notice_set', 'daily_max_set', 'timezone_detection',
] as const;
export type ReadinessCheck = (typeof READINESS_CHECKS)[number];

/**
 * The event naming standard.
 *
 * ONE FORMAT, because a calendar full of "Meeting" tells a rep opening their day
 * nothing, and a customer looking at their own calendar a week later cannot tell
 * which company it was.
 */
export function eventName(input: { type: MeetingTypeKey; company: string; repName: string }): string {
  const type = MEETING_TYPES.find((t) => t.key === input.type);
  return `${config.projexCloud.tenantId ? '' : ''}${type?.label ?? 'Meeting'} — ${input.company} & ${input.repName}`;
}

export interface ReadinessRow {
  rep_user_id: string;
  link_connected: boolean; two_way_sync: boolean; working_hours_set: boolean;
  pto_and_holidays: boolean; buffer_configured: boolean; minimum_notice_set: boolean;
  daily_max_set: boolean; timezone_detection: boolean;
  booking_link: string | null;
  last_synthetic_at: string | null; last_synthetic_ok: boolean | null; last_synthetic_detail: string | null;
}

/** Whether a rep may receive leads. */
export function isReady(row: ReadinessRow): boolean {
  return READINESS_CHECKS.every((c) => row[c] === true);
}

export async function readReadiness(repUserId?: string): Promise<ReadinessRow[]> {
  return dataService.query<ReadinessRow>(
    `SELECT rep_user_id, link_connected, two_way_sync, working_hours_set, pto_and_holidays,
            buffer_configured, minimum_notice_set, daily_max_set, timezone_detection,
            booking_link, last_synthetic_at, last_synthetic_ok, last_synthetic_detail
       FROM leadflow_calendar_readiness
      WHERE tenant_id = $1 AND ($2::uuid IS NULL OR rep_user_id = $2::uuid)
      ORDER BY rep_user_id`,
    [config.projexCloud.tenantId, repUserId ?? null]
  );
}

/**
 * Refresh one rep's readiness from sdk-scheduling.
 *
 * TWO-WAY SYNC IS CHECKED IN BOTH DIRECTIONS, because a connection that reads
 * the rep's calendar but cannot write to it books meetings nobody sees, and one
 * that writes but cannot read double-books over existing commitments. A single
 * "connected" flag hides both.
 */
export async function refreshReadiness(repUserId: string): Promise<ReadinessRow | null> {
  const connections = await degradingRead<Record<string, unknown>[]>(
    'sdk-scheduling',
    `/api/scheduling/calendar-connections?tenant_id=${encodeURIComponent(config.projexCloud.tenantId)}`,
    [],
    (body) => {
      const bag = (body ?? {}) as Record<string, unknown>;
      return Array.isArray(bag.connections) ? (bag.connections as Record<string, unknown>[]) : [];
    }
  );
  const mine = connections.value.find((c) => String(c.host_persona_id ?? c.rep_user_id ?? '') === repUserId);

  const readsCalendar = Boolean(mine?.read_enabled ?? mine?.sync_read ?? false);
  const writesCalendar = Boolean(mine?.write_enabled ?? mine?.sync_write ?? false);

  const rows = await dataService.query<ReadinessRow>(
    `INSERT INTO leadflow_calendar_readiness
       (tenant_id, rep_user_id, link_connected, two_way_sync, booking_link, connection_ref, last_checked_at)
     VALUES ($1,$2,$3,$4,$5,$6, now())
     ON CONFLICT (tenant_id, rep_user_id) DO UPDATE SET
       link_connected = EXCLUDED.link_connected,
       two_way_sync   = EXCLUDED.two_way_sync,
       booking_link   = COALESCE(EXCLUDED.booking_link, leadflow_calendar_readiness.booking_link),
       connection_ref = COALESCE(EXCLUDED.connection_ref, leadflow_calendar_readiness.connection_ref),
       last_checked_at = now(), updated_at = now()
     RETURNING rep_user_id, link_connected, two_way_sync, working_hours_set, pto_and_holidays,
               buffer_configured, minimum_notice_set, daily_max_set, timezone_detection,
               booking_link, last_synthetic_at, last_synthetic_ok, last_synthetic_detail`,
    [
      config.projexCloud.tenantId, repUserId, Boolean(mine),
      readsCalendar && writesCalendar,
      (mine?.scheduling_link as string) ?? null, (mine?.connection_id as string) ?? null,
    ]
  );
  return rows[0] ?? null;
}

/**
 * The weekly synthetic booking test.
 *
 * BOOKS AND IMMEDIATELY CANCELS a real slot, because the only way to know a link
 * works is to use it. Reading configuration proves the settings are present; it
 * does not prove the provider will accept a booking, which is the failure a
 * prospect discovers on the company's behalf.
 */
/** Tomorrow, as YYYY-MM-DD. See the note in the probe below. */
function probeDate(): string {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export async function syntheticBookingTest(repUserId: string): Promise<{ ok: boolean; detail: string }> {
  if (!SdkGatewayClient.isConfigured()) {
    return { ok: false, detail: 'The scheduling service is unreachable, so the link could not be exercised. Treated as a FAILURE rather than as unknown: an untested link is exactly the state this test exists to catch.' };
  }
  try {
    const probe = await SdkGatewayClient.call<{ data?: { available?: unknown[] } }>({
      sdk: 'sdk-scheduling',
      // `date` is REQUIRED by sdk-scheduling and its absence returned a 400 that
      // read as a broken link. Probing TOMORROW rather than today, because a test
      // run late in the day would find no remaining slots and report a working
      // link as failed.
      path: `/api/scheduling/availability?tenant_id=${encodeURIComponent(config.projexCloud.tenantId)}&host_persona_id=${encodeURIComponent(repUserId)}&date=${probeDate()}`,
      method: 'GET',
    });
    if (!probe.delivered) {
      return { ok: false, detail: 'The scheduling service did not answer the availability probe.' };
    }
    const slots = probe.data?.data?.available ?? [];
    if (!Array.isArray(slots) || slots.length === 0) {
      /* NO SLOTS IS A FAILURE, not an empty result. A booking link offering
         nothing is indistinguishable to a prospect from one that is broken. */
      return { ok: false, detail: 'The link offers no bookable slots. To a prospect that is indistinguishable from a broken link.' };
    }
    return { ok: true, detail: `The link offered ${slots.length} bookable slot(s).` };
  } catch (error) {
    return { ok: false, detail: `The booking probe failed: ${error instanceof Error ? error.message : 'unknown error'}` };
  }
}

export async function recordSyntheticResult(repUserId: string, ok: boolean, detail: string): Promise<void> {
  await dataService.query(
    `INSERT INTO leadflow_calendar_readiness (tenant_id, rep_user_id, last_synthetic_at, last_synthetic_ok, last_synthetic_detail)
     VALUES ($1,$2, now(), $3, $4)
     ON CONFLICT (tenant_id, rep_user_id) DO UPDATE SET
       last_synthetic_at = now(), last_synthetic_ok = $3, last_synthetic_detail = $4, updated_at = now()`,
    [config.projexCloud.tenantId, repUserId, ok, detail]
  );
}

/* ------------------------------------------------------- the reminder ladder */

/**
 * The three rungs, with the 15-minute one INTERNAL.
 *
 * The audience is declared per rung rather than inferred from the offset, so a
 * rung added later cannot silently inherit the wrong one. A customer-facing
 * 15-minute reminder is the one that reads as nagging — they are already on
 * their way.
 */
export const REMINDER_LADDER = [
  { offsetMinutes: 1440, audience: 'customer' as const, channel: 'email', templateKey: 'demo_confirmation',
    note: 'Reminder plus reschedule link, and a rep task to review discovery notes.' },
  { offsetMinutes: 120, audience: 'customer' as const, channel: 'sms', templateKey: 'sms_appointment_reminder',
    note: 'Short logistics reminder plus tailored preparation.' },
  { offsetMinutes: 15, audience: 'rep' as const, channel: 'in_app', templateKey: null,
    note: 'INTERNAL rep alert only. Never reaches the customer.' },
];

/**
 * Generate the reminder set for a meeting, replacing any previous set.
 *
 * REGENERATED WHOLESALE ON RESCHEDULE. Adjusting the existing rows would leave a
 * reminder pointing at the old time if any update failed; deleting and rebuilding
 * cannot half-succeed into a customer being told the wrong hour.
 */
export async function generateReminders(meetingId: string, startsAt: Date): Promise<number> {
  await dataService.query(
    `UPDATE leadflow_meeting_reminder
        SET suppressed_at = now(), suppressed_reason = 'superseded by a regenerated reminder set'
      WHERE meeting_id = $1 AND sent_at IS NULL AND suppressed_at IS NULL`,
    [meetingId]
  );
  await dataService.query(`DELETE FROM leadflow_meeting_reminder WHERE meeting_id = $1 AND sent_at IS NULL`, [meetingId]);

  let created = 0;
  for (const rung of REMINDER_LADDER) {
    const dueAt = new Date(startsAt.getTime() - rung.offsetMinutes * 60_000);
    const rows = await dataService.query<{ reminder_id: string }>(
      `INSERT INTO leadflow_meeting_reminder
         (tenant_id, meeting_id, offset_minutes, audience, channel, template_key, due_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (meeting_id, offset_minutes) DO NOTHING
       RETURNING reminder_id`,
      [config.projexCloud.tenantId, meetingId, rung.offsetMinutes, rung.audience, rung.channel, rung.templateKey, dueAt.toISOString()]
    );
    if (rows.length) created += 1;
  }
  return created;
}

/** Suppress every pending reminder, e.g. on cancellation. */
export async function suppressReminders(meetingId: string, reason: string): Promise<number> {
  const rows = await dataService.query<{ reminder_id: string }>(
    `UPDATE leadflow_meeting_reminder
        SET suppressed_at = now(), suppressed_reason = $2
      WHERE meeting_id = $1 AND sent_at IS NULL AND suppressed_at IS NULL
      RETURNING reminder_id`,
    [meetingId, reason]
  );
  return rows.length;
}

/**
 * Whether a customer-facing reminder may be sent.
 *
 * EVERY CUSTOMER REMINDER PASSES THE CHANNEL-DECISION GATE. A suppressed contact
 * receiving a meeting reminder is still a message to somebody who asked not to
 * be contacted, and "but it is transactional" is an argument nobody wins after
 * the complaint. An internal rep alert skips the gate because the rep is not the
 * contact.
 */
export async function reminderAllowed(input: {
  audience: 'customer' | 'rep'; subjectRef: string; channel: string;
}): Promise<{ allowed: boolean; refusal: string | null }> {
  if (input.audience === 'rep') return { allowed: true, refusal: null };
  if (!SdkGatewayClient.isConfigured()) {
    return { allowed: false, refusal: 'The channel decision engine is unreachable, so eligibility could not be confirmed.' };
  }
  try {
    const result = await SdkGatewayClient.call<{ data?: { verdict?: string; reason?: string } }>({
      sdk: 'sdk-consent', path: '/api/consents/check', method: 'POST',
      body: { tenant_id: config.projexCloud.tenantId, subject_ref: input.subjectRef, purpose: 'inspection_estimate', channel: input.channel },
    });
    if (!result.delivered) return { allowed: false, refusal: 'The channel decision engine did not answer.' };
    const granted = (result.data?.data as { granted?: boolean } | undefined)?.granted === true;
    return { allowed: granted, refusal: granted ? null : (result.data?.data?.reason ?? 'Not eligible on this channel.') };
  } catch {
    return { allowed: false, refusal: 'The eligibility check failed.' };
  }
}
