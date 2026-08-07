import { Router, type Request, type Response } from 'express';
import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/errorHandler';
import { SdkGatewayClient } from './client';

/**
 * GET /api/leadflow/platform/sdk-health — the RevOps provider-health panel.
 *
 * BEHIND `authenticate`, NOT `governed`. Two reasons, and the second is the one
 * that matters: the payload carries no personal data at all — SDK names, circuit
 * states, counts and latencies — so there is no subject to make a governed
 * decision about; and gating a health panel on `integration.configure` would
 * lock it to the people who change integrations rather than the people working a
 * queue that has just gone quiet. An operator who cannot see that
 * sdk-source-record is short-circuiting files a bug about the capture screen.
 *
 * Answers 200 even when everything is on fire. The panel's job is to REPORT the
 * outage; returning 503 because the things it describes are unhealthy would make
 * the diagnostic disappear exactly when it is needed, and would trip whatever
 * monitors the panel itself.
 */
export const sdkHealthRoutes: Router = Router();

sdkHealthRoutes.use(authenticate);

sdkHealthRoutes.get(
  '/sdk-health',
  asyncHandler(async (_req: Request, res: Response): Promise<void> => {
    const sdks = SdkGatewayClient.healthSnapshot();

    res.status(200).json({
      success: true,
      data: {
        // `unknown` is NOT counted as a problem here — an SDK nobody has called
        // this process is not evidence of anything. Counting it would paint the
        // panel amber every time the app restarts.
        gatewayConfigured: SdkGatewayClient.isConfigured(),
        unavailable: sdks.filter((s) => s.verdict === 'unavailable').length,
        degraded: sdks.filter((s) => s.verdict === 'degraded').length,
        observedAt: new Date().toISOString(),
        sdks,
      },
    });
  }),
);
