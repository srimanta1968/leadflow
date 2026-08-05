import { Response } from 'express';
import { PERMISSIONS } from '../../config/roles';
import { AUDIT_EVENTS } from '../../platform/audit/vocabulary';
import { governed, GovernedRequest } from '../../platform/policy/governed';
import { AppError, ErrorCodes } from '../../utils/errors';
import { huddleBrief, riskSignals, INTERVENTION_LEAD_MINUTES } from './managerRiskService';
import { revopsAnalysis } from './revopsProposalService';

/** Bounds on the caller-supplied lead time, in minutes. */
const MIN_LEAD = 1;
const MAX_LEAD = 24 * 60;

export class AiManagerController {
  /**
   * GET /api/leadflow/ai/manager/risk-signals
   *
   * A read, so 200 (MUST-54).
   *
   * Governed by dashboard.view_team, which is the authority this genuinely
   * needs: the response lists other people's leads and names the owner whose
   * queue is deep, so it is team visibility rather than working a lead. A Sales
   * Rep holds lead.work_assigned and NOT this, and that is the correct outcome —
   * a rep should not be reading a list of which colleagues are behind.
   *
   * WRAPPED IN `governed` even though it is a read. Most reads in this codebase
   * are not, and this one is because the thing being read IS the sensitive part:
   * "who looked at the team's performance, and when" is a question that gets
   * asked, and an unaudited management dashboard cannot answer it.
   */
  static signals = governed(
    {
      action: PERMISSIONS.DASHBOARD_VIEW_TEAM,
      event: AUDIT_EVENTS.AI_RISK_PREDICTED,
      purpose: 'lead_management',
      resourceType: 'ai_risk_signal',
      metadata: (req) => ({
        min_lead_minutes: (req.query as { minLeadMinutes?: string })?.minLeadMinutes ?? null,
      }),
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const raw = req.query.minLeadMinutes;
      let minLeadMinutes = INTERVENTION_LEAD_MINUTES;

      if (raw !== undefined) {
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < MIN_LEAD || parsed > MAX_LEAD) {
          throw new AppError(
            400,
            ErrorCodes.VALIDATION_ERROR,
            `minLeadMinutes must be a whole number between ${MIN_LEAD} and ${MAX_LEAD}`
          );
        }
        minLeadMinutes = parsed;
      }

      const report = await riskSignals({ minLeadMinutes });

      res.status(200).json({
        success: true,
        data: {
          ...report,
          // The brief is derived from the SAME report rather than recomputed, so
          // the prose and the list cannot disagree.
          brief: huddleBrief(report),
        },
      });
    }
  );
}

export class AiRevOpsController {
  /**
   * GET /api/leadflow/ai/revops/proposals
   *
   * A read that has a side effect — it opens a proposal per finding — and is
   * still a GET rather than a POST. That is defensible only because the side
   * effect is genuinely IDEMPOTENT: every proposal is keyed on the finding it
   * came from, so calling this twice returns the proposals already waiting
   * rather than a second copy of each. It was not idempotent when first written,
   * and a second live call duly opened every sequence proposal again.
   *
   * 200, not 201: the response is the analysis, and the proposals are a
   * consequence of it rather than the addressable thing being created.
   *
   * Governed by data.configure — RevOps findings are about how the machine is
   * configured (routing shares, dedupe, sequence quality), which is that role's
   * own remit.
   */
  static proposals = governed(
    {
      action: PERMISSIONS.DATA_CONFIGURE,
      event: AUDIT_EVENTS.AI_REVOPS_ANALYSED,
      purpose: 'lead_management',
      resourceType: 'ai_proposal',
    },
    async (_req: GovernedRequest, res: Response): Promise<void> => {
      const report = await revopsAnalysis();

      res.status(200).json({
        success: true,
        data: {
          duplicates: report.duplicates,
          routingRepairs: report.routingRepairs,
          // Present even when null, so a client can tell "routing is healthy"
          // from "we could not check" without inspecting array lengths.
          routingUnavailableReason: report.routingUnavailableReason,
          sequenceFindings: report.sequenceFindings,
          proposals: report.proposals,
          generatedAt: report.generatedAt,
        },
      });
    }
  );
}
