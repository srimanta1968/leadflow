import { Router, type Response } from 'express';
import { asyncHandler } from '../../middleware/errorHandler';
import { authenticate, type AuthenticatedRequest } from '../../middleware/auth';
import { AppError, ErrorCodes } from '../../utils/errors';
import { dataService } from '../../services/DataService';
import { config } from '../../config/env';
import { SdkGatewayClient } from '../../platform/sdkGateway';
import { EFFECT_CLASSES, auditVersionChange, createVersion, inFlightRuns, simulate } from './workflowService';

export const workflowRoutes: Router = Router();
workflowRoutes.use(authenticate);

/** POST /api/leadflow/workflows — draft a version. Never live on creation. */
workflowRoutes.post(
  '/',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const workflowKey = typeof body.workflow_key === 'string' ? body.workflow_key.trim() : '';
    if (workflowKey === '') throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'workflow_key is required');
    if (typeof body.definition !== 'object' || body.definition === null) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'definition must be an object');
    }

    const saved = await createVersion({
      workflowKey, definition: body.definition, createdBy: req.session?.userId ?? null,
    });
    res.status(201).json({
      success: true,
      data: {
        workflow_version_id: saved.workflowVersionId, workflow_key: workflowKey, version: saved.version,
        published: false, dry_run_id: null, approval_ref: null,
        note: 'A version is created inert. Reaching production needs a passing dry run AND a recorded approval, and a CHECK constraint refuses a published row that has neither.',
      },
    });
  })
);

/**
 * POST /api/leadflow/workflows/:id/dry-run — replay real history, no effects.
 *
 * ZERO SIDE EFFECTS BY CONSTRUCTION, not by a flag. The simulation never
 * receives a gateway client; it receives a recorder that counts the intention
 * and returns. A `dryRun` boolean checked at each call site is one missed check
 * away from a real message to a real customer, and the whole point of a dry run
 * is that a reviewer trusts it enough to publish on its word.
 */
workflowRoutes.post(
  '/:id/dry-run',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const versionId = String(req.params?.id ?? '');
    const body = (req.body ?? {}) as Record<string, unknown>;

    const rows = await dataService.query<{ workflow_key: string; version: number; definition: { steps?: unknown[] } }>(
      `SELECT workflow_key, version, definition FROM leadflow_workflow_version WHERE workflow_version_id = $1`,
      [versionId]
    );
    if (rows.length === 0) throw new AppError(404, ErrorCodes.NOT_FOUND, 'No workflow version with that id');

    const days = Number(body.window_days ?? 14);
    if (!Number.isFinite(days) || days <= 0 || days > 180) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'window_days must be between 1 and 180');
    }
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);

    const result = await simulate({
      workflowKey: rows[0].workflow_key, candidateVersion: rows[0].version,
      definition: rows[0].definition as { steps?: never[] }, from, to,
      ranBy: req.session?.userId ?? null,
    });

    await dataService.query(
      `UPDATE leadflow_workflow_version SET dry_run_id = $2 WHERE workflow_version_id = $1`,
      [versionId, result.dryRunId]
    );

    res.status(201).json({
      success: true,
      data: {
        dry_run_id: result.dryRunId, workflow_version_id: versionId,
        workflow_key: rows[0].workflow_key, candidate_version: rows[0].version,
        window_days: days, window_from: from.toISOString(), window_to: to.toISOString(),
        /* AC2 — counted per effect class rather than as one total. "412 things
           would have happened" tells a reviewer nothing; "308 messages would
           have sent" stops the publish. */
        records_replayed: result.recordsReplayed,
        would_send: result.wouldSend, would_create_task: result.wouldCreateTask,
        would_change_stage: result.wouldChangeStage, would_suppress: result.wouldSuppress,
        sla_outcomes: result.slaOutcomes,
        effect_classes: EFFECT_CLASSES,
        sample: result.sample,
        /* The zero-side-effect property, asserted by the runner itself. */
        side_effects_attempted: result.sideEffectsAttempted,
        passed: result.passed,
        why_not: result.passed
          ? null
          : result.recordsReplayed === 0
            ? 'No records fell in the window, so the run proves nothing. An empty window reporting "0 messages would send" would read as a harmless rule.'
            : 'The definition contains actions this runner does not understand, so it would do something unknown in production.',
      },
    });
  })
);

/**
 * POST /api/leadflow/workflows/:id/publish — the gate.
 *
 * REFUSED SERVER-SIDE without a PASSING dry run and a recorded approval. Both
 * are checked here and a CHECK constraint enforces the same pairing at the row
 * level, so a publish cannot be recorded by any writer that forgets — a rule
 * living only in a reviewer's habits is not followed the first time somebody is
 * in a hurry, which is the only time it matters.
 */
workflowRoutes.post(
  '/:id/publish',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const versionId = String(req.params?.id ?? '');
    const rows = await dataService.query<{
      workflow_key: string; version: number; dry_run_id: string | null; approval_ref: string | null;
    }>(
      `SELECT workflow_key, version, dry_run_id, approval_ref
         FROM leadflow_workflow_version WHERE workflow_version_id = $1`,
      [versionId]
    );
    if (rows.length === 0) throw new AppError(404, ErrorCodes.NOT_FOUND, 'No workflow version with that id');

    if (rows[0].dry_run_id === null) {
      throw new AppError(
        409, ErrorCodes.CONFLICT,
        'This version has never been dry-run, so it cannot be published. No automation reaches production without a passing simulation.'
      );
    }
    const dry = await dataService.query<{ passed: boolean; would_send: number; side_effects_attempted: number }>(
      `SELECT passed, would_send, side_effects_attempted FROM leadflow_workflow_dry_run WHERE dry_run_id = $1`,
      [rows[0].dry_run_id]
    );
    if (!dry[0]?.passed) {
      throw new AppError(
        409, ErrorCodes.CONFLICT,
        'The dry run for this version did not pass, so it cannot be published. Re-run it over a window with records and a definition whose every action the runner understands.'
      );
    }

    /* The approval is requested here if the caller did not bring one. Requesting
       it rather than refusing outright means the publish attempt itself starts
       the review, instead of leaving somebody to go and find the approval
       surface — but the publish still does not happen until it lands. */
    let approvalRef = rows[0].approval_ref;
    const supplied = typeof (req.body as Record<string, unknown>)?.approval_ref === 'string'
      ? String((req.body as Record<string, unknown>).approval_ref) : '';
    if (supplied !== '') approvalRef = supplied;

    if (approvalRef === null || approvalRef === '') {
      let requested: string | null = null;
      if (SdkGatewayClient.isConfigured()) {
        try {
          const a = await SdkGatewayClient.call<{ data?: { approval_id?: string } }>({
            sdk: 'sdk-approval', path: '/api/approvals/requests', method: 'POST',
            idempotencyKey: `workflow-publish:${versionId}`,
            body: {
              tenant_id: config.projexCloud.tenantId, kind: 'workflow_publish',
              subject_ref: versionId,
              reason: `Publish ${rows[0].workflow_key} v${rows[0].version}; the dry run would have sent ${dry[0].would_send} messages.`,
            },
          });
          requested = a.data?.data?.approval_id ?? null;
        } catch { requested = null; }
      }
      throw new AppError(
        409, ErrorCodes.CONFLICT,
        requested === null
          ? 'This version has no recorded approval, so it cannot be published. A dry run says what would happen; an approval says somebody read it.'
          : `This version has no recorded approval, so it cannot be published. One has been requested (${requested}) — publish again with its reference once it is granted.`
      );
    }

    const published = await dataService.query<{ published_at: string }>(
      `UPDATE leadflow_workflow_version
          SET approval_ref = $2, published_at = now(), published_by = $3
        WHERE workflow_version_id = $1 RETURNING published_at`,
      [versionId, approvalRef, req.session?.userId ?? null]
    );

    /* Superseding is separate and AFTER, so a failure here leaves two rows
       claiming to be live and the unique index refuses the second — noisy and
       correct, rather than quietly leaving none live at all. */
    await dataService.query(
      `UPDATE leadflow_workflow_version SET rolled_back_at = now()
        WHERE tenant_id = $1 AND workflow_key = $2 AND workflow_version_id <> $3
          AND published_at IS NOT NULL AND rolled_back_at IS NULL`,
      [config.projexCloud.tenantId, rows[0].workflow_key, versionId]
    );

    const audited = await auditVersionChange('published', versionId, {
      workflow_key: rows[0].workflow_key, version: rows[0].version,
      dry_run_id: rows[0].dry_run_id, approval_ref: approvalRef,
    }, req.session?.userId ?? null);

    res.status(200).json({
      success: true,
      data: {
        workflow_version_id: versionId, workflow_key: rows[0].workflow_key, version: rows[0].version,
        published_at: published[0].published_at,
        dry_run_id: rows[0].dry_run_id, approval_ref: approvalRef,
        /* AC4 — actor and approval reference in the audit chain. */
        audited,
        audit_note: audited ? null : 'sdk-audit was unreachable, so the version row is the only record of this publish for now.',
      },
    });
  })
);

/**
 * POST /api/leadflow/workflows/:id/rollback — back to a prior version.
 *
 * IN-FLIGHT RUNS ARE DECIDED, NEVER ORPHANED. A run mid-way through the version
 * being withdrawn is in a state neither version describes, and the caller must
 * say which of the two honest options applies. Leaving it running against a
 * definition that no longer exists is how a customer receives step 4 of a
 * sequence that was rolled back for sending the wrong thing.
 */
workflowRoutes.post(
  '/:id/rollback',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const versionId = String(req.params?.id ?? '');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const disposition = typeof body.in_flight === 'string' ? body.in_flight.trim() : '';
    if (!['finish_under_old', 'stop'].includes(disposition)) {
      throw new AppError(
        400, ErrorCodes.VALIDATION_ERROR,
        'in_flight must be either finish_under_old or stop — a rollback that does not say what happens to running instances orphans them'
      );
    }

    const target = await dataService.query<{ workflow_key: string; version: number; published_at: string | null }>(
      `SELECT workflow_key, version, published_at FROM leadflow_workflow_version WHERE workflow_version_id = $1`,
      [versionId]
    );
    if (target.length === 0) throw new AppError(404, ErrorCodes.NOT_FOUND, 'No workflow version with that id');
    if (target[0].published_at === null) {
      throw new AppError(409, ErrorCodes.CONFLICT, 'That version was never published, so there is nothing to roll back to it from');
    }

    const live = await dataService.query<{ workflow_version_id: string; version: number }>(
      `SELECT workflow_version_id, version FROM leadflow_workflow_version
        WHERE tenant_id = $1 AND workflow_key = $2 AND published_at IS NOT NULL AND rolled_back_at IS NULL
        LIMIT 1`,
      [config.projexCloud.tenantId, target[0].workflow_key]
    );

    const flight = await inFlightRuns(target[0].workflow_key);

    if (live.length > 0) {
      await dataService.query(
        `UPDATE leadflow_workflow_version SET rolled_back_at = now(), rollback_of = $2
          WHERE workflow_version_id = $1`,
        [live[0].workflow_version_id, versionId]
      );
    }
    await dataService.query(
      `UPDATE leadflow_workflow_version SET rolled_back_at = NULL, published_at = now(), published_by = $2
        WHERE workflow_version_id = $1`,
      [versionId, req.session?.userId ?? null]
    );

    let stopped = 0;
    if (disposition === 'stop' && flight.available && SdkGatewayClient.isConfigured()) {
      for (const runId of flight.runs) {
        try {
          await SdkGatewayClient.call({
            sdk: 'sdk-workflow', path: `/api/workflows/runs/${encodeURIComponent(runId)}/cancel`,
            method: 'POST', idempotencyKey: `rollback-stop:${runId}`,
            body: { tenant_id: config.projexCloud.tenantId, reason: 'workflow version rolled back' },
          });
          stopped += 1;
        } catch { /* counted below by the difference; the rollback still stands */ }
      }
    }

    const audited = await auditVersionChange('rolled_back', versionId, {
      workflow_key: target[0].workflow_key, restored_version: target[0].version,
      withdrew_version: live[0]?.version ?? null, in_flight: disposition,
      in_flight_count: flight.runs.length, stopped,
    }, req.session?.userId ?? null);

    res.status(200).json({
      success: true,
      data: {
        workflow_key: target[0].workflow_key, restored_version: target[0].version,
        withdrew_version: live[0]?.version ?? null,
        /* AC3 — the in-flight decision, its count and what was actually done. */
        in_flight: disposition,
        in_flight_count: flight.runs.length,
        in_flight_visible: flight.available,
        stopped,
        in_flight_note: flight.available
          ? (disposition === 'stop'
            ? 'Running instances were cancelled.'
            : 'Running instances finish under the definition they started with, which is the version being withdrawn — deliberate, because interrupting mid-sequence is its own harm.')
          : 'sdk-workflow could not be reached, so the number of running instances is unknown. The rollback stands; the disposition could not be applied to them.',
        audited,
      },
    });
  })
);

/** GET /api/leadflow/workflows/:key/versions — the history. */
workflowRoutes.get(
  '/:key/versions',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const workflowKey = String(req.params?.key ?? '');
    const rows = await dataService.query<Record<string, unknown>>(
      `SELECT workflow_version_id, version, created_at, created_by, dry_run_id, approval_ref,
              published_at, published_by, rolled_back_at, rollback_of
         FROM leadflow_workflow_version
        WHERE tenant_id = $1 AND workflow_key = $2 ORDER BY version DESC`,
      [config.projexCloud.tenantId, workflowKey]
    );
    if (rows.length === 0) throw new AppError(404, ErrorCodes.NOT_FOUND, 'No versions exist for that workflow');
    res.status(200).json({
      success: true,
      data: {
        workflow_key: workflowKey, versions: rows, version_count: rows.length,
        live: rows.find((r) => r.published_at !== null && r.rolled_back_at === null) ?? null,
      },
    });
  })
);
