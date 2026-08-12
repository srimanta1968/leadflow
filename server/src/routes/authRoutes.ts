import { Router } from 'express';
import { AuthController } from '../controllers/AuthController';
import { authenticate } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';

/**
 * Authentication routes.
 *
 * `register` and `login` are the auth bootstrap — they PROVIDE the session
 * token rather than requiring one, so they carry no guard. Everything else on
 * this router sits behind `authenticate`.
 */
const router: Router = Router();

router.post('/register', asyncHandler(AuthController.register));
router.post('/login', asyncHandler(AuthController.login));

/*
 * UNAUTHENTICATED, all three, and each for the same reason: the token in the
 * link IS the credential. Requiring a session would mean somebody who cannot
 * sign in until they confirm can never confirm, and somebody invited to an
 * account with no password could never claim it.
 */
router.post('/verify-email', asyncHandler(AuthController.verifyEmail));
router.post('/resend-verification', asyncHandler(AuthController.resendVerification));
router.post('/accept-invitation', asyncHandler(AuthController.acceptInvitation));
router.get('/me', authenticate, asyncHandler(AuthController.me));

export default router;
