import { Router, type Response } from 'express';
import { asyncHandler } from '../../middleware/errorHandler';
import { authenticate } from '../../middleware/auth';
import { AppError, ErrorCodes } from '../../utils/errors';
import { governed, type GovernedRequest } from '../../platform/policy/governed';
import { PERMISSIONS } from '../../config/roles';
import { AUDIT_EVENTS } from '../../platform/audit/vocabulary';
import {
  CASE_FAMILIES,
  CASE_TYPES,
  CASE_TYPE_KEYS,
  RISK_LEVELS,
  caseTypeByKey,
  slaBand,
  type CaseFamily,
  type RiskLevel,
} from './caseTypes';
import { listIncidents, listSlaBreaches, resolveOwners, type IncidentRow } from './dataReviewGateway';
import { DETECTOR_KEYS, runDetectors } from './detectors';

/** How a detector pass came to run. Mirrors the CHECK on leadflow_detector_run. */
const TRIGGERS = ['schedule', 'event', 'manual'] as const;

/**
 * The Data Review screen's read surface: one endpoint, one screen.
 *
 * ONE CALL, THREE UPSTREAMS, DEGRADING INDEPENDENTLY. The register, the clocks
 * and the role holders are read CONCURRENTLY; an unreachable policy service
 * empties the owner column and leaves every case triageable, and an unreachable
 * incident register empties the queue and says so rather than reporting zero
 * cases. Fanning out from the browser would put the tiles and the rows at three
 * different instants behind one screen.
 *
 * THE TILES AND THE QUEUE ARE COUNTED FROM THE SAME ROWS. A tile reading 12
 * above a filter that finds 9 is the classic failure here, and it happens when
 * counts come from an aggregate endpoint and rows from a list. Both are derived
 * from the one register read.
 */
export const dataReviewRoutes: Router = Router();

dataReviewRoutes.use(authenticate);

const NOT_AN_OWNED_RECORD = {
  own_record_only: {
    kind: 'defer' as const,
    because: 'a data review case belongs to the tenant and its adjudicating role, not to an operator',
  },
};

const minutesUntil = (iso: string | undefined): number | null => {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : Math.round((at - Date.now()) / 60000);
};

/**
 * Normalise one incident into a queue row.
 *
 * AN UNRECOGNISED CASE TYPE IS KEPT, NOT DROPPED. A case the screen has no tile
 * for is still a case somebody has to work, and silently hiding it is how a
 * governance queue quietly stops being complete. It lands with its raw type and
 * no family, so the type filter will not claim it and the count still includes it.
 */
function toRow(
  incident: IncidentRow,
  clock: { minutes_remaining: number | null; breached: boolean } | undefined,
  owners: Record<string, string | null>,
): Record<string, unknown> {
  const def = incident.case_type ? caseTypeByKey(incident.case_type) : undefined;
  const minutes = clock ? clock.minutes_remaining : minutesUntil(incident.due_at);
  const risk = RISK_LEVELS.includes(incident.risk as RiskLevel)
    ? (incident.risk as RiskLevel)
    : 'medium';

  return {
    case_id: incident.incident_id ?? null,
    case_type: incident.case_type ?? null,
    case_type_label: def?.label ?? incident.case_type ?? 'Unclassified',
    family: def?.family ?? null,
    risk,
    entity: incident.entity_label ?? incident.entity_ref ?? null,
    issue: incident.issue ?? null,
    evidence_summary: incident.evidence_summary ?? null,
    /* AC4 - the ROLE is durable, the person is resolved and may be null. */
    owner_role: def?.ownerRole ?? incident.owner_role ?? null,
    owner: def?.ownerRole ? owners[def.ownerRole] ?? null : null,
    sla_minutes_remaining: minutes,
    /* AC3 - the band the screen escalates on, decided here so the tile, the
       row and any later export agree on what "critical" means. */
    sla_band: slaBand(minutes),
    status: incident.status ?? 'Review',
    opened_at: incident.opened_at ?? null,
  };
}

dataReviewRoutes.get(
  '/cases',
  asyncHandler(governed(
    {
      action: PERMISSIONS.DATA_CONFIGURE,
      event: AUDIT_EVENTS.DATA_REVIEW_QUEUE_INSPECTED,
      purpose: 'compliance',
      resourceType: 'data_review_case',
      metadata: (req) => ({
        surface: 'data_review',
        risk: (req.query?.risk as string) ?? 'all',
        family: (req.query?.family as string) ?? 'all',
      }),
      obligations: NOT_AN_OWNED_RECORD,
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      /*
       * REJECTED, NOT IGNORED. Silently dropping an unrecognised filter returns
       * the WHOLE register to somebody who asked for one segment, and a screen
       * headed "High risk" listing low-risk work gets worked in the wrong order.
       */
      const riskParam = req.query?.risk;
      if (typeof riskParam === 'string' && riskParam !== 'all'
        && !RISK_LEVELS.includes(riskParam as RiskLevel)) {
        throw new AppError(
          400,
          ErrorCodes.VALIDATION_ERROR,
          `risk must be all or one of: ${RISK_LEVELS.join(', ')}`,
        );
      }
      const familyParam = req.query?.family;
      if (typeof familyParam === 'string' && familyParam !== 'all'
        && !CASE_FAMILIES.includes(familyParam as CaseFamily)) {
        throw new AppError(
          400,
          ErrorCodes.VALIDATION_ERROR,
          `family must be all or one of: ${CASE_FAMILIES.join(', ')}`,
        );
      }

      const rawLimit = Number(req.query?.limit ?? 200);
      const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 200, 1), 1000);

      const [register, breaches] = await Promise.all([listIncidents(limit), listSlaBreaches()]);

      const owners = await resolveOwners([...new Set(CASE_TYPES.map((t) => t.ownerRole))]);

      const clocks = new Map(
        (breaches.available ? breaches.value : []).map((b) => [
          b.incident_id ?? '',
          {
            minutes_remaining:
              typeof b.minutes_remaining === 'number' ? b.minutes_remaining : minutesUntil(b.due_at),
            breached: b.breached === true,
          },
        ]),
      );

      const all = (register.available ? register.value : []).map((incident) =>
        toRow(incident, clocks.get(incident.incident_id ?? ''), owners.value),
      );

      /*
       * AC2 - THE TWO FILTERS COMPOSE. Risk and family are independent
       * predicates applied to the same set, so High + Consent means both rather
       * than the last one clicked. Applied here rather than in the browser so
       * the counts below describe the same window the rows came from.
       */
      const risk = typeof riskParam === 'string' && riskParam !== 'all' ? riskParam : null;
      const family = typeof familyParam === 'string' && familyParam !== 'all' ? familyParam : null;
      const rows = all.filter(
        (row) => (risk === null || row.risk === risk) && (family === null || row.family === family),
      );

      res.status(200).json({
        success: true,
        data: {
          /*
           * AC1 - all eight tiles ALWAYS render, with a live count from the
           * same rows the queue shows. A type with no open cases is a zero, not
           * a missing tile: an absent tile reads as "we do not check for this".
           * The count is null rather than 0 when the register could not be read.
           */
          case_types: CASE_TYPES.map((type) => ({
            key: type.key,
            label: type.label,
            description: type.description,
            family: type.family,
            owner_role: type.ownerRole,
            count: register.available
              ? all.filter((row) => row.case_type === type.key).length
              : null,
          })),
          cases: rows,
          case_count: rows.length,
          /* Counted over the WHOLE window, so a segment count never moves with itself. */
          risk_counts: RISK_LEVELS.reduce<Record<string, number>>((counts, level) => {
            counts[level] = all.filter((row) => row.risk === level).length;
            return counts;
          }, {}),
          family_counts: CASE_FAMILIES.reduce<Record<string, number>>((counts, key) => {
            counts[key] = all.filter((row) => row.family === key).length;
            return counts;
          }, {}),
          filters: { risk: risk ?? 'all', family: family ?? 'all' },
          known_case_types: CASE_TYPE_KEYS,
          upstream_available: {
            register: register.available,
            sla: breaches.available,
            owners: owners.available,
          },
          /* Named so a blank column is never read as "nobody owns this". */
          field_gaps: owners.available
            ? []
            : [{
              field: 'owner',
              reason:
                'The policy service could not be reached, so the role that owns each case is shown without the person currently holding it. Routing is unaffected.',
            }],
        },
      });
    },
  )),
);

/* ------------------------------------------------------- the detectors (#93) */

/**
 * POST /api/leadflow/review/detectors/run — run one detector or all eight.
 *
 * THE SAME ENTRY POINT FOR EVERY TRIGGER. The nightly sweep, the event
 * subscriber and an operator all arrive here, so a detector cannot behave
 * differently depending on what woke it — which is the bug that makes a
 * scheduled job pass every test and misbehave only in production.
 *
 * IDEMPOTENT BY CONSTRAINT, NOT BY CHECK. Re-running opens nothing it has
 * already opened, because leadflow_review_case carries a partial unique index
 * over (tenant, type, dedupe_key) WHERE status = 'open'. The response reports
 * `suppressed` alongside `opened` so a healthy re-run is visible as such rather
 * than looking like a detector that has stopped finding anything.
 *
 * GOVERNED because a run puts real records in front of a human: who caused the
 * queue to exist is part of the record.
 */
dataReviewRoutes.post(
  '/detectors/run',
  asyncHandler(governed(
    {
      action: PERMISSIONS.SOURCE_RECORD_PROMOTE,
      event: AUDIT_EVENTS.DATA_REVIEW_QUEUE_INSPECTED,
      purpose: 'lead_management',
      resourceType: 'data_review_detector_run',
      metadata: (req) => ({
        detector: String((req.body as Record<string, unknown>)?.detector ?? 'all'),
        trigger: String((req.body as Record<string, unknown>)?.trigger ?? 'manual'),
      }),
      obligations: NOT_AN_OWNED_RECORD,
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const detector = typeof body.detector === 'string' && body.detector ? body.detector : undefined;
      const trigger = typeof body.trigger === 'string' && body.trigger ? body.trigger : 'manual';
      const triggerRef = typeof body.trigger_ref === 'string' ? body.trigger_ref : null;

      /*
       * REJECTED, NOT FALLEN BACK TO A FULL SWEEP. An event subscriber wired to
       * a detector name that no longer exists would otherwise run all eight on
       * every domain event, and nobody would notice until the load did.
       */
      if (detector !== undefined && !DETECTOR_KEYS.includes(detector)) {
        throw new AppError(
          400,
          ErrorCodes.VALIDATION_ERROR,
          `detector must be one of ${DETECTOR_KEYS.join(', ')}`
        );
      }

      /*
       * The run log exists to answer "has this been running at all", and a
       * trigger nobody can interpret makes that answer unreadable for every run
       * after it.
       */
      if (!TRIGGERS.includes(trigger as (typeof TRIGGERS)[number])) {
        throw new AppError(
          400,
          ErrorCodes.VALIDATION_ERROR,
          `trigger must be one of ${TRIGGERS.join(', ')}`
        );
      }

      const sweep = await runDetectors(trigger as 'schedule' | 'event' | 'manual', {
        detector,
        triggerRef,
      });

      res.status(200).json({
        success: true,
        data: {
          run_id: sweep.runId,
          trigger: sweep.trigger,
          detector: detector ?? 'all',
          /* AC1 — `suppressed` is the idempotence working, reported rather than
             discarded. A second identical sweep opens 0 and suppresses what the
             first opened. */
          totals: sweep.totals,
          runs: sweep.outcomes.map((outcome) => ({
            detector: outcome.detector,
            found: outcome.found,
            opened: outcome.opened,
            suppressed: outcome.suppressed,
            /* A detector that could not look found nothing for a reason that
               says nothing about the cases. Reported beside the count so "0" is
               never read as "clean". */
            source_available: outcome.sourceAvailable,
            note: outcome.note,
            /* AC4 — the role, resolved to a person by the queue read. */
            owner_role: caseTypeByKey(outcome.detector)?.ownerRole ?? null,
            risk: null,
          })),
          note: 'Cases are closed only by a detector whose source answered. A pass that could not look resolves nothing.',
        },
      });
    }
  ))
);
