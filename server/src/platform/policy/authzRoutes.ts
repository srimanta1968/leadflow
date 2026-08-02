import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/errorHandler';
import { AuthzController } from './authzController';

// @governance-tracked
// Every route below has a definition under tests/api_definitions/authz/, so the
// pre-push hook tests it rather than reporting it as an endpoint nobody declared.

/**
 * Policy decisions for the signed-in caller.
 *
 * Behind `authenticate` like every other read of caller-specific state: the
 * answer depends entirely on who is asking, so an unauthenticated evaluation
 * has no meaning.
 */
const router: Router = Router();

router.use(authenticate);

router.post('/evaluate', asyncHandler(AuthzController.evaluate));

export default router;
