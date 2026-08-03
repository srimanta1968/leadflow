import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/errorHandler';
import { CaptureInboxController } from './inboxController';

// @governance-tracked
// Definition: tests/api_definitions/capture/inbox-get.json

/**
 * The capture triage surface.
 *
 * Behind `authenticate` like every other operator screen: the rows are scoped
 * to the tenant and the actions to the caller, so an unauthenticated read has
 * no meaning.
 */
const router: Router = Router();

router.use(authenticate);

router.get('/inbox', asyncHandler(CaptureInboxController.inbox));

export default router;
