import { dataService } from '../../services/DataService';
import { config } from '../../config/env';
import { SdkGatewayClient } from '../../platform/sdkGateway';
import { overnightPlan, type OvernightPlan } from './businessCalendar';

/**
 * The after-hours, weekend and holiday path. SOP §04.
 *
 * NEVER PROMISE A CALLBACK NOBODY CAN MAKE. That is the rule this file exists
 * for. A prospect asking for same-night contact is routed to an approved on-call
 * rep ONLY when coverage actually exists; when it does not, the acknowledgement
 * states the next-business-day commitment and offers a booking link instead. The
 * database refuses the alternative — `same_night_promised` carries a CHECK that
 * it can only be true when an on-call rep is named — so an optimistic promise
 * cannot be stored even by a caller that skips this module.
 */

export interface OncallRep {
  user_id?: string;
  name?: string;
  until?: string;
}

/**
 * Who is genuinely on call right now.
 *
 * AN UNREACHABLE ROSTER MEANS NO COVERAGE, deliberately. The failure modes are
 * not symmetric: assuming coverage during an outage promises a call nobody will
 * make, while assuming none sends a next-business-day commitment that is merely
 * more conservative than necessary. Only one of those damages the customer.
 */
export async function currentOncall(): Promise<OncallRep | null> {
  if (!SdkGatewayClient.isConfigured()) return null;
  try {
    const result = await SdkGatewayClient.call<{ data?: { on_call?: OncallRep; current?: OncallRep } }>({
      sdk: 'sdk-coverage',
      path: `/api/coverage/on-call/current?tenant_id=${encodeURIComponent(config.projexCloud.tenantId)}`,
      method: 'GET',
    });
    if (!result.delivered) return null;
    const bag = result.data?.data ?? {};
    const rep = bag.on_call ?? bag.current ?? null;
    return rep && rep.user_id ? rep : null;
  } catch {
    return null;
  }
}

/**
 * Send the acknowledgement, respecting the RECIPIENT'S local quiet hours.
 *
 * The quiet-hours window is the recipient's, not ours: somebody who filled in a
 * form at 23:00 their time should not be texted back immediately just because it
 * is mid-morning in Chicago. The channel choice is handed to sdk-notification
 * with the constraint stated, so the platform applies its own per-recipient
 * window rather than this service guessing at one.
 */
export async function acknowledge(input: {
  leadId: string;
  plan: OvernightPlan;
  bookingLink: string | null;
  sameNight: boolean;
}): Promise<boolean> {
  if (!SdkGatewayClient.isConfigured()) return false;
  try {
    const result = await SdkGatewayClient.call({
      sdk: 'sdk-notification',
      path: '/api/notifications',
      method: 'POST',
      idempotencyKey: `overnight-ack:${input.leadId}`,
      body: {
        tenant_id: config.projexCloud.tenantId,
        subject_ref: input.leadId,
        template: 'after_hours_acknowledgement',
        channels: ['email', 'sms'],
        // The platform applies the RECIPIENT's window; we state the requirement
        // rather than computing a window in the wrong timezone.
        respect_quiet_hours: true,
        quiet_hours_basis: 'recipient_local',
        body:
          input.sameNight
            ? 'Thanks for getting in touch. An on-call specialist will contact you tonight.'
            : `Thanks for getting in touch. We have your request and will call you by 09:30 Central on ${input.plan.nextBusinessDate}. You can also pick a time that suits you.`,
        booking_link: input.bookingLink,
      },
    });
    return result.delivered;
  } catch {
    return false;
  }
}

/** A public booking link, so the customer can choose a time rather than wait. */
export async function bookingLink(leadId: string): Promise<string | null> {
  if (!SdkGatewayClient.isConfigured()) return null;
  try {
    const result = await SdkGatewayClient.call<{ data?: { url?: string; link?: string } }>({
      sdk: 'sdk-scheduling',
      path: '/api/scheduling/booking-links',
      method: 'POST',
      idempotencyKey: `overnight-book:${leadId}`,
      body: { tenant_id: config.projexCloud.tenantId, subject_ref: leadId, purpose: 'first_call' },
    });
    if (!result.delivered) return null;
    return result.data?.data?.url ?? result.data?.data?.link ?? null;
  } catch {
    return null;
  }
}

export interface OvernightEntry {
  entry_id: string;
  lead_id: string;
  arrived_at: string;
  reason: string;
  acknowledged_at: string | null;
  booking_link: string | null;
  next_business_open: string | null;
  owner_task_due_at: string | null;
  first_call_due_at: string | null;
  oncall_user_id: string | null;
  same_night_promised: boolean;
  released_at: string | null;
}

/**
 * Enqueue an out-of-hours arrival and make the commitment.
 *
 * Returns null when the arrival is inside business hours — the caller should not
 * have to ask twice, and an in-hours lead has no business in this queue.
 */
export async function enqueue(input: {
  leadId: string;
  arrivedAt: Date;
  sameNightRequested: boolean;
}): Promise<OvernightEntry | null> {
  const plan = overnightPlan(input.arrivedAt);
  if (!plan) return null;

  /*
   * COVERAGE IS CHECKED BEFORE ANYTHING IS PROMISED. Only a real on-call rep
   * turns a same-night request into a same-night commitment; otherwise the
   * request is honoured with the next-business-day path, which is the honest
   * answer rather than a silent downgrade.
   */
  const oncall = input.sameNightRequested ? await currentOncall() : null;
  const sameNight = Boolean(input.sameNightRequested && oncall?.user_id);

  const link = await bookingLink(input.leadId);
  const acked = await acknowledge({ leadId: input.leadId, plan, bookingLink: link, sameNight });

  const rows = await dataService.query<OvernightEntry>(
    `INSERT INTO leadflow_overnight_queue
       (tenant_id, lead_id, arrived_at, reason, acknowledged_at, booking_link,
        next_business_open, owner_task_due_at, first_call_due_at,
        oncall_user_id, same_night_promised)
     VALUES ($1,$2,$3,$4, CASE WHEN $5 THEN now() ELSE NULL END, $6,$7,$8,$9,$10,$11)
     ON CONFLICT (lead_id) DO UPDATE SET
       acknowledged_at = COALESCE(leadflow_overnight_queue.acknowledged_at, EXCLUDED.acknowledged_at),
       booking_link    = COALESCE(EXCLUDED.booking_link, leadflow_overnight_queue.booking_link)
     RETURNING entry_id, lead_id, arrived_at, reason, acknowledged_at, booking_link,
               next_business_open, owner_task_due_at, first_call_due_at,
               oncall_user_id, same_night_promised, released_at`,
    [
      config.projexCloud.tenantId,
      input.leadId,
      input.arrivedAt.toISOString(),
      plan.reason,
      acked,
      link,
      plan.nextBusinessOpen.toISOString(),
      plan.ownerTaskDueAt.toISOString(),
      plan.firstCallDueAt.toISOString(),
      oncall?.user_id ?? null,
      sameNight,
    ]
  );
  return rows[0] ?? null;
}

/** The queue, oldest first. */
export async function listQueue(includeReleased: boolean): Promise<OvernightEntry[]> {
  return dataService.query<OvernightEntry>(
    `SELECT entry_id, lead_id, arrived_at, reason, acknowledged_at, booking_link,
            next_business_open, owner_task_due_at, first_call_due_at,
            oncall_user_id, same_night_promised, released_at
       FROM leadflow_overnight_queue
      WHERE tenant_id = $1 AND ($2::boolean OR released_at IS NULL)
      ORDER BY arrived_at ASC
      LIMIT 500`,
    [config.projexCloud.tenantId, includeReleased]
  );
}
