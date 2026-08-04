import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/errorHandler';
import { AiCoachController, AiSdrController } from './aiController';

// @governance-tracked
// Definition: tests/api_definitions/ai/sdr-qualify-post.json
// Definition: tests/api_definitions/ai/sdr-proposals-id-accept-post.json
// Definition: tests/api_definitions/ai/coach-calls-post.json
// Definition: tests/api_definitions/ai/coach-scorecard-callid-get.json

/**
 * The AI agent surface.
 *
 * Behind `authenticate` like every other operator surface. Note what is NOT
 * here: no send route, no dispatch route, no "approve and send" shortcut. The
 * SOP requires a qualified human to review consequential outputs, and the way
 * to guarantee that is the absence of the endpoint rather than a guard on it.
 */
const router: Router = Router();

router.use(authenticate);

router.post('/sdr/qualify', asyncHandler(AiSdrController.qualify));
router.post('/sdr/proposals/:id/accept', asyncHandler(AiSdrController.accept));
router.post('/coach/calls', asyncHandler(AiCoachController.register));
router.get('/coach/scorecard/:callId', asyncHandler(AiCoachController.scorecard));

export default router;
