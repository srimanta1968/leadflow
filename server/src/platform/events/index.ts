/**
 * Event ingestion, read projections and the transactional outbox.
 *
 * The one-way flows this module owns:
 *
 *   ProjexCloud --HMAC webhook--> receiver -> event log -> pure fold -> projection
 *   LeadFlow write --same txn--> outbox -> dispatcher -> sdkGateway -> ProjexCloud
 *
 * Both are at-least-once, and both survive a restart because the durable step
 * comes FIRST: the log row before the handler, the outbox row before the send.
 */
export { ingest, advancePipeline, rebuildPipeline, projectionFingerprint, checkpoint, PIPELINE_PROJECTION } from './consumer';
export type { IngestInput, IngestResult, AdvanceResult } from './consumer';
export { apply, fold, emptyState, HANDLED_EVENT_TYPES } from './projections';
export type { PipelineState, DomainEvent } from './projections';
export { verifyDelivery } from './signature';
export type { VerificationResult, SignatureState } from './signature';
export { enqueue, dispatchOutbox, listOutboxDlq, replayOutbox } from './outboxDispatcher';
export type { EnqueueInput, DispatchResult } from './outboxDispatcher';
export { eventRoutes } from './eventsController';
export { registerEventReceiver, subscribableEventTypes } from './subscription';
export type { RegistrationResult } from './subscription';
