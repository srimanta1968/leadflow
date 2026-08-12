import { dataService } from '../../services/DataService';
import { config } from '../../config/env';
import { SdkGatewayClient } from '../../platform/sdkGateway';

/**
 * Funnel, cohort and attribution reads, and the forecast confidence gate.
 * SOP §20, §47.
 */

/** What a deal must carry to be in the committed forecast. SOP §47. */
export const FORECAST_REQUIREMENTS = [
  'decision_date', 'named_stakeholder', 'next_event', 'stated_risk', 'evidence',
] as const;
export type ForecastRequirement = (typeof FORECAST_REQUIREMENTS)[number];

export interface ForecastDeal {
  dealRef: string; amountCents: number;
  decisionDate?: string | null; namedStakeholder?: string | null;
  nextEvent?: string | null; statedRisk?: string | null; evidence?: string | null;
}

export interface ForecastVerdict {
  dealRef: string; amountCents: number;
  committed: boolean; missing: ForecastRequirement[];
}

/**
 * Which forecast deals may be committed.
 *
 * A DEAL MISSING ANY ONE ELEMENT IS EXCLUDED, and shown as unqualified with the
 * missing element NAMED. Both halves matter: excluding it keeps the commit
 * number honest, and naming what is missing is what makes the exclusion
 * actionable rather than an argument in the pipeline review. "This is not in
 * commit" starts a debate; "this has no decision date" ends one.
 *
 * The requirements are conjunctive on purpose. A deal with a date and a
 * stakeholder but no stated risk is the classic slipped deal — everybody knew
 * the risk and nobody wrote it down, so nobody planned for it.
 */
export function classifyForecast(deals: ForecastDeal[]): {
  verdicts: ForecastVerdict[]; committedCents: number; unqualifiedCents: number;
} {
  const verdicts = deals.map((d) => {
    const missing: ForecastRequirement[] = [];
    if (!d.decisionDate) missing.push('decision_date');
    if (!d.namedStakeholder) missing.push('named_stakeholder');
    if (!d.nextEvent) missing.push('next_event');
    if (!d.statedRisk) missing.push('stated_risk');
    if (!d.evidence) missing.push('evidence');
    return { dealRef: d.dealRef, amountCents: d.amountCents, committed: missing.length === 0, missing };
  });
  return {
    verdicts,
    committedCents: verdicts.filter((v) => v.committed).reduce((s, v) => s + v.amountCents, 0),
    /* Reported as its own number rather than folded away. A commit of 400k with
       900k unqualified behind it is a different conversation from a commit of
       400k with nothing behind it, and hiding the second number makes the two
       look identical. */
    unqualifiedCents: verdicts.filter((v) => !v.committed).reduce((s, v) => s + v.amountCents, 0),
  };
}

/* ------------------------------------------------------------------ funnel */

export interface SourceRow {
  source: string; leads: number; contacted: number; booked: number;
  shown: number; won: number; contact_rate: number; booking_rate: number;
  show_rate: number; win_rate: number;
}

/**
 * Contact, booking, show and win rates by ORIGINAL source.
 *
 * POOR SOURCES ARE SURFACED, NEVER FILTERED. SOP §20 says so in as many words,
 * and the temptation runs the other way: a source with 400 leads and 2 meetings
 * makes the dashboard look bad, and the natural instinct is a minimum-conversion
 * filter that quietly hides it. That filter is exactly how a channel keeps
 * getting budget. So this query has no HAVING clause on conversion, and the
 * caller receives high-volume low-conversion sources ranked to the top of the
 * quality view rather than dropped from it.
 */
export async function funnelBySource(days: number): Promise<SourceRow[]> {
  const rows = await dataService.query<Record<string, string>>(
    `SELECT COALESCE(source, 'unknown') AS source,
            COUNT(*)::text                                              AS leads,
            COUNT(first_response_at)::text                              AS contacted,
            COUNT(*) FILTER (WHERE stage IN ('meeting_booked','demo','decision_review','closed_won'))::text AS booked,
            COUNT(*) FILTER (WHERE stage IN ('demo','decision_review','closed_won'))::text                  AS shown,
            COUNT(*) FILTER (WHERE stage = 'closed_won')::text          AS won
       FROM leads
      WHERE created_at >= now() - ($1 || ' days')::interval
      GROUP BY COALESCE(source, 'unknown')
      ORDER BY COUNT(*) DESC`,
    [String(days)]
  );

  return rows.map((r) => {
    const leads = Number(r.leads);
    const rate = (n: string): number => (leads === 0 ? 0 : Number((Number(n) / leads).toFixed(4)));
    return {
      source: r.source, leads,
      contacted: Number(r.contacted), booked: Number(r.booked),
      shown: Number(r.shown), won: Number(r.won),
      contact_rate: rate(r.contacted), booking_rate: rate(r.booked),
      show_rate: rate(r.shown), win_rate: rate(r.won),
    };
  });
}

/**
 * Sources whose volume is high and whose conversion is not.
 *
 * Ranked by WASTED VOLUME — leads that went nowhere — rather than by the
 * conversion percentage. A source with three leads and no wins has a 0% rate and
 * costs nothing; one with four hundred leads and two wins has a 0.5% rate and is
 * where the money is going. Sorting by rate alone puts the harmless one first.
 */
export function poorQuality(rows: SourceRow[], minVolume: number): (SourceRow & { wasted: number })[] {
  return rows
    .filter((r) => r.leads >= minVolume)
    .map((r) => ({ ...r, wasted: r.leads - r.won }))
    .filter((r) => r.win_rate < 0.02)
    .sort((a, b) => b.wasted - a.wasted);
}

/** Pipeline aging, with the two hard targets. */
export async function pipelineHealth(): Promise<{
  unowned: number; active_without_next: number; aging: { stage: string; count: number; oldest_days: number }[];
}> {
  const unowned = await dataService.query<{ v: string }>(
    `SELECT COUNT(*)::text AS v FROM leads
      WHERE owner_user_id IS NULL AND (stage IS NULL OR stage NOT IN ('closed_won','closed_lost'))`
  );
  const noNext = await dataService.query<{ v: string }>(
    `SELECT COUNT(*)::text AS v FROM leads
      WHERE next_due_at IS NULL AND (stage IS NULL OR stage NOT IN ('closed_won','closed_lost'))`
  );
  const aging = await dataService.query<{ stage: string; count: string; oldest_days: string }>(
    `SELECT COALESCE(stage,'unstaged') AS stage, COUNT(*)::text AS count,
            FLOOR(EXTRACT(EPOCH FROM (now() - MIN(created_at)))/86400)::text AS oldest_days
       FROM leads
      WHERE stage IS NULL OR stage NOT IN ('closed_won','closed_lost')
      GROUP BY COALESCE(stage,'unstaged') ORDER BY COUNT(*) DESC`
  );

  return {
    /* HARD TARGETS, both zero. Reported as raw counts rather than as a
       percentage: 99.4% owned sounds like success and is forty unowned leads
       nobody is working. */
    unowned: Number(unowned[0]?.v ?? 0),
    active_without_next: Number(noNext[0]?.v ?? 0),
    aging: aging.map((a) => ({ stage: a.stage, count: Number(a.count), oldest_days: Number(a.oldest_days) })),
  };
}

/** Onboarding attainment against the one-business-day standard. SOP §47. */
export async function onboardingAttainment(): Promise<{
  paid: number; assigned_and_booked: number; within_one_business_day: number; attainment: number;
}> {
  const rows = await dataService.query<{ paid: string; done: string; fast: string }>(
    `SELECT COUNT(*)::text AS paid,
            COUNT(*) FILTER (WHERE accepted_at IS NOT NULL AND kickoff_at IS NOT NULL)::text AS done,
            COUNT(*) FILTER (WHERE accepted_at IS NOT NULL AND kickoff_at IS NOT NULL
                                 AND accepted_at <= paid_at + interval '1 day')::text        AS fast
       FROM leadflow_onboarding_handoff WHERE tenant_id = $1`,
    [config.projexCloud.tenantId]
  );
  const paid = Number(rows[0]?.paid ?? 0);
  const fast = Number(rows[0]?.fast ?? 0);
  return {
    paid, assigned_and_booked: Number(rows[0]?.done ?? 0), within_one_business_day: fast,
    /* Measured against the ONE-BUSINESS-DAY standard, not against "eventually".
       A handoff accepted in six days met the goal on any measure that only asks
       whether it happened. */
    attainment: paid === 0 ? 1 : Number((fast / paid).toFixed(4)),
  };
}

/* ------------------------------------------------------------- attribution */

/**
 * Campaign, source, ad and creative performance from the lead columns.
 *
 * EVIDENCE-BASED, NOT RECONSTRUCTED. The attribution columns are stamped at
 * intake and travel with the lead to closed-won, so this is a GROUP BY over
 * facts recorded at the time rather than a guess assembled later from timestamps
 * and campaign windows — which is what "evidence-based" means in SOP §20 and is
 * the difference between a number marketing can defend and one they cannot.
 */
export async function attribution(days: number): Promise<Record<string, unknown>[]> {
  return dataService.query(
    `SELECT COALESCE(attribution_platform,'unknown')   AS platform,
            COALESCE(attribution_campaign_id,'none')   AS campaign_id,
            COALESCE(attribution_ad_id,'none')         AS ad_id,
            COALESCE(attribution_creative_id,'none')   AS creative_id,
            COALESCE(utm_source,'none')                AS utm_source,
            COALESCE(utm_medium,'none')                AS utm_medium,
            COALESCE(source,'unknown')                 AS original_source,
            COALESCE(latest_source, source, 'unknown') AS latest_source,
            COUNT(*)::int                              AS leads,
            COUNT(first_response_at)::int              AS contacted,
            COUNT(*) FILTER (WHERE stage = 'closed_won')::int AS closed_won
       FROM leads
      WHERE created_at >= now() - ($1 || ' days')::interval
      GROUP BY 1,2,3,4,5,6,7,8
      ORDER BY COUNT(*) DESC LIMIT 500`,
    [String(days)]
  );
}

/**
 * Register the derivation with sdk-analytics so the lineage is inspectable.
 *
 * The dataset spec is the artifact that makes AC4 true: a reader who disputes an
 * attribution number can follow the lineage ref back to the inputs rather than
 * being told the query was correct.
 */
export async function publishLineage(specKey: string, sql: string): Promise<{ specId: string | null; note: string }> {
  if (!SdkGatewayClient.isConfigured()) {
    return { specId: null, note: 'sdk-analytics is not configured, so no lineage ref was registered for this derivation.' };
  }
  try {
    const result = await SdkGatewayClient.call<{ data?: { spec_id?: string } }>({
      sdk: 'sdk-analytics', path: '/api/analytics/datasets', method: 'POST',
      idempotencyKey: `dataset:${specKey}`,
      body: {
        tenant_id: config.projexCloud.tenantId, spec_key: specKey,
        definition: { sql }, lineage: { source: 'leadflow.leads', derivation: specKey },
      },
    });
    return result.delivered
      ? { specId: result.data?.data?.spec_id ?? null, note: 'Lineage registered with sdk-analytics.' }
      : { specId: null, note: 'sdk-analytics did not answer, so the derivation is unregistered for this run.' };
  } catch (error) {
    return { specId: null, note: `Lineage registration failed: ${error instanceof Error ? error.message : 'unknown'}` };
  }
}
