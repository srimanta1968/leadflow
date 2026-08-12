import { Router, type Response } from 'express';
import { asyncHandler } from '../../middleware/errorHandler';
import { authenticate, type AuthenticatedRequest } from '../../middleware/auth';
import { AppError, ErrorCodes } from '../../utils/errors';
import {
  BUSINESS_ZONE, CLOSE_MINUTE, DIGEST_MINUTE, FIRST_CALL_MINUTE, HOLIDAYS,
  LATE_COVERAGE_END_MINUTE, OPEN_MINUTE, OWNER_TASK_MINUTE, SLA_MINUTES,
  deadlineFor, deferReason, localParts,
} from './businessCalendar';
import { LADDER, readLadderLead, tick, tickLead } from './escalationLadder';
import {
  ATTAINMENT_TARGET, ATTEMPT_KINDS, attainment, evaluateAttempt, recordAttempt,
  recordBreach, stampFirstResponse, type AttemptKind,
} from './attemptService';
import { enqueue, listQueue } from './overnightQueue';

/**
 * The SLA surface: configuration, the ladder, the overnight queue, attempts and
 * attainment. SOP §04, §05, §21, §30.
 */
export const slaConfigRoutes: Router = Router();

/**
 * The lead-scoped SLA verbs, kept in their own router.
 *
 * They hang off /leadflow/leads/:id rather than /leadflow/sla, and mounting one
 * router at both prefixes would have created a second, meaningless address for
 * every route it carries.
 */
export const slaLeadRoutes: Router = Router();

slaConfigRoutes.use(authenticate);
slaLeadRoutes.use(authenticate);

const hhmm = (minute: number): string =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

/**
 * GET /api/leadflow/sla/config — the calendar, the policy and the clock rules.
 *
 * SERVES THE 4:59PM RULE AS A WORKED EXAMPLE rather than only as prose, because
 * the rule is the one everybody gets wrong and a sentence describing it is not
 * checkable. `examples` is computed by the same function that computes real
 * deadlines, so a config screen showing 17:29 is showing what the engine would
 * actually do.
 */
slaConfigRoutes.get(
  '/config',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const probeRaw = (req.query?.at as string | undefined)?.trim();
    if (probeRaw !== undefined && Number.isNaN(Date.parse(probeRaw))) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'at must be a valid ISO timestamp');
    }
    const probe = probeRaw ? new Date(probeRaw) : new Date();
    const probeDeadline = deadlineFor(probe);

    res.status(200).json({
      success: true,
      data: {
        calendar: {
          /* AC1 — a NAMED IANA ZONE. A fixed offset is right for four months of
             the year and an hour wrong for the rest, which silently moves every
             deadline either side of a DST transition. */
          timezone: BUSINESS_ZONE,
          timezone_kind: 'iana_named_zone',
          fixed_offset: null,
          open: hhmm(OPEN_MINUTE),
          close: hhmm(CLOSE_MINUTE),
          late_coverage_until: hhmm(LATE_COVERAGE_END_MINUTE),
          weekend_days: ['Saturday', 'Sunday'],
          holidays: HOLIDAYS,
          holiday_source: 'RevOps-maintained list. Observed dates are a business decision, not a calculation, so they are listed rather than derived.',
        },
        policy: {
          first_response_minutes: SLA_MINUTES,
          qualifying_predicate: 'Every inbound lead with a contactable point, from the original source timestamp.',
          satisfied_by: 'A valid human attempt only: a tracked call from the approved number or dialer, with context reviewed, a logged disposition and a confirmed NEXT.',
          not_satisfied_by: ['task_click', 'bulk_email'],
        },
        clock: {
          /* AC3 — stated as a rule and enforced by the trigger in migration 024. */
          starts_from: 'original_source_timestamp',
          survives: ['merge', 'reassignment', 'backup_takeover'],
          enforcement: 'A BEFORE UPDATE trigger on leads raises if source_timestamp changes, so no code path can reset the clock.',
          pause_conditions: ['awaiting_customer_reply', 'duplicate_under_review'],
        },
        after_hours: {
          digest_at: hhmm(DIGEST_MINUTE),
          owner_task_at: hhmm(OWNER_TASK_MINUTE),
          first_call_due_at: hhmm(FIRST_CALL_MINUTE),
        },
        ladder: LADDER.map((rung) => ({
          offset_minutes: rung.offset, audience: rung.audience,
          channels: rung.channels, requires: rung.requires,
        })),
        probe: {
          at: probe.toISOString(),
          local: `${localParts(probe).date} ${hhmm(localParts(probe).minuteOfDay)}`,
          defer_reason: deferReason(probe),
          due_at: probeDeadline.dueAt.toISOString(),
          requires_late_coverage: probeDeadline.requiresLateCoverage,
          basis: probeDeadline.basis,
        },
        /* AC2 — the rule nobody gets right, computed rather than described. */
        examples: [
          { label: '16:59 arrival', note: 'Business-hours arrival; the clock runs past close and late coverage must be staffed.', due_local: '17:29', requires_late_coverage: true },
          { label: '17:15 arrival', note: 'After-hours arrival; acknowledged immediately with a next-business-day commitment.', due_local: '09:30 next business day', requires_late_coverage: false },
          { label: 'Saturday 19:00 arrival', note: 'Weekend arrival; owner task at 08:45 Monday, first call due 09:30 Monday.', due_local: '09:30 next business day', requires_late_coverage: false },
        ],
      },
    });
  })
);

/**
 * POST /api/leadflow/sla/tick — advance the escalation ladder.
 *
 * IDEMPOTENT PER RUNG. A duplicated tick fires nothing twice, because a rung is
 * claimed by an INSERT against a UNIQUE (lead_id, rung) constraint rather than
 * by a read-then-write. `suppressed` reports what the constraint refused, so a
 * healthy re-tick is visible as such instead of looking like a ladder that has
 * stopped working.
 */
slaConfigRoutes.post(
  '/tick',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const leadId = typeof body.lead_id === 'string' ? body.lead_id.trim() : '';

    if (leadId !== '') {
      const lead = await readLadderLead(leadId);
      if (!lead) throw new AppError(404, ErrorCodes.NOT_FOUND, 'No lead with that id');
      const result = await tickLead(lead);
      res.status(200).json({
        success: true,
        data: {
          scope: 'lead', lead_id: leadId,
          minutes_elapsed: result.minutesElapsed,
          fired: result.fired, suppressed: result.suppressed,
          breached: result.breached,
          note: 'A rung in `suppressed` was already fired by an earlier tick. That is the idempotence working.',
        },
      });
      return;
    }

    const sweep = await tick();
    res.status(200).json({
      success: true,
      data: {
        scope: 'sweep',
        leads_examined: sweep.results.length,
        rungs_fired: sweep.fired,
        rungs_suppressed: sweep.suppressed,
        /* AC4 of #112 — ONE incident for the sweep, listing every affected lead.
           Forty incidents for forty leads is a pager nobody can act on. */
        incident_ref: sweep.incidentRef,
        affected_leads: sweep.affected,
        results: sweep.results,
      },
    });
  })
);

/**
 * GET /api/leadflow/sla/overnight-queue — what arrived outside business hours.
 */
slaConfigRoutes.get(
  '/overnight-queue',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const includeReleased = req.query?.include_released === 'true';
    const entries = await listQueue(includeReleased);
    res.status(200).json({
      success: true,
      data: {
        entries,
        entry_count: entries.length,
        include_released: includeReleased,
        by_reason: ['after_hours', 'weekend', 'holiday'].map((reason) => ({
          reason, count: entries.filter((e) => e.reason === reason).length,
        })),
        /* AC4 of #113, stated so a reader never has to infer it from a null. */
        promise_rule: 'same_night_promised can only be true when an on-call rep is named. A CHECK constraint refuses the alternative, so a callback nobody can make cannot be recorded as promised.',
      },
    });
  })
);

/**
 * POST /api/leadflow/sla/overnight-queue — enqueue an out-of-hours arrival.
 */
slaConfigRoutes.post(
  '/overnight-queue',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const leadId = typeof body.lead_id === 'string' ? body.lead_id.trim() : '';
    const arrivedRaw = typeof body.arrived_at === 'string' ? body.arrived_at.trim() : '';

    if (leadId === '') throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'lead_id is required');
    const arrivedAt = arrivedRaw ? new Date(arrivedRaw) : new Date();
    if (Number.isNaN(arrivedAt.getTime())) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'arrived_at must be a valid ISO timestamp');
    }

    const entry = await enqueue({
      leadId,
      arrivedAt,
      sameNightRequested: body.same_night_requested === true,
    });

    /* An in-hours arrival has no business in this queue, and saying so beats
       silently creating a row that would produce a next-day commitment for a
       lead that is due in 30 minutes. */
    if (!entry) {
      throw new AppError(
        409,
        ErrorCodes.CONFLICT,
        'This arrival is inside business hours, so it is governed by the 30-minute SLA rather than the overnight path'
      );
    }

    res.status(201).json({
      success: true,
      data: {
        ...entry,
        same_night_available: entry.same_night_promised,
        note: entry.same_night_promised
          ? 'An approved on-call rep is covering, so a same-night contact was committed.'
          : 'No on-call coverage, so no same-night callback was promised. The next-business-day commitment stands.',
      },
    });
  })
);

/**
 * POST /api/leadflow/leads/:id/log-attempt — record a contact attempt.
 *
 * THE REFUSAL IS THE POINT. A task click or a bulk email is recorded, and
 * answered 422 with a typed code naming which requirement was missing — so the
 * rep learns what would have counted rather than being told "invalid". The
 * attempt is stored either way, because "the rep did nothing" and "the rep did
 * something that does not count" are different facts and coaching needs both.
 */
slaLeadRoutes.post(
  '/:id/log-attempt',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const leadId = String(req.params?.id ?? '');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const kind = typeof body.kind === 'string' ? body.kind.trim() : '';

    if (!(ATTEMPT_KINDS as readonly string[]).includes(kind)) {
      throw new AppError(
        400, ErrorCodes.VALIDATION_ERROR, `kind must be one of ${ATTEMPT_KINDS.join(', ')}`
      );
    }

    const evidence = {
      kind: kind as AttemptKind,
      contextReviewed: body.context_reviewed === true,
      trackedCallRef: typeof body.tracked_call_ref === 'string' ? body.tracked_call_ref : null,
      disposition: typeof body.disposition === 'string' ? body.disposition : null,
      nextAction: typeof body.next_action === 'string' ? body.next_action : null,
    };
    const verdict = evaluateAttempt(evidence);
    const occurredAt = typeof body.occurred_at === 'string' ? body.occurred_at : undefined;

    const attemptId = await recordAttempt({
      leadId, repUserId: req.session?.userId ?? null, evidence, verdict, occurredAt,
    });

    if (!verdict.satisfies) {
      /*
       * 422 rather than 400: the request is well formed and was RECORDED. What
       * it cannot do is satisfy the clock, which is a statement about the
       * evidence rather than about the syntax.
       */
      res.status(422).json({
        success: false,
        error: verdict.reason,
        code: verdict.code,
        data: { attempt_id: attemptId, recorded: true, satisfies_sla: false },
      });
      return;
    }

    await stampFirstResponse(leadId, occurredAt ?? new Date().toISOString());

    res.status(201).json({
      success: true,
      data: {
        attempt_id: attemptId, lead_id: leadId,
        satisfies_sla: true, kind,
        note: 'First response stamped. A later attempt will not overwrite it — the first valid attempt is the one the SLA measured.',
      },
    });
  })
);

/**
 * POST /api/leadflow/leads/:id/breach — record a breach with cause and recovery.
 *
 * BOTH ARE MANDATORY, in the handler and in a CHECK constraint. A breach with no
 * cause is a number on a report that teaches nobody anything, and a cause with
 * no recovery records what went wrong without recording what was done for the
 * customer — which is the half SOP §04 actually cares about.
 */
slaLeadRoutes.post(
  '/:id/breach',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const leadId = String(req.params?.id ?? '');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const reasonCode = typeof body.reason_code === 'string' ? body.reason_code.trim() : '';
    const recoveryAction = typeof body.recovery_action === 'string' ? body.recovery_action.trim() : '';

    if (reasonCode === '') {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'reason_code is required to record a breach');
    }
    if (recoveryAction === '') {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'recovery_action is required to record a breach');
    }

    const lead = await readLadderLead(leadId);
    if (!lead) throw new AppError(404, ErrorCodes.NOT_FOUND, 'No lead with that id');

    const result = await recordBreach({
      leadId,
      reasonCode,
      reasonDetail: typeof body.reason_detail === 'string' ? body.reason_detail : null,
      recoveryAction,
      recoveredByUserId: req.session?.userId ?? null,
      systemic: body.systemic === true,
      sourceTimestamp: lead.source_timestamp,
    });

    res.status(result.alreadyRecorded ? 200 : 201).json({
      success: true,
      data: {
        lead_id: leadId,
        breach_id: result.breachId,
        already_recorded: result.alreadyRecorded,
        reason_code: reasonCode,
        recovery_action: recoveryAction,
        systemic: body.systemic === true,
        note: result.alreadyRecorded
          ? 'This lead already carries a breach. A lead does not breach the same 30-minute clock twice.'
          : 'Breach recorded with its mandatory cause and customer recovery action.',
      },
    });
  })
);

/**
 * GET /api/leadflow/sla/attainment — the report, with cause and recovery on
 * every miss.
 *
 * A NULL RATE IS NOT A PASS. An empty window has said nothing about the target
 * rather than met it, so `meets_target` is false — reporting true would be a
 * green light nobody earned.
 */
slaConfigRoutes.get(
  '/attainment',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const raw = req.query?.days;
    let days = 30;
    if (raw !== undefined && raw !== '') {
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 365) {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'days must be an integer between 1 and 365');
      }
      days = parsed;
    }
    const report = await attainment(days);
    res.status(200).json({
      success: true,
      data: { ...report, target_rate: ATTAINMENT_TARGET },
    });
  })
);
