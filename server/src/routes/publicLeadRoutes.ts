import rateLimit from 'express-rate-limit';
import { Router } from 'express';
import { LeadController } from '../controllers/LeadController';
import { asyncHandler } from '../middleware/errorHandler';
import { config } from '../config/env';
import { ErrorCodes } from '../utils/errors';

/**
 * The public front door for the marketing site's lead form.
 *
 * This route is deliberately unauthenticated: a prospect filling in the form on
 * the landing page holds no session, and requiring one would defeat the whole
 * point of inbound capture. It is the only unauthenticated write in LeadFlow,
 * and it is constrained accordingly:
 *
 *  - per-IP rate limit, so the endpoint cannot be used to flood the inbox
 *  - the same validator as the authenticated route, so no unvalidated field
 *    reaches the database or the upstream assertion
 *  - captures land as `origin_class: first_party_declared` and enter the
 *    Capture Inbox for resolution rather than becoming trusted contacts
 */
const router: Router = Router();

const captureLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.maxRequests,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many submissions from this address. Please try again later.',
    code: ErrorCodes.RATE_LIMITED,
  },
});

router.post('/leads', captureLimiter, asyncHandler(LeadController.capture));

export default router;
