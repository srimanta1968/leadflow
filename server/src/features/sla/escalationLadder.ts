import { dataService } from '../../services/DataService';
import { config } from '../../config/env';
import { SdkGatewayClient } from '../../platform/sdkGateway';
import { unreachable, type Reached } from '../../platform/sdkGateway/degradingRead';
import { deadlineFor, SLA_MINUTES } from './businessCalendar';

/**
 * The T+0 to T+45 escalation ladder. SOP §04, §05, §30.
 *
 * A DUPLICATED TICK MUST NOT DOUBLE-ALERT, and that is a uniqueness problem
 * rather than a scheduling one. Ticks arrive from the timer, from a webhook and
 * from an operator; two landing on the same lead a millisecond apart both read
 * "T+15 has not fired" and both send. So a rung fires by INSERTING into
 * leadflow_escalation_fire, which carries UNIQUE (lead_id, rung) — the second
 * insert is refused by the database, and a refused insert means somebody else
 * already alerted. No read-then-write, no lock, no window.
 */

/** One rung: when it fires, who hears about it, and what it demands. */
export interface Rung {
  /** Minutes from the ORIGINAL source timestamp. */
  offset: number;
  audience: string;
  channels: string[];
  /** What a human must actually do. Carried into the notification body. */
  requires: string;
}

export const LADDER: readonly Rung[] = [
  { offset: 0,  audience: 'owner',                 channels: ['in_app'],                    requires: 'Assign primary, backup and manager, write NEXT and the SLA due time, create the First Call task, send the eligible acknowledgement.' },
  { offset: 1,  audience: 'contact',               channels: ['email', 'sms', 'push'],      requires: 'Acknowledgement to the contact where eligible, plus mobile and desktop alert to the owner.' },
  { offset: 5,  audience: 'owner,backup',          channels: ['push'],                      requires: 'Unaccepted reminder with a visible countdown. The backup is notified so takeover is possible.' },
  { offset: 15, audience: 'owner,manager',         channels: ['push', 'in_app'],            requires: 'Rep reminder plus a yellow manager warning showing capacity and availability, with one-click reassign.' },
  { offset: 25, audience: 'manager,backup',        channels: ['push', 'in_app'],            requires: 'Red alert. New P1 assignment to an overloaded rep may be frozen from here.' },
  { offset: 30, audience: 'owner,manager,leadership', channels: ['email', 'push', 'in_app'], requires: 'BREACH. Reassign, notify leadership, and record a mandatory reason plus the customer recovery action.' },
  { offset: 45, audience: 'oncall,revops',         channels: ['page', 'email'],             requires: 'Critical incident. Page on-call leadership and RevOps, list every affected lead, pause the broken workflow if needed.' },
];

export const BREACH_RUNG = 30;
export const INCIDENT_RUNG = 45;

/** One lead as the ladder needs to see it. */
export interface LadderLead {
  id: string;
  source_timestamp: string | null;
  owner_user_id: string | null;
  backup_user_id: string | null;
  manager_user_id: string | null;
  accepted_at: string | null;
  first_response_at: string | null;
  closed_at: string | null;
  priority: string | null;
}

/** What one tick did. */
export interface TickResult {
  leadId: string;
  minutesElapsed: number | null;
  fired: number[];
  /** Rungs already fired by an earlier tick. The idempotence, made visible. */
  suppressed: number[];
  breached: boolean;
  incidentOpened: boolean;
}

/** Leads still owed a response. */
export async function leadsAwaitingResponse(limit = 500): Promise<LadderLead[]> {
  return dataService.query<LadderLead>(
    `SELECT id, source_timestamp, owner_user_id, backup_user_id, manager_user_id,
            accepted_at, first_response_at, closed_at, priority
       FROM leads
      WHERE closed_at IS NULL
        AND first_response_at IS NULL
        AND source_timestamp IS NOT NULL
      ORDER BY source_timestamp ASC
      LIMIT $1`,
    [limit]
  );
}

export async function readLadderLead(leadId: string): Promise<LadderLead | null> {
  const rows = await dataService.query<LadderLead>(
    `SELECT id, source_timestamp, owner_user_id, backup_user_id, manager_user_id,
            accepted_at, first_response_at, closed_at, priority
       FROM leads WHERE id = $1`,
    [leadId]
  );
  return rows[0] ?? null;
}

/**
 * Claim a rung.
 *
 * @returns true when THIS caller won the insert and should therefore send.
 */
async function claimRung(lead: LadderLead, rung: Rung): Promise<boolean> {
  const rows = await dataService.query<{ fire_id: string }>(
    `INSERT INTO leadflow_escalation_fire
       (tenant_id, lead_id, rung, audience, channels, source_timestamp)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     ON CONFLICT (lead_id, rung) DO NOTHING
     RETURNING fire_id`,
    [
      config.projexCloud.tenantId,
      lead.id,
      rung.offset,
      rung.audience,
      JSON.stringify(rung.channels),
      lead.source_timestamp,
    ]
  );
  return rows.length > 0;
}

/** Mark what actually went out, so an undelivered alert is not read as sent. */
async function markDelivered(leadId: string, rung: number, delivered: boolean, detail: string): Promise<void> {
  await dataService.query(
    `UPDATE leadflow_escalation_fire SET delivered = $3, detail = $4
      WHERE lead_id = $1 AND rung = $2`,
    [leadId, rung, delivered, detail]
  );
}

/** Send one rung's notification. Degrades rather than throwing: an unreachable
 *  notifier must not stop the ladder recording that the rung came due. */
async function notify(lead: LadderLead, rung: Rung): Promise<Reached<null>> {
  if (!SdkGatewayClient.isConfigured()) return unreachable(null);
  try {
    const result = await SdkGatewayClient.call({
      sdk: 'sdk-notification',
      path: '/api/notifications',
      method: 'POST',
      idempotencyKey: `escalation:${lead.id}:${rung.offset}`,
      body: {
        tenant_id: config.projexCloud.tenantId,
        audience: rung.audience.split(','),
        channels: rung.channels,
        subject_ref: lead.id,
        template: `sla_escalation_t${rung.offset}`,
        body: rung.requires,
        recipients: [lead.owner_user_id, lead.backup_user_id, lead.manager_user_id].filter(Boolean),
      },
    });
    return result.delivered ? { value: null, available: true } : unreachable(null);
  } catch {
    return unreachable(null);
  }
}

/** Open the T+45 critical incident, naming every lead currently in breach. */
async function openIncident(affected: string[]): Promise<string | null> {
  if (!SdkGatewayClient.isConfigured()) return null;
  try {
    const result = await SdkGatewayClient.call<{ data?: { incident_id?: string } }>({
      sdk: 'sdk-incident',
      path: '/api/incidents',
      method: 'POST',
      // ONE INCIDENT PER SWEEP, not one per lead: forty leads breaching because a
      // workflow broke is one incident with forty rows, and forty incidents is a
      // pager nobody can act on.
      idempotencyKey: `sla-critical:${new Date().toISOString().slice(0, 13)}`,
      body: {
        tenant_id: config.projexCloud.tenantId,
        severity: 'critical',
        kind: 'sla_t45_critical',
        title: `SLA T+${INCIDENT_RUNG}: ${affected.length} lead(s) past the critical threshold`,
        detail: 'On-call leadership and RevOps paged. Pause the broken workflow if the cause is systemic.',
        affected_refs: affected,
      },
    });
    return result.data?.data?.incident_id ?? null;
  } catch {
    return null;
  }
}

export function minutesElapsed(lead: LadderLead, now = Date.now()): number | null {
  if (!lead.source_timestamp) return null;
  const at = Date.parse(lead.source_timestamp);
  if (Number.isNaN(at)) return null;
  return Math.floor((now - at) / 60_000);
}

/**
 * Advance one lead's ladder.
 *
 * FIRES EVERY DUE RUNG, not just the latest. A tick that has been delayed — the
 * process was down, the timer was paused — must not skip T+5 and T+15 on its way
 * to T+25, because the backup was never told and the manager never saw the
 * warning. Each rung is claimed separately, so a catch-up sweep sends the ones
 * that were genuinely missed and silently suppresses the ones that were not.
 *
 * ACCEPTED LEADS STOP AT T+5. Accepting answers the "has anybody picked this up"
 * rungs; it does not answer the response clock, so the breach rungs still fire.
 */
export async function tickLead(lead: LadderLead, now = Date.now()): Promise<TickResult> {
  const elapsed = minutesElapsed(lead, now);
  const result: TickResult = {
    leadId: lead.id,
    minutesElapsed: elapsed,
    fired: [],
    suppressed: [],
    breached: false,
    incidentOpened: false,
  };
  if (elapsed === null) return result;

  for (const rung of LADDER) {
    if (elapsed < rung.offset) continue;
    // The acceptance rungs are answered by acceptance; the response rungs are not.
    if (lead.accepted_at && (rung.offset === 5 || rung.offset === 15)) continue;

    const won = await claimRung(lead, rung);
    if (!won) {
      result.suppressed.push(rung.offset);
      continue;
    }
    const sent = await notify(lead, rung);
    await markDelivered(
      lead.id,
      rung.offset,
      sent.available,
      sent.available ? 'notified' : 'notifier unreachable; rung recorded as due but not delivered'
    );
    result.fired.push(rung.offset);
    if (rung.offset >= BREACH_RUNG) result.breached = true;
  }

  return result;
}

/**
 * Sweep every lead awaiting a response.
 *
 * The T+45 incident is opened ONCE for the whole sweep, listing every affected
 * lead, rather than once per lead.
 */
export async function tick(now = Date.now()): Promise<{
  results: TickResult[];
  fired: number;
  suppressed: number;
  incidentRef: string | null;
  affected: string[];
}> {
  const leads = await leadsAwaitingResponse();
  const results: TickResult[] = [];
  for (const lead of leads) results.push(await tickLead(lead, now));

  const affected = results.filter((r) => r.fired.includes(INCIDENT_RUNG)).map((r) => r.leadId);
  const incidentRef = affected.length > 0 ? await openIncident(affected) : null;
  if (incidentRef) for (const r of results) if (affected.includes(r.leadId)) r.incidentOpened = true;

  return {
    results,
    fired: results.reduce((n, r) => n + r.fired.length, 0),
    suppressed: results.reduce((n, r) => n + r.suppressed.length, 0),
    incidentRef,
    affected,
  };
}

/** The deadline a lead is being held to, and how it was derived. */
export function deadlineForLead(lead: LadderLead): ReturnType<typeof deadlineFor> | null {
  if (!lead.source_timestamp) return null;
  const at = new Date(lead.source_timestamp);
  return Number.isNaN(at.getTime()) ? null : deadlineFor(at);
}

export { SLA_MINUTES };
