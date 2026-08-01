import { Router } from 'express';
import { UserController } from '../controllers/UserController';
import { authenticate } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';

/**
 * Team roster. Behind `authenticate` — the roster names real people, so it is
 * never public, but it is not admin-gated either: every operator who routes or
 * reassigns work needs to read it.
 */
const router: Router = Router();

router.use(authenticate);

router.get('/', asyncHandler(UserController.list));

export default router;
