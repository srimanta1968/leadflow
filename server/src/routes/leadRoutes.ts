import { Router } from 'express';
import { LeadController } from '../controllers/LeadController';
import { RoutingController } from '../controllers/RoutingController';
import { SlaController } from '../controllers/SlaController';
import { authenticate } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';

/**
 * Lead routes for authenticated callers — the application UI and server-to-server
 * API integrations. Every route on this router is behind `authenticate`.
 *
 * The public marketing web form does NOT post here; it posts to the separately
 * mounted, rate-limited public capture route (see `publicLeadRoutes`).
 */
const router: Router = Router();

router.use(authenticate);

router.post('/', asyncHandler(LeadController.capture));
router.get('/', asyncHandler(LeadController.list));
router.get('/:id', asyncHandler(LeadController.getById));

// Routing and assignment are commands against a lead, so they live under the
// lead's own path rather than in the rule-administration router.
//
// `route-unowned` is registered BEFORE `/:id/*` so the literal path is not
// swallowed by the parameterised route and treated as a lead id.
router.post('/route-unowned', asyncHandler(RoutingController.routeUnowned));
router.post('/:id/route', asyncHandler(RoutingController.routeLead));
router.post('/:id/assign', asyncHandler(RoutingController.assignLead));

// Stopping the response clock is likewise a command against one lead, so it is
// mounted here rather than under /api/sla even though the SLA monitor owns it.
router.post('/:id/first-response', asyncHandler(SlaController.recordFirstResponse));

export default router;
