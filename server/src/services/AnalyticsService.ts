import { randomUUID } from 'crypto';
import { dataService } from './DataService';
import { SdkGatewayClient } from './projexcloud/SdkGatewayClient';
import { SLA_WINDOW_MINUTES } from './RoutingService';
import { AnalyticsOverviewQuery } from '../validators/analyticsValidators';
import { LeadSourceChannel, SlaClockSource } from '../types';
import { currentTenantContext, tenantIdFor } from '../platform/tenancy/tenantHierarchy';

/** Counts of leads reaching each stage of the capture-to-response funnel. */
export interface AnalyticsFunnel {
  /** Leads that arrived inside the window. */
  captured: number;
  /** Of those, how many reached an owner. */
  routed: number;
  /** Of those, how many a human answered. */
  responded: number;
  /** Of those, how many missed their response deadline. */
  breached: number;
}

/**
 * Stage-to-stage conversion, each 0..1 to four decimals.
 *
 * Every rate is null when its denominator is empty rather than 0: a rate of
 * zero reads as "we are failing" and a manager acts on it, whereas an empty
 * window means "there is nothing to judge yet". They are not the same claim and
 * must not render the same.
 */
export interface AnalyticsConversion {
  /** routed / captured. */
  routed_rate: number | null;
  /** responded / routed. */
  response_rate: number | null;
  /** breached / clocks that have closed. */
  breach_rate: number | null;
}

/**
 * Response-time distribution in seconds, measured from lead ARRIVAL.
 *
 * All three are reported together because an average alone hides the tail: a
 * queue answering most leads in two minutes and a handful in six hours has a
 * respectable mean and a serious problem, and only p90 shows it.
 */
export interface AnalyticsResponseTimes {
  average_seconds: number | null;
  median_seconds: number | null;
  p90_seconds: number | null;
}

/** One capture channel's contribution. */
export interface AnalyticsSourceBreakdown {
  source: LeadSourceChannel | null;
  captured: number;
  responded: number;
  breached: number;
  average_response_seconds: number | null;
}

/** One day of the window. */
export interface AnalyticsDailyPoint {
  /** Calendar day, `YYYY-MM-DD`. */
  day: string;
  captured: number;
  responded: number;
  breached: number;
}

/** How many closed clocks in the window one clock produced the verdict for. */
export interface AnalyticsClockShare {
  /**
   * `sdk_sla` for the ProjexCloud business-calendar clock, `local_wallclock` for
   * LeadFlow's outage fallback, and null for a closed clock the monitor has not
   * observed yet — it has an outcome on the lead but no observation row stating
   * which clock decided it.
   */
  clock_source: SlaClockSource | null;
  closed: number;
  breached: number;
}

/**
 * Which clock the breach figures in this window actually rest on.
 *
 * This is the ProjexCloud SDK's contribution to the analytics rollup, and it is
 * the difference between a defensible compliance number and an indefensible one.
 * `sdk-sla` judges a deadline against the tenant's business calendar — working
 * hours, holidays, timezone, pause windows. LeadFlow's fallback compares plain
 * elapsed time. The fallback exists so a genuine breach is still DETECTED during
 * a gateway outage, but the two are not the same measurement: a lead that
 * arrived at 17:55 breaches on the wall clock by 09:05 the next morning and does
 * not breach at all on a business calendar.
 *
 * `SlaMonitorService` is careful to record `clock_source` on every observation
 * for exactly this reason. Aggregating the breach rate without carrying that
 * provenance forward would average the two clocks together silently and undo
 * that care at the last step — which is why `mixed` is reported rather than left
 * for the reader to infer.
 */
export interface AnalyticsClockProvenance {
  /** True when a gateway URL and API key are both configured right now. */
  gateway_configured: boolean;
  /** The clock a verdict recorded at this moment would carry. */
  current_clock_source: SlaClockSource;
  /** Closed clocks in the window, split by the clock that judged them. */
  by_clock_source: AnalyticsClockShare[];
  /**
   * True when more than one distinct clock produced the closed verdicts in this
   * window. A mixed window's breach rate is a blend of two measurements and
   * should be read — and presented — with that caveat.
   */
  mixed: boolean;
}

/**
 * Response-time attainment for the window, from ProjexCloud `sdk-sla`.
 *
 * The rest of this rollup is counted locally on purpose — the dashboard reads
 * LeadFlow's own projection so it never fans out into a read per lead. This one
 * block is different: attainment is a judgement about whether targets were MET,
 * and the target and the calendar it is judged against belong to `sdk-sla`, not
 * to LeadFlow. Asking upstream for it is ONE call for the whole window, so the
 * no-fan-out rule holds.
 *
 * When the gateway is unconfigured or unreachable the same figures are derived
 * from the local projection and `delivered` is false. That fallback is a
 * DIFFERENT measurement, not a cheaper route to the same one: it counts the
 * breach flags already on the lead rows against the default target, with no
 * business calendar. `source` says which of the two the reader is looking at,
 * so a wall-clock number is never mistaken for a calendar-aware one.
 */
export interface AnalyticsAttainment {
  /** True when `sdk-sla` answered; false when these are LeadFlow's own figures. */
  delivered: boolean;
  /** `sdk_sla` when upstream computed this, `local_wallclock` when LeadFlow did. */
  source: SlaClockSource;
  /** The first-response target the rate was judged against, in minutes. */
  target_minutes: number | null;
  /** Clocks that closed in the window. */
  closed: number;
  /** Of those, how many met their target. */
  met: number;
  /** Of those, how many missed it. */
  breached: number;
  /**
   * met / closed, 0..1 to four decimals, null when nothing has closed.
   *
   * The complement of `conversion.breach_rate` when both come from the same
   * clock, and deliberately NOT derived from it: when `sdk-sla` answers, the two
   * are counted on different calendars and forcing one to be `1 - other` would
   * manufacture agreement that does not exist.
   */
  attainment_rate: number | null;
}

export interface AnalyticsOverview {
  generated_at: string;
  filters: {
    from: string;
    to: string;
    source: LeadSourceChannel | null;
    owner_user_id: string | null;
  };
  funnel: AnalyticsFunnel;
  conversion: AnalyticsConversion;
  response_times: AnalyticsResponseTimes;
  attainment: AnalyticsAttainment;
  clock_provenance: AnalyticsClockProvenance;
  by_source: AnalyticsSourceBreakdown[];
  daily: AnalyticsDailyPoint[];
}

/** Shape of the single aggregate row the totals query returns. */
interface TotalsRow {
  captured: string;
  routed: string;
  responded: string;
  breached: string;
  closed: string;
  average_seconds: string | null;
  median_seconds: string | null;
  p90_seconds: string | null;
}

interface SourceRow {
  source: LeadSourceChannel | null;
  captured: string;
  responded: string;
  breached: string;
  average_seconds: string | null;
}

interface DailyRow {
  day: string;
  captured: string;
  responded: string;
  breached: string;
}

interface ClockSourceRow {
  clock_source: SlaClockSource | null;
  closed: string;
  breached: string;
}

/** One window's attainment as ProjexCloud `sdk-sla` reports it. */
interface SdkAttainmentResult {
  data?: {
    attainment?: {
      target_minutes?: number;
      closed?: number;
      met?: number;
      breached?: number;
    };
  };
}

/**
 * Divide, or report null when there is nothing to divide by.
 *
 * Rounded to four decimals so a rate survives JSON without a trailing float
 * artefact — 0.6667, never 0.6666666666666666.
 */
function rate(numerator: number, denominator: number): number | null {
  if (denominator === 0) {
    return null;
  }
  return Math.round((numerator / denominator) * 10000) / 10000;
}

/** Postgres returns COUNT and numeric aggregates as strings. */
function toInt(value: string | null): number {
  return value === null ? 0 : Math.round(Number(value));
}

function toNullableInt(value: string | null): number | null {
  return value === null ? null : Math.round(Number(value));
}

/**
 * Analytics rollups over the local lead projection.
 *
 * DELIBERATELY SEPARATE FROM `SlaMonitorService.status`. That is the operational
 * view — "which clocks need somebody right now" — and it returns per-lead rows
 * for triage. This is the analytical view: aggregate performance over a closed
 * historical window, with no per-lead rows at all. Neither is derivable from the
 * other, so they are computed independently rather than one wrapping the other.
 *
 * ProjexCloud contributes two things here and only two: the attainment block,
 * which is a judgement against a target and a business calendar LeadFlow does
 * not hold, and the provenance of the breach figures. The counts themselves stay
 * local — see `AnalyticsAttainment` for why that split is deliberate.
 *
 * Every figure is aggregated IN POSTGRES rather than by reading rows and
 * summing them in Node. A dashboard over a year of captures would otherwise pull
 * the whole window across the wire to produce nine numbers, and the percentile
 * would need the full set in memory to sort.
 *
 * Response time is measured from `leads.created_at` — the moment the prospect
 * submitted — not from `assigned_at`, matching how the SLA clock itself is
 * measured. Measuring from assignment would let a lead sit unrouted for an hour
 * and still report a fast response.
 */
export class AnalyticsService {
  /**
   * Build the WHERE clause shared by all three queries.
   *
   * Returns the fragment and its parameters together so a caller cannot bind
   * them out of step. The window is half-open — `>= from AND < to` — so a lead
   * that arrives exactly on a boundary is counted in one window, never in both.
   */
  private static scope(query: AnalyticsOverviewQuery): { where: string; params: unknown[] } {
    const params: unknown[] = [query.from, query.to];
    let where = 'l.created_at >= $1 AND l.created_at < $2';

    if (query.source) {
      params.push(query.source);
      where += ` AND l.source = $${params.length}`;
    }
    if (query.owner_user_id) {
      params.push(query.owner_user_id);
      where += ` AND l.owner_user_id = $${params.length}`;
    }

    return { where, params };
  }

  /**
   * Which clock a verdict recorded at this instant would carry.
   *
   * Derived the same way `SlaMonitorService` derives it, from whether the
   * gateway is configured, so the rollup and the monitor can never disagree
   * about what the current clock is.
   */
  private static currentClockSource(): SlaClockSource {
    return SdkGatewayClient.isConfigured() ? 'sdk_sla' : 'local_wallclock';
  }

  /**
   * Ask `sdk-sla` how the window performed against its response targets.
   *
   * ONE call for the whole window, with the screen's own filters passed through
   * so upstream aggregates exactly the population the rest of the rollup counts.
   * A per-lead question would be the N+1 fan-out the read projection exists to
   * prevent, which is why nothing else on this screen is asked of the gateway.
   *
   * POST, not GET, matching `SlaMonitorService.askMonitor`: the filter set is a
   * structured body rather than four query parameters. No idempotency key —
   * this reads, it does not record.
   *
   * Reporting degrades, it never fails. A dashboard that 500s because a third
   * party is slow is worse than one showing locally-counted attainment with
   * `delivered:false` against it, so every failure path returns the fallback.
   *
   * @param query    The window and filters the whole rollup is scoped to.
   * @param fallback Locally-counted attainment, used unless upstream answers
   *                 with a usable payload.
   */
  private static async askAttainment(
    query: AnalyticsOverviewQuery,
    fallback: AnalyticsAttainment
  ): Promise<AnalyticsAttainment> {
    if (!SdkGatewayClient.isConfigured()) {
      return fallback;
    }

    const correlationId = randomUUID();

    try {
      // GET with query parameters, not POST with a body. Verified against the
      // running gateway rather than assumed:
      //   POST /api/sla/attainment                    -> 404
      //   GET  /api/sla/attainment?tenant_id&from&to  -> 200
      // The previous form was BOTH the wrong path (/v1/response-clocks/...)
      // and the wrong method, so it could never have returned anything.
      const params = new URLSearchParams({
        // Required, and app-scoped: attainment for THIS app's leads, not the
        // customer's other products.
        tenant_id: tenantIdFor(currentTenantContext(), 'sla'),
        from: query.from.toISOString(),
        to: query.to.toISOString(),
      });
      // Omitted entirely when absent rather than sent empty — an empty filter
      // reads upstream as "match nothing" and would report a clean window as a
      // window with no data.
      if (query.source) {
        params.set('source', query.source);
      }
      if (query.owner_user_id) {
        params.set('owner_user_id', query.owner_user_id);
      }

      const result = await SdkGatewayClient.call<SdkAttainmentResult>({
        sdk: 'sdk-sla',
        path: `/api/sla/attainment?${params.toString()}`,
        method: 'GET',
        correlationId,
      });

      const attainment = result.delivered ? result.data?.data?.attainment : undefined;

      // A payload without a closed count is unusable, not empty: `met` alone
      // cannot be turned into a rate, and defaulting the denominator to zero
      // would report 100% attainment for a window nobody measured. An answer
      // that cannot be read is treated exactly like no answer.
      if (!attainment || typeof attainment.closed !== 'number') {
        return fallback;
      }

      const closed = Math.max(0, Math.round(attainment.closed));
      const breached =
        typeof attainment.breached === 'number' ? Math.max(0, Math.round(attainment.breached)) : 0;
      // Trust `met` when upstream sends it, derive it when it does not. Clamped
      // to the closed total either way: upstream counting on a calendar LeadFlow
      // does not hold may legitimately disagree about a lead, but it can never
      // meet more clocks than it closed, and a rate above 1 would be nonsense on
      // the screen rather than an interesting discrepancy.
      const met =
        typeof attainment.met === 'number'
          ? Math.min(closed, Math.max(0, Math.round(attainment.met)))
          : Math.max(0, closed - breached);

      return {
        delivered: true,
        source: 'sdk_sla',
        target_minutes:
          typeof attainment.target_minutes === 'number'
            ? attainment.target_minutes
            : fallback.target_minutes,
        closed,
        met,
        breached: Math.min(closed, breached),
        attainment_rate: rate(met, closed),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[AnalyticsService] sdk-sla attainment unavailable (${correlationId}):`, message);
      return fallback;
    }
  }

  /**
   * Compute the analytics overview for a filtered window.
   *
   * @param query Validated bounds and filters.
   * @returns The funnel, conversion rates, response-time distribution, the
   *          `sdk-sla` attainment block and its clock provenance, the
   *          per-source breakdown and the per-day series.
   */
  static async overview(query: AnalyticsOverviewQuery): Promise<AnalyticsOverview> {
    const { where, params } = AnalyticsService.scope(query);

    // Seconds from arrival to first response, for the leads that have one.
    // Expressed once here and reused by both the totals and the breakdown so the
    // two can never disagree about what a "response time" is.
    const responseSeconds = 'EXTRACT(EPOCH FROM (l.first_response_at - l.created_at))';

    // A clock is CLOSED once its outcome is decided: the lead was answered, or
    // it breached. Leads still comfortably inside their window are excluded from
    // the breach rate rather than counted as passes — they have not been judged
    // yet, and counting them would flatter the number.
    const totals = await dataService.queryOne<TotalsRow>(
      `SELECT
         COUNT(*)                                                          AS captured,
         COUNT(*) FILTER (WHERE l.owner_user_id IS NOT NULL)               AS routed,
         COUNT(*) FILTER (WHERE l.first_response_at IS NOT NULL)           AS responded,
         COUNT(*) FILTER (WHERE l.sla_breached)                            AS breached,
         COUNT(*) FILTER (WHERE l.first_response_at IS NOT NULL
                             OR l.sla_breached)                            AS closed,
         AVG(${responseSeconds}) FILTER (WHERE l.first_response_at IS NOT NULL)
                                                                           AS average_seconds,
         PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${responseSeconds})
           FILTER (WHERE l.first_response_at IS NOT NULL)                  AS median_seconds,
         PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY ${responseSeconds})
           FILTER (WHERE l.first_response_at IS NOT NULL)                  AS p90_seconds
       FROM leads l
       WHERE ${where}`,
      params
    );

    const bySource = await dataService.query<SourceRow>(
      `SELECT
         l.source                                                          AS source,
         COUNT(*)                                                          AS captured,
         COUNT(*) FILTER (WHERE l.first_response_at IS NOT NULL)           AS responded,
         COUNT(*) FILTER (WHERE l.sla_breached)                            AS breached,
         AVG(${responseSeconds}) FILTER (WHERE l.first_response_at IS NOT NULL)
                                                                           AS average_seconds
       FROM leads l
       WHERE ${where}
       GROUP BY l.source
       ORDER BY COUNT(*) DESC, l.source ASC`,
      params
    );

    // date_trunc, not a client-side bucket: the day a lead belongs to must be
    // decided by one clock, and doing it in SQL keeps it consistent with the
    // window bounds the same query filters on.
    const daily = await dataService.query<DailyRow>(
      `SELECT
         to_char(date_trunc('day', l.created_at), 'YYYY-MM-DD')            AS day,
         COUNT(*)                                                          AS captured,
         COUNT(*) FILTER (WHERE l.first_response_at IS NOT NULL)           AS responded,
         COUNT(*) FILTER (WHERE l.sla_breached)                            AS breached
       FROM leads l
       WHERE ${where}
       GROUP BY date_trunc('day', l.created_at)
       ORDER BY date_trunc('day', l.created_at) ASC`,
      params
    );

    // Provenance of the breach figures, from the observation the SLA monitor
    // wrote for each lead. A LEFT JOIN, and a separate query from the totals:
    // joining it into the aggregate above would risk a lead with no observation
    // silently dropping out of `captured`, which would corrupt every rate on the
    // screen to answer a question about provenance.
    //
    // Restricted to CLOSED clocks so it lines up exactly with the denominator of
    // breach_rate. Reporting provenance over a different population than the
    // rate it qualifies would be worse than reporting none.
    const byClockSource = await dataService.query<ClockSourceRow>(
      `SELECT
         m.clock_source                                                    AS clock_source,
         COUNT(*)                                                          AS closed,
         COUNT(*) FILTER (WHERE l.sla_breached)                            AS breached
       FROM leads l
       LEFT JOIN sla_metrics m ON m.subject_lead_id = l.id
       WHERE ${where}
         AND (l.first_response_at IS NOT NULL OR l.sla_breached)
       GROUP BY m.clock_source
       ORDER BY COUNT(*) DESC, m.clock_source ASC`,
      params
    );

    const captured = toInt(totals?.captured ?? '0');
    const routed = toInt(totals?.routed ?? '0');
    const responded = toInt(totals?.responded ?? '0');
    const breached = toInt(totals?.breached ?? '0');
    const closed = toInt(totals?.closed ?? '0');

    // Counted locally first, so the gateway call has something to fall back to
    // and so the fallback is never computed inside an error path where a second
    // mistake could go unnoticed.
    const attainment = await AnalyticsService.askAttainment(query, {
      delivered: false,
      source: 'local_wallclock',
      target_minutes: SLA_WINDOW_MINUTES,
      closed,
      met: closed - breached,
      breached,
      attainment_rate: rate(closed - breached, closed),
    });

    return {
      generated_at: new Date().toISOString(),
      filters: {
        from: query.from.toISOString(),
        to: query.to.toISOString(),
        source: query.source ?? null,
        owner_user_id: query.owner_user_id ?? null,
      },
      funnel: { captured, routed, responded, breached },
      conversion: {
        routed_rate: rate(routed, captured),
        response_rate: rate(responded, routed),
        breach_rate: rate(breached, closed),
      },
      response_times: {
        average_seconds: toNullableInt(totals?.average_seconds ?? null),
        median_seconds: toNullableInt(totals?.median_seconds ?? null),
        p90_seconds: toNullableInt(totals?.p90_seconds ?? null),
      },
      attainment,
      clock_provenance: {
        gateway_configured: SdkGatewayClient.isConfigured(),
        current_clock_source: AnalyticsService.currentClockSource(),
        by_clock_source: byClockSource.map((row) => ({
          clock_source: row.clock_source,
          closed: toInt(row.closed),
          breached: toInt(row.breached),
        })),
        // Counted over ATTRIBUTED verdicts only. An unobserved clock is a gap in
        // the record, not a third kind of clock, so it must not make a window
        // that only ever used sdk-sla report itself as mixed.
        mixed:
          byClockSource.filter((row) => row.clock_source !== null).length > 1,
      },
      by_source: bySource.map((row) => ({
        source: row.source,
        captured: toInt(row.captured),
        responded: toInt(row.responded),
        breached: toInt(row.breached),
        average_response_seconds: toNullableInt(row.average_seconds),
      })),
      daily: daily.map((row) => ({
        day: row.day,
        captured: toInt(row.captured),
        responded: toInt(row.responded),
        breached: toInt(row.breached),
      })),
    };
  }
}
