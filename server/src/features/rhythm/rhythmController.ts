import { Router, type Response } from 'express';
import { asyncHandler } from '../../middleware/errorHandler';
import { authenticate, type AuthenticatedRequest } from '../../middleware/auth';
import { AppError, ErrorCodes } from '../../utils/errors';
import { dataService } from '../../services/DataService';
import { config } from '../../config/env';
import { BUSINESS_ZONE } from '../sla/businessCalendar';
import { RHYTHMS, RHYTHM_KEYS, escalateOverdue, templateVersionFor, tick } from './rhythmService';

export const digestRoutes: Router = Router();
digestRoutes.use(authenticate);

/**
 * GET /api/leadflow/digests — generated digests and the state of their outputs.
 *
 * The outputs are returned WITH the digest rather than behind a second call,
 * because the question anybody opening this screen is asking is "what came out
 * of yesterday's sweeps" — and a list of digests alone answers "what did we
 * send", which nobody needs to know.
 */
digestRoutes.get(
  '/',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const rhythmKey = typeof req.query?.rhythm_key === 'string' ? req.query.rhythm_key : null;
    if (rhythmKey !== null && !RHYTHM_KEYS.includes(rhythmKey)) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `rhythm_key must be one of ${RHYTHM_KEYS.join(', ')}`);
    }

    const digests = await dataService.query<Record<string, unknown>>(
      `SELECT d.id AS digest_id, d.rhythm_key, d.business_date, d.scheduled_local, d.template_key,
              d.template_version, d.generated_at, d.delivered_at,
              COALESCE(jsonb_agg(jsonb_build_object(
                'output_id', o.output_id, 'output_key', o.output_key, 'description', o.description,
                'owner_user_id', o.owner_user_id, 'due_at', o.due_at,
                'completed_at', o.completed_at, 'escalated_at', o.escalated_at
              ) ORDER BY o.due_at) FILTER (WHERE o.output_id IS NOT NULL), '[]'::jsonb) AS outputs
         FROM leadflow_operating_rhythm_digest d
         LEFT JOIN leadflow_digest_output o ON o.digest_id = d.id
        WHERE d.tenant_id = $1 AND d.rhythm_key IS NOT NULL
          AND ($2::text IS NULL OR d.rhythm_key = $2)
        GROUP BY d.id
        ORDER BY d.business_date DESC, d.generated_at DESC
        LIMIT 100`,
      [config.projexCloud.tenantId, rhythmKey]
    );

    const openOutputs = await dataService.query<{ open: string; overdue: string; escalated: string }>(
      `SELECT COUNT(*) FILTER (WHERE completed_at IS NULL)::text                       AS open,
              COUNT(*) FILTER (WHERE completed_at IS NULL AND due_at < now())::text    AS overdue,
              COUNT(*) FILTER (WHERE escalated_at IS NOT NULL)::text                   AS escalated
         FROM leadflow_digest_output WHERE tenant_id = $1`,
      [config.projexCloud.tenantId]
    );

    res.status(200).json({
      success: true,
      data: {
        digests, digest_count: digests.length,
        /* AC1 — every rhythm and the outputs it must produce, so a caller can
           see what a review is FOR and not only that it fired. */
        rhythms: RHYTHMS.map((r) => ({
          key: r.key, label: r.label, cadence: r.cadence,
          local_time: `${String(Math.floor(r.minuteOfDay / 60)).padStart(2, '0')}:${String(r.minuteOfDay % 60).padStart(2, '0')}`,
          template_key: r.templateKey, template_version: templateVersionFor(r.templateKey),
          required_outputs: r.outputs,
        })),
        /* AC2 — the calendar is named, never an offset. */
        timezone: BUSINESS_ZONE,
        outputs_open: Number(openOutputs[0]?.open ?? 0),
        outputs_overdue: Number(openOutputs[0]?.overdue ?? 0),
        outputs_escalated: Number(openOutputs[0]?.escalated ?? 0),
        note: 'The difference between a reminder and a rhythm is the output. A digest with no tracked output is a message people learn to skim.',
      },
    });
  })
);

/**
 * POST /api/leadflow/digests/:id/complete-output — close a required output.
 *
 * A NOTE IS MANDATORY. "Done" is not a record of a review outcome: the point of
 * tracking the output is that somebody can read, three weeks later, what the
 * 11:30 sweep actually decided — and a completion with no note leaves the
 * tracking without the thing being tracked.
 */
digestRoutes.post(
  '/:id/complete-output',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const digestId = String(req.params?.id ?? '');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const outputKey = typeof body.output_key === 'string' ? body.output_key.trim() : '';
    const note = typeof body.completion_note === 'string' ? body.completion_note.trim() : '';

    if (outputKey === '') throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'output_key is required');
    if (note === '') {
      throw new AppError(
        400, ErrorCodes.VALIDATION_ERROR,
        'completion_note is required — the point of tracking the output is that somebody can read later what the review actually decided, and "done" is not that'
      );
    }

    const rows = await dataService.query<{
      output_id: string; description: string; due_at: string; escalated_at: string | null;
    }>(
      `UPDATE leadflow_digest_output
          SET completed_at = now(), completed_by = $3, completion_note = $4
        WHERE digest_id = $1 AND output_key = $2 AND completed_at IS NULL
        RETURNING output_id, description, due_at, escalated_at`,
      [digestId, outputKey, req.session?.userId ?? null, note]
    );
    if (rows.length === 0) {
      const exists = await dataService.query<{ completed_at: string | null }>(
        `SELECT completed_at FROM leadflow_digest_output WHERE digest_id = $1 AND output_key = $2`,
        [digestId, outputKey]
      );
      if (exists.length === 0) throw new AppError(404, ErrorCodes.NOT_FOUND, 'No such output on that digest');
      /* Already complete is a 200, not an error. A second click on "done" is a
         person confirming, not a conflict — and returning the first completion
         is more useful than refusing. */
      res.status(200).json({
        success: true,
        data: { digest_id: digestId, output_key: outputKey, already_complete: true, completed_at: exists[0].completed_at },
      });
      return;
    }

    const remaining = await dataService.query<{ v: string }>(
      `SELECT COUNT(*)::text AS v FROM leadflow_digest_output WHERE digest_id = $1 AND completed_at IS NULL`,
      [digestId]
    );

    res.status(200).json({
      success: true,
      data: {
        digest_id: digestId, output_key: outputKey, output_id: rows[0].output_id,
        description: rows[0].description, due_at: rows[0].due_at,
        /* AC3 — whether this one had already escalated, kept visible so a
           manager can see the pattern rather than only the closure. */
        was_escalated: rows[0].escalated_at !== null,
        outputs_remaining: Number(remaining[0]?.v ?? 0),
        digest_complete: Number(remaining[0]?.v ?? 0) === 0,
      },
    });
  })
);

/** POST /api/leadflow/digests/run — generate everything due now. */
digestRoutes.post(
  '/run',
  asyncHandler(async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    const result = await tick(new Date());
    res.status(200).json({
      success: true,
      data: {
        generated: result.generated, generated_count: result.generated.length,
        skipped: result.skipped, escalated: result.escalated,
        timezone: BUSINESS_ZONE,
        note: 'One digest per rhythm per business day, enforced by a unique constraint. Two ticks inside the same window would otherwise produce two huddle packs with different numbers.',
      },
    });
  })
);

/** POST /api/leadflow/digests/escalate — sweep outputs past their due time. */
digestRoutes.post(
  '/escalate',
  asyncHandler(async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    const result = await escalateOverdue();
    res.status(200).json({
      success: true,
      data: {
        escalated: result.escalated, items: result.items,
        note: 'Stamped once per output. A manager who gets the same escalation on every tick stops reading them, which is the failure the escalation exists to prevent.',
      },
    });
  })
);
