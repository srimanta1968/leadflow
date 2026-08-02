/**
 * The LeadFlow audit vocabulary — one canonical name per governed action.
 *
 * CLOSED SET, and that is the point. An audit trail whose event names are typed
 * freehand at each call site becomes unqueryable within a release: `lead.routed`
 * and `lead.route` and `routing.applied` all appear, and nobody can answer "how
 * often was a lead routed" without knowing every spelling anyone ever used.
 * Every name below maps to an entry the mockup's Audit Timeline renders, so the
 * screen and the ledger cannot disagree about what happened.
 *
 * ADDING A NAME IS A DELIBERATE ACT. Extend this object, and the type of every
 * append call follows automatically — an invented name is a compile error rather
 * than a row nobody will ever find.
 */
export const AUDIT_EVENTS = {
  CAPTURE_CREATED: 'capture.created',
  CAPTURE_NORMALIZED: 'capture.normalized',
  CAPTURE_PROMOTED: 'capture.promoted',
  IMPORT_RUN_COMMITTED: 'import.run.committed',
  IMPORT_RUN_ROLLED_BACK: 'import.run.rolled_back',
  IDENTITY_LINK_VERIFIED: 'identity.link.verified',
  IDENTITY_LINK_RETRACTED: 'identity.link.retracted',
  CONSENT_RECEIPT_ISSUED: 'consent.receipt.issued',
  CONSENT_RECEIPT_REVOKED: 'consent.receipt.revoked',
  SUPPRESSION_APPLIED: 'suppression.applied',
  ENRICHMENT_REQUESTED: 'enrichment.requested',
  ENRICHMENT_SETTLED: 'enrichment.settled',
  PII_REVEALED: 'pii.revealed',
  RELATIONSHIP_ESTABLISHED: 'relationship.established',
  RELATIONSHIP_ENDED: 'relationship.ended',
  OFFER_VERSION_STAMPED: 'offer.version.stamped',
  PAYMENT_VERIFIED: 'payment.verified',
  HANDOFF_ACCEPTED: 'handoff.accepted',
  SLA_BREACHED: 'sla.breached',
} as const;

/** Any name in the vocabulary. Nothing else is appendable. */
export type AuditEventName = (typeof AUDIT_EVENTS)[keyof typeof AUDIT_EVENTS];

/** Every canonical name, for the lint rule and for documentation. */
export function allAuditEventNames(): AuditEventName[] {
  return Object.values(AUDIT_EVENTS);
}

/** Whether a string is a canonical event name. */
export function isAuditEventName(value: string): value is AuditEventName {
  return allAuditEventNames().includes(value as AuditEventName);
}

/**
 * Events that record a REVERSAL of something previously recorded.
 *
 * Called out because reversals are the entries an auditor looks for first, and
 * because none of them may ever delete the entry they reverse — an audit trail
 * records that a thing was undone, not that it never happened.
 */
export const REVERSAL_EVENTS: AuditEventName[] = [
  AUDIT_EVENTS.IMPORT_RUN_ROLLED_BACK,
  AUDIT_EVENTS.IDENTITY_LINK_RETRACTED,
  AUDIT_EVENTS.CONSENT_RECEIPT_REVOKED,
  AUDIT_EVENTS.RELATIONSHIP_ENDED,
];
