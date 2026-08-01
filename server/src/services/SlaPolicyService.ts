import { dataService } from './DataService';
import { eventStream } from './EventStream';
import { AppError, ErrorCodes } from '../utils/errors';
import { LeadSourceChannel, SlaPolicy } from '../types';

/**
 * Response window applied when NO policy matches a lead.
 *
 * Declared here rather than imported from `RoutingService` because this service
 * is now the authority on how long a lead has; `RoutingService` asks it. The
 * value matches the flat window the product shipped with, so a tenant that has
 * configured nothing sees no behaviour change.
 */
export const DEFAULT_FIRST_RESPONSE_MINUTES = 30;

interface SlaPolicyRow {
  id: string;
  name: string;
  source_channel: string | null;
  first_response_minutes: number;
  business_hours_only: boolean;
  evaluation_order: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

/** A Postgres unique-violation, raised by the active (channel, order) index. */
const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === UNIQUE_VIOLATION
  );
}

/**
 * Owns the per-lead-type SLA targets.
 *
 * Before this service every lead got a flat thirty minutes regardless of how it
 * arrived, which is wrong in both directions: a live-chat prospect is waiting in
 * the window right now, while a CSV-imported row is not waiting at all. A policy
 * makes that difference configurable by an operator instead of a deploy.
 *
 * Matching deliberately mirrors `RoutingService`'s rule matching — first match
 * wins in ascending `evaluation_order`, and a policy with no `source_channel` is
 * the catch-all — so an operator learns ONE precedence model for the whole
 * product rather than two that look similar and differ in detail.
 *
 * Retirement is a SOFT delete. A lead's `sla_due_at` was written from the policy
 * in force at the moment it was assigned, so "why did this lead only get five
 * minutes?" has to stay answerable after the policy is retired.
 */
export class SlaPolicyService {
  /** Map a row to the API shape. */
  private static toPolicy(row: SlaPolicyRow): SlaPolicy {
    return {
      id: row.id,
      name: row.name,
      source_channel: row.source_channel as LeadSourceChannel | null,
      first_response_minutes: row.first_response_minutes,
      business_hours_only: row.business_hours_only,
      evaluation_order: row.evaluation_order,
      is_active: row.is_active,
      created_at: row.created_at.toISOString(),
    };
  }

  /**
   * Resolve the response window for a lead of the given channel.
   *
   * First match wins in evaluation order, with a channel-less policy acting as
   * the catch-all. Returns the flat default when nothing matches, so a tenant
   * that has configured no policies still gets a running clock rather than a
   * lead with no deadline.
   *
   * @param sourceChannel The lead's capture channel, or null when unknown.
   * @returns The window in minutes and the policy that decided it (null for the
   *          default), so the caller can record WHY a deadline is what it is.
   */
  static async resolveTarget(
    sourceChannel: string | null
  ): Promise<{ minutes: number; policy: SlaPolicy | null }> {
    // Ordered in SQL and matched in SQL: the channel-specific policy is
    // preferred over the catch-all at the SAME evaluation_order, because a
    // policy naming a channel is the more specific statement of intent and an
    // operator would be surprised to see the catch-all win a tie.
    const row = await dataService.queryOne<SlaPolicyRow>(
      `SELECT * FROM sla_policies
        WHERE is_active = TRUE
          AND (source_channel IS NULL OR source_channel = $1)
        ORDER BY evaluation_order ASC,
                 (source_channel IS NULL) ASC,
                 created_at ASC
        LIMIT 1`,
      [sourceChannel]
    );

    if (!row) {
      return { minutes: DEFAULT_FIRST_RESPONSE_MINUTES, policy: null };
    }
    return {
      minutes: row.first_response_minutes,
      policy: SlaPolicyService.toPolicy(row),
    };
  }

  /**
   * List policies in the order the matcher walks them.
   *
   * Listing in evaluation order is what makes a shadowing mistake visible: a
   * catch-all sitting at a low order silently overrides every policy after it,
   * and that is only obvious when the list is in matching order.
   *
   * @param activeOnly When true, omit retired policies.
   */
  static async listPolicies(
    activeOnly = false
  ): Promise<{ policies: SlaPolicy[]; total: number; effective_default_minutes: number }> {
    const rows = activeOnly
      ? await dataService.query<SlaPolicyRow>(
          `SELECT * FROM sla_policies WHERE is_active = TRUE
            ORDER BY evaluation_order ASC, created_at ASC`
        )
      : await dataService.query<SlaPolicyRow>(
          'SELECT * FROM sla_policies ORDER BY evaluation_order ASC, created_at ASC'
        );

    return {
      policies: rows.map(SlaPolicyService.toPolicy),
      total: rows.length,
      effective_default_minutes: DEFAULT_FIRST_RESPONSE_MINUTES,
    };
  }

  /**
   * Create an SLA policy.
   *
   * @param input Validated policy fields.
   * @throws AppError(409 CONFLICT) when an active policy already occupies that
   *         (channel, evaluation_order) slot — a tie would make the effective
   *         SLA depend on insertion order.
   */
  static async createPolicy(input: {
    name: string;
    source_channel?: LeadSourceChannel | null;
    first_response_minutes: number;
    business_hours_only?: boolean;
    evaluation_order?: number;
    is_active?: boolean;
  }): Promise<SlaPolicy> {
    try {
      const created = await dataService.queryOne<SlaPolicyRow>(
        `INSERT INTO sla_policies
           (name, source_channel, first_response_minutes, business_hours_only,
            evaluation_order, is_active)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          input.name,
          input.source_channel ?? null,
          input.first_response_minutes,
          input.business_hours_only ?? false,
          input.evaluation_order ?? 100,
          input.is_active ?? true,
        ]
      );
      if (!created) {
        throw new AppError(500, ErrorCodes.INTERNAL_ERROR, 'The SLA policy could not be created');
      }
      eventStream.publish({ type: 'sla_policy.changed', subject_id: created.id });
      return SlaPolicyService.toPolicy(created);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw AppError.conflict(
          ErrorCodes.CONFLICT,
          'An active SLA policy already exists for that lead type at that evaluation order. Choose a different evaluation order.'
        );
      }
      throw error;
    }
  }

  /**
   * Update a policy in place.
   *
   * A partial update: only the keys present in `changes` are written, so an
   * operator correcting a name cannot accidentally reset the target. Passing
   * `source_channel: null` explicitly turns the policy into the catch-all —
   * that is a meaningful value, which is why absence and null differ here.
   *
   * Tightening a target does NOT re-judge leads already in flight: `sla_due_at`
   * was written at assignment from the policy in force then, and moving the
   * goalposts under somebody working a queue would manufacture breaches nobody
   * could have prevented.
   *
   * @throws AppError(404 NOT_FOUND) when no policy has that id.
   * @throws AppError(400 VALIDATION_ERROR) when `changes` is empty.
   * @throws AppError(409 CONFLICT) when the change would tie two active policies.
   */
  static async updatePolicy(
    policyId: string,
    changes: {
      name?: string;
      source_channel?: LeadSourceChannel | null;
      first_response_minutes?: number;
      business_hours_only?: boolean;
      evaluation_order?: number;
      is_active?: boolean;
    }
  ): Promise<SlaPolicy> {
    const existing = await dataService.queryOne<SlaPolicyRow>(
      'SELECT * FROM sla_policies WHERE id = $1',
      [policyId]
    );
    if (!existing) {
      throw AppError.notFound('SLA policy not found');
    }

    // Built from present keys only. COALESCE cannot express "set this column to
    // NULL on purpose", which is exactly what turning a policy into the
    // catch-all requires.
    const sets: string[] = [];
    const params: unknown[] = [policyId];
    const put = (column: string, value: unknown): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };

    if (changes.name !== undefined) put('name', changes.name);
    if (changes.source_channel !== undefined) put('source_channel', changes.source_channel);
    if (changes.first_response_minutes !== undefined) {
      put('first_response_minutes', changes.first_response_minutes);
    }
    if (changes.business_hours_only !== undefined) {
      put('business_hours_only', changes.business_hours_only);
    }
    if (changes.evaluation_order !== undefined) put('evaluation_order', changes.evaluation_order);
    if (changes.is_active !== undefined) put('is_active', changes.is_active);

    if (sets.length === 0) {
      throw AppError.badRequest('Provide at least one field to update');
    }
    sets.push('updated_at = CURRENT_TIMESTAMP');

    try {
      const updated = await dataService.queryOne<SlaPolicyRow>(
        `UPDATE sla_policies SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
        params
      );
      if (!updated) {
        throw new AppError(500, ErrorCodes.INTERNAL_ERROR, 'The SLA policy could not be updated');
      }
      eventStream.publish({ type: 'sla_policy.changed', subject_id: policyId });
      return SlaPolicyService.toPolicy(updated);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw AppError.conflict(
          ErrorCodes.CONFLICT,
          'That change would leave two active SLA policies on the same lead type at the same evaluation order. Choose a different evaluation order.'
        );
      }
      throw error;
    }
  }

  /**
   * Retire a policy by deactivating it.
   *
   * A SOFT delete, for the same reason routing-rule retirement is: a lead's
   * deadline was computed from the policy in force when it was assigned, so
   * destroying the row would erase the explanation for a past deadline.
   *
   * Idempotent: retiring an already-retired policy reports `already_inactive`
   * rather than failing.
   *
   * @throws AppError(404 NOT_FOUND) when no policy has that id.
   */
  static async retirePolicy(
    policyId: string
  ): Promise<{ policy: SlaPolicy; already_inactive: boolean }> {
    const existing = await dataService.queryOne<SlaPolicyRow>(
      'SELECT * FROM sla_policies WHERE id = $1',
      [policyId]
    );
    if (!existing) {
      throw AppError.notFound('SLA policy not found');
    }
    if (!existing.is_active) {
      return { policy: SlaPolicyService.toPolicy(existing), already_inactive: true };
    }

    const retired = await dataService.queryOne<SlaPolicyRow>(
      'UPDATE sla_policies SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *',
      [policyId]
    );
    if (!retired) {
      throw new AppError(500, ErrorCodes.INTERNAL_ERROR, 'The SLA policy could not be retired');
    }
    eventStream.publish({ type: 'sla_policy.changed', subject_id: policyId });
    return { policy: SlaPolicyService.toPolicy(retired), already_inactive: false };
  }
}
