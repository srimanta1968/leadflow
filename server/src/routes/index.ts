import { Router } from 'express';
import authRoutes from './authRoutes';
import leadRoutes from './leadRoutes';
import publicLeadRoutes from './publicLeadRoutes';
import routingRoutes from './routingRoutes';
import slaRoutes from './slaRoutes';
import userRoutes from './userRoutes';
import eventRoutes from './eventRoutes';
import analyticsRoutes from './analyticsRoutes';
import { authzRoutes } from '../platform/policy';
import { intakeRoutes } from '../features/intake';
import { captureRoutes } from '../features/capture';

/**
 * Root API router, mounted at `/api`.
 *
 * Mount order matters: `/public` carries the single unauthenticated write and
 * is registered explicitly so it can never be reached through a guarded router
 * by accident.
 */
const router: Router = Router();

router.use('/auth', authRoutes);
router.use('/public', publicLeadRoutes);
router.use('/leads', leadRoutes);
router.use('/routing-rules', routingRoutes);
router.use('/sla', slaRoutes);
router.use('/users', userRoutes);
router.use('/events', eventRoutes);
router.use('/analytics', analyticsRoutes);
router.use('/leadflow/authz', authzRoutes);
router.use('/leadflow/intake', intakeRoutes);
router.use('/leadflow/capture', captureRoutes);

export default router;
