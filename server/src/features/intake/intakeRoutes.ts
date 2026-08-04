import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/errorHandler';
import { IntakeController } from './intakeController';

// @governance-tracked
// Definition: tests/api_definitions/intake/events-post.json
// Definition: tests/api_definitions/intake/webhooks-platform-post.json
// Definition: tests/api_definitions/intake/adapters-get.json
// Definition: tests/api_definitions/intake/adapters-launch-evidence-get.json

/**
 * Universal intake.
 *
 * TWO AUTHENTICATION MODELS ON ONE ROUTER, which is why the guard is applied
 * per route rather than with a blanket `router.use(authenticate)`:
 *
 *  - `/events` is first-party. A bearer token establishes the caller.
 *  - `/webhooks/:platform` is a machine we do not control, authenticated by
 *    HMAC over the raw body. It has no session and cannot have one — putting it
 *    behind `authenticate` would mean every provider needs a LeadFlow login,
 *    which is not how webhooks work.
 *
 * Applying `authenticate` router-wide and then trying to exempt the webhook is
 * the version of this that goes wrong: the exemption is easy to lose in a
 * refactor, and losing it fails CLOSED — every provider silently starts getting
 * 401s and nobody notices until leads stop arriving.
 */
const router: Router = Router();

router.post('/events', authenticate, asyncHandler(IntakeController.events));
router.post('/backfill', authenticate, asyncHandler(IntakeController.backfill));
router.get('/adapters', authenticate, asyncHandler(IntakeController.adapters));
router.get(
  '/adapters/:key/launch-evidence',
  authenticate,
  asyncHandler(IntakeController.launchEvidence)
);

// Deliberately NOT behind `authenticate` — see above. Its guard is the
// signature check inside the handler, which runs before anything is processed.
router.post('/webhooks/:platform', asyncHandler(IntakeController.webhook));

export default router;
