import { Router, type Response } from 'express';
import { asyncHandler } from '../../middleware/errorHandler';
import { authenticate, type AuthenticatedRequest } from '../../middleware/auth';
import { AppError, ErrorCodes } from '../../utils/errors';
import {
  CAPACITY_FREEZE_MINUTES,
  CAPACITY_LIMIT,
  ACCEPTANCE_MINUTES,
  REQUIRED_FIELDS,
  acceptLead,
  acceptanceOverdue,
  capacityVerdict,
  declineToBackup,
  findOrphans,
  minutesSinceSource,
  openLoad,
  readLead,
  reassignLead,
  recordEvent,
  type LeadOwnershipRow,
  type RequiredField,
} from './ownershipService';

/**
 * Ownership, acceptance and the zero-orphan validator. SOP §02 and §30.
 *
 * EVERY HANDOVER LEAVES THE CLOCK ALONE. accept, decline, reassign and backup
 * takeover all move `assigned_at` and none of them touches `source_timestamp` or
 * `sla_due_at` — the customer has been waiting exactly as long as they were
 * before the lead changed hands. Migration 024 makes that structural: a BEFORE
 * UPDATE trigger raises if the source timestamp moves, so the invariant holds
 * even for a statement written later by somebody who has not read this comment.
 */
export const ownershipRoutes: Router = Router();

ownershipRoutes.use(authenticate);

const leadIdOf = (req: AuthenticatedRequest): string => String(req.params?.id ?? '');
const actorOf = (req: AuthenticatedRequest): string => req.session?.userId ?? '';

/** What every ownership response says about the clock. */
function clockOf(row: LeadOwnershipRow): Record<string, unknown> {
  return {
    /* AC1 — returned on every handover so a caller can SEE it did not move. */
    source_timestamp: row.source_timestamp,
    sla_due_at: row.sla_due_at,
    assigned_at: row.assigned_at,
    minutes_since_source: minutesSinceSource(row),
    clock_reset: false,
    clock_note:
      'The response clock runs from when the lead arrived, not from when the current owner received it. A handover moves assigned_at and nothing else.',
  };
}

/**
 * POST /api/leadflow/leads/:id/accept — the owner takes it.
 *
 * IDEMPOTENT, and the first acceptance wins. A double-clicked button or a retry
 * after a timeout must not rewrite the instant the rep actually picked it up.
 */
ownershipRoutes.post(
  '/:id/accept',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const leadId = leadIdOf(req);
    const actor = actorOf(req);

    const accepted = await acceptLead(leadId, actor);

    /*
     * ONE CODE FOR "no such lead" AND "not yours", deliberately. Telling a
     * caller that a lead exists but belongs to somebody else discloses the
     * existence of a record they have no claim on.
     */
    if (!accepted) {
      throw new AppError(404, ErrorCodes.NOT_FOUND, 'No lead assigned to you with that id');
    }

    await recordEvent({
      leadId,
      kind: 'accepted',
      toUserId: actor,
      sourceTimestamp: accepted.source_timestamp,
      slaDueAt: accepted.sla_due_at,
      actorUserId: actor,
    });

    res.status(200).json({
      success: true,
      data: {
        lead_id: leadId,
        owner_user_id: accepted.owner_user_id,
        accepted_at: accepted.accepted_at,
        ...clockOf(accepted),
        note: 'Accepting confirms you have the lead. It does not extend the deadline.',
      },
    });
  })
);

/**
 * POST /api/leadflow/leads/:id/decline — hand straight to the backup.
 *
 * THE BACKUP BECOMES THE OWNER IN THE SAME STATEMENT. A decline that cleared the
 * owner and then failed before setting the backup would leave an unowned record
 * with a running clock — the exact orphan SOP §30 forbids, manufactured by the
 * code meant to prevent it.
 */
ownershipRoutes.post(
  '/:id/decline',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const leadId = leadIdOf(req);
    const actor = actorOf(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';

    /* SOP §02 requires a reason immediately. Enforced here AND by a CHECK
       constraint on the event table, so no writer can skip it. */
    if (reason === '') {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'reason is required to decline a lead');
    }

    const before = await readLead(leadId);
    if (!before || before.owner_user_id !== actor) {
      throw new AppError(404, ErrorCodes.NOT_FOUND, 'No lead assigned to you with that id');
    }

    /*
     * REFUSED, NOT EXECUTED, when there is nowhere for the lead to go. Dropping
     * it into an unowned state to satisfy the request trades one rep's
     * inconvenience for a customer nobody is answering. 409 because the request
     * is well formed and the RECORD is not in a state that permits it.
     */
    if (!before.backup_user_id) {
      throw new AppError(
        409,
        ErrorCodes.CONFLICT,
        'This lead has no backup, so declining it would leave it unowned'
      );
    }

    const moved = await declineToBackup({ leadId, decliningUserId: actor, reason });
    if (!moved) {
      throw new AppError(404, ErrorCodes.NOT_FOUND, 'No lead assigned to you with that id');
    }

    await recordEvent({
      leadId,
      kind: 'declined',
      fromUserId: actor,
      toUserId: moved.owner_user_id,
      reason,
      sourceTimestamp: moved.source_timestamp,
      slaDueAt: moved.sla_due_at,
      actorUserId: actor,
    });

    res.status(200).json({
      success: true,
      data: {
        lead_id: leadId,
        declined_by: actor,
        decline_reason: reason,
        /* AC2 — routed to the backup in the same statement, not queued for a
           sweep to notice later. */
        new_owner_user_id: moved.owner_user_id,
        routed_to_backup: true,
        ...clockOf(moved),
      },
    });
  })
);

/**
 * POST /api/leadflow/leads/:id/reassign — manager one-click, or backup takeover.
 *
 * DOES NOT REQUIRE THE CALLER TO OWN THE LEAD. A manager reassigning from an
 * alert is the main path, and requiring ownership would make the one-click
 * reassign impossible for the person it exists for. SOP §02 is explicit that an
 * ownership dispute never delays contact.
 */
ownershipRoutes.post(
  '/:id/reassign',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const leadId = leadIdOf(req);
    const actor = actorOf(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const toUserId = typeof body.to_user_id === 'string' ? body.to_user_id.trim() : '';
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    const backupUserId = typeof body.backup_user_id === 'string' ? body.backup_user_id.trim() : null;

    if (toUserId === '') {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'to_user_id is required');
    }
    if (reason === '') {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'reason is required to reassign a lead');
    }

    const before = await readLead(leadId);
    if (!before || before.closed_at) {
      throw new AppError(404, ErrorCodes.NOT_FOUND, 'No open lead with that id could be reassigned');
    }

    /*
     * AC4 — the capacity freeze, evaluated against the TARGET rather than the
     * caller, and measured from the source timestamp so a lead that has been
     * passed around does not keep resetting its own freeze window.
     */
    const load = await openLoad(toUserId);
    const verdict = capacityVerdict({
      priority: before.priority,
      minutesSinceSource: minutesSinceSource(before),
      openLoad: load,
    });

    if (verdict.frozen) {
      // Recorded, not just refused: a freeze nobody can see is a freeze that
      // looks like a bug to the manager it just blocked.
      await recordEvent({
        leadId,
        kind: 'capacity_frozen',
        fromUserId: before.owner_user_id,
        toUserId,
        reason: verdict.reason,
        sourceTimestamp: before.source_timestamp,
        slaDueAt: before.sla_due_at,
        actorUserId: actor,
      });
      throw new AppError(409, ErrorCodes.CONFLICT, verdict.reason ?? 'Capacity freeze');
    }

    const moved = await reassignLead({ leadId, toUserId, backupUserId });
    if (!moved) {
      throw new AppError(404, ErrorCodes.NOT_FOUND, 'No open lead with that id could be reassigned');
    }

    /* A takeover and a manager move are different acts and are named
       differently, so "how often does the backup have to step in" stays
       answerable by querying a kind rather than parsing a reason. */
    const isTakeover = before.backup_user_id === toUserId && acceptanceOverdue(before);

    await recordEvent({
      leadId,
      kind: isTakeover ? 'backup_takeover' : 'reassigned',
      fromUserId: before.owner_user_id,
      toUserId,
      reason,
      sourceTimestamp: moved.source_timestamp,
      slaDueAt: moved.sla_due_at,
      actorUserId: actor,
    });

    res.status(200).json({
      success: true,
      data: {
        lead_id: leadId,
        from_user_id: before.owner_user_id,
        new_owner_user_id: moved.owner_user_id,
        backup_user_id: moved.backup_user_id,
        kind: isTakeover ? 'backup_takeover' : 'reassigned',
        reason,
        /* Shown inline so a manager can see what they are doing to somebody's
           queue before they do it, which is the whole point of one-click. */
        target_open_load: load,
        capacity_limit: CAPACITY_LIMIT,
        capacity_freeze_minutes: CAPACITY_FREEZE_MINUTES,
        acceptance_minutes: ACCEPTANCE_MINUTES,
        ...clockOf(moved),
      },
    });
  })
);

/**
 * GET /api/leadflow/leads/orphans — the zero-orphan validator.
 *
 * REPORTS THE MISSING FIELDS, not a verdict. "This lead is incomplete" is not
 * actionable; "this lead has no NEXT and no due time" is, and somebody being
 * able to fix what it finds is the entire point.
 */
ownershipRoutes.get(
  '/orphans',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const requested = (req.query?.missing as string | undefined)?.trim();

    if (requested && !(REQUIRED_FIELDS as readonly string[]).includes(requested)) {
      throw new AppError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        `missing must be one of ${REQUIRED_FIELDS.join(', ')}`
      );
    }

    const all = await findOrphans();
    const orphans = requested
      ? all.filter((row) => row.missing.includes(requested as RequiredField))
      : all;

    /* Counted per field so the report says WHICH rule is being broken most,
       which is what tells somebody where the process is failing rather than
       just that it is. */
    const byField: Record<string, number> = {};
    for (const field of REQUIRED_FIELDS) {
      byField[field] = all.filter((row) => row.missing.includes(field)).length;
    }

    res.status(200).json({
      success: true,
      data: {
        orphans,
        orphan_count: orphans.length,
        /* AC3 — zero is the target, and a clean result says so plainly. */
        clean: all.length === 0,
        missing_by_field: byField,
        required_fields: REQUIRED_FIELDS,
        missing: requested ?? null,
        scope: 'open records only — a won or lost lead legitimately has no next action',
      },
    });
  })
);
