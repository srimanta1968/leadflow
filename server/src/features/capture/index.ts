/**
 * Capture triage — the composed inbox the Capture Inbox screen reads.
 */
export { CaptureInboxController } from './inboxController';
export {
  parseInboxQuery,
  encodeCursor,
  decodeCursor,
  actionsForTrustState,
  availableActions,
  TRUST_STATES,
  ORIGIN_CLASSES,
  MAX_LIMIT,
} from './inboxQuery';
export type { InboxQuery, InboxCursor, TrustState, OriginClass } from './inboxQuery';
export { default as captureRoutes } from './captureRoutes';
