import { Router } from 'express';
import { SlaController } from '../controllers/SlaController';
import { authenticate } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';

/**
 * SLA monitoring. Every route is behind `authenticate` — the compliance picture
 * names who is late on which prospect, so it is never publicly readable, and the
 * sweep writes breach state.
 *
 * The first-response command lives on the lead's own path (see `leadRoutes`)
 * rather than here, matching how routing and assignment are mounted: a command
 * against one lead belongs under that lead.
 */
const router: Router = Router();

router.use(authenticate);

router.get('/status', asyncHandler(SlaController.status));
router.post('/evaluate', asyncHandler(SlaController.evaluate));

// SLA targets per lead type. Registered after the literal /status and /evaluate
// paths so neither can be swallowed by a parameterised route.
// Escalation alerts. The two literal action paths are registered BEFORE the
// ledger read so neither can be mistaken for a filter, and neither collides with
// the /policies routes below.
router.get('/alerts', asyncHandler(SlaController.listAlerts));
router.post('/alerts/acknowledge', asyncHandler(SlaController.acknowledgeAlerts));
router.post('/alerts/dispatch', asyncHandler(SlaController.dispatchAlerts));

router.get('/policies', asyncHandler(SlaController.listPolicies));
router.post('/policies', asyncHandler(SlaController.createPolicy));
router.patch('/policies/:id', asyncHandler(SlaController.updatePolicy));
// Soft delete: a lead's deadline was computed from the policy in force when it
// was assigned, so the row is retired rather than removed and a past deadline
// stays explainable.
router.delete('/policies/:id', asyncHandler(SlaController.retirePolicy));

export default router;
