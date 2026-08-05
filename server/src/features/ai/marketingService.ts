import {
  GOVERNED_SEGMENTS,
  GovernedSegment,
  allSegmentKeys,
  partitionRequestedSegments,
  promotionalSegments,
  segmentByKey,
} from '../../config/governedSegments';
import { dataService } from '../../services/DataService';
import { AppError, ErrorCodes } from '../../utils/errors';
import { propose, Proposal } from '../../platform/ai/reviewGate';

/**
 * The AI Marketing module: attribution, and what to send next.
 *
 * THE ONE RULE THAT SHAPES THIS FILE is that a recommendation may only name an
 * audience from the governed segment registry. Not "should", and not "is
 * filtered to" — a recommendation naming anything else is REFUSED, because a
 * silently narrowed audience produces a recommendation whose reasoning was drawn
 * from people who are not in it, and a reviewer reading the proposal cannot tell.
 *
 * ATTRIBUTION IS FRACTIONAL AND SAYS SO. Last-touch attribution is easy and
 * wrong in the one case anybody cares about — the channel that opened the
 * relationship gets nothing, so the cheap channel that closed it looks like the
 * whole story. Every touch on a lead shares the credit, and the response names
 * the model so nobody compares these numbers with a last-touch report from
 * somewhere else and concludes one of them is broken.
 */

export interface AttributionRow {
  /** Channel or campaign the credit is attributed to. */
  touch: string;
  /** Leads with this touch anywhere in their attribution. */
  leads: number;
  /** Leads that were answered. */
  responded: number;
  /**
   * Fractional credit, shared across every touch on a lead.
   *
   * A lead with three touches gives each a third, so the column sums to the lead
   * count rather than to three times it. Whole-number credit per touch is how a
   * report ends up claiming more conversions than there were leads.
   */
  fractionalCredit: number;
}

export interface AttributionReport {
  model: 'fractional_even';
  window_days: number;
  rows: AttributionRow[];
  generatedAt: string;
}

/**
 * Revenue attribution across touches.
 *
 * "Revenue" is the word in the brief and the honest local answer is that
 * LeadFlow holds no revenue: there is no won amount on a lead, so crediting
 * money would mean inventing it. What this credits is RESPONDED LEADS, and the
 * field names say so rather than labelling a lead count as revenue and letting a
 * reader assume currency.
 */
export async function attribution(windowDays = 30): Promise<AttributionReport> {
  const rows = await dataService.query<{
    touch: string;
    leads: string;
    responded: string;
    fractional_credit: string;
  }>(
    `WITH touched AS (
       SELECT l.id,
              l.first_response_at,
              -- Every non-null attribution field is one touch. Built as an array
              -- so the divisor below is the REAL number of touches on that lead
              -- rather than a guess.
              ARRAY_REMOVE(ARRAY[
                l.attribution_platform,
                l.utm_source,
                l.utm_medium,
                l.utm_campaign,
                l.source
              ], NULL) AS touches
         FROM leads l
        WHERE l.created_at >= NOW() - ($1 || ' days')::interval
     )
     SELECT touch,
            COUNT(*)::text                                              AS leads,
            COUNT(*) FILTER (WHERE first_response_at IS NOT NULL)::text AS responded,
            -- The fraction is 1/(touch count) per lead, so the column sums back
            -- to the number of attributed leads.
            ROUND(SUM(1.0 / ARRAY_LENGTH(touches, 1))::numeric, 3)::text AS fractional_credit
       FROM touched, UNNEST(touches) AS touch
      WHERE ARRAY_LENGTH(touches, 1) > 0
      GROUP BY touch
      ORDER BY fractional_credit DESC`,
    [String(windowDays)]
  );

  return {
    model: 'fractional_even',
    window_days: windowDays,
    rows: rows.map((row) => ({
      touch: row.touch,
      leads: parseInt(row.leads, 10) || 0,
      responded: parseInt(row.responded, 10) || 0,
      fractionalCredit: Number(row.fractional_credit) || 0,
    })),
    generatedAt: new Date().toISOString(),
  };
}

export interface SegmentSize {
  key: string;
  label: string;
  purpose: string;
  elective: boolean;
  members: number;
}

/**
 * How many people are currently in each governed segment.
 *
 * Runs the segment's own SQL predicate. That is the reason the registry stores
 * a predicate rather than a description: a segment whose membership cannot be
 * computed cannot be checked, and an audience nobody can count is an audience
 * nobody can review.
 */
export async function segmentSizes(): Promise<SegmentSize[]> {
  const sizes: SegmentSize[] = [];

  for (const segment of GOVERNED_SEGMENTS) {
    const row = await dataService.queryOne<{ members: string }>(
      `SELECT COUNT(*)::text AS members FROM leads l WHERE ${segment.predicate}`,
      []
    );
    sizes.push({
      key: segment.key,
      label: segment.label,
      purpose: segment.purpose,
      elective: segment.elective,
      members: parseInt(row?.members ?? '0', 10) || 0,
    });
  }

  return sizes;
}

export interface CampaignRecommendation {
  segmentKey: string;
  segmentLabel: string;
  purpose: string;
  members: number;
  /** Suggested send window, from when this segment historically responds. */
  timing: string;
  rationale: string;
}

export interface RecommendInput {
  /** Audiences to consider. Defaults to every ELECTIVE governed segment. */
  segmentKeys?: string[];
  /** True when the campaign is promotional rather than service communication. */
  promotional?: boolean;
}

/**
 * Recommend the next campaign.
 *
 * @throws AppError(422 SEGMENT_NOT_GOVERNED) when any requested audience is not
 *         in the registry, or when a promotional campaign names a
 *         service-necessary segment.
 */
export async function recommendCampaign(
  input: RecommendInput = {}
): Promise<CampaignRecommendation[]> {
  const promotional = input.promotional === true;
  const requested = input.segmentKeys ?? promotionalSegments().map((segment) => segment.key);

  const { governed, refused } = partitionRequestedSegments(requested);

  // Checked BEFORE any membership is counted, so an ungoverned audience never
  // reaches a query at all. Reports every refusal at once rather than one per
  // request.
  if (refused.length > 0) {
    throw new AppError(
      422,
      ErrorCodes.SEGMENT_NOT_GOVERNED,
      `Audiences not in the governed segment registry: ${refused.join(', ')}. Registered: ${allSegmentKeys().join(', ')}`
    );
  }

  const resolved = governed.map((key) => segmentByKey(key) as GovernedSegment);

  if (promotional) {
    // A PROMOTION MAY ONLY GO TO AN ELECTIVE AUDIENCE. The segment being in the
    // registry is not enough: 'waiting on us' is a perfectly governed audience
    // for a service message and sending them a promotion is exactly the misuse
    // of a service purpose the consent registry exists to prevent.
    const serviceOnly = resolved.filter((segment) => !segment.elective);
    if (serviceOnly.length > 0) {
      throw new AppError(
        422,
        ErrorCodes.SEGMENT_NOT_GOVERNED,
        `These audiences are contactable for service purposes only, not promotion: ${serviceOnly
          .map((segment) => segment.key)
          .join(', ')}`
      );
    }
  }

  const sizes = await segmentSizes();
  const bySize = new Map(sizes.map((size) => [size.key, size.members]));

  return resolved
    .map((segment) => ({
      segmentKey: segment.key,
      segmentLabel: segment.label,
      purpose: segment.purpose,
      members: bySize.get(segment.key) ?? 0,
      timing: timingFor(segment),
      rationale: `${segment.basis} Recommended under the ${segment.purpose} purpose, which is the basis these members are contactable on.`,
    }))
    .filter((recommendation) => recommendation.members > 0)
    .sort((a, b) => b.members - a.members);
}

/**
 * When to send.
 *
 * Driven by the segment's PURPOSE rather than by an engagement model, because
 * the purpose is what makes the timing appropriate: an operational update about
 * somebody's own job is welcome on a weekday morning, and a promotion at the
 * same hour is an interruption.
 */
function timingFor(segment: GovernedSegment): string {
  switch (segment.purpose) {
    case 'inspection_estimate':
      return 'Immediately — they are waiting on an answer they asked for.';
    case 'project_operations':
      return 'Weekday mornings, alongside the working day their job runs in.';
    case 'seasonal_promotions':
      return 'Midweek, outside working hours, and no more than once per season.';
    case 'referral_program':
      return 'After a completed job, when the experience is recent.';
    default:
      return 'No timing rule recorded for this purpose.';
  }
}

/**
 * Run the marketing analysis and open a proposal per recommendation.
 *
 * Every recommendation is a PROPOSAL, like everything else the agent modules
 * produce. A campaign that could schedule itself would be an AI deciding to
 * contact somebody, which is the single thing the review gate exists to prevent.
 */
export async function marketingAnalysis(input: RecommendInput = {}): Promise<{
  attribution: AttributionReport;
  recommendations: CampaignRecommendation[];
  proposals: Proposal[];
  generatedAt: string;
}> {
  const [report, recommendations] = await Promise.all([
    attribution(),
    recommendCampaign(input),
  ]);

  const proposals: Proposal[] = [];
  for (const recommendation of recommendations) {
    proposals.push(
      await propose({
        agentKey: 'marketing_planner',
        kind: 'next_action',
        content: {
          finding: 'campaign_recommendation',
          action: `Send to ${recommendation.segmentLabel} (${recommendation.members} members).`,
          // The SEGMENT KEY travels on the proposal, so a reviewer can check the
          // audience against the registry rather than against a label somebody
          // typed.
          evidence: recommendation,
        },
      })
    );
  }

  return {
    attribution: report,
    recommendations,
    proposals,
    generatedAt: new Date().toISOString(),
  };
}
