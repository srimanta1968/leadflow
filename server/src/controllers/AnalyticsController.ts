import { Response } from 'express';
import { AnalyticsService } from '../services/AnalyticsService';
import { validateAnalyticsOverviewQuery } from '../validators/analyticsValidators';
import { AuthenticatedRequest } from '../middleware/auth';

/**
 * HTTP surface for the analytics dashboard.
 *
 * A read, so it answers 200 (MUST-54).
 */
export class AnalyticsController {
  /** GET /api/analytics/overview — funnel, conversion and response-time rollup. */
  static async overview(req: AuthenticatedRequest, res: Response): Promise<void> {
    const query = validateAnalyticsOverviewQuery(req.query as Record<string, unknown>);
    const data = await AnalyticsService.overview(query);
    res.status(200).json({ success: true, data });
  }
}
