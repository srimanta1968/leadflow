import { dataService } from '../services/DataService';
import { SdkGatewayClient } from '../platform/sdkGateway';
import { compose } from './channelDecision';

/**
 * What an SLA rung or breach actually causes.
 *
 * Between sdk-sla saying "this is late" and anybody doing something about it
 * sits a set of decisions nobody had written down: who hears about it, when
 * ownership moves, and when a run of individual lates stops being individual and
 * becomes an outage. This module is that, in one place.
 *
 * THE AUDIENCE WIDENS WITH THE RUNG, and it widens rather than moves. Telling
 * the manager INSTEAD of the rep at T+30 is how a rep learns that ignoring the
 * first alert costs them nothing; telling them AS WELL is how escalation is
 * supposed to feel.
 *
 * ONE INCIDENT PER SYSTEMIC EPISODE, not one per rung and not one per lead.
 * A provider outage breaches forty leads in ten minutes, and forty incidents is
 * indistinguishable from no incident at all — the one that matters is buried in
 * thirty-nine duplicates and the on-call engineer stops reading them. That
 * deduplication is the whole point of this file and is what AC4 asks for.
 */

export type Rung = 'first_warning' | 'second_warning' | 'reassign' | 'breach';

export interface RungEvent {
  eventId: string;
  subjectRef: string;
  rung: Rung;
  /** Minutes past the SLA target when this fired. */
  minutesLate: number;
  ownerId?: string | null;
  managerId?: string | null;
  tenantId?: string | null;
  correlationId?: string;
}

/**
 * Who hears about each rung.
 *
 * Cumulative by construction: each rung's list contains the previous one's.
 */
const AUDIENCE_BY_RUNG: Record<Rung, string[]> = {
  first_warning: ['owner'],
  second_warning: ['owner', 'manager'],
  reassign: ['owner', 'manager', 'backup'],
  breach: ['owner', 'manager', 'backup', 'leadership'],
};

/** The rung at which ownership moves, per the SOP's T+45. */
const REASSIGN_AT_MINUTES = 45;

/**
 * How many distinct subjects must breach inside the window before it is called
 * systemic.
 *
 * Five, deliberately, and not one. A single breach is somebody having a busy
 * afternoon; five different leads breaching in fifteen minutes is not a
 * coincidence and is almost always a provider or a routing fault. Setting this
 * to one would open an incident for every late lead and make the incident queue
 * useless, which is the failure mode this threshold exists to avoid.
 */
const SYSTEMIC_SUBJECT_THRESHOLD = 5;
const SYSTEMIC_WINDOW_MINUTES = 15;

export interface EscalationOutcome {
  notified: string[];
  reassigned: boolean;
  incidentRef: string | null;
  incidentCreated: boolean;
  systemic: boolean;
  duplicate: boolean;
}

/**
 * Handle one rung event.
 *
 * IDEMPOTENT ON THE EVENT ID, because sdk-sla delivers at least once and a rung
 * that fires twice must not notify twice — an escalation that arrives in
 * duplicate teaches people to ignore escalations.
 */
export async function handleRung(event: RungEvent): Promise<EscalationOutcome> {
  const outcome: EscalationOutcome = {
    notified: [], reassigned: false, incidentRef: null,
    incidentCreated: false, systemic: false, duplicate: false,
  };

  const claimed = await dataService.query<{ event_id: string }>(
    `INSERT INTO leadflow_escalation_event
       (event_id, subject_ref, rung, minutes_late, tenant_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [event.eventId, event.subjectRef, event.rung, event.minutesLate, event.tenantId ?? null],
  );
  if (claimed.length === 0) {
    outcome.duplicate = true;
    return outcome;
  }

  const tenant_id = event.tenantId ?? undefined;

  /* ------------------------------------------------------------- notify */
  for (const audience of AUDIENCE_BY_RUNG[event.rung] ?? []) {
    const decision = await compose({
      subjectRef: event.subjectRef,
      channel: 'email',
      // Internal every time: an SLA escalation goes to colleagues, never to the
      // customer. Sending "we are late" to the person waiting is its own defect.
      audience: 'internal',
      tenantId: event.tenantId ?? null,
      correlationId: event.correlationId,
      decidedBy: `escalationGlue:${event.rung}`,
    });
    if (decision.verdict === 'deny') continue;
    try {
      await SdkGatewayClient.call({
        sdk: 'sdk-notification',
        path: '/api/notifications/send',
        method: 'POST',
        body: {
          tenant_id, audience, subject_ref: event.subjectRef,
          template_key: `sla_${event.rung}`,
          urgency: event.rung === 'breach' ? 'high' : 'normal',
          channel_decision_id: decision.id,
        },
        idempotencyKey: `${event.eventId}:${audience}`,
        correlationId: event.correlationId,
      });
      outcome.notified.push(audience);
    } catch (error) {
      // ONE FAILED AUDIENCE MUST NOT STOP THE REST. If the manager's address
      // bounces, leadership still needs to hear about the breach.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[escalation] notify ${audience} failed:`, message);
    }
  }

  /* ---------------------------------------------------------- reassign */
  if (event.minutesLate >= REASSIGN_AT_MINUTES) {
    try {
      await SdkGatewayClient.call({
        sdk: 'sdk-assignment',
        path: '/api/assignment/route',
        method: 'POST',
        body: {
          tenant_id, subject_ref: event.subjectRef, reassign: true,
          exclude_owner_id: event.ownerId ?? null,
          reason: `sla_${event.rung}_at_${event.minutesLate}m`,
        },
        idempotencyKey: `${event.eventId}:reassign`,
        correlationId: event.correlationId,
      });
      outcome.reassigned = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[escalation] reassignment failed:', message);
    }
  }

  /* ---------------------------------------------------------- incident */
  if (event.rung === 'breach') {
    const systemic = await isSystemic(event);
    outcome.systemic = systemic.systemic;
    if (systemic.systemic) {
      const opened = await openIncidentOnce(event, systemic.subjectCount);
      outcome.incidentRef = opened.incidentRef;
      outcome.incidentCreated = opened.created;
    }
  }

  return outcome;
}

/** Distinct subjects that have breached inside the window, this one included. */
async function isSystemic(event: RungEvent): Promise<{ systemic: boolean; subjectCount: number }> {
  const rows = await dataService.query<{ n: string }>(
    `SELECT count(DISTINCT subject_ref)::int AS n
       FROM leadflow_escalation_event
      WHERE rung = 'breach'
        AND received_at > NOW() - ($1 || ' minutes')::interval`,
    [String(SYSTEMIC_WINDOW_MINUTES)],
  );
  // DISTINCT SUBJECTS, not events. One lead breaching its first, second and
  // final rung is one unhappy lead, not three — counting events would call that
  // an outage and open an incident for a single slow afternoon.
  const n = Number(rows[0]?.n ?? 0);
  return { systemic: n >= SYSTEMIC_SUBJECT_THRESHOLD, subjectCount: n };
}

/**
 * Open the incident, or join the one that is already open.
 *
 * THE DEDUPE KEY IS THE EPISODE, not the event: tenant plus the window bucket.
 * Every breach inside the same fifteen minutes maps to the same key, so the
 * fortieth breach of an outage attaches to the incident the fifth one opened
 * instead of opening a fortieth.
 */
async function openIncidentOnce(
  event: RungEvent,
  subjectCount: number,
): Promise<{ incidentRef: string | null; created: boolean }> {
  const bucket = Math.floor(Date.now() / (SYSTEMIC_WINDOW_MINUTES * 60_000));
  const episodeKey = `sla-systemic:${event.tenantId ?? 'default'}:${bucket}`;

  const claimed = await dataService.query<{ episode_key: string }>(
    `INSERT INTO leadflow_escalation_incident (episode_key, tenant_id, subject_count)
     VALUES ($1, $2, $3)
     ON CONFLICT (episode_key) DO UPDATE
        -- Still one row. The count is refreshed so the incident says how wide
        -- the episode got, rather than freezing at the five that opened it.
        SET subject_count = GREATEST(leadflow_escalation_incident.subject_count, EXCLUDED.subject_count)
     RETURNING episode_key, incident_ref, (xmax = 0) AS inserted`,
    [episodeKey, event.tenantId ?? null, subjectCount],
  );

  const row = claimed[0] as unknown as { incident_ref: string | null; inserted: boolean };
  if (!row?.inserted) {
    // Somebody already opened it. Join it.
    return { incidentRef: row?.incident_ref ?? null, created: false };
  }

  try {
    const res = await SdkGatewayClient.call<{ data?: { incident_id?: string } }>({
      sdk: 'sdk-incident',
      path: '/api/incidents',
      method: 'POST',
      body: {
        tenant_id: event.tenantId ?? undefined,
        kind: 'sla_systemic_breach',
        severity: 'high',
        summary: `${subjectCount} leads breached their SLA within ${SYSTEMIC_WINDOW_MINUTES} minutes`,
        evidence: { episode_key: episodeKey, window_minutes: SYSTEMIC_WINDOW_MINUTES },
      },
      // The EPISODE key, so even a retry of this call joins rather than opens.
      idempotencyKey: episodeKey,
      correlationId: event.correlationId,
    });
    const incidentRef = res.data?.data?.incident_id ?? null;
    await dataService.query(
      `UPDATE leadflow_escalation_incident SET incident_ref = $2 WHERE episode_key = $1`,
      [episodeKey, incidentRef],
    );
    return { incidentRef, created: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The local row STAYS. Deleting it on failure would let the next breach open
    // a second attempt, and a flapping incident service would then produce the
    // duplicate storm this function exists to prevent.
    await dataService.query(
      `UPDATE leadflow_escalation_incident SET last_error = $2 WHERE episode_key = $1`,
      [episodeKey, message],
    );
    console.error('[escalation] incident creation failed:', message);
    return { incidentRef: null, created: false };
  }
}

/** Exposed for the tests and the operator panel. */
export const ESCALATION_RULES = {
  AUDIENCE_BY_RUNG,
  REASSIGN_AT_MINUTES,
  SYSTEMIC_SUBJECT_THRESHOLD,
  SYSTEMIC_WINDOW_MINUTES,
};
