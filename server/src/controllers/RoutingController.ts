import { Response } from 'express';
import { RoutingService } from '../services/RoutingService';
import { AssignmentService } from '../services/AssignmentService';
import {
  validateAssignment,
  validateRoutingRule,
  validateRoutingRuleUpdate,
  validateUuidParam,
} from '../validators/routingValidators';
import { AuthenticatedRequest } from '../middleware/auth';

/**
 * HTTP surface for lead routing.
 *
 * Routing a lead is a command against an existing resource rather than the
 * creation of a new one, so it answers 200 (MUST-54). Creating a rule at the
 * collection root answers 201.
 */
export class RoutingController {
  /** POST /api/leads/:id/route — assign an owner and start the response clock. */
  static async routeLead(req: AuthenticatedRequest, res: Response): Promise<void> {
    const leadId = validateUuidParam('id', req.params.id);
    const result = await RoutingService.routeLead(leadId);
    res.status(200).json({ success: true, data: result });
  }

  /**
   * POST /api/leads/:id/assign — assign or reassign to a named owner.
   * A command against an existing lead, so it answers 200.
   */
  static async assignLead(req: AuthenticatedRequest, res: Response): Promise<void> {
    const leadId = validateUuidParam('id', req.params.id);
    const input = validateAssignment(req.body as Record<string, unknown>);
    const result = await AssignmentService.assignTo(leadId, input.owner_user_id, input.reason);
    res.status(200).json({ success: true, data: result });
  }

  /**
   * POST /api/leads/route-unowned — the zero-orphan sweep.
   * A bulk command, so it answers 200 rather than 201.
   */
  static async routeUnowned(req: AuthenticatedRequest, res: Response): Promise<void> {
    const limit = req.body?.limit === undefined ? 100 : Number(req.body.limit);
    const result = await AssignmentService.routeUnowned(limit);
    res.status(200).json({ success: true, data: result });
  }

  /** GET /api/routing-rules — list rules in evaluation order. */
  static async listRules(req: AuthenticatedRequest, res: Response): Promise<void> {
    const activeOnly = req.query.active === 'true';
    const result = await RoutingService.listRules(activeOnly);
    res.status(200).json({ success: true, data: result });
  }

  /** POST /api/routing-rules — create a routing rule. */
  static async createRule(req: AuthenticatedRequest, res: Response): Promise<void> {
    const input = validateRoutingRule(req.body as Record<string, unknown>);
    const rule = await RoutingService.createRule(input);
    res.status(201).json({ success: true, data: { rule } });
  }

  /** PATCH /api/routing-rules/:id — partially update a rule. Answers 200. */
  static async updateRule(req: AuthenticatedRequest, res: Response): Promise<void> {
    const ruleId = validateUuidParam('id', req.params.id);
    const changes = validateRoutingRuleUpdate(req.body as Record<string, unknown>);
    const rule = await RoutingService.updateRule(ruleId, changes);
    res.status(200).json({ success: true, data: { rule } });
  }

  /**
   * DELETE /api/routing-rules/:id — retire a rule.
   *
   * Answers 200 with a summary rather than a bodyless 204, because the caller
   * needs to know whether this call retired the rule or found it already
   * retired, and because the retirement is a soft delete whose resulting state
   * is worth returning.
   */
  static async retireRule(req: AuthenticatedRequest, res: Response): Promise<void> {
    const ruleId = validateUuidParam('id', req.params.id);
    const result = await RoutingService.retireRule(ruleId);
    res.status(200).json({ success: true, data: result });
  }
}
