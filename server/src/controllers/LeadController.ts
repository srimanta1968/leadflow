import { Request, Response } from 'express';
import { LeadCaptureService } from '../services/LeadCaptureService';
import { validateLeadCapture } from '../validators/leadValidators';
import { AuthenticatedRequest } from '../middleware/auth';

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

  /** GET /api/leads/:id — fetch one captured lead. */
  static async getById(req: AuthenticatedRequest, res: Response): Promise<void> {
    const lead = await LeadCaptureService.getById(String(req.params.id));
    res.status(200).json({ success: true, data: { lead } });
  }
}
