import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/errorHandler';
import { CaptureInboxController } from './inboxController';
import { QuickCaptureController } from './quickCaptureController';
import { ResolveCaptureController } from './resolveCaptureController';
import { ExtensionCaptureController } from './extensionCaptureController';
import { SyncBatchController } from './syncBatchController';

// @governance-tracked
// Definition: tests/api_definitions/capture/inbox-get.json
// Definition: tests/api_definitions/capture/quick-post.json
// Definition: tests/api_definitions/capture/resolve-post.json
// Definition: tests/api_definitions/capture/extension-post.json
// Definition: tests/api_definitions/capture/extension-domain-policy-get.json
// Definition: tests/api_definitions/capture/sync-batch-post.json

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
router.post('/quick', asyncHandler(QuickCaptureController.quick));
// Registered BEFORE '/:id/resolve'. Express matches in order, so with the
// parameterised route first, a GET to '/extension/domain-policy' would bind
// 'extension' to :id and never reach this handler.
router.get('/extension/domain-policy', asyncHandler(ExtensionCaptureController.domainPolicy));
router.post('/extension', asyncHandler(ExtensionCaptureController.capture));
router.post('/sync-batch', asyncHandler(SyncBatchController.sync));
router.post('/:id/resolve', asyncHandler(ResolveCaptureController.resolve));

export default router;
