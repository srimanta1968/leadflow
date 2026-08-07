import { randomUUID } from 'crypto';
import { dataService } from './DataService';
import { SdkGatewayClient } from '../platform/sdkGateway';
import { SLA_WINDOW_MINUTES } from './RoutingService';
import { SlaAlertService } from './SlaAlertService';
import { eventStream } from './EventStream';
import { AppError } from '../utils/errors';
import {
  FirstResponseInput,
  SlaAlertKind,
  SlaAttentionItem,
  SlaBreachReason,
  SlaClockSource,
  SlaObservation,
  SlaState,
  SlaStatusSnapshot,
  SlaSweepResult,
} from '../types';
import { SlaEvaluateInput, SlaStatusQuery } from '../validators/slaValidators';
import { currentTenantContext, tenantIdFor } from '../platform/tenancy/tenantHierarchy';

/**
 * Fraction of the response window that must elapse before a lead is at risk.
 *
 * 0.8 gives an operator the last fifth of the window as usable warning time —
 * six minutes of a thirty-minute clock. A threshold much later than this warns
 * too late to act on, and much earlier turns every lead amber and trains people
 * to ignore the signal.
 */
export const AT_RISK_THRESHOLD = 0.8;

/** How many attention rows a snapshot returns before it becomes a report. */
const ATTENTION_LIMIT = 50;

interface SlaLeadRow {
  id: string;
  name: string | null;
  created_at: Date;
  owner_user_id: string | null;
  assigned_at: Date | null;
  sla_due_at: Date | null;
  first_response_at: Date | null;
  sla_breached: boolean;
  sla_breach_reason: string | null;
  /** Joined from `users` so a snapshot issues no per-row lookup. */
  owner_name?: string | null;
}

/** One clock verdict as ProjexCloud `sdk-sla` reports it. */
interface SdkClockVerdict {
  subject_id?: string;
  state?: string;
  breach_reason?: string;
}

interface SdkEvaluateResult {
  data?: {
    verdicts?: SdkClockVerdict[];
  };
}

/** The states `sdk-sla` may return, so an unknown value is never trusted. */
const SDK_STATES: readonly SlaState[] = ['on_track', 'at_risk', 'breached', 'met'];
const SDK_BREACH_REASONS: readonly SlaBreachReason[] = [
  'no_response_in_window',
  'responded_after_due',
];

const LEAD_SLA_SELECT = `
  SELECT l.id,
         l.name,
         l.created_at,
         l.owner_user_id,
         l.assigned_at,
         l.sla_due_at,
         l.first_response_at,
         l.sla_breached,
         l.sla_breach_reason,
         COALESCE(
           NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''),
           u.email
         ) AS owner_name
    FROM leads l
    LEFT JOIN users u ON u.id = l.owner_user_id`;

/**
 * Monitors every lead's response clock through the ProjexCloud `sdk-sla` SDK.
 *
 * ProjexCloud is the authority on whether a deadline has actually passed,
 * because the real deadline runs on the tenant's business calendar — working
 * hours, holidays, timezone and pause windows — which LeadFlow does not hold.
 * A wall-clock deadline would report a breach at 09:05 on a lead that arrived at
 * 17:55 the previous evening, and no manager would trust the number twice.
 *
 * When the gateway is unconfigured or unreachable the monitor falls back to a
 * plain elapsed-time comparison against `sla_due_at`. The fallback exists so a
 * genuine breach is still DETECTED during an outage — silence would be the worse
 * failure — and it is deliberately NOT a reimplementation of the business
 * calendar. Every observation records `clock_source` so a business-calendar
 * verdict and a wall-clock verdict are never silently averaged together.
 *
 * Two rules hold across everything here:
 *
 *  1. A BREACH IS NEVER CLEARED. A missed deadline is a historical fact;
 *     responding late records `responded_after_due` rather than turning the
 *     breach into a pass.
 *  2. RECORDING IS IDEMPOTENT. A retried request never overwrites the original
 *     `first_response_at` with a later one, which would quietly convert a breach
 *     into compliance.
 */
export class SlaMonitorService {
  /** Which clock this process will use for a verdict right now. */
  private static clockSource(): SlaClockSource {
    return SdkGatewayClient.isConfigured() ? 'sdk_sla' : 'local_wallclock';
  }

  /** ISO-8601 duration, written to the legacy `response_time` VARCHAR column. */
  private static isoDuration(seconds: number | null): string | null {
    return seconds === null ? null : `PT${seconds}S`;
  }

  /**
   * The local wall-clock verdict for one lead.
   *
   * Used directly when the gateway is unconfigured, and as the fallback for any
   * lead `sdk-sla` did not return a verdict for.
   *
   * @param row The lead's clock columns.
   * @param now Evaluation instant, passed in so every lead in one sweep is
   *            judged against the SAME instant rather than drifting row by row.
   */
  private static deriveState(
    row: SlaLeadRow,
    now: Date
  ): { state: SlaState; breachReason: SlaBreachReason | null } {
    // No clock was ever started (the lead is unrouted), so there is no deadline
    // to be late against. Reported as on_track rather than met: nothing has been
    // achieved, there is simply nothing being measured yet.
    if (!row.sla_due_at) {
      return { state: row.first_response_at ? 'met' : 'on_track', breachReason: null };
    }

    const dueAt = row.sla_due_at.getTime();

    if (row.first_response_at) {
      return row.first_response_at.getTime() > dueAt
        ? { state: 'breached', breachReason: 'responded_after_due' }
        : { state: 'met', breachReason: null };
    }

    if (now.getTime() > dueAt) {
      return { state: 'breached', breachReason: 'no_response_in_window' };
    }

    // The window runs from when the clock STARTED, which is the assignment for a
    // routed lead and arrival for anything else, so the at-risk fraction is
    // measured against the real window rather than a nominal thirty minutes.
    const startedAt = (row.assigned_at ?? row.created_at).getTime();
    const window = dueAt - startedAt;
    const elapsed = now.getTime() - startedAt;
    if (window > 0 && elapsed / window >= AT_RISK_THRESHOLD) {
      return { state: 'at_risk', breachReason: null };
    }

    return { state: 'on_track', breachReason: null };
  }

  /** Seconds from lead ARRIVAL to the first response, or null while running. */
  private static responseSeconds(row: SlaLeadRow): number | null {
    if (!row.first_response_at) {
      return null;
    }
    return Math.max(
      0,
      Math.round((row.first_response_at.getTime() - row.created_at.getTime()) / 1000)
    );
  }

  /** The response window a verdict was measured against, in minutes. */
  private static targetMinutes(row: SlaLeadRow): number | null {
    if (!row.sla_due_at) {
      return null;
    }
    const startedAt = (row.assigned_at ?? row.created_at).getTime();
    return Math.max(1, Math.round((row.sla_due_at.getTime() - startedAt) / 60000));
  }

  /** Assemble the API-shaped observation for one lead. */
  private static toObservation(
    row: SlaLeadRow,
    state: SlaState,
    breachReason: SlaBreachReason | null,
    clockSource: SlaClockSource
  ): SlaObservation {
    return {
      lead_id: row.id,
      owner_user_id: row.owner_user_id,
      sla_due_at: row.sla_due_at ? row.sla_due_at.toISOString() : null,
      first_response_at: row.first_response_at ? row.first_response_at.toISOString() : null,
      response_seconds: SlaMonitorService.responseSeconds(row),
      target_minutes: SlaMonitorService.targetMinutes(row),
      state,
      breach_reason: breachReason,
      clock_source: clockSource,
    };
  }

  /**
   * Persist what the monitor observed about one lead.
   *
   * Upserts on `subject_lead_id` so there is exactly ONE observation row per
   * lead: compliance is a property of the lead's clock, not of how many times
   * the sweep happened to run, and a row per sweep would drag every average
   * toward whichever leads were swept most often.
   *
   * `violation` is always written explicitly — the column's schema default is
   * TRUE, so an omitted value would record a violation for a lead that met its
   * deadline.
   *
   * Response-channel details are only known on the first-response path; the
   * sweep passes null and COALESCE keeps whatever a previous first-response
   * observation already recorded rather than erasing it.
   */
  private static async recordObservation(
    observation: SlaObservation,
    correlationId: string,
    details?: { channel?: string; respondedByUserId?: string; note?: string }
  ): Promise<void> {
    await dataService.query(
      `INSERT INTO sla_metrics (
         subject_lead_id, response_seconds, response_time, target_minutes, state,
         breach_reason, violation, responded_at, response_channel,
         responded_by_user_id, note, clock_source, observed_at, correlation_id,
         updated_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8, $9,
         $10, $11, $12, CURRENT_TIMESTAMP, $13,
         CURRENT_TIMESTAMP
       )
       ON CONFLICT (subject_lead_id) WHERE subject_lead_id IS NOT NULL
       DO UPDATE SET
         response_seconds     = EXCLUDED.response_seconds,
         response_time        = EXCLUDED.response_time,
         target_minutes       = EXCLUDED.target_minutes,
         state                = EXCLUDED.state,
         breach_reason        = EXCLUDED.breach_reason,
         violation            = EXCLUDED.violation,
         responded_at         = COALESCE(EXCLUDED.responded_at, sla_metrics.responded_at),
         response_channel     = COALESCE(EXCLUDED.response_channel, sla_metrics.response_channel),
         responded_by_user_id = COALESCE(EXCLUDED.responded_by_user_id, sla_metrics.responded_by_user_id),
         note                 = COALESCE(EXCLUDED.note, sla_metrics.note),
         clock_source         = EXCLUDED.clock_source,
         observed_at          = CURRENT_TIMESTAMP,
         correlation_id       = EXCLUDED.correlation_id,
         updated_at           = CURRENT_TIMESTAMP`,
      [
        observation.lead_id,
        observation.response_seconds,
        SlaMonitorService.isoDuration(observation.response_seconds),
        observation.target_minutes,
        observation.state,
        observation.breach_reason,
        observation.state === 'breached',
        observation.first_response_at,
        details?.channel ?? null,
        details?.respondedByUserId ?? null,
        details?.note ?? null,
        observation.clock_source,
        correlationId,
      ]
    );
  }

  /**
   * Ask `sdk-sla` for the authoritative verdict on a batch of clocks.
   *
   * One batched call rather than one per lead: a sweep over a few hundred open
   * clocks must not become a few hundred round trips.
   *
   * @returns A subject-id → verdict map, empty when the gateway is unconfigured
   *          or unreachable, plus whether the call was delivered.
   */
  private static async askMonitor(
    rows: SlaLeadRow[],
    correlationId: string
  ): Promise<{ delivered: boolean; verdicts: Map<string, SdkClockVerdict> }> {
    const verdicts = new Map<string, SdkClockVerdict>();
    if (rows.length === 0) {
      return { delivered: false, verdicts };
    }

    try {
      const result = await SdkGatewayClient.call<SdkEvaluateResult>({
        sdk: 'sdk-sla',
        path: '/api/sla/breach-scan',
        method: 'POST',
        idempotencyKey: correlationId,
        correlationId,
        body: {
          // REQUIRED by sdk-sla; the scan 400s without it. App-scoped, so a
          // sweep never reaches a sibling app's clocks.
          tenant_id: tenantIdFor(currentTenantContext(), 'sla'),
          task: 'first_response',
          default_target_minutes: SLA_WINDOW_MINUTES,
          subjects: rows.map((row) => ({
            subject_type: 'lead',
            subject_id: row.id,
            started_at: (row.assigned_at ?? row.created_at).toISOString(),
            due_at: row.sla_due_at ? row.sla_due_at.toISOString() : null,
            responded_at: row.first_response_at ? row.first_response_at.toISOString() : null,
          })),
        },
      });

      if (!result.delivered) {
        return { delivered: false, verdicts };
      }

      for (const verdict of result.data?.data?.verdicts ?? []) {
        if (verdict.subject_id) {
          verdicts.set(verdict.subject_id, verdict);
        }
      }
      return { delivered: true, verdicts };
    } catch (error) {
      // Monitoring must degrade, never fail: an undetected breach is worse than
      // a breach detected by the local clock. Fall through to the fallback.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[SlaMonitorService] sdk-sla unavailable (${correlationId}):`, message);
      return { delivered: false, verdicts };
    }
  }

  /**
   * Reconcile one lead's verdict: `sdk-sla` when it answered for this lead,
   * the local wall-clock otherwise.
   *
   * An unrecognised state from upstream is discarded rather than stored — a
   * typo'd or newly-added SDK state must not silently become a lead's recorded
   * compliance outcome.
   */
  private static reconcile(
    row: SlaLeadRow,
    verdict: SdkClockVerdict | undefined,
    now: Date
  ): { state: SlaState; breachReason: SlaBreachReason | null; source: SlaClockSource } {
    const local = SlaMonitorService.deriveState(row, now);

    if (verdict && SDK_STATES.includes(verdict.state as SlaState)) {
      const reason = SDK_BREACH_REASONS.includes(verdict.breach_reason as SlaBreachReason)
        ? (verdict.breach_reason as SlaBreachReason)
        : local.breachReason;
      return {
        state: verdict.state as SlaState,
        breachReason: verdict.state === 'breached' ? reason : null,
        source: 'sdk_sla',
      };
    }

    return { state: local.state, breachReason: local.breachReason, source: 'local_wallclock' };
  }

  /**
   * Record a valid human first response, stopping the lead's clock.
   *
   * @param leadId         The lead that was responded to.
   * @param input          Validated channel, note and responder.
   * @param sessionUserId  The calling user, used when no responder is named.
   * @throws AppError(404 NOT_FOUND) when the lead, or the named responder, does
   *         not exist.
   */
  static async recordFirstResponse(
    leadId: string,
    input: FirstResponseInput,
    sessionUserId: string
  ): Promise<{
    sla: SlaObservation;
    already_recorded: boolean;
    monitor_delivered: boolean;
    correlation_id: string;
  }> {
    const correlationId = randomUUID();

    const existing = await dataService.queryOne<SlaLeadRow>(`${LEAD_SLA_SELECT} WHERE l.id = $1`, [
      leadId,
    ]);
    if (!existing) {
      throw AppError.notFound('Lead not found');
    }

    const responderId = input.responded_by_user_id ?? sessionUserId;
    const responder = await dataService.queryOne<{ id: string }>(
      'SELECT id FROM users WHERE id = $1',
      [responderId]
    );
    if (!responder) {
      throw AppError.notFound('The user credited with this response does not exist');
    }

    // Compare-and-set on `first_response_at IS NULL`. Two operators clicking at
    // once, or one retrying after a timeout, must not overwrite the original
    // response time with a later one — that would quietly turn a breach into a
    // pass, which is the exact number this product exists to keep honest.
    const updated = await dataService.queryOne<SlaLeadRow>(
      `UPDATE leads
          SET first_response_at = CURRENT_TIMESTAMP,
              sla_breached = (
                sla_breached
                OR (sla_due_at IS NOT NULL AND CURRENT_TIMESTAMP > sla_due_at)
              ),
              sla_breach_reason = CASE
                WHEN sla_due_at IS NOT NULL AND CURRENT_TIMESTAMP > sla_due_at
                  THEN 'responded_after_due'
                ELSE sla_breach_reason
              END,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
          AND first_response_at IS NULL
        RETURNING id, name, created_at, owner_user_id, assigned_at, sla_due_at,
                  first_response_at, sla_breached, sla_breach_reason`,
      [leadId]
    );

    if (!updated) {
      // Somebody already stopped this clock. Report the ORIGINAL response,
      // unchanged, rather than failing a harmless retry.
      const local = SlaMonitorService.deriveState(existing, new Date());
      return {
        sla: SlaMonitorService.toObservation(
          existing,
          local.state,
          local.breachReason,
          SlaMonitorService.clockSource()
        ),
        already_recorded: true,
        monitor_delivered: false,
        correlation_id: correlationId,
      };
    }

    const now = new Date();
    const monitor = await SlaMonitorService.askMonitor([updated], correlationId);
    const verdict = SlaMonitorService.reconcile(updated, monitor.verdicts.get(leadId), now);

    const observation = SlaMonitorService.toObservation(
      updated,
      verdict.state,
      verdict.breachReason,
      verdict.source
    );

    await SlaMonitorService.recordObservation(observation, correlationId, {
      channel: input.channel,
      respondedByUserId: responderId,
      note: input.note,
    });

    // Published AFTER the write so a client that reacts immediately cannot read
    // a projection that still shows the clock running.
    eventStream.publish({ type: 'sla.response_recorded', subject_id: leadId });

    return {
      sla: observation,
      already_recorded: false,
      monitor_delivered: monitor.delivered,
      correlation_id: correlationId,
    };
  }

  /**
   * Run the monitoring sweep and record what it finds.
   *
   * @param input Validated `lead_id` (targeted) or `limit` (sweep).
   * @throws AppError(404 NOT_FOUND) when a named `lead_id` matches no lead.
   */
  static async evaluate(input: SlaEvaluateInput): Promise<SlaSweepResult> {
    const correlationId = randomUUID();

    const rows = input.lead_id
      ? await dataService.query<SlaLeadRow>(`${LEAD_SLA_SELECT} WHERE l.id = $1`, [input.lead_id])
      : await dataService.query<SlaLeadRow>(
          `${LEAD_SLA_SELECT}
            WHERE l.first_response_at IS NULL
              AND l.sla_due_at IS NOT NULL
            ORDER BY l.sla_due_at ASC
            LIMIT $1`,
          [input.limit]
        );

    if (input.lead_id && rows.length === 0) {
      throw AppError.notFound('Lead not found');
    }

    const monitor = await SlaMonitorService.askMonitor(rows, correlationId);

    // One instant for the whole sweep, so two leads with identical deadlines
    // cannot come out with different verdicts because of elapsed loop time.
    const now = new Date();
    const counts: Record<SlaState, number> = { on_track: 0, at_risk: 0, breached: 0, met: 0 };
    const newlyBreached: string[] = [];
    let clockSource: SlaClockSource = SlaMonitorService.clockSource();
    let alertsRaised = 0;
    let alertsDelivered = 0;

    for (const row of rows) {
      const verdict = SlaMonitorService.reconcile(row, monitor.verdicts.get(row.id), now);
      counts[verdict.state] += 1;
      clockSource = verdict.source;

      const minutesToDue = row.sla_due_at
        ? Math.round((row.sla_due_at.getTime() - now.getTime()) / 60000)
        : null;

      // A breach is recorded once and never cleared, so the UPDATE is guarded on
      // `sla_breached = FALSE`: an alerting job driven off `newly_breached` must
      // not re-notify on every sweep.
      if (verdict.state === 'breached' && !row.sla_breached) {
        await dataService.query(
          `UPDATE leads
              SET sla_breached      = TRUE,
                  sla_breach_reason = $2,
                  updated_at        = CURRENT_TIMESTAMP
            WHERE id = $1
              AND sla_breached = FALSE`,
          [row.id, verdict.breachReason ?? 'no_response_in_window']
        );
        newlyBreached.push(row.id);
        eventStream.publish({ type: 'sla.breached', subject_id: row.id });
      }

      // Escalate. The alert service is idempotent per (lead, recipient, tier),
      // so raising on every sweep notifies each person exactly once — and it
      // never throws, because an undetected breach is worse than an undelivered
      // email and the sweep's own findings are still worth recording.
      //
      // Both tiers are attempted for a breached lead, not just the manager one:
      // a lead that went from on_track straight past its deadline between two
      // sweeps would otherwise never warn its owner at all.
      if (verdict.state === 'at_risk' || verdict.state === 'breached') {
        const tiers: SlaAlertKind[] =
          verdict.state === 'breached' ? ['owner_warning', 'manager_breach'] : ['owner_warning'];

        for (const kind of tiers) {
          const outcome = await SlaAlertService.raise({
            leadId: row.id,
            leadName: row.name,
            kind,
            ownerUserId: row.owner_user_id,
            reason:
              kind === 'manager_breach'
                ? `SLA breached (${verdict.breachReason ?? 'no_response_in_window'}) with no first response`
                : 'Most of the response window has elapsed with no first response',
            minutesToDue,
            correlationId,
          });
          alertsRaised += outcome.raised;
          alertsDelivered += outcome.delivered;
        }
      }

      await SlaMonitorService.recordObservation(
        SlaMonitorService.toObservation(row, verdict.state, verdict.breachReason, verdict.source),
        correlationId
      );
    }

    return {
      evaluated: rows.length,
      on_track: counts.on_track,
      at_risk: counts.at_risk,
      breached: counts.breached,
      met: counts.met,
      newly_breached: newlyBreached,
      alerts_raised: alertsRaised,
      alerts_delivered: alertsDelivered,
      clock_source: clockSource,
      monitor_delivered: monitor.delivered,
      correlation_id: correlationId,
    };
  }

  /**
   * Build the SLA compliance snapshot for the monitoring dashboard.
   *
   * States are computed live from `sla_due_at` at read time rather than read
   * from stored verdicts, so the snapshot is never stale between sweeps — a lead
   * that crossed its at-risk threshold a minute ago shows as amber immediately.
   * The stored verdicts remain the audit record of what the monitor decided and
   * when; this is the current picture.
   *
   * @param query Validated window and optional owner filter.
   */
  static async status(query: SlaStatusQuery): Promise<SlaStatusSnapshot> {
    const params: unknown[] = [String(query.window_minutes)];
    let ownerFilter = '';
    if (query.owner_user_id) {
      params.push(query.owner_user_id);
      ownerFilter = ` AND l.owner_user_id = $${params.length}`;
    }

    const rows = await dataService.query<SlaLeadRow>(
      `${LEAD_SLA_SELECT}
        WHERE l.created_at >= CURRENT_TIMESTAMP - ($1 || ' minutes')::interval${ownerFilter}
        ORDER BY l.created_at DESC`,
      params
    );

    const now = new Date();
    const counts: Record<SlaState, number> = { on_track: 0, at_risk: 0, breached: 0, met: 0 };
    const attention: SlaAttentionItem[] = [];
    let responseSecondsTotal = 0;
    let responded = 0;

    for (const row of rows) {
      const { state } = SlaMonitorService.deriveState(row, now);
      counts[state] += 1;

      const seconds = SlaMonitorService.responseSeconds(row);
      if (seconds !== null) {
        responseSecondsTotal += seconds;
        responded += 1;
      }

      // A closed breach is history; an OPEN one is work. Only clocks somebody
      // can still act on belong on an attention list.
      if ((state === 'at_risk' || state === 'breached') && !row.first_response_at) {
        attention.push({
          lead_id: row.id,
          name: row.name,
          owner_user_id: row.owner_user_id,
          owner_name: row.owner_name ?? null,
          sla_due_at: row.sla_due_at ? row.sla_due_at.toISOString() : null,
          minutes_to_due: row.sla_due_at
            ? Math.round((row.sla_due_at.getTime() - now.getTime()) / 60000)
            : null,
          state,
        });
      }
    }

    // Most overdue first: the negative minutes sort ahead of the positive ones.
    attention.sort((a, b) => (a.minutes_to_due ?? 0) - (b.minutes_to_due ?? 0));

    // Compliance is measured over clocks whose outcome is DECIDED — met, plus
    // breached (a passed deadline is decided even while the clock still runs).
    // Leads still comfortably inside their window are excluded rather than
    // counted as passes: reporting an empty window as 100 percent is a number a
    // manager would act on, so it is returned as null instead.
    const decided = counts.met + counts.breached;

    return {
      window_minutes: query.window_minutes,
      generated_at: now.toISOString(),
      clock_source: SlaMonitorService.clockSource(),
      totals: {
        tracked: rows.length,
        on_track: counts.on_track,
        at_risk: counts.at_risk,
        breached: counts.breached,
        met: counts.met,
      },
      compliance_rate: decided === 0 ? null : Math.round((counts.met / decided) * 10000) / 10000,
      average_response_seconds:
        responded === 0 ? null : Math.round(responseSecondsTotal / responded),
      attention: attention.slice(0, ATTENTION_LIMIT),
    };
  }
}

/**
 * Re-exported so a caller that already imports the monitor does not also need to
 * reach into `RoutingService` for the window the clocks are set from.
 */
export { SLA_WINDOW_MINUTES };
