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
/**
 * VERSION SUFFIX IS MANDATORY. ProjexCloud enforces
 * `<domain>.<entity>.<verb>.v<N>` (EVENT_TYPE_NAME_PATTERN in
 * packages/contracts/src/events.ts) and rejects anything else with a 400 before
 * any write. Every name here lacked the `.v1` suffix, so sdk-audit refused the
 * entire LeadFlow audit trail — and because emitEvent swallows append failures
 * by design, that showed up only as log lines while the chain verified clean and
 * empty. The suffix is what lets a payload shape change later as a NEW version
 * instead of silently redefining rows already written under the old shape.
 *
 * These are a consuming application's own types, so they must be registered at
 * runtime via POST /api/events/types (tenant-scoped, additive). They must never
 * be added to the platform's EVENT_TYPE_REGISTRY constant, and must not reuse a
 * platform name.
 */
export const AUDIT_EVENTS = {
  CAPTURE_CREATED: 'capture.created.v1',
  CAPTURE_NORMALIZED: 'capture.normalized.v1',
  CAPTURE_PROMOTED: 'capture.promoted.v1',
  IMPORT_RUN_COMMITTED: 'import.run.committed.v1',
  IMPORT_RUN_ROLLED_BACK: 'import.run.rolled_back.v1',
  /** A run's register, lineage or completed-run report was read. */
  IMPORT_RUN_INSPECTED: 'import.run.inspected.v1',
  /**
   * The rights attestation and evidence bundle behind a run was read.
   *
   * A SEPARATE EVENT from `inspected`, deliberately. "Somebody looked at the
   * import queue" and "somebody read the attestation naming who swore this data
   * was lawfully obtained" are different disclosures, and an audit that spells
   * them the same way cannot answer the second question — which is the one a
   * complaint actually asks.
   */
  IMPORT_EVIDENCE_EXPORTED: 'import.evidence.exported.v1',
  /**
   * Somebody opened the steward queue and saw who might be whom.
   *
   * Recorded even though nothing was decided. A candidate link names two people
   * the system believes MIGHT be the same, next to the evidence for it — so the
   * queue discloses a probabilistic claim about real people to whoever opens it,
   * and that disclosure is the event, not the adjudication that may follow.
   * Kept distinct from `verified` for the same reason `import.run.inspected` is
   * distinct from `import.evidence.exported`: "who looked" and "who decided" are
   * different questions and an audit that spells them the same way can answer
   * neither.
   */
  IDENTITY_REVIEW_QUEUE_INSPECTED: 'identity.review_queue.inspected.v1',
  /**
   * The auto-link policy changed.
   *
   * A first-class event rather than a config note, because this decides what the
   * system may do to people's records with NOBODY watching. Every link made
   * afterwards was made under this rule, so the entry is what ties a later
   * complaint to the threshold in force at the time.
   */
  IDENTITY_RISK_PROFILE_CHANGED: 'identity.risk_profile.changed.v1',
  IDENTITY_LINK_VERIFIED: 'identity.link.verified.v1',
  IDENTITY_LINK_RETRACTED: 'identity.link.retracted.v1',
  CONSENT_RECEIPT_ISSUED: 'consent.receipt.issued.v1',
  CONSENT_RECEIPT_REVOKED: 'consent.receipt.revoked.v1',
  SUPPRESSION_APPLIED: 'suppression.applied.v1',
  ENRICHMENT_REQUESTED: 'enrichment.requested.v1',
  ENRICHMENT_SETTLED: 'enrichment.settled.v1',
  PII_REVEALED: 'pii.revealed.v1',
  RELATIONSHIP_ESTABLISHED: 'relationship.established.v1',
  RELATIONSHIP_ENDED: 'relationship.ended.v1',
  OFFER_VERSION_STAMPED: 'offer.version.stamped.v1',
  PAYMENT_VERIFIED: 'payment.verified.v1',
  HANDOFF_ACCEPTED: 'handoff.accepted.v1',
  SLA_BREACHED: 'sla.breached.v1',

  // Routing and assignment. Added because the ledger could describe what
  // happened TO a lead's data but not who decided who would work it — which is
  // the question asked first when a lead is missed, and the one the audit
  // timeline could not previously answer.
  LEAD_ROUTED: 'lead.routed.v1',
  LEAD_ASSIGNED: 'lead.assigned.v1',
  LEAD_BULK_ROUTED: 'lead.bulk_routed.v1',
  ROUTING_RULE_CREATED: 'routing.rule.created.v1',
  ROUTING_RULE_UPDATED: 'routing.rule.updated.v1',
  ROUTING_RULE_RETIRED: 'routing.rule.retired.v1',

  // SLA. `sla.breached` already recorded the OUTCOME; these record the human
  // acts around it. Separate names rather than one `sla.policy.changed` with a
  // verb in the metadata, because "when was this target last loosened" should be
  // answerable by querying an event name, not by parsing a payload.
  SLA_POLICY_CREATED: 'sla.policy.created.v1',
  SLA_POLICY_UPDATED: 'sla.policy.updated.v1',
  SLA_POLICY_RETIRED: 'sla.policy.retired.v1',
  SLA_FIRST_RESPONSE_RECORDED: 'sla.first_response.recorded.v1',
  SLA_SWEEP_RUN: 'sla.sweep.run.v1',
  SLA_ALERT_ACKNOWLEDGED: 'sla.alert.acknowledged.v1',
  SLA_ALERT_DISPATCHED: 'sla.alert.dispatched.v1',

  // AI agent modules. The SOP allows AI to suggest and requires a qualified
  // human to review consequential outputs, so the ledger must be able to
  // separate the two: `ai.draft.proposed` is a machine act and
  // `ai.draft.accepted` is a person taking responsibility for it. One combined
  // name would make the only question anybody asks after a bad send — did a
  // human read this — unanswerable.
  AI_DRAFT_PROPOSED: 'ai.draft.proposed.v1',
  AI_DRAFT_ACCEPTED: 'ai.draft.accepted.v1',
  // Recorded per proposal, naming the sources used. "Where did this claim about
  // the prospect come from" is asked about a specific draft, months later.
  AI_RESEARCH_PERFORMED: 'ai.research.performed.v1',
  AI_CALL_REGISTERED: 'ai.call.registered.v1',
  AI_COACH_SCORED: 'ai.coach.scored.v1',
  // A refusal is an event too. An absent entry cannot distinguish "we declined
  // to process this call" from "nobody ever asked", and only the first is
  // evidence that the consent gate is doing its job.
  AI_COACH_REFUSED_NO_CONSENT: 'ai.coach.refused_no_consent.v1',

  // The AI foundation. `ai.draft.*` above names a DRAFT specifically, which was
  // right while the only consequential output was a message; the review gate
  // accepts scores, summaries, next actions and offer-term changes too, so it
  // needs names that are not about drafts. It also names the REJECTION, which
  // the draft pair never did — and "how often does a human turn the machine
  // down" is the single most useful number about an AI feature.
  AI_PROPOSAL_PROPOSED: 'ai.proposal.proposed.v1',
  AI_PROPOSAL_DECIDED: 'ai.proposal.decided.v1',
  AI_RUN_STARTED: 'ai.run.started.v1',
  // The scope an agent was granted, recorded so it outlives the token. A token
  // expires in fifteen minutes; "what was this agent allowed to touch" is asked
  // months later.
  AI_CAPABILITY_TOKEN_ISSUED: 'ai.capability_token.issued.v1',
  AI_CAPABILITY_TOKEN_REVOKED: 'ai.capability_token.revoked.v1',
  // Pulling the switch is itself a governed act, and the entry carries how many
  // runs it caught. An emergency stop nobody can reconstruct afterwards leaves
  // the review with no answer to "what was running when we pulled it".
  AI_KILL_SWITCH_ENGAGED: 'ai.kill_switch.engaged.v1',

  // The AI Manager, RevOps and Marketing modules. Two names rather than one
  // `ai.analysis.run`, because the two answer different questions and get asked
  // about separately: `ai.risk.predicted` is read when somebody wants to know
  // who was watching the team's queue, and `ai.revops.analysed` when somebody
  // asks where a routing proposal came from. One combined name would make both
  // queries return the other's rows.
  AI_RISK_PREDICTED: 'ai.risk.predicted.v1',
  AI_REVOPS_ANALYSED: 'ai.revops.analysed.v1',

  // Conversation intelligence. The eligibility CHECK is recorded separately
  // from the recording's own custody chain, because it is the one event that
  // happens when there is no recording to attach it to — and a check that
  // blocked a call leaves no other trace anywhere.
  RECORDING_ELIGIBILITY_CHECKED: 'recording.eligibility.checked.v1',
  // Reading a recording's intelligence. Named because "who listened to this
  // call" is the question asked first when somebody complains, and the answer
  // must live in the tamper-evident chain rather than only in a server log.
  RECORDING_ACCESSED: 'recording.accessed.v1',
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
