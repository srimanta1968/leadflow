import { Router, type Response } from 'express';
import { asyncHandler } from '../../middleware/errorHandler';
import { authenticate, type AuthenticatedRequest } from '../../middleware/auth';
import { AppError, ErrorCodes } from '../../utils/errors';
import { dataService } from '../../services/DataService';
import { config } from '../../config/env';
import {
  ACTIVE_CADENCE, NURTURE_TRACKS, REACTIVATION_TRIGGERS, STOP_RULES, STOP_SIGNALS,
  type NurtureSegment,
} from './cadence';
import { applyStop, tickAll } from './sequenceExecutor';
import { pollInboundSignals } from './inboundSignals';

/** Cadences, the executor, reactive stops and nurture. SOP §08, §33, §47. */
export const sequenceRoutes: Router = Router();
sequenceRoutes.use(authenticate);

/**
 * GET /api/leadflow/sequences — the cadence, as configuration.
 *
 * THIRTEEN STEPS WITH THEIR TIMING, CHANNEL, OBJECTIVE AND REQUIRED NEXT. The
 * executor reads this list and knows nothing about step 7 specifically, so
 * changing the cadence is an edit to a declaration rather than a code change.
 */
sequenceRoutes.get(
  '/',
  asyncHandler(async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    res.status(200).json({
      success: true,
      data: {
        sequences: [{
          key: 'active_14_day',
          label: 'The 14-day active cadence',
          step_count: ACTIVE_CADENCE.length,
          steps: ACTIVE_CADENCE.map((s) => ({
            step: s.step, offset_minutes: s.offsetMinutes, channels: s.channels,
            objective: s.objective,
            /* AC3 of #125 — every step binds to a template KEY rather than
               composing its own copy, so nothing bypasses the approval gate. */
            template_keys: s.templateKeys,
            /* AC2 of #125 — the NEXT the step must leave behind. */
            required_next: s.requiredNext,
          })),
        }],
        stop_rules: STOP_RULES,
        nurture_tracks: NURTURE_TRACKS,
        reactivation_triggers: REACTIVATION_TRIGGERS,
        source: 'config in features/sequences/cadence.ts — the executor reads it and knows nothing about any step specifically',
      },
    });
  })
);

/**
 * POST /api/leadflow/sequences/tick — advance every active enrolment.
 *
 * TWO TICKS IN THE SAME MINUTE PRODUCE EXACTLY ONE SEND PER DUE STEP. A step is
 * CLAIMED by an INSERT against UNIQUE (enrollment_id, step_number); a refused
 * insert means another tick owns it. `suppressed` counts the refusals, so a
 * healthy re-tick is visible rather than looking like a cadence that has stalled.
 */
sequenceRoutes.post(
  '/tick',
  asyncHandler(async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    const result = await tickAll();
    res.status(200).json({
      success: true,
      data: {
        enrollments_examined: result.enrollments,
        /* AC1 of #124 — claimed vs suppressed is the idempotence, made visible. */
        steps_claimed: result.claimed,
        steps_suppressed: result.suppressed,
        steps_dispatched: result.dispatched,
        outcomes: result.outcomes,
        note: 'A claimed step is not necessarily a sent one. dispatched reports what the provider actually accepted, because a claimed step whose send failed must not look like a message the prospect received.',
      },
    });
  })
);

/** POST /api/leadflow/sequences/enroll — put a subject on a cadence. */
sequenceRoutes.post(
  '/enroll',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const subjectRef = typeof body.subject_ref === 'string' ? body.subject_ref.trim() : '';
    const sequenceKey = typeof body.sequence_key === 'string' ? body.sequence_key.trim() : 'active_14_day';
    if (subjectRef === '') throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'subject_ref is required');

    const rows = await dataService.query<{ enrollment_id: string }>(
      `INSERT INTO leadflow_sequence_enrollment (tenant_id, subject_ref, sequence_key, owner_user_id)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id, subject_ref, sequence_key) DO NOTHING
       RETURNING enrollment_id`,
      [config.projexCloud.tenantId, subjectRef, sequenceKey, req.session?.userId ?? null]
    );

    /* A second enrolment on the same cadence is a double send, so it is refused
       rather than silently ignored — the caller believes it enrolled. */
    if (rows.length === 0) {
      throw new AppError(409, ErrorCodes.CONFLICT, 'This subject is already enrolled on that sequence');
    }
    res.status(201).json({ success: true, data: { enrollment_id: rows[0].enrollment_id, subject_ref: subjectRef, sequence_key: sequenceKey } });
  })
);

/**
 * POST /api/leadflow/sequences/enrollments/:id/stop — a reactive signal.
 *
 * STOP, REPLACE OR PAUSE, decided by the signal rather than by the caller. A
 * booked meeting REPLACES the booking CTA rather than ending the relationship,
 * so logistics reminders for that meeting continue; a payment STOPS everything,
 * because presale messaging to a customer is the failure customers screenshot.
 */
sequenceRoutes.post(
  '/enrollments/:id/stop',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const enrollmentId = String(req.params?.id ?? '');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const signal = typeof body.signal === 'string' ? body.signal.trim() : '';

    if (!STOP_SIGNALS.includes(signal)) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `signal must be one of ${STOP_SIGNALS.join(', ')}`);
    }

    const result = await applyStop({
      enrollmentId, signal,
      detail: typeof body.detail === 'string' ? body.detail : null,
      actorUserId: req.session?.userId ?? null,
    });
    if (!result.found) throw new AppError(404, ErrorCodes.NOT_FOUND, 'No enrolment with that id');

    res.status(200).json({
      success: true,
      data: {
        enrollment_id: enrollmentId, signal,
        /* AC1/2/3 of #126 — the action differs by signal, and is named. */
        action: result.action,
        /* AC4 — the reason is recorded on the enrolment, not only in a log. */
        stop_reason: result.reason,
        cancelled_steps: result.cancelledSteps,
        owner_task_created: result.taskCreated,
        note: result.action === 'replace'
          ? 'The booking CTA is replaced. Logistics reminders for the accepted meeting continue.'
          : 'Queued steps are claimed as cancelled, so a tick already in flight cannot send one.',
      },
    });
  })
);

/** GET /api/leadflow/sequences/:key/performance — per-step rates. */
sequenceRoutes.get(
  '/:key/performance',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const key = String(req.params?.key ?? '');
    const rows = await dataService.query<{ step_number: number; executed: string; dispatched: string; skipped: string }>(
      `SELECT e.step_number,
              COUNT(*)::text AS executed,
              COUNT(*) FILTER (WHERE e.dispatched)::text AS dispatched,
              COUNT(*) FILTER (WHERE e.skipped_reason IS NOT NULL)::text AS skipped
         FROM leadflow_sequence_execution e
         JOIN leadflow_sequence_enrollment n ON n.enrollment_id = e.enrollment_id
        WHERE n.tenant_id = $1 AND n.sequence_key = $2
        GROUP BY e.step_number ORDER BY e.step_number`,
      [config.projexCloud.tenantId, key]
    );
    const stops = await dataService.query<{ stop_reason: string; n: string }>(
      `SELECT COALESCE(split_part(stop_reason, ':', 1), 'none') AS stop_reason, COUNT(*)::text AS n
         FROM leadflow_sequence_enrollment
        WHERE tenant_id = $1 AND sequence_key = $2 AND status = 'stopped'
        GROUP BY 1 ORDER BY 2 DESC`,
      [config.projexCloud.tenantId, key]
    );
    res.status(200).json({
      success: true,
      data: {
        sequence_key: key,
        steps: rows.map((r) => ({
          step: r.step_number, executed: Number(r.executed),
          dispatched: Number(r.dispatched), skipped: Number(r.skipped),
          /* Null rather than 0 when nothing executed: an unrun step has no rate,
             and 0% reads as a step that always fails. */
          dispatch_rate: Number(r.executed) === 0 ? null : Number(r.dispatched) / Number(r.executed),
        })),
        stop_reasons: stops.map((s) => ({ reason: s.stop_reason, count: Number(s.n) })),
      },
    });
  })
);

/** GET /api/leadflow/sequences/guards/log — why steps were deferred or refused. */
sequenceRoutes.get(
  '/guards/log',
  asyncHandler(async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    const rows = await dataService.query<{ guard: string; outcome: string; detail: string; created_at: string; enrollment_id: string | null; step_number: number | null }>(
      `SELECT guard, outcome, detail, created_at, enrollment_id, step_number
         FROM leadflow_sequence_guard_log WHERE tenant_id = $1
        ORDER BY created_at DESC LIMIT 200`,
      [config.projexCloud.tenantId]
    );
    const circuits = await dataService.query<{ circuit_key: string; consecutive_failures: number; opened_at: string | null; retry_after: string | null; last_error: string | null }>(
      `SELECT circuit_key, consecutive_failures, opened_at, retry_after, last_error
         FROM leadflow_sequence_circuit ORDER BY updated_at DESC`
    );
    res.status(200).json({
      success: true,
      data: {
        entries: rows, entry_count: rows.length,
        /* AC4 of #124 — the breaker is visible rather than only effective. An
           invisible breaker looks exactly like a cadence that stopped working. */
        circuits: circuits.map((c) => ({ ...c, open: Boolean(c.opened_at && (!c.retry_after || Date.parse(c.retry_after) > Date.now())) })),
      },
    });
  })
);

/* ------------------------------------------------------------------ nurture */

/** GET /api/leadflow/sequences/nurture — the tracks and who is on them. */
sequenceRoutes.get(
  '/nurture',
  asyncHandler(async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    const rows = await dataService.query<{
      subject_ref: string; reason_segment: string; owner_user_id: string; entered_at: string;
      future_change: string | null; next_action: string | null; next_due_at: string | null;
    }>(
      `SELECT m.subject_ref, m.reason_segment, m.owner_user_id, m.entered_at, m.future_change,
              n.action_type AS next_action, n.due_at AS next_due_at
         FROM leadflow_nurture_membership m
         LEFT JOIN leadflow_next_action n
                ON n.subject_ref = m.subject_ref AND n.completed_at IS NULL
        WHERE m.tenant_id = $1 AND m.exited_at IS NULL
        ORDER BY m.entered_at DESC LIMIT 500`,
      [config.projexCloud.tenantId]
    );

    /* AC2 of #127 — one owner AND one dated next action, at all times. Records
       missing either are reported as a violation rather than quietly listed,
       because a nurture record with no next action never comes back. */
    const violations = rows.filter((r) => !r.owner_user_id || !r.next_due_at);

    res.status(200).json({
      success: true,
      data: {
        tracks: NURTURE_TRACKS,
        members: rows, member_count: rows.length,
        by_segment: NURTURE_TRACKS.map((t) => ({ segment: t.segment, count: rows.filter((r) => r.reason_segment === t.segment).length })),
        violations, violation_count: violations.length,
        invariant: 'Every nurture record must retain one owner and one dated next action. Records listed under violations have lost one of them.',
        reactivation_triggers: REACTIVATION_TRIGGERS,
      },
    });
  })
);

/** POST /api/leadflow/sequences/nurture — enter a record, by REASON. */
sequenceRoutes.post(
  '/nurture',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const subjectRef = typeof body.subject_ref === 'string' ? body.subject_ref.trim() : '';
    const segment = typeof body.reason_segment === 'string' ? body.reason_segment.trim() : '';
    const futureChange = typeof body.future_change === 'string' ? body.future_change.trim() : '';
    const ownerUserId = typeof body.owner_user_id === 'string' ? body.owner_user_id.trim() : (req.session?.userId ?? '');

    if (subjectRef === '') throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'subject_ref is required');
    if (!NURTURE_TRACKS.some((t) => t.segment === segment)) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `reason_segment must be one of ${NURTURE_TRACKS.map((t) => t.segment).join(', ')}`);
    }
    /* AC2 — one owner, required rather than defaulted to nobody. */
    if (ownerUserId === '') throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'owner_user_id is required — a nurture record with no owner never comes back');
    /* AC4 — a no-fit record is not nurtured without a specific future change. */
    if (segment === 'no_fit_today' && futureChange === '') {
      throw new AppError(
        400, ErrorCodes.VALIDATION_ERROR,
        'future_change is required for no_fit_today — SOP §47 does not permit nurturing a record that does not fit unless a specific future change could create fit'
      );
    }

    const rows = await dataService.query<{ membership_id: string }>(
      `INSERT INTO leadflow_nurture_membership (tenant_id, subject_ref, reason_segment, future_change, owner_user_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (tenant_id, subject_ref) DO UPDATE SET
         reason_segment = EXCLUDED.reason_segment, future_change = EXCLUDED.future_change,
         owner_user_id = EXCLUDED.owner_user_id, exited_at = NULL
       RETURNING membership_id`,
      [config.projexCloud.tenantId, subjectRef, segment, futureChange || null, ownerUserId]
    );

    const track = NURTURE_TRACKS.find((t) => t.segment === segment)!;
    const firstTouch = track.touchDays[0] ?? null;
    if (firstTouch !== null) {
      await dataService.query(
        `INSERT INTO leadflow_next_action (tenant_id, subject_ref, action_type, owner_user_id, due_at, purpose, intended_outcome)
         VALUES ($1,$2,'task',$3, now() + ($4 || ' days')::interval, $5, $6)
         ON CONFLICT DO NOTHING`,
        [config.projexCloud.tenantId, subjectRef, ownerUserId, String(firstTouch), `Nurture touch: ${track.label}`, track.approach]
      );
    }

    res.status(201).json({
      success: true,
      data: {
        membership_id: rows[0].membership_id, subject_ref: subjectRef,
        reason_segment: segment, owner_user_id: ownerUserId,
        track, first_touch_days: firstTouch,
        note: 'Nurture is segmented by REASON rather than by list. One stream serving six reasons sends the same thing to everybody and changes only the subject line.',
      },
    });
  })
);

/** POST /api/leadflow/sequences/nurture/:ref/reactivate — bring one back. */
sequenceRoutes.post(
  '/nurture/:ref/reactivate',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const subjectRef = String(req.params?.ref ?? '');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const trigger = typeof body.trigger === 'string' ? body.trigger.trim() : '';

    if (!(REACTIVATION_TRIGGERS as readonly string[]).includes(trigger)) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `trigger must be one of ${REACTIVATION_TRIGGERS.join(', ')}`);
    }

    const rows = await dataService.query<{ owner_user_id: string }>(
      `UPDATE leadflow_nurture_membership
          SET exited_at = now(), exit_reason = $2
        WHERE tenant_id = $1 AND subject_ref = $3 AND exited_at IS NULL
        RETURNING owner_user_id`,
      [config.projexCloud.tenantId, `reactivated: ${trigger}`, subjectRef]
    );
    if (rows.length === 0) throw new AppError(404, ErrorCodes.NOT_FOUND, 'No open nurture membership for that record');

    /* AC3 — a SAME-DAY owner task, not a queued one. A reactivation trigger is
       the prospect doing something now; answering tomorrow wastes it. */
    await dataService.query(
      `UPDATE leadflow_next_action SET completed_at = now() WHERE subject_ref = $1 AND completed_at IS NULL`,
      [subjectRef]
    );
    await dataService.query(
      `INSERT INTO leadflow_next_action (tenant_id, subject_ref, action_type, owner_user_id, due_at, purpose, intended_outcome)
       VALUES ($1,$2,'call',$3, date_trunc('day', now()) + interval '1 day' - interval '1 second', $4, $5)`,
      [
        config.projexCloud.tenantId, subjectRef, rows[0].owner_user_id,
        `Reactivation: ${trigger}`, 'Reach them the same day the signal arrived',
      ]
    );

    let rescored = false;
    try {
      const { SdkGatewayClient } = await import('../../platform/sdkGateway');
      if (SdkGatewayClient.isConfigured()) {
        const r = await SdkGatewayClient.call({
          sdk: 'sdk-lead-scoring', path: '/api/lead-scoring/score', method: 'POST',
          idempotencyKey: `reactivate-score:${subjectRef}:${trigger}`,
          body: { tenant_id: config.projexCloud.tenantId, subject_ref: subjectRef, reason: trigger },
        });
        rescored = r.delivered;
      }
    } catch { rescored = false; }

    res.status(200).json({
      success: true,
      data: {
        subject_ref: subjectRef, trigger,
        owner_user_id: rows[0].owner_user_id,
        same_day_task_created: true, rescored,
        note: 'A reactivation trigger is the prospect acting now. The task is due today, not queued.',
      },
    });
  })
);

void (null as unknown as NurtureSegment);

/**
 * POST /api/leadflow/sequences/inbound/poll - pull replies, bounces and SMS
 * keywords, and stop what they should stop.
 *
 * A PULL BECAUSE UPSTREAM EMITS NOTHING. sdk-deliverability exposes reply and
 * bounce events as READ endpoints and publishes no domain events at all, so
 * there is nothing to subscribe to. This is the piece that makes every stop rule
 * reachable: without it a prospect could reply, hard-bounce or text STOP and the
 * cadence would keep sending, because the only caller of applyStop was a human
 * recording it after the fact.
 */
sequenceRoutes.post(
  '/inbound/poll',
  asyncHandler(async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    const result = await pollInboundSignals();
    res.status(200).json({
      success: true,
      data: {
        polled: result.polled,
        signals_seen: result.outcomes.length,
        cadences_stopped: result.stopped,
        outcomes: result.outcomes,
        upstream_available: result.upstream,
        note: 'Watermarked per source, so a re-poll does not re-handle events it has already consumed. A soft bounce is deliberately NOT a stop - a full mailbox that clears next week should not end the relationship.',
      },
    });
  })
);
