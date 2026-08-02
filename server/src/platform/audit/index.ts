/**
 * Platform audit — the LeadFlow event vocabulary and its append helper.
 */
export { AUDIT_EVENTS, allAuditEventNames, isAuditEventName, REVERSAL_EVENTS } from './vocabulary';
export type { AuditEventName } from './vocabulary';
export { appendAuditEntry, verifyAuditChain } from './auditLog';
export type { AuditEntry, AuditAppendResult, ChainVerificationResult } from './auditLog';
