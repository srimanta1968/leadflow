import { Response } from 'express';
import { RoutingService } from '../services/RoutingService';
import { AssignmentService } from '../services/AssignmentService';
import {
  validateAssignment,
  validateRoutingRule,
  validateRoutingRuleUpdate,
  validateUuidParam,
} from '../validators/routingValidators';
import { PERMISSIONS } from '../config/roles';
import { AUDIT_EVENTS } from '../platform/audit/vocabulary';
import { governed, GovernedRequest } from '../platform/policy/governed';

/**
 * HTTP surface for lead routing.
 *
 * Routing a lead is a command against an existing resource rather than the
 * creation of a new one, so it answers 200 (MUST-54). Creating a rule at the
 * collection root answers 201.
 *
 * EVERY MUTATING HANDLER IS WRAPPED IN `governed`, which asks the PDP before the
 * write and appends the audit entry after it. The wrapper is not decoration: an
 * unwrapped handler here is a write nobody authorised and nobody recorded, and
 * it looks exactly like a wrapped one from the outside.
 */
export class RoutingController {
  /** POST /api/leads/:id/route — assign an owner and start the response clock. */
  static routeLead = governed(
    {
      action: PERMISSIONS.LEAD_REASSIGN,
      event: AUDIT_EVENTS.LEAD_ROUTED,
      purpose: 'lead_management',
      resourceType: 'lead',
      resourceId: (req) => req.params.id,
      obligations: {
        business_unit_scope: {
          kind: 'defer',
          // Honest rather than silent: `leads` has no business-unit column, so
          // there is nothing to compare the manager's scope against. Deferred
          // and stamped into the ledger until the column exists.
          because: 'leads carry no business_unit_id yet, so the scope cannot be compared',
        },
      },
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const leadId = validateUuidParam('id', req.params.id);
      const result = await RoutingService.routeLead(leadId);
      res.status(200).json({ success: true, data: result });
    }
  );

  /**
   * POST /api/leads/:id/assign — assign or reassign to a named owner.
   * A command against an existing lead, so it answers 200.
   */
  static assignLead = governed(
    {
      action: PERMISSIONS.LEAD_REASSIGN,
      event: AUDIT_EVENTS.LEAD_ASSIGNED,
      purpose: 'lead_management',
      resourceType: 'lead',
      resourceId: (req) => req.params.id,
      metadata: (req) => ({
        // The intended owner and the stated reason belong in the ledger: "who
        // moved this lead and why" is the question a reassignment raises.
        requested_owner: (req.body as { owner_user_id?: string })?.owner_user_id ?? null,
        reason: (req.body as { reason?: string })?.reason ?? null,
      }),
      obligations: {
        business_unit_scope: {
          kind: 'defer',
          because: 'leads carry no business_unit_id yet, so the scope cannot be compared',
        },
      },
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const leadId = validateUuidParam('id', req.params.id);
      const input = validateAssignment(req.body as Record<string, unknown>);
      const result = await AssignmentService.assignTo(leadId, input.owner_user_id, input.reason);
      res.status(200).json({ success: true, data: result });
    }
  );

  /**
   * POST /api/leads/route-unowned — the zero-orphan sweep.
   * A bulk command, so it answers 200 rather than 201.
   */
  static routeUnowned = governed(
    {
      action: PERMISSIONS.LEAD_REASSIGN,
      // A distinct event from LEAD_ROUTED. One entry standing for a hundred
      // assignments is not the same fact as one entry per assignment, and an
      // auditor reading `lead.routed` should not have to guess which they have.
      event: AUDIT_EVENTS.LEAD_BULK_ROUTED,
      purpose: 'lead_management',
      resourceType: 'lead_collection',
      metadata: (req) => ({ limit: (req.body as { limit?: number })?.limit ?? 100 }),
      obligations: {
        business_unit_scope: {
          kind: 'defer',
          because: 'leads carry no business_unit_id yet, so the scope cannot be compared',
        },
      },
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const limit = req.body?.limit === undefined ? 100 : Number(req.body.limit);
      const result = await AssignmentService.routeUnowned(limit);
      res.status(200).json({ success: true, data: result });
    }
  );

  /** GET /api/routing-rules — list rules in evaluation order. */
  static async listRules(req: GovernedRequest, res: Response): Promise<void> {
    const activeOnly = req.query.active === 'true';
    const result = await RoutingService.listRules(activeOnly);
    res.status(200).json({ success: true, data: result });
  }

  /** POST /api/routing-rules — create a routing rule. */
  static createRule = governed(
    {
      action: PERMISSIONS.ROUTING_CONFIGURE,
      event: AUDIT_EVENTS.ROUTING_RULE_CREATED,
      purpose: 'service_operation',
      resourceType: 'routing_rule',
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const input = validateRoutingRule(req.body as Record<string, unknown>);
      const rule = await RoutingService.createRule(input);
      res.status(201).json({ success: true, data: { rule } });
    }
  );

  /** PATCH /api/routing-rules/:id — partially update a rule. Answers 200. */
  static updateRule = governed(
    {
      action: PERMISSIONS.ROUTING_CONFIGURE,
      event: AUDIT_EVENTS.ROUTING_RULE_UPDATED,
      purpose: 'service_operation',
      resourceType: 'routing_rule',
      resourceId: (req) => req.params.id,
      // The requested changes, so the ledger says WHAT was altered rather than
      // only that something was.
      metadata: (req) => ({ changes: Object.keys((req.body as object) ?? {}) }),
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const ruleId = validateUuidParam('id', req.params.id);
      const changes = validateRoutingRuleUpdate(req.body as Record<string, unknown>);
      const rule = await RoutingService.updateRule(ruleId, changes);
      res.status(200).json({ success: true, data: { rule } });
    }
  );

  /**
   * DELETE /api/routing-rules/:id — retire a rule.
   *
   * Answers 200 with a summary rather than a bodyless 204, because the caller
   * needs to know whether this call retired the rule or found it already
   * retired, and because the retirement is a soft delete whose resulting state
   * is worth returning.
   */
  static retireRule = governed(
    {
      action: PERMISSIONS.ROUTING_CONFIGURE,
      event: AUDIT_EVENTS.ROUTING_RULE_RETIRED,
      purpose: 'service_operation',
      resourceType: 'routing_rule',
      resourceId: (req) => req.params.id,
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const ruleId = validateUuidParam('id', req.params.id);
      const result = await RoutingService.retireRule(ruleId);
      res.status(200).json({ success: true, data: result });
    }
  );
}
