import { Response } from 'express';
import { SlaMonitorService } from '../services/SlaMonitorService';
import { SlaPolicyService } from '../services/SlaPolicyService';
import { SlaAlertService } from '../services/SlaAlertService';
import {
  validateAlertAcknowledge,
  validateAlertDispatch,
  validateFirstResponse,
  validateSlaAlertQuery,
  validateSlaEvaluate,
  validateSlaPolicy,
  validateSlaPolicyUpdate,
  validateSlaStatusQuery,
} from '../validators/slaValidators';
import { validateUuidParam } from '../validators/routingValidators';
import { AuthenticatedRequest } from '../middleware/auth';
import { AppError } from '../utils/errors';
import { PERMISSIONS } from '../config/roles';
import { AUDIT_EVENTS } from '../platform/audit/vocabulary';
import { governed, GovernedRequest } from '../platform/policy/governed';

/**
 * HTTP surface for SLA monitoring.
 *
 * Recording a response and running the sweep are commands against existing
 * leads rather than the creation of new resources, so both answer 200
 * (MUST-54). The snapshot is a read and answers 200.
 *
 * Every mutating handler goes through `governed` — PDP before the write, audit
 * entry after it. SLA targets in particular: a loosened response target is the
 * change most worth being able to reconstruct afterwards, and until now nothing
 * recorded who loosened it.
 */
export class SlaController {
  /**
   * POST /api/leads/:id/first-response — record the first human response and
   * stop the lead's clock.
   */
  static recordFirstResponse = governed(
    {
      action: PERMISSIONS.LEAD_WORK_ASSIGNED,
      event: AUDIT_EVENTS.SLA_FIRST_RESPONSE_RECORDED,
      purpose: 'lead_management',
      resourceType: 'lead',
      resourceId: (req) => req.params.id,
      obligations: {
        own_record_only: {
          kind: 'defer',
          // The service credits the response to the session user, so it cannot
          // be attributed to someone else — but nothing yet checks that the
          // caller is the lead's owner or named backup, which is what the
          // obligation actually says.
          because: 'ownership of the lead is not checked against the caller yet',
        },
      },
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const leadId = validateUuidParam('id', req.params.id);
      const input = validateFirstResponse(req.body as Record<string, unknown>);

      // `authenticate` has already run, so this is defensive rather than expected;
      // crediting a response to nobody would leave the audit trail unusable.
      if (!req.session) {
        throw AppError.unauthenticated();
      }

      const result = await SlaMonitorService.recordFirstResponse(
        leadId,
        input,
        req.session.userId
      );
      res.status(200).json({ success: true, data: result });
    }
  );

  /** GET /api/sla/status — the SLA compliance snapshot. */
  static async status(req: AuthenticatedRequest, res: Response): Promise<void> {
    const query = validateSlaStatusQuery(req.query as Record<string, unknown>);
    const snapshot = await SlaMonitorService.status(query);
    res.status(200).json({ success: true, data: snapshot });
  }

  /** POST /api/sla/evaluate — run the monitoring sweep. */
  static evaluate = governed(
    {
      action: PERMISSIONS.SLA_EVALUATE,
      event: AUDIT_EVENTS.SLA_SWEEP_RUN,
      purpose: 'service_operation',
      resourceType: 'sla_sweep',
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const input = validateSlaEvaluate((req.body ?? {}) as Record<string, unknown>);
      const result = await SlaMonitorService.evaluate(input);
      res.status(200).json({ success: true, data: result });
    }
  );

  /** GET /api/sla/policies — list SLA targets in evaluation order. */
  static async listPolicies(req: AuthenticatedRequest, res: Response): Promise<void> {
    const activeOnly = req.query.active === 'true';
    const result = await SlaPolicyService.listPolicies(activeOnly);
    res.status(200).json({ success: true, data: result });
  }

  /**
   * POST /api/sla/policies — define an SLA target for a lead type.
   * A create at the collection root, so it answers 201.
   */
  static createPolicy = governed(
    {
      action: PERMISSIONS.SLA_CONFIGURE,
      event: AUDIT_EVENTS.SLA_POLICY_CREATED,
      purpose: 'service_operation',
      resourceType: 'sla_policy',
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const input = validateSlaPolicy(req.body as Record<string, unknown>);
      const policy = await SlaPolicyService.createPolicy(input);
      res.status(201).json({ success: true, data: { policy } });
    }
  );

  /** PATCH /api/sla/policies/:id — partially update a target. Answers 200. */
  static updatePolicy = governed(
    {
      action: PERMISSIONS.SLA_CONFIGURE,
      event: AUDIT_EVENTS.SLA_POLICY_UPDATED,
      purpose: 'service_operation',
      resourceType: 'sla_policy',
      resourceId: (req) => req.params.id,
      // Which fields were touched — the difference between tightening and
      // loosening a target is the whole reason to record this at all.
      metadata: (req) => ({ changes: Object.keys((req.body as object) ?? {}) }),
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const policyId = validateUuidParam('id', req.params.id);
      const changes = validateSlaPolicyUpdate((req.body ?? {}) as Record<string, unknown>);
      const policy = await SlaPolicyService.updatePolicy(policyId, changes);
      res.status(200).json({ success: true, data: { policy } });
    }
  );

  /**
   * DELETE /api/sla/policies/:id — retire a target.
   *
   * Answers 200 with a summary rather than a bodyless 204: the caller needs to
   * know whether this call retired the policy or found it already retired, and
   * the retirement is a soft delete whose resulting state is worth returning.
   */
  static retirePolicy = governed(
    {
      action: PERMISSIONS.SLA_CONFIGURE,
      event: AUDIT_EVENTS.SLA_POLICY_RETIRED,
      purpose: 'service_operation',
      resourceType: 'sla_policy',
      resourceId: (req) => req.params.id,
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const policyId = validateUuidParam('id', req.params.id);
      const result = await SlaPolicyService.retirePolicy(policyId);
      res.status(200).json({ success: true, data: result });
    }
  );

  /** GET /api/sla/alerts — read the escalation ledger, newest first. */
  static async listAlerts(req: AuthenticatedRequest, res: Response): Promise<void> {
    const query = validateSlaAlertQuery(req.query as Record<string, unknown>);
    const result = await SlaAlertService.list(query);
    res.status(200).json({ success: true, data: result });
  }

  /**
   * POST /api/sla/alerts/acknowledge — clear MY alerts for a lead.
   *
   * A command against existing rows, so it answers 200.
   */
  static acknowledgeAlerts = governed(
    {
      action: PERMISSIONS.SLA_ALERT_ACKNOWLEDGE,
      event: AUDIT_EVENTS.SLA_ALERT_ACKNOWLEDGED,
      purpose: 'service_operation',
      resourceType: 'sla_alert',
      resourceId: (req) => (req.body as { lead_id?: string })?.lead_id,
      obligations: {
        own_record_only: {
          kind: 'discharge',
          // GENUINELY DISCHARGED, not deferred. The recipient comes from the
          // verified session and the service scopes the update to it, so a
          // caller cannot reach another person's alerts even by naming them.
          check: (req) => Boolean(req.session?.userId),
          onFail: 'An acknowledgement must be made by an identified caller.',
        },
      },
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const input = validateAlertAcknowledge((req.body ?? {}) as Record<string, unknown>);

      // `authenticate` has already run, so this is defensive. The recipient MUST
      // come from the verified session and never from the body — otherwise one
      // manager could acknowledge away another's escalation.
      if (!req.session) {
        throw AppError.unauthenticated();
      }

      const result = await SlaAlertService.acknowledgeForLead(input.lead_id, req.session.userId);
      res.status(200).json({ success: true, data: result });
    }
  );

  /** POST /api/sla/alerts/dispatch — retry undelivered notifications. */
  static dispatchAlerts = governed(
    {
      action: PERMISSIONS.SLA_ALERT_DISPATCH,
      event: AUDIT_EVENTS.SLA_ALERT_DISPATCHED,
      purpose: 'service_operation',
      resourceType: 'sla_alert',
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const input = validateAlertDispatch((req.body ?? {}) as Record<string, unknown>);
      const result = await SlaAlertService.dispatchPending(input.limit);
      res.status(200).json({ success: true, data: result });
    }
  );
}
