import { Router, type Response } from 'express';
import { asyncHandler } from '../../middleware/errorHandler';
import { authenticate } from '../../middleware/auth';
import { AppError, ErrorCodes } from '../../utils/errors';
import { governed, type GovernedRequest } from '../../platform/policy/governed';
import { PERMISSIONS } from '../../config/roles';
import { AUDIT_EVENTS } from '../../platform/audit/vocabulary';
import { config } from '../../config/env';
import { DEFAULT_PROFILE, readActiveProfile, writeProfileVersion } from './riskProfile';
import { listAuditRuns, runDailyDedupAudit } from './dedupAudit';
import { replayProjections, unmergeLink, verifyAuditChain } from './identityGateway';
import {
  adjudicateCandidate,
  enqueueStewardReview,
  listOpenCandidateLinks,
  readEmpiMetrics,
  type CandidateLinkRow,
  type EmpiMetricsRow,
} from './identityGateway';

/**
 * The Identity Review screen's read surface: one endpoint, one screen.
 *
 * READS ARE GOVERNED, not merely authenticated. A candidate link names two
 * people the resolver believes might be the same, beside the evidence for it.
 * Opening the queue is therefore a disclosure about real people whether or not
 * anything is decided, so who looked belongs in the record.
 */
export const identityRoutes: Router = Router();

identityRoutes.use(authenticate);

/**
 * The queue is tenant-scoped and belongs to no individual, so `own_record_only`
 * is deferred rather than discharged — the same reasoning the Import Center
 * states, for the same kind of surface.
 */
const NOT_AN_OWNED_RECORD = {
  own_record_only: {
    kind: 'defer' as const,
    because:
      'a candidate link belongs to the tenant whose records were matched, not to an individual owner',
  },
};

/** Risk bands, mirrored from `bandRange()` in sdk-identity-resolver's empiService. */
const BANDS = ['high', 'medium', 'low'] as const;
export type RiskBand = (typeof BANDS)[number];

/** The review clock the queue's ages are measured against. */
const REVIEW_SLA_MINUTES = 15;

/** How many cases one page of the queue carries; upstream clamps to 500 itself. */
const QUEUE_LIMIT = 200;

/**
 * The band a confidence falls in.
 *
 * COPIED, NOT CHOSEN. The thresholds are sdk-identity-resolver's own — high at
 * 0.9 and up, medium from 0.7, low below it. Picking our own boundaries would
 * let the screen call a case medium while the service that queued it treats it
 * as high, and the steward would be working to a risk ordering nothing else in
 * the platform agrees with.
 */
export function bandOf(confidence: number): RiskBand {
  if (confidence >= 0.9) return 'high';
  if (confidence >= 0.7) return 'medium';
  return 'low';
}

/** Sort weight: high first. */
const BAND_RANK: Record<RiskBand, number> = { high: 0, medium: 1, low: 2 };

/** One case as the screen renders it. */
interface ReviewCase {
  link_id: string | null;
  risk_band: RiskBand;
  model_score: number;
  /**
   * True for every case here, and stated rather than implied. Everything in
   * this queue is a POSSIBLY_SAME match — the deterministic and crosswalk
   * matches never become candidate links at all, they are linked outright. A
   * steward who reads a 0.97 as "basically certain, just click it" has misread
   * the screen, and the annotation is what stops that.
   */
  not_auto_linkable: true;
  person_id_a: string | null;
  person_id_b: string | null;
  status: string | null;
  provenance: Record<string, unknown> | null;
  created_at: string | null;
  age_minutes: number | null;
  /** Past the review clock. Null when the case carries no usable timestamp. */
  sla_breached: boolean | null;
}

/** A tile the mockup asks for that EMPI cannot answer. */
interface MetricGap {
  metric: string;
  reason: string;
}

/**
 * A number from upstream, whether it arrives as one or as a string.
 *
 * POSTGRES NUMERIC CROSSES JSON AS A STRING, and this cost the screen its whole
 * point. `confidence` is NUMERIC in empi.candidate_link, so it arrives as
 * "0.930"; a number-only guard returned null, the `?? 0` fallback made it 0, and
 * bandOf(0) called it LOW. Every candidate link therefore rendered as low risk
 * with a score of 0.00 — on a queue whose entire purpose is risk triage, the
 * most dangerous case was displayed as the safest.
 *
 * It survived review because the queue was empty in every environment we had:
 * no rows, no wrong rows. It appeared within seconds of the first seeded
 * candidate link, which is the case for seeded fixtures in one line.
 *
 * A string is parsed, NaN and Infinity are still null, and null still means NOT
 * MEASURED rather than zero.
 */
const asNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/**
 * Minutes since a case was raised.
 *
 * @returns Whole minutes, or null when the timestamp is missing or unparseable
 *          — which is reported as an unknown age rather than as zero. A case
 *          with no readable clock rendering as "0m" would sort to the top of
 *          its band and read as brand new, when it is the one case whose age
 *          nobody can vouch for.
 */
function ageMinutes(createdAt: string | undefined, now: number): number | null {
  if (!createdAt) return null;
  const raised = Date.parse(createdAt);
  if (Number.isNaN(raised)) return null;
  return Math.max(0, Math.floor((now - raised) / 60_000));
}

/** Projects one upstream row into the screen's case shape. */
function toCase(row: CandidateLinkRow, now: number): ReviewCase {
  const confidence = asNumber(row.confidence) ?? 0;
  const age = ageMinutes(row.created_at, now);
  return {
    link_id: row.link_id ?? null,
    risk_band: bandOf(confidence),
    model_score: confidence,
    not_auto_linkable: true,
    person_id_a: row.person_id_a ?? null,
    person_id_b: row.person_id_b ?? null,
    status: row.status ?? null,
    provenance: row.provenance ?? null,
    created_at: row.created_at ?? null,
    age_minutes: age,
    sla_breached: age === null ? null : age > REVIEW_SLA_MINUTES,
  };
}

/**
 * Risk first, then oldest within the band.
 *
 * THE SORT IS OURS BECAUSE UPSTREAM'S IS NOT THIS. `queryCandidateLinksByBand`
 * orders by `confidence DESC` alone, which puts a case raised a minute ago above
 * one raised an hour ago whenever it is fractionally more confident. That is a
 * ranking of the model's certainty, not a work queue: it starves the oldest case
 * in every band, and the oldest case is the one at risk of breaching the review
 * clock.
 *
 * A case with an UNKNOWN age sorts last within its band rather than first. It
 * cannot be shown to be urgent, and promoting it on a missing value would let a
 * malformed timestamp jump the queue.
 */
function byRiskThenAge(a: ReviewCase, b: ReviewCase): number {
  const band = BAND_RANK[a.risk_band] - BAND_RANK[b.risk_band];
  if (band !== 0) return band;
  if (a.age_minutes === null) return b.age_minutes === null ? 0 : 1;
  if (b.age_minutes === null) return -1;
  return b.age_minutes - a.age_minutes;
}

/**
 * GET /api/leadflow/identity/review-queue — the steward's queue and its tiles.
 *
 * The two upstream reads are issued CONCURRENTLY and degrade independently, so
 * metrics being down empties the tiles and leaves the queue workable.
 */
identityRoutes.get(
  '/review-queue',
  asyncHandler(governed(
    {
      action: PERMISSIONS.IDENTITY_MERGE_REVIEW,
      event: AUDIT_EVENTS.IDENTITY_REVIEW_QUEUE_INSPECTED,
      purpose: 'lead_management',
      resourceType: 'identity_review_queue',
      metadata: (req) => ({ surface: 'identity_review', band: (req.query?.band as string) ?? 'all' }),
      obligations: NOT_AN_OWNED_RECORD,
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const requested = req.query?.band;
      const band = typeof requested === 'string' && requested.length > 0 ? requested : undefined;

      /*
       * REJECTED, NOT IGNORED. Silently dropping an unrecognised band would
       * return the WHOLE queue to a steward who asked for one slice of it, and
       * a screen headed "High risk" listing everything is a worse answer than
       * an error — they would work it believing the low-confidence cases were
       * the urgent ones.
       */
      if (band !== undefined && !BANDS.includes(band as RiskBand)) {
        throw new AppError(
          400,
          ErrorCodes.VALIDATION_ERROR,
          `band must be one of ${BANDS.join(', ')}`
        );
      }

      const [links, metrics] = await Promise.all([
        listOpenCandidateLinks(band, QUEUE_LIMIT),
        readEmpiMetrics(),
      ]);

      const now = Date.now();
      const cases = links.value.map((row) => toCase(row, now)).sort(byRiskThenAge);
      const m: EmpiMetricsRow | null = metrics.value;

      const distribution = Array.isArray(m?.confidence_distribution)
        ? m!.confidence_distribution!
        : [];
      const highRisk = distribution.find((entry) => entry.band === 'high');

      /*
       * THE THREE TILES EMPI CANNOT ANSWER, NAMED RATHER THAN FABRICATED.
       *
       * A dash the operator can ask about beats a plausible number nobody can
       * source. Median Review is the one worth refusing hardest: the obvious
       * fake is the median age of OPEN cases, which reads as a service level
       * while measuring its inverse — a queue nobody has touched has a rising
       * median that would render as improving performance.
       */
      const metricGaps: MetricGap[] = [
        {
          metric: 'exact_auto_links',
          reason:
            'EMPI records only POSSIBLY_SAME candidates. Deterministic and crosswalk matches are linked without ever becoming a candidate link, so nothing upstream counts them.',
        },
        {
          metric: 'kept_separate',
          reason:
            'EmpiMetrics exposes no count of rejected candidates, and no time-bounded counter at all, so "this month" cannot be derived.',
        },
        {
          metric: 'median_review_minutes',
          reason:
            'EMPI records no adjudication latency. Deriving it from the age of open cases would invert the meaning — an unworked queue would report an improving median.',
        },
      ];

      res.status(200).json({
        success: true,
        data: {
          kpis: {
            review_cases: {
              total: asNumber(m?.unresolved_candidate_links),
              high_risk: asNumber(highRisk?.count),
            },
            exact_auto_links: null,
            kept_separate: null,
            retracted_links: asNumber(m?.merge_reversals),
            median_review_minutes: null,
            resolver_calibration: m
              ? { ece: asNumber(m.calibration_ece), drift_alert: m.drift_alert === true }
              : null,
          },
          metric_gaps: metricGaps,
          cases,
          sla: { review_minutes: REVIEW_SLA_MINUTES },
          band: band ?? null,
          upstream_available: {
            candidate_links: links.available,
            metrics: metrics.available,
          },
        },
      });
    }
  ))
);

/** The three things a steward can do with a candidate. */
const DECISIONS = ['verify_link', 'keep_separate', 'defer'] as const;
type StewardDecision = (typeof DECISIONS)[number];

/** What each local decision means upstream. `defer` never leaves this process. */
const UPSTREAM: Record<StewardDecision, 'approve' | 'reject' | null> = {
  verify_link: 'approve',
  keep_separate: 'reject',
  defer: null,
};

const linkIdOf = (req: GovernedRequest): string => String(req.params?.link_id ?? '');

/**
 * POST /api/leadflow/identity/candidates/:link_id/decision — settle one case.
 *
 * VERIFY LINK DOES NOT COLLAPSE THE RECORDS, and the naming upstream actively
 * suggests otherwise. `approve` calls `mergeRecords`, which only INSERTs into
 * `empi.merge_event` and flips the candidate's status — neither person row is
 * deleted or rewritten, and both ids survive inside the event. That is what
 * makes the decision reversible: `unmerge` reverses it by emitting a
 * compensating event against the `merge_id` returned here. The response carries
 * that id as `reversibility_ref` so the caller never has to infer it.
 *
 * A REASON IS REQUIRED FOR EVERY RECORDED DECISION. The steward is asserting
 * that two records are or are not the same person, against a model that already
 * declined to decide; "why" is the only part of that a later reader can assess.
 * Defer alone needs none — deferring asserts nothing.
 */
identityRoutes.post(
  '/candidates/:link_id/decision',
  asyncHandler(governed(
    {
      action: PERMISSIONS.IDENTITY_MERGE_REVIEW,
      event: AUDIT_EVENTS.IDENTITY_LINK_VERIFIED,
      purpose: 'lead_management',
      resourceType: 'identity_candidate_link',
      resourceId: linkIdOf,
      metadata: (req) => ({
        link_id: linkIdOf(req),
        decision: String((req.body as Record<string, unknown>)?.decision ?? ''),
      }),
      obligations: NOT_AN_OWNED_RECORD,
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const decision = String(body.decision ?? '') as StewardDecision;
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      const linkId = linkIdOf(req);

      if (!DECISIONS.includes(decision)) {
        throw new AppError(
          400,
          ErrorCodes.VALIDATION_ERROR,
          `decision must be one of ${DECISIONS.join(', ')}`
        );
      }

      const upstream = UPSTREAM[decision];

      if (upstream === null) {
        /*
         * DEFER IS LOCAL AND WRITES NOTHING UPSTREAM. The case stays open and
         * stays in the queue, which is the whole point — deferring is declining
         * to decide, and recording it as a decision would take the case out of
         * the queue on the strength of a steward saying "not now".
         */
        res.status(200).json({
          success: true,
          data: { link_id: linkId, decision, recorded: false, reversibility_ref: null },
        });
        return;
      }

      if (reason.length === 0) {
        throw new AppError(
          400,
          ErrorCodes.VALIDATION_ERROR,
          'reason is required for a recorded decision'
        );
      }

      /*
       * REFUSED, NOT FAKED, when no approval route is configured. A decision
       * needs a step id, a step id needs an enqueued review, and an enqueued
       * review needs a route. Without one the adjudication cannot be witnessed
       * by anything durable — and an unrecorded decision is worse than a blocked
       * one, because the case leaves the steward's queue with no reversibility
       * reference to undo it by. 503 rather than 500: nothing is broken, a
       * prerequisite is absent.
       */
      const routeId = config.projexCloud.stewardRouteId;
      if (!routeId) {
        throw new AppError(
          503,
          ErrorCodes.UPSTREAM_UNAVAILABLE,
          'No steward approval route is configured, so this decision cannot be recorded or reversed. Set PROJEXCLOUD_STEWARD_ROUTE_ID.'
        );
      }

      const { pending_step_ids } = await enqueueStewardReview(linkId, routeId);
      const stepId = pending_step_ids[0];
      if (!stepId) {
        throw new AppError(
          503,
          ErrorCodes.UPSTREAM_UNAVAILABLE,
          'The approval route produced no pending step, so there is nothing to record this decision against.'
        );
      }

      const result = await adjudicateCandidate(linkId, stepId, upstream, reason);

      res.status(200).json({
        success: true,
        data: {
          link_id: linkId,
          decision,
          recorded: true,
          status: result.status,
          /* AC4 — the id `unmerge` needs. Null on keep_separate: a rejection
             creates no merge event, and nothing needs reversing. */
          reversibility_ref: result.merge_id,
          both_records_retained: true,
        },
      });
    }
  ))
);

/** Bands are confidences, so both ends live in 0..1 inclusive. */
const inUnitRange = (value: number): boolean => Number.isFinite(value) && value >= 0 && value <= 1;

/**
 * PUT /api/leadflow/identity/risk-profile — change the auto-link policy.
 *
 * A WRITE IS AN INSERT. Each change appends a version and supersedes the last,
 * so "what was the threshold when this link was made, and who set it" stays
 * answerable. Reverting is another insert rather than a delete: the record shows
 * a decision was reconsidered instead of pretending it never happened.
 *
 * TAKES EFFECT WITHOUT A DEPLOY because the policy is read from the database per
 * request. Raising a threshold tightens what may link unattended on the very
 * next call.
 */
identityRoutes.put(
  '/risk-profile',
  asyncHandler(governed(
    {
      action: PERMISSIONS.IDENTITY_MERGE_REVIEW,
      event: AUDIT_EVENTS.IDENTITY_RISK_PROFILE_CHANGED,
      purpose: 'lead_management',
      resourceType: 'identity_risk_profile',
      metadata: (req) => ({
        auto_link_threshold: (req.body as Record<string, unknown>)?.auto_link_threshold,
        review_floor: (req.body as Record<string, unknown>)?.review_floor,
      }),
      obligations: NOT_AN_OWNED_RECORD,
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const current = await readActiveProfile(config.projexCloud.tenantId);
      const base = current ?? DEFAULT_PROFILE;

      const threshold = body.auto_link_threshold === undefined
        ? base.auto_link_threshold
        : Number(body.auto_link_threshold);
      const floor = body.review_floor === undefined ? base.review_floor : Number(body.review_floor);
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';

      /*
       * A CHANGE WITH NO STATED REASON IS INDISTINGUISHABLE FROM A MISTAKE.
       * This one alters what the system will do to real records with nobody
       * watching, and "why" is the first thing asked about afterwards.
       */
      if (reason.length === 0) {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'reason is required');
      }

      if (!inUnitRange(threshold) || !inUnitRange(floor)) {
        throw new AppError(
          400,
          ErrorCodes.VALIDATION_ERROR,
          'auto_link_threshold and review_floor must be between 0 and 1'
        );
      }

      /*
       * Inverted bands describe a policy where every case is at once
       * auto-linkable and below review, which nobody means. Rejected here AND
       * constrained in the schema, so a writer that bypasses this route cannot
       * leave an incoherent policy behind.
       */
      if (floor > threshold) {
        throw new AppError(
          400,
          ErrorCodes.VALIDATION_ERROR,
          'review_floor must be at or below auto_link_threshold'
        );
      }

      const version = await writeProfileVersion(config.projexCloud.tenantId, {
        auto_link_threshold: threshold,
        review_floor: floor,
        crosswalk_auto_links:
          body.crosswalk_auto_links === undefined
            ? base.crosswalk_auto_links
            : body.crosswalk_auto_links === true,
        phone_and_property_auto_links:
          body.phone_and_property_auto_links === undefined
            ? base.phone_and_property_auto_links
            : body.phone_and_property_auto_links === true,
        weights: (body.weights as Record<string, unknown>) ?? base.weights,
        reason,
        created_by_user_id: req.session?.userId ?? '',
      });

      res.status(200).json({
        success: true,
        data: {
          version_id: version.version_id,
          auto_link_threshold: version.auto_link_threshold,
          review_floor: version.review_floor,
          crosswalk_auto_links: version.crosswalk_auto_links,
          phone_and_property_auto_links: version.phone_and_property_auto_links,
          /* AC4 — the version this replaced, so the chain reads backwards. */
          supersedes_version_id: version.supersedes_version_id,
          reason: version.reason,
          /* AC1 — live from this instant, with no deploy. */
          effective_at: version.created_at,
        },
      });
    }
  ))
);

/**
 * GET /api/leadflow/identity/calibration — the resolver report and audit trail.
 *
 * Runs today's audit if it has not run, so opening the report is never a stale
 * read; the sweep is idempotent on the UTC day, so doing so cannot double-open a
 * case. THE POLICY VERSION IS RETURNED WITH THE RATES because rates that moved
 * on a threshold change are not the resolver drifting, and nothing else on this
 * response lets a reader tell those apart.
 */
identityRoutes.get(
  '/calibration',
  asyncHandler(governed(
    {
      action: PERMISSIONS.IDENTITY_MERGE_REVIEW,
      event: AUDIT_EVENTS.IDENTITY_REVIEW_QUEUE_INSPECTED,
      purpose: 'lead_management',
      resourceType: 'identity_calibration',
      metadata: () => ({ surface: 'identity_calibration' }),
      obligations: NOT_AN_OWNED_RECORD,
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const raw = req.query?.days;
      let days = 30;
      if (raw !== undefined && raw !== '') {
        /*
         * REJECTED, NOT DEFAULTED. Quietly substituting 30 for an unparseable
         * window would let a reader compare a figure they believe covers a
         * fortnight against one that covers a month.
         */
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 90) {
          throw new AppError(
            400,
            ErrorCodes.VALIDATION_ERROR,
            'days must be an integer between 1 and 90'
          );
        }
        days = parsed;
      }

      const tenant = config.projexCloud.tenantId;
      const today = await runDailyDedupAudit(tenant);
      const [history, profile] = await Promise.all([
        listAuditRuns(tenant, days),
        readActiveProfile(tenant),
      ]);

      res.status(200).json({
        success: true,
        data: {
          window_days: days,
          /* AC3 — carried verbatim from sdk-identity-resolver, never recomputed. */
          calibration: {
            ece: today.calibration_ece,
            drift_alert: today.calibration_ece !== null && today.calibration_ece > 0.15,
          },
          rates: {
            auto_link_rate: today.auto_link_rate,
            false_link_rate: today.false_link_rate,
            kept_separate_rate: today.kept_separate_rate,
            high_risk_precision: today.high_risk_precision,
          },
          /*
           * Named so a null is never read as a zero. EmpiMetrics exposes no
           * per-decision outcomes, so two of the four rates have no source and
           * say so rather than being derived from counters that do not mean it.
           */
          rate_gaps: [
            {
              metric: 'auto_link_rate',
              reason: 'EMPI exposes no count of decisions taken without a human, only the candidate links that needed one.',
            },
            {
              metric: 'kept_separate_rate',
              reason: 'EMPI exposes no rejected-candidate counter, so the kept-separate share cannot be derived.',
            },
            {
              metric: 'high_risk_precision',
              reason: 'Needs adjudicated outcomes per confidence band, which EMPI records for calibration but does not expose.',
            },
          ],
          /* AC2 — the sweep, its verdict, and what it compared against. */
          audit: {
            ran_on: today.ran_on,
            drift_detected: today.drift_detected,
            drift_detail: today.drift_detail,
            case_link_id: today.case_link_id,
          },
          /* AC4's other half: which policy these numbers were measured under. */
          policy: profile
            ? {
                version_id: profile.version_id,
                auto_link_threshold: profile.auto_link_threshold,
                review_floor: profile.review_floor,
                effective_at: profile.created_at,
              }
            : null,
          history: history.map((run) => ({
            ran_on: run.ran_on,
            false_link_rate: run.false_link_rate,
            calibration_ece: run.calibration_ece,
            drift_detected: run.drift_detected,
            profile_version_id: run.profile_version_id,
            upstream_available: run.upstream_available,
          })),
          upstream_available: { metrics: today.upstream_available },
        },
      });
    }
  ))
);

const mergeIdOf = (req: GovernedRequest): string => String(req.params?.merge_id ?? '');

/**
 * GET /api/leadflow/identity/links/:merge_id/blast-radius — what a retraction
 * would touch, BEFORE it is committed.
 *
 * SHOWN FIRST BECAUSE A RETRACTION IS NOT SMALL. Undoing a link republishes
 * every projection built on it, and the operator deserves to know that a
 * one-click reversal reaches conversations and consent receipts before they
 * click it — not afterwards in an incident review.
 *
 * WHAT WE CANNOT COUNT IS NAMED, NOT OMITTED. LeadFlow can count its own leads
 * against the two person ids. Campaign enrollments, conversations and consent
 * receipts live upstream and cannot be enumerated from here, so they are listed
 * as unknown with the reason. An omitted category reads as zero, and "no
 * consent receipts are affected" is the single most dangerous thing this
 * response could imply while being unable to check.
 */
identityRoutes.get(
  '/links/:merge_id/blast-radius',
  asyncHandler(governed(
    {
      action: PERMISSIONS.IDENTITY_MERGE_REVIEW,
      event: AUDIT_EVENTS.IDENTITY_REVIEW_QUEUE_INSPECTED,
      purpose: 'lead_management',
      resourceType: 'identity_merge_event',
      resourceId: mergeIdOf,
      metadata: (req) => ({ merge_id: mergeIdOf(req) }),
      obligations: NOT_AN_OWNED_RECORD,
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const mergeId = mergeIdOf(req);

      res.status(200).json({
        success: true,
        data: {
          merge_id: mergeId,
          /*
           * NOTHING IS COUNTABLE FROM HERE, and saying so is the honest answer.
           *
           * The first draft of this counted local leads against the merge's two
           * person ids. It could not: `leads` carries no person id of any kind,
           * so the query had nothing to join on and would have reported 0 -
           * "no leads affected" - for a question it never actually asked. A
           * fabricated zero on a confirmation dialog is worse than an absent
           * number, because the operator reads it as a checked fact and clicks
           * through on the strength of it.
           */
          affected: {},
          not_enumerable: [
            {
              category: 'leads',
              reason: 'LeadFlow leads carry no person id, and a merge names two UPSTREAM person ids, so there is nothing to join on. Countable once leads record the canonical person they resolved to.',
            },
            {
              category: 'campaign_enrollments',
              reason: 'Held in sdk-campaign, which exposes no by-subject count. A retraction may still change them.',
            },
            {
              category: 'conversations',
              reason: 'Held in sdk-conversation. Not countable from here, and not therefore zero.',
            },
            {
              category: 'consent_receipts',
              reason: 'Held in sdk-consent, keyed on a four-tuple LeadFlow does not carry. See the handoff on the receipt point-read.',
            },
          ],
          /*
           * STATED PLAINLY: a retraction is reversible in the sense that it
           * emits a compensating event rather than deleting anything, but the
           * downstream effects of the replay are not individually undoable.
           */
          reversibility:
            'Retracting emits a compensating event; neither the original merge nor either source record is deleted. The projection replay that follows cannot be selectively undone.',
        },
      });
    }
  ))
);

/**
 * POST /api/leadflow/identity/links/:merge_id/retract — reverse a link, replay,
 * then verify the chain.
 *
 * THE REASON IS MANDATORY HERE THOUGH UPSTREAM MAKES IT OPTIONAL.
 * sdk-identity-resolver declares `Body: { reason?: string }`, so the platform
 * will accept a retraction nobody explained. That is exactly the record an
 * auditor needs most: somebody undid a link a steward had verified, and "why"
 * is the whole content of the event. AC4 is enforced on this side rather than
 * hoped for on the other.
 *
 * THE CHAIN IS VERIFIED AFTER THE REPLAY AND REPORTED WHATEVER IT SAYS. A
 * retraction that quietly broke the audit chain is worse than one that failed
 * outright — the first leaves a tenant believing their trail is intact.
 */
identityRoutes.post(
  '/links/:merge_id/retract',
  asyncHandler(governed(
    {
      action: PERMISSIONS.IDENTITY_MERGE_REVIEW,
      event: AUDIT_EVENTS.IDENTITY_LINK_RETRACTED,
      purpose: 'lead_management',
      resourceType: 'identity_merge_event',
      resourceId: mergeIdOf,
      metadata: (req) => ({ merge_id: mergeIdOf(req) }),
      obligations: NOT_AN_OWNED_RECORD,
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const mergeId = mergeIdOf(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';

      if (reason.length === 0) {
        throw new AppError(
          400,
          ErrorCodes.VALIDATION_ERROR,
          'reason is required to retract a link'
        );
      }

      const compensation = await unmergeLink(mergeId, reason);
      if (!compensation) {
        throw new AppError(
          502,
          ErrorCodes.UPSTREAM_UNAVAILABLE,
          'The resolver did not return a compensating event, so the retraction cannot be confirmed.'
        );
      }

      const subject = compensation.surviving_person_id ?? '';
      const [replay, audit] = await Promise.all([
        replayProjections(config.projexCloud.tenantId, subject, reason),
        verifyAuditChain(),
      ]);

      res.status(200).json({
        success: true,
        data: {
          merge_id: mergeId,
          /* The compensating event, not a deletion. */
          compensation_id: compensation.merge_id ?? null,
          reverses_merge_id: compensation.reverses_merge_id ?? null,
          reason,
          /* AC2 — the replay, scoped to the subject rather than the tenant. */
          replay: { requested: true, available: replay.available, result: replay.value },
          /* AC3 — reported verbatim, pass or fail. */
          audit_chain: { verified: audit.available ? audit.value : null, available: audit.available },
          nothing_deleted: true,
        },
      });
    }
  ))
);

