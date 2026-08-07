import { randomUUID } from 'crypto';
import { dataService } from './DataService';
import { SdkGatewayClient } from '../platform/sdkGateway';
import { DEFAULT_FIRST_RESPONSE_MINUTES, SlaPolicyService } from './SlaPolicyService';
import { AppError, ErrorCodes } from '../utils/errors';
import { eventStream } from './EventStream';
import { LeadSourceChannel, RoutingDecision, RoutingMethod, RoutingRule } from '../types';
import { currentTenantContext, tenantIdFor } from '../platform/tenancy/tenantHierarchy';

/**
 * Minutes a lead owner has to make a valid human first response when NO SLA
 * policy matches the lead.
 *
 * Re-exported from `SlaPolicyService`, which now owns the value, so there is one
 * source of truth: a per-lead-type target set by an operator takes precedence,
 * and this is only the floor for a tenant that has configured nothing.
 */
export const SLA_WINDOW_MINUTES = DEFAULT_FIRST_RESPONSE_MINUTES;

interface RoutingRuleRow {
  id: string;
  name: string | null;
  criteria: string | null;
  source_channel: string | null;
  assigned_user_id: string | null;
  evaluation_order: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

interface LeadOwnershipRow {
  id: string;
  name: string | null;
  email: string | null;
  source: string | null;
  owner_user_id: string | null;
  assigned_at: Date | null;
  sla_due_at: Date | null;
  routing_method: string | null;
  routing_reason: string | null;
  routing_rule_id: string | null;
  first_response_at: Date | null;
  sla_breached: boolean;
}

/** What the ProjexCloud assignment SDK returns when it picks an owner. */
interface SdkAssignmentResult {
  data?: {
    assignee_id?: string;
    reason?: string;
  };
}

/**
 * Assigns an owner to every lead and starts its response clock.
 *
 * ProjexCloud `sdk-assignment` is the authority when the gateway is configured:
 * it evaluates the full six-step routing order against live coverage — skills,
 * territory, capacity, presence, PTO and on-call — which is knowledge LeadFlow
 * does not hold. This service composes that call and records the result.
 *
 * When the gateway is unconfigured it falls back to a deliberately simple local
 * order: the first matching active rule by evaluation order, then round-robin
 * across active users. The fallback exists so no lead is ever left unowned
 * (the zero-orphan guarantee) — it is NOT a reimplementation of the six-step
 * engine, and `routing_method` records which path made the decision so the two
 * are never confused when auditing a queue.
 */
export class RoutingService {
  /** Map a rule row to the API shape. */
  private static toRule(row: RoutingRuleRow): RoutingRule {
    return {
      id: row.id,
      name: row.name,
      criteria: row.criteria,
      source_channel: row.source_channel as LeadSourceChannel | null,
      assigned_user_id: row.assigned_user_id,
      evaluation_order: row.evaluation_order,
      is_active: row.is_active,
      created_at: row.created_at.toISOString(),
    };
  }

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
   * Ask ProjexCloud sdk-assignment for an owner.
   *
   * @returns The chosen assignee and reason, or null when the gateway is not
   *          configured or returned no assignee.
   */
  private static async askSdk(
    lead: LeadOwnershipRow,
    targetMinutes: number,
    correlationId: string
  ): Promise<{ assigneeId: string; reason: string } | null> {
    try {
      const result = await SdkGatewayClient.call<SdkAssignmentResult>({
        sdk: 'sdk-assignment',
        // `/api/assignment/route`, NOT `/api/assignment/assign-by-task`.
        // assign-by-task is GEOGRAPHIC dispatch: it requires location {lat,lng}
        // and scores candidates by proximity with persona_locations and
        // fallback_radius_km — it is for sending a technician to a site. A
        // LeadFlow lead carries no geography at all, and routing here is
        // rule-match then least-loaded round-robin, so that endpoint could never
        // have worked and would have 400d on the missing location forever.
        //
        // STILL BLOCKED, and honestly so: /api/assignment/route requires
        // `candidate_persona_ids`, a non-empty array of ProjexCloud PERSONA ids.
        // LeadFlow's users have no personas yet (migration 007 adds the columns;
        // the backfill needs a provisioned tenant), so this call answers
        // 400 until that lands and the documented local fallback — rule match,
        // then round robin — continues to carry routing. That fallback is not a
        // degradation of this call; it is what routes every lead today.
        path: '/api/assignment/route',
        method: 'POST',
        idempotencyKey: lead.id,
        correlationId,
        body: {
          // Both REQUIRED by sdk-assignment; the call 400s without them.
          tenant_id: tenantIdFor(currentTenantContext(), 'routing'),
          // The subject being routed, as the SDK addresses it. Derived from the
          // lead rather than generated, so a retry routes the SAME subject
          // instead of creating a second one — the idempotency key above only
          // protects against a duplicate REQUEST, not a duplicate subject.
          subject_ref: `lead:${lead.id}`,
          subject_type: 'lead',
          subject_id: lead.id,
          task: 'first_response',
          // The SDK picks an owner who can actually meet THIS lead's deadline, so
          // it must be told the resolved target rather than a flat default — a
          // five-minute live-chat SLA needs different coverage from a day-long
          // csv_import one.
          required_by_minutes: targetMinutes,
          attributes: {
            source_channel: lead.source,
            email: lead.email,
          },
        },
      });

      const assigneeId = result.data?.data?.assignee_id;
      if (!result.delivered || !assigneeId) {
        return null;
      }
      return {
        assigneeId,
        reason: result.data?.data?.reason ?? 'Chosen by the ProjexCloud six-step routing order',
      };
    } catch (error) {
      // Routing must not fail because the gateway is briefly unavailable — an
      // unrouted lead is worse than a locally-routed one. Fall through.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[RoutingService] sdk-assignment unavailable (${correlationId}):`, message);
      return null;
    }
  }

  /**
   * Local fallback: first matching active rule, then round-robin.
   *
   * @returns The chosen owner and how they were chosen, or null when the tenant
   *          has no active user to route to at all.
   */
  private static async decideLocally(
    lead: LeadOwnershipRow
  ): Promise<{ assigneeId: string; reason: string; method: RoutingMethod; ruleId: string | null } | null> {
    // The rule's target must be an ACTIVE user, not merely a named one. A rule
    // is long-lived configuration while a person's availability changes: without
    // the join, a rule written months ago keeps routing leads to somebody who
    // has left, and they sit unactioned until the clock breaches. This also
    // keeps the guarantee consistent with `AssignmentService.assignTo`, which
    // refuses to assign to a deactivated user.
    const rules = await dataService.query<RoutingRuleRow>(
      `SELECT r.* FROM routing_rules r
         JOIN users u ON u.id = r.assigned_user_id
        WHERE r.is_active = TRUE
          AND u.is_active = TRUE
        ORDER BY r.evaluation_order ASC, r.created_at ASC`
    );

    // Step one: the first rule whose channel matches, or whose channel is blank
    // (a catch-all). First match wins, which is what evaluation_order encodes.
    const matched = rules.find(
      (rule) => rule.source_channel === null || rule.source_channel === lead.source
    );
    if (matched && matched.assigned_user_id) {
      return {
        assigneeId: matched.assigned_user_id,
        reason: `Matched routing rule "${matched.name ?? matched.id}" on source ${lead.source ?? 'any'}`,
        method: 'rule_match',
        ruleId: matched.id,
      };
    }

    // Step two: round-robin over active users, choosing whoever currently holds
    // the fewest open leads. This keeps assignment fair without needing the
    // coverage data only sdk-coverage has.
    const candidate = await dataService.queryOne<{ id: string; open_leads: string }>(
      `SELECT u.id, COUNT(l.id)::text AS open_leads
         FROM users u
         LEFT JOIN leads l
           ON l.owner_user_id = u.id AND l.first_response_at IS NULL
        WHERE u.is_active = TRUE
        GROUP BY u.id
        ORDER BY COUNT(l.id) ASC, u.created_at ASC
        LIMIT 1`
    );

    if (!candidate) {
      return null;
    }
    return {
      assigneeId: candidate.id,
      reason: `Round-robin: fewest open leads (${candidate.open_leads}) among active users`,
      method: 'round_robin',
      ruleId: null,
    };
  }

  /**
   * Route a lead to an owner and start its response clock.
   *
   * Idempotent by design: a lead that already has an owner is returned
   * unchanged rather than reassigned, so a retried request cannot silently move
   * a lead out from under whoever is working it.
   *
   * @param leadId The lead to route.
   * @throws AppError(404 NOT_FOUND) when no lead has that id.
   * @throws AppError(409 CONFLICT) when the tenant has no active user to route to.
   */
  static async routeLead(
    leadId: string
  ): Promise<{ decision: RoutingDecision; already_routed: boolean }> {
    const lead = await dataService.queryOne<LeadOwnershipRow>('SELECT * FROM leads WHERE id = $1', [
      leadId,
    ]);
    if (!lead) {
      throw AppError.notFound('Lead not found');
    }

    if (lead.owner_user_id) {
      return { decision: RoutingService.toDecision(lead), already_routed: true };
    }

    const correlationId = randomUUID();

    // The deadline comes from the SLA policy that matches this lead's channel,
    // falling back to the flat default when a tenant has configured none. The
    // target is resolved BEFORE the owner is chosen so the assignment SDK can be
    // told what deadline the owner has to meet.
    const target = await SlaPolicyService.resolveTarget(lead.source);
    const fromSdk = await RoutingService.askSdk(lead, target.minutes, correlationId);

    const chosen = fromSdk
      ? {
          assigneeId: fromSdk.assigneeId,
          reason: fromSdk.reason,
          method: 'sdk_assignment' as RoutingMethod,
          ruleId: null as string | null,
        }
      : await RoutingService.decideLocally(lead);

    if (!chosen) {
      throw AppError.conflict(
        ErrorCodes.CONFLICT,
        'No active user is available to own this lead. Add an active user or a routing rule.'
      );
    }

    const updated = await dataService.queryOne<LeadOwnershipRow>(
      `UPDATE leads
          SET owner_user_id  = $2,
              assigned_at    = CURRENT_TIMESTAMP,
              sla_due_at     = CURRENT_TIMESTAMP + ($3 || ' minutes')::interval,
              routing_method = $4,
              routing_reason = $5,
              routing_rule_id = $6,
              updated_at     = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING *`,
      [
        leadId,
        chosen.assigneeId,
        String(target.minutes),
        chosen.method,
        // Record which policy set the deadline, so "why did this lead only get
        // five minutes?" is answerable from the row itself.
        target.policy
          ? `${chosen.reason} — SLA ${target.minutes}m from policy "${target.policy.name}"`
          : `${chosen.reason} — SLA ${target.minutes}m (default, no policy matched)`,
        chosen.ruleId,
      ]
    );

    if (!updated) {
      throw new AppError(500, ErrorCodes.INTERNAL_ERROR, 'The lead could not be routed');
    }

    // Tell connected operators to re-read. Published AFTER the commit so a
    // client that reacts immediately cannot read a pre-update projection.
    eventStream.publish({ type: 'lead.routed', subject_id: leadId });

    return { decision: RoutingService.toDecision(updated), already_routed: false };
  }

  /**
   * List routing rules in evaluation order.
   * @param activeOnly When true, omit deactivated rules.
   */
  static async listRules(activeOnly = false): Promise<{ rules: RoutingRule[]; total: number }> {
    const rows = activeOnly
      ? await dataService.query<RoutingRuleRow>(
          'SELECT * FROM routing_rules WHERE is_active = TRUE ORDER BY evaluation_order ASC, created_at ASC'
        )
      : await dataService.query<RoutingRuleRow>(
          'SELECT * FROM routing_rules ORDER BY evaluation_order ASC, created_at ASC'
        );

    return { rules: rows.map(RoutingService.toRule), total: rows.length };
  }

  /**
   * Create a routing rule.
   *
   * @param input Validated rule fields.
   * @throws AppError(404 NOT_FOUND) when `assigned_user_id` names no user — a
   *         rule pointing at a non-existent owner would route leads into a hole.
   */
  static async createRule(input: {
    name: string;
    assigned_user_id: string;
    source_channel?: LeadSourceChannel;
    criteria?: string;
    evaluation_order?: number;
    is_active?: boolean;
  }): Promise<RoutingRule> {
    const owner = await dataService.queryOne<{ id: string; is_active: boolean }>(
      'SELECT id, is_active FROM users WHERE id = $1',
      [input.assigned_user_id]
    );
    if (!owner) {
      throw AppError.notFound('The user this rule assigns to does not exist');
    }

    const created = await dataService.queryOne<RoutingRuleRow>(
      `INSERT INTO routing_rules
         (name, criteria, source_channel, assigned_user_id, evaluation_order, is_active)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.name,
        input.criteria ?? null,
        input.source_channel ?? null,
        input.assigned_user_id,
        input.evaluation_order ?? 100,
        input.is_active ?? true,
      ]
    );

    if (!created) {
      throw new AppError(500, ErrorCodes.INTERNAL_ERROR, 'The routing rule could not be created');
    }
    eventStream.publish({ type: 'routing_rule.changed', subject_id: created.id });
    return RoutingService.toRule(created);
  }

  /**
   * Update a routing rule in place.
   *
   * A partial update: only the fields present in `changes` are written, so a
   * caller correcting a typo in the name cannot accidentally clear the channel.
   * Passing `source_channel: null` explicitly turns the rule into a catch-all —
   * that is a meaningful value, which is why absence and null differ here.
   *
   * @throws AppError(404 NOT_FOUND) when the rule, or a new owner, does not exist.
   * @throws AppError(409 CONFLICT) when the new owner is deactivated.
   */
  static async updateRule(
    ruleId: string,
    changes: {
      name?: string;
      source_channel?: LeadSourceChannel | null;
      assigned_user_id?: string;
      criteria?: string | null;
      evaluation_order?: number;
      is_active?: boolean;
    }
  ): Promise<RoutingRule> {
    const existing = await dataService.queryOne<RoutingRuleRow>(
      'SELECT * FROM routing_rules WHERE id = $1',
      [ruleId]
    );
    if (!existing) {
      throw AppError.notFound('Routing rule not found');
    }

    if (changes.assigned_user_id !== undefined) {
      const owner = await dataService.queryOne<{ id: string; is_active: boolean }>(
        'SELECT id, is_active FROM users WHERE id = $1',
        [changes.assigned_user_id]
      );
      if (!owner) {
        throw AppError.notFound('The user this rule assigns to does not exist');
      }
      if (!owner.is_active) {
        throw AppError.conflict(
          ErrorCodes.CONFLICT,
          'That user is deactivated, so a rule cannot route to them'
        );
      }
    }

    // Build the SET list from present keys only. COALESCE would be wrong here:
    // it cannot express "set this column to NULL on purpose".
    const sets: string[] = [];
    const params: unknown[] = [ruleId];
    const put = (column: string, value: unknown): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };

    if (changes.name !== undefined) put('name', changes.name);
    if (changes.source_channel !== undefined) put('source_channel', changes.source_channel);
    if (changes.assigned_user_id !== undefined) put('assigned_user_id', changes.assigned_user_id);
    if (changes.criteria !== undefined) put('criteria', changes.criteria);
    if (changes.evaluation_order !== undefined) put('evaluation_order', changes.evaluation_order);
    if (changes.is_active !== undefined) put('is_active', changes.is_active);

    if (sets.length === 0) {
      throw AppError.badRequest('Provide at least one field to update');
    }
    sets.push('updated_at = CURRENT_TIMESTAMP');

    const updated = await dataService.queryOne<RoutingRuleRow>(
      `UPDATE routing_rules SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      params
    );
    if (!updated) {
      throw new AppError(500, ErrorCodes.INTERNAL_ERROR, 'The routing rule could not be updated');
    }
    eventStream.publish({ type: 'routing_rule.changed', subject_id: ruleId });
    return RoutingService.toRule(updated);
  }

  /**
   * Retire a routing rule by deactivating it.
   *
   * This is a SOFT delete and always will be. A routed lead holds
   * `routing_rule_id` as a foreign key: a hard delete would either violate that
   * constraint or, with a cascade, erase the attribution that makes a past
   * routing decision explainable. "Why did this lead go to Priya?" must remain
   * answerable after the rule is retired.
   *
   * Idempotent: retiring an already-retired rule reports `already_inactive`
   * rather than failing.
   *
   * @throws AppError(404 NOT_FOUND) when no rule has that id.
   */
  static async retireRule(
    ruleId: string
  ): Promise<{ rule: RoutingRule; already_inactive: boolean }> {
    const existing = await dataService.queryOne<RoutingRuleRow>(
      'SELECT * FROM routing_rules WHERE id = $1',
      [ruleId]
    );
    if (!existing) {
      throw AppError.notFound('Routing rule not found');
    }
    if (!existing.is_active) {
      return { rule: RoutingService.toRule(existing), already_inactive: true };
    }

    const retired = await dataService.queryOne<RoutingRuleRow>(
      'UPDATE routing_rules SET is_active = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *',
      [ruleId, false]
    );
    if (!retired) {
      throw new AppError(500, ErrorCodes.INTERNAL_ERROR, 'The routing rule could not be retired');
    }
    eventStream.publish({ type: 'routing_rule.changed', subject_id: ruleId });
    return { rule: RoutingService.toRule(retired), already_inactive: false };
  }
}
