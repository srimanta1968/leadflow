import { Router } from 'express';
import { UserController } from '../controllers/UserController';
import { UserAdminController } from '../features/users';
import { authenticate } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';

/**
 * Team roster and the user register.
 *
 * TWO AUDIENCES ON ONE ROUTER, deliberately. `GET /` is the roster every screen
 * that must name a colleague already calls — routing, ownership, coverage — and
 * it is behind `authenticate` without a role gate, because hiding the roster
 * from the operators who route to it would make those screens unusable.
 *
 * Everything under it is the REGISTER: who may sign in and in what capacity.
 * Those are `governed()` and each carries its own permission, so the gate is the
 * policy decision point rather than this file. Nothing here is admin-gated by a
 * role check in middleware — one authority, evaluated in one place.
 *
 * LITERAL PATHS BEFORE PARAMETERISED ONES. `/roles` and `/permission-matrix`
 * would be swallowed by a `/:id` route registered ahead of them, and the failure
 * would be a 404 for a route that plainly exists.
 */
const router: Router = Router();

router.use(authenticate);

router.get('/', asyncHandler(UserController.list));
router.get('/register', asyncHandler(UserAdminController.list));
router.get('/roles', asyncHandler(UserAdminController.roles));
router.get('/permission-matrix', asyncHandler(UserAdminController.matrix));

router.post('/invite', asyncHandler(UserAdminController.invite));
router.patch('/:id/role', asyncHandler(UserAdminController.assignRole));
router.post('/:id/activate', asyncHandler(UserAdminController.activate));
router.post('/:id/deactivate', asyncHandler(UserAdminController.deactivate));

export default router;
