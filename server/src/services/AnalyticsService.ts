import { dataService } from './DataService';
import { AnalyticsOverviewQuery } from '../validators/analyticsValidators';
import { LeadSourceChannel } from '../types';

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
   * Compute the analytics overview for a filtered window.
   *
   * @param query Validated bounds and filters.
   * @returns The funnel, conversion rates, response-time distribution, the
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

    const captured = toInt(totals?.captured ?? '0');
    const routed = toInt(totals?.routed ?? '0');
    const responded = toInt(totals?.responded ?? '0');
    const breached = toInt(totals?.breached ?? '0');
    const closed = toInt(totals?.closed ?? '0');

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
