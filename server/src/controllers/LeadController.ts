import { Request, Response } from 'express';
import { LeadCaptureService } from '../services/LeadCaptureService';
import { validateLeadCapture } from '../validators/leadValidators';
import { AuthenticatedRequest } from '../middleware/auth';
import { evaluateActivationGate } from '../features/intake/activationGate';
import { AppError } from '../utils/errors';
import { validateUuidParam } from '../validators/routingValidators';

/**
 * HTTP surface for lead capture.
 *
 * Capture is a collection-root create, so it answers 201. The reads answer 200.
 */
export class LeadController {
  /** POST /api/leads — capture a lead and assert it upstream. */
  static async capture(req: Request, res: Response): Promise<void> {
    const input = validateLeadCapture(req.body as Record<string, unknown>);
    const result = await LeadCaptureService.capture(input);
    res.status(201).json({ success: true, data: result });
  }

  /** GET /api/leads — list captured leads, newest first. */
  static async list(req: AuthenticatedRequest, res: Response): Promise<void> {
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;
    const offset = req.query.offset ? parseInt(String(req.query.offset), 10) : 0;
    const result = await LeadCaptureService.list(limit, offset);
    res.status(200).json({ success: true, data: result });
  }

  /**
   * GET /api/leads/:id/activation-gate — may this record be worked?
   *
   * A read, so 200 — including when the answer is "no". A blocked record is not
   * an error the caller caused, and a 4xx would make an integrity screen look
   * broken while it is doing exactly its job.
   *
   * Evaluating writes the activation_state marker, which is what puts the
   * record in the manager's integrity queue. That is deliberate: the queue is
   * an indexed read over that column rather than a re-evaluation of every lead,
   * so checking a record is what makes it visible.
   */
  static async activationGate(req: AuthenticatedRequest, res: Response): Promise<void> {
    const leadId = validateUuidParam('id', req.params.id);
    const verdict = await evaluateActivationGate(leadId);
    if (!verdict) {
      throw AppError.notFound('Lead not found');
    }
    res.status(200).json({ success: true, data: verdict });
  }

  /** GET /api/leads/:id — fetch one captured lead. */
  static async getById(req: AuthenticatedRequest, res: Response): Promise<void> {
    const lead = await LeadCaptureService.getById(String(req.params.id));
    res.status(200).json({ success: true, data: { lead } });
  }
}
