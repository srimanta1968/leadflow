import { Router } from 'express';
import { EventController } from '../controllers/EventController';
import { authenticate } from '../middleware/auth';

/**
 * The UI push channel. Behind `authenticate` like every other read — an event
 * stream that names leads and owners is not public.
 *
 * NOT wrapped in `asyncHandler`: that helper forwards a rejection to the error
 * handler, which would try to write a JSON error body onto a response whose
 * headers are already committed as text/event-stream. The handler owns its own
 * teardown instead.
 */
const router: Router = Router();

router.use(authenticate);

router.get('/stream', (req, res) => {
  void EventController.stream(req, res);
});

export default router;
