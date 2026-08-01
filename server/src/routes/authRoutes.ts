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
router.get('/me', authenticate, asyncHandler(AuthController.me));

export default router;
