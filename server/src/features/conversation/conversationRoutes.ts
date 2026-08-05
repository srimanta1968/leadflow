import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/errorHandler';
import { ConversationController } from './conversationController';

// @governance-tracked
// Definition: tests/api_definitions/calls/recording-eligibility-get.json
// Definition: tests/api_definitions/calls/id-intelligence-get.json

/**
 * The conversation intelligence surface.
 *
 * Behind `authenticate` like every other operator surface. Note what is NOT
 * here: no route that starts a recording. Recording is started by the telephony
 * connector, and the only thing this application offers beforehand is the
 * ELIGIBILITY answer — which is the shape the criterion asks for, because a
 * "record now" endpoint that checked consent itself would put the check and the
 * action in the same call, and the check exists to happen first.
 *
 * ORDER MATTERS in the two registrations below: `/recording-eligibility` is a
 * literal segment that would otherwise be captured by `/:id`, and Express takes
 * the first match. Registered first, so asking about eligibility cannot be
 * mistaken for asking about a call whose id happens to be that word.
 */
const router: Router = Router();

router.use(authenticate);

router.get('/recording-eligibility', asyncHandler(ConversationController.eligibility));
router.get('/:id/intelligence', asyncHandler(ConversationController.intelligence));

export default router;
