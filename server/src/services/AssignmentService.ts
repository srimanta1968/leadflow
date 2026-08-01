import { dataService } from './DataService';
import { RoutingService } from './RoutingService';
import { SlaPolicyService } from './SlaPolicyService';
import { AppError, ErrorCodes } from '../utils/errors';
import { eventStream } from './EventStream';
import { RoutingDecision, RoutingMethod } from '../types';

interface LeadOwnershipRow {
  id: string;
  /** Capture channel, used to resolve which SLA policy sets the deadline. */
  source: string | null;
  owner_user_id: string | null;
  assigned_at: Date | null;
  sla_due_at: Date | null;
  routing_method: string | null;
  routing_reason: string | null;
  routing_rule_id: string | null;
  sla_breached: boolean;
}

/**
 * Explicit ownership changes, as distinct from automatic routing.
 *
 * `RoutingService` decides who *should* own a lead. This service handles the
 * cases where a human overrides that decision, or where the decision has to be
 * taken again because circumstances changed. The two are separate because they
 * have different audit meanings: an automatic assignment is a policy outcome,
 * while a manual one is a person taking responsibility, and `routing_method`
 * records which happened so a queue can be audited afterwards.
 */
export class AssignmentService {
  /** Map an ownership row to the API shape. */
  private static toDecision(row: LeadOwnershipRow): RoutingDecision {
    return {
      lead_id: row.id,
      owner_user_id: row.owner_user_id,
      assigned_at: row.assigned_at ? row.assigned_at.toISOString() : null,
      sla_due_at: row.sla_due_at ? row.sla_due_at.toISOString() : null,
      routing_method: row.routing_method as RoutingMethod | null,
      routing_reason: row.routing_reason,
      routing_rule_id: row.routing_rule_id,
      sla_breached: row.sla_breached,
    };
  }

  /**
   * Assign a lead to a named owner, overriding any automatic decision.
   *
   * Unlike `routeLead` this is NOT idempotent-by-skip: reassignment is the whole
   * point, so an already-owned lead is moved. The response reports the previous
   * owner so the caller can show what changed rather than silently swapping it.
   *
   * The response clock is deliberately NOT restarted. The prospect has been
   * waiting since the lead arrived, and resetting the deadline on every
   * reassignment would let a lead be passed around indefinitely while always
   * appearing to be within SLA — which is precisely the gaming this product
   * exists to prevent.
   *
   * @param leadId  The lead to reassign.
   * @param ownerId The user who will own it.
   * @param reason  Why, recorded for audit. Required — an unexplained
   *                reassignment is not auditable.
   * @throws AppError(404 NOT_FOUND) when the lead or the user does not exist.
   * @throws AppError(409 CONFLICT) when the target user is deactivated.
   */
  static async assignTo(
    leadId: string,
    ownerId: string,
    reason: string
  ): Promise<{ decision: RoutingDecision; previous_owner_user_id: string | null }> {
    const lead = await dataService.queryOne<LeadOwnershipRow>(
      'SELECT * FROM leads WHERE id = $1',
      [leadId]
    );
    if (!lead) {
      throw AppError.notFound('Lead not found');
    }

    const owner = await dataService.queryOne<{ id: string; is_active: boolean }>(
      'SELECT id, is_active FROM users WHERE id = $1',
      [ownerId]
    );
    if (!owner) {
      throw AppError.notFound('The user you are assigning to does not exist');
    }
    if (!owner.is_active) {
      throw AppError.conflict(
        ErrorCodes.CONFLICT,
        'That user is deactivated and cannot own a lead'
      );
    }

    const previousOwner = lead.owner_user_id;

    // Only consulted when this is the FIRST assignment (the COALESCE below).
    // Resolved from the lead's channel so a manual pickup gets the same
    // per-lead-type deadline automatic routing would have given it.
    const target = await SlaPolicyService.resolveTarget(lead.source);

    // The clock is set only on FIRST assignment. COALESCE keeps the original
    // deadline through every later reassignment.
    const updated = await dataService.queryOne<LeadOwnershipRow>(
      `UPDATE leads
          SET owner_user_id   = $2,
              assigned_at     = COALESCE(assigned_at, CURRENT_TIMESTAMP),
              sla_due_at      = COALESCE(sla_due_at, CURRENT_TIMESTAMP + ($3 || ' minutes')::interval),
              routing_method  = $4,
              routing_reason  = $5,
              routing_rule_id = NULL,
              updated_at      = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING *`,
      [leadId, ownerId, String(target.minutes), 'manual' satisfies RoutingMethod, reason]
    );

    if (!updated) {
      throw new AppError(500, ErrorCodes.INTERNAL_ERROR, 'The lead could not be reassigned');
    }

    eventStream.publish({ type: 'lead.reassigned', subject_id: leadId });

    return {
      decision: AssignmentService.toDecision(updated),
      previous_owner_user_id: previousOwner,
    };
  }

  /**
   * Route every unowned lead, oldest first.
   *
   * The zero-orphan backstop. Automatic routing at intake covers the normal
   * path; this exists for leads that arrived while routing was unavailable — no
   * active user, or the gateway down — so a transient outage does not leave a
   * permanent hole in the queue.
   *
   * Failures are collected rather than thrown: one unroutable lead must not stop
   * the rest of the queue from being cleared.
   *
   * @param limit        Maximum leads to process in one pass.
   */
  static async routeUnowned(
    limit = 100
  ): Promise<{ routed: number; failed: number; failures: { lead_id: string; reason: string }[] }> {
    const safeLimit = Math.min(Math.max(Number.isFinite(limit) ? limit : 100, 1), 500);

    const pending = await dataService.query<{ id: string }>(
      `SELECT id FROM leads
        WHERE owner_user_id IS NULL
        ORDER BY created_at ASC
        LIMIT $1`,
      [safeLimit]
    );

    let routed = 0;
    const failures: { lead_id: string; reason: string }[] = [];

    for (const lead of pending) {
      try {
        const result = await RoutingService.routeLead(lead.id);
        if (!result.already_routed) {
          routed += 1;
        }
      } catch (error) {
        failures.push({
          lead_id: lead.id,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { routed, failed: failures.length, failures };
  }
}
