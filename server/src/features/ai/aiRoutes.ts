import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/errorHandler';
import { AiCoachController, AiSdrController } from './aiController';
import { AiReviewGateController } from './reviewGateController';
import { AiManagerController, AiRevOpsController } from './opsController';

// @governance-tracked
// Definition: tests/api_definitions/ai/sdr-qualify-post.json
// Definition: tests/api_definitions/ai/sdr-proposals-id-accept-post.json
// Definition: tests/api_definitions/ai/coach-calls-post.json
// Definition: tests/api_definitions/ai/coach-scorecard-callid-get.json
// Definition: tests/api_definitions/ai/propose-post.json
// Definition: tests/api_definitions/ai/proposals-id-decide-post.json
// Definition: tests/api_definitions/ai/manager-risk-signals-get.json
// Definition: tests/api_definitions/ai/revops-proposals-get.json

/**
 * The AI agent surface.
 *
 * Behind `authenticate` like every other operator surface. Note what is NOT
 * here: no send route, no dispatch route, no "approve and send" shortcut. The
 * SOP requires a qualified human to review consequential outputs, and the way
 * to guarantee that is the absence of the endpoint rather than a guard on it.
 *
 * `/propose` and `/proposals/:id/decide` are the GENERAL form of the gate the
 * SDR pair implements for drafts alone: any agent, any consequential output
 * kind, one place where a qualified human decides. A module added later uses
 * these rather than growing a review path of its own — the guarantee holds for
 * the modules that remembered, and the one written next year is the one that
 * forgets.
 */
const router: Router = Router();

router.use(authenticate);

router.post('/propose', asyncHandler(AiReviewGateController.propose));
router.post('/proposals/:id/decide', asyncHandler(AiReviewGateController.decide));
router.post('/sdr/qualify', asyncHandler(AiSdrController.qualify));
router.post('/sdr/proposals/:id/accept', asyncHandler(AiSdrController.accept));
router.post('/coach/calls', asyncHandler(AiCoachController.register));
router.get('/coach/scorecard/:callId', asyncHandler(AiCoachController.scorecard));
router.get('/manager/risk-signals', asyncHandler(AiManagerController.signals));
router.get('/revops/proposals', asyncHandler(AiRevOpsController.proposals));

export default router;
