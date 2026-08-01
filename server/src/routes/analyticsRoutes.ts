import { Router } from 'express';
import { AnalyticsController } from '../controllers/AnalyticsController';
import { authenticate } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';

/**
 * Analytics rollups. Behind `authenticate` like every other read — the overview
 * reports how each representative's queue is performing, which is not public.
 */
const router: Router = Router();

router.use(authenticate);

router.get('/overview', asyncHandler(AnalyticsController.overview));

export default router;
