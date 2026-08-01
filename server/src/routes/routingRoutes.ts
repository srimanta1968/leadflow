import { Router } from 'express';
import { RoutingController } from '../controllers/RoutingController';
import { authenticate } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';

/**
 * Routing rule administration. Every route is behind `authenticate` — routing
 * configuration decides who owns revenue, so it is never publicly writable.
 */
const router: Router = Router();

router.use(authenticate);

router.get('/', asyncHandler(RoutingController.listRules));
router.post('/', asyncHandler(RoutingController.createRule));
router.patch('/:id', asyncHandler(RoutingController.updateRule));
// Soft delete: leads reference routing_rule_id, so the row is retired rather
// than removed and the past routing decision stays explainable.
router.delete('/:id', asyncHandler(RoutingController.retireRule));

export default router;
