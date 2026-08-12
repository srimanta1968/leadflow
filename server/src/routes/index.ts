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
import { importsRoutes } from '../features/imports';
import { identityRoutes } from '../features/identity';
import { consentRoutes } from '../features/consent';
import { enrichmentRoutes } from '../features/enrichment';
import { auditRoutes } from '../features/audit';
import { relationshipRoutes } from '../features/relationships';
import { ownershipRoutes } from '../features/ownership';
import { slaConfigRoutes, slaLeadRoutes } from '../features/sla';
import { pipelineRoutes, recordRoutes } from '../features/pipeline';
import { channelRoutes, callRoutes, templateRoutes } from '../features/channels';
import { sequenceRoutes } from '../features/sequences';
import { calendarRoutes, meetingRoutes } from '../features/calendar';
import { offerRoutes, checkoutRoutes, paymentRoutes, onboardingRoutes } from '../features/commerce';
import { segmentRoutes } from '../features/campaigns';
import { kpiRoutes, insightsRoutes } from '../features/insights';
import { digestRoutes } from '../features/rhythm';
import { workflowRoutes } from '../features/workflows';
import { failureRoutes } from '../features/failures';
import { contactRoutes, savedViewRoutes } from '../features/contacts';
import {
  routingWorkspaceRoutes, routingTraceRoutes, coverageRoutes, pipelineBoardRoutes,
  nextActionRoutes, inboxRoutes, opportunityRoutes, handoffRoutes, dashboardRoutes,
  incidentRoutes, governanceRoutes, certificationRoutes,
} from '../features/workspace';
import { creditsRoutes } from '../features/enrichment';
import { dataReviewRoutes } from '../features/dataReview';
import { aiRoutes } from '../features/ai';
import { conversationRoutes } from '../features/conversation';
import { sdkHealthRoutes } from '../platform/sdkGateway';
import { eventRoutes as platformEventRoutes } from '../platform/events';
import { orchestrationRoutes } from '../orchestration';

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
// Behind `authenticate` inside the router itself, like every other governed
// surface: governed() reads roles from the session, which only exists once
// authenticate has run.
router.use('/leadflow/imports', importsRoutes);
router.use('/leadflow/identity', identityRoutes);
router.use('/leadflow/consent', consentRoutes);
router.use('/leadflow/enrichment', enrichmentRoutes);
router.use('/leadflow/audit', auditRoutes);
router.use('/leadflow/relationships', relationshipRoutes);
router.use('/leadflow/leads', ownershipRoutes);
router.use('/leadflow/sla', slaConfigRoutes);
router.use('/leadflow/leads', slaLeadRoutes);
router.use('/leadflow/pipeline', pipelineRoutes);
router.use('/leadflow/records', recordRoutes);
router.use('/leadflow/channels', channelRoutes);
router.use('/leadflow/calls', callRoutes);
router.use('/leadflow/templates', templateRoutes);
router.use('/leadflow/sequences', sequenceRoutes);
router.use('/leadflow/calendar', calendarRoutes);
router.use('/leadflow/meetings', meetingRoutes);
router.use('/leadflow/offers', offerRoutes);
router.use('/leadflow/checkout', checkoutRoutes);
router.use('/leadflow/payments', paymentRoutes);
router.use('/leadflow/onboarding', onboardingRoutes);
router.use('/leadflow/segments', segmentRoutes);
router.use('/leadflow/kpi-definitions', kpiRoutes);
router.use('/leadflow/analytics', insightsRoutes);
router.use('/leadflow/digests', digestRoutes);
router.use('/leadflow/workflows', workflowRoutes);
router.use('/leadflow/failures', failureRoutes);
router.use('/leadflow/contacts', contactRoutes);
router.use('/leadflow/saved-views', savedViewRoutes);
router.use('/leadflow/routing', routingWorkspaceRoutes);
router.use('/leadflow/leads', routingTraceRoutes);
router.use('/leadflow/coverage', coverageRoutes);
router.use('/leadflow/pipeline', pipelineBoardRoutes);
router.use('/leadflow/next-actions', nextActionRoutes);
router.use('/leadflow/inbox', inboxRoutes);
router.use('/leadflow/opportunities', opportunityRoutes);
router.use('/leadflow/handoffs', handoffRoutes);
router.use('/leadflow/dashboards', dashboardRoutes);
router.use('/leadflow/incidents', incidentRoutes);
router.use('/leadflow/go-live', governanceRoutes);
router.use('/leadflow/certification', certificationRoutes);
router.use('/leadflow/credits', creditsRoutes);
router.use('/leadflow/data-review', dataReviewRoutes);
router.use('/leadflow/ai', aiRoutes);
router.use('/leadflow/calls', conversationRoutes);
router.use('/leadflow/platform', sdkHealthRoutes);
router.use('/leadflow/events', platformEventRoutes);
router.use('/leadflow', orchestrationRoutes);

export default router;
