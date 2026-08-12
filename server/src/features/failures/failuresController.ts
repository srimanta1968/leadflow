import { Router, type Response } from 'express';
import { asyncHandler } from '../../middleware/errorHandler';
import { authenticate, type AuthenticatedRequest } from '../../middleware/auth';
import { AppError, ErrorCodes } from '../../utils/errors';
import { dataService } from '../../services/DataService';
import { config } from '../../config/env';
import {
  REPLAY_BATCH_CAP, RUNBOOK, RUNBOOK_MODES, claimRetry, entryFor, readDlq,
  record, replay, sendsHalted, setKillSwitch,
} from './runbook';

export const failureRoutes: Router = Router();
failureRoutes.use(authenticate);

/** GET /api/leadflow/failures/dlq — what is stuck, from both queues. */
failureRoutes.get(
  '/dlq',
  asyncHandler(async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { items, sources } = await readDlq();
    const local = await dataService.query<Record<string, unknown>>(
      `SELECT failure_id, failure_mode, source_ref, original_event_id, detected_at,
              retry_count, fallback_taken, owner_role, resolved_at
         FROM leadflow_failure_event
        WHERE tenant_id = $1 AND resolved_at IS NULL
        ORDER BY detected_at DESC LIMIT 200`,
      [config.projexCloud.tenantId]
    );

    const unreachable = Object.entries(sources).filter(([, ok]) => !ok).map(([name]) => name);

    res.status(200).json({
      success: true,
      data: {
        items, item_count: items.length,
        local_failures: local, local_count: local.length,
        sources,
        /* An empty DLQ and a DLQ that could not be read look identical, and only
           one of them is good news — so the unreachable sources are named. */
        unreachable_sources: unreachable,
        complete: unreachable.length === 0,
        /* AC1 — the runbook itself, so an operator reading the queue can see
           which fallback applies and who owns it. */
        runbook: RUNBOOK,
        replay_batch_cap: REPLAY_BATCH_CAP,
      },
    });
  })
);

/**
 * POST /api/leadflow/failures/dlq/replay — bounded, idempotent replay.
 *
 * THE CAP IS THE POINT. A queue filling for six hours holds thousands of items,
 * and replaying them all at once trips the provider's rate limit, refills the
 * queue, and — for a messaging connector — puts thousands of messages into
 * inboxes in a minute. The count NOT replayed is returned, because a silent cap
 * reads as "the queue is clear".
 */
failureRoutes.post(
  '/dlq/replay',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ids = (Array.isArray(body.ids) ? body.ids : []).filter((i): i is string => typeof i === 'string' && i !== '');
    if (ids.length === 0) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'ids must be a non-empty array of delivery ids');

    if (await sendsHalted()) {
      /* AC4 — the kill switch outranks the replay. Replaying a DLQ during a
         duplicate-send incident is the loop the switch was thrown to stop. */
      throw new AppError(
        409, ErrorCodes.CONFLICT,
        'The global send pause is engaged, so nothing may be replayed. Release the kill switch first — replaying a queue during a duplicate-send incident is the loop the switch was thrown to stop.'
      );
    }

    const result = await replay(ids);
    res.status(200).json({
      success: true,
      data: {
        requested: ids.length,
        replayed: result.replayed, replayed_count: result.replayed.length,
        failed: result.failed, failed_count: result.failed.length,
        /* Never silently truncated. */
        skipped: result.skipped, batch_cap: REPLAY_BATCH_CAP,
        idempotency: 'Each replay is keyed on the item id, so replaying a replay is one replay. A DLQ item delivered twice is the duplicate the queue exists to avoid.',
      },
    });
  })
);

/** POST /api/leadflow/failures — record a failure and take its fallback. */
failureRoutes.post(
  '/',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const mode = typeof body.failure_mode === 'string' ? body.failure_mode.trim() : '';
    const originalEventId = typeof body.original_event_id === 'string' ? body.original_event_id.trim() : '';

    if (!RUNBOOK_MODES.includes(mode)) {
      throw new AppError(
        400, ErrorCodes.VALIDATION_ERROR,
        `failure_mode must be one of ${RUNBOOK_MODES.join(', ')} — a failure logged under a name nothing has a fallback for is the same as not logging it`
      );
    }
    if (originalEventId === '') {
      throw new AppError(
        400, ErrorCodes.VALIDATION_ERROR,
        'original_event_id is required — it is the dedupe key, and a connector outage that loses it makes the backfill produce duplicates'
      );
    }

    const result = await record({
      mode, originalEventId,
      sourceRef: typeof body.source_ref === 'string' ? body.source_ref : null,
      payload: body.payload ?? null,
    });

    res.status(result.duplicate ? 200 : 201).json({
      success: true,
      data: {
        failure_id: result.failureId, failure_mode: mode, original_event_id: originalEventId,
        /* AC1 — the fallback and its named owner, returned with the record. An
           alert addressed to everybody is addressed to nobody. */
        fallback: result.entry?.fallback ?? null,
        owner_role: result.entry?.ownerRole ?? null,
        response_window: result.entry?.responseWindow ?? null,
        retries_allowed: result.entry?.retries ?? 0,
        duplicate: result.duplicate,
      },
    });
  })
);

/**
 * POST /api/leadflow/failures/:id/retry — claim the one permitted retry.
 *
 * CLAIMED BY THE UPDATE, not decided by a read. Two concurrent handlers would
 * both read retry_count = 0 and both retry — the customer gets two copies and
 * the incident report says "we retried once".
 */
failureRoutes.post(
  '/:id/retry',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const failureId = String(req.params?.id ?? '');
    const rows = await dataService.query<{ failure_mode: string; retry_count: number; source_ref: string | null }>(
      `SELECT failure_mode, retry_count, source_ref FROM leadflow_failure_event WHERE failure_id = $1`,
      [failureId]
    );
    if (rows.length === 0) throw new AppError(404, ErrorCodes.NOT_FOUND, 'No failure with that id');

    const entry = entryFor(rows[0].failure_mode);
    const claimed = await claimRetry(failureId);

    if (!claimed) {
      /* AC3 — the retry budget is spent, so a HUMAN task is created rather than
         a third attempt. Two automated attempts and then a person is the SOP;
         retrying until it works is how a provider outage becomes a duplicate
         storm the moment it recovers. */
      await dataService.query(
        `UPDATE leadflow_failure_event
            SET fallback_taken = $2, owner_role = $3
          WHERE failure_id = $1 AND fallback_taken IS DISTINCT FROM $2`,
        [failureId, entry?.fallback ?? 'human task created', entry?.ownerRole ?? 'revenue_operations']
      );
      res.status(200).json({
        success: true,
        data: {
          failure_id: failureId, retried: false,
          retries_used: rows[0].retry_count, retries_allowed: entry?.retries ?? 0,
          fallback: entry?.fallback ?? null, owner_role: entry?.ownerRole ?? null,
          human_task_required: true,
          note: 'The retry budget is spent. A call or manual-email task is the next step, not a third attempt.',
        },
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: {
        failure_id: failureId, retried: true,
        retries_used: rows[0].retry_count + 1, retries_allowed: entry?.retries ?? 0,
        note: 'Exactly one retry, claimed by the update rather than decided by a read — two concurrent handlers would both read zero and both send.',
      },
    });
  })
);

/**
 * POST /api/leadflow/failures/kill-switch — halt every automated send.
 *
 * THE LOCAL ROW IS THE AUTHORITY. Every send path checks it, so engaging the
 * switch stops sending on the next tick whether or not sdk-feature-flags is
 * reachable — a kill switch that depends on a remote service is unavailable
 * exactly when the incident that needs it is happening.
 */
failureRoutes.post(
  '/kill-switch',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const engaged = body.engaged === true;
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (engaged && reason === '') {
      throw new AppError(
        400, ErrorCodes.VALIDATION_ERROR,
        'reason is required to engage the kill switch — halting every automated send is an incident, and the record of why is what the post-mortem reads'
      );
    }

    const key = typeof body.switch_key === 'string' && body.switch_key.trim() !== ''
      ? body.switch_key.trim() : 'global_send_pause';

    const result = await setKillSwitch({
      key, engaged, reason: reason === '' ? null : reason, actorId: req.session?.userId ?? null,
    });

    res.status(200).json({
      success: true,
      data: {
        switch_key: key, engaged: result.engaged, engaged_at: result.engagedAt,
        upstream_flag_set: result.upstream,
        /* AC4 — effective on the next tick, because the check is a local read
           on the send path rather than a remote call. */
        effective: 'next tick',
        upstream_note: result.upstream
          ? null
          : 'sdk-feature-flags was not updated, but the local switch is authoritative and every send path reads it.',
      },
    });
  })
);

/** GET /api/leadflow/failures/kill-switch — is sending halted right now. */
failureRoutes.get(
  '/kill-switch',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const key = typeof req.query?.switch_key === 'string' && req.query.switch_key !== ''
      ? String(req.query.switch_key) : 'global_send_pause';
    const halted = await sendsHalted(key);
    res.status(200).json({
      success: true,
      data: {
        switch_key: key, sends_halted: halted,
        fails: 'closed',
        note: 'A switch that cannot be read is treated as ENGAGED. Pausing sends we did not need to pause costs a delay; sending during the incident the switch was thrown for makes the incident worse.',
      },
    });
  })
);
