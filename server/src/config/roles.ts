/**
 * The nine LeadFlow actors — the ONLY place a role is defined.
 *
 * Adding, renaming or re-scoping a role is an edit to this file and nothing
 * else. The provisioner iterates whatever is here, so there is no switch
 * statement, no per-role function and no second list to keep in step. That is
 * the whole acceptance condition for this task, and it is worth protecting: the
 * moment a role needs a code change, the next person adds one quietly in a
 * handler and the permission model stops being reviewable in one sitting.
 *
 * PROVENANCE. Every entry traces to SOP §28's ROLE PERMISSIONS table, which
 * speaks in four groups — Rep, Manager, RevOps, and "Leadership / Product /
 * Finance / CS". LeadFlow needs nine actors, so several are elaborations rather
 * than direct quotations, and each says which it is in `sopBasis`. Where the SOP
 * is silent the entry says so instead of inventing authority: a fabricated
 * permission is indistinguishable from a real one once it is in the file.
 *
 * The two lists are deliberately asymmetric. `canDo` is what the role may do
 * unaided; `requiresApproval` is what it may do WITH a second party — not what
 * it is forbidden. The SOP wording is "cannot do without approval", and
 * flattening that into a denial would remove the escalation path the business
 * actually runs on.
 */

/** One actor, as provisioned into sdk-persona and sdk-rebac. */
export interface RoleDefinition {
  /**
   * Stable machine key. Becomes the sdk-persona role label and the sdk-rebac
   * template name, so it must never change once provisioned — a rename creates
   * a SECOND template and silently strands everyone holding the old one.
   */
  key: string;
  /** Human label for the permission matrix screen. */
  label: string;
  /** One line on why this actor exists. */
  purpose: string;
  /** Permissions granted outright, as sdk-rebac permission strings. */
  canDo: string[];
  /** Actions permitted only with a second party's approval. */
  requiresApproval: string[];
  /** Which SOP §28 group this derives from, and how directly. */
  sopBasis: string;
}

/**
 * Permission vocabulary, as `<object>.<action>` strings.
 *
 * Named constants rather than loose strings so a typo is a compile error
 * instead of a permission that silently never matches — the failure mode being
 * a role that appears provisioned and grants nothing.
 */
export const PERMISSIONS = {
  LEAD_WORK_ASSIGNED: 'lead.work_assigned',
  LEAD_REASSIGN: 'lead.reassign',
  LEAD_BULK_EXPORT: 'lead.bulk_export',
  MESSAGE_SEND_APPROVED: 'message.send_approved',
  MESSAGE_PUBLISH_TEMPLATE: 'message.publish_template',
  STAGE_UPDATE: 'stage.update',
  NEXT_ACTION_CREATE: 'next_action.create',
  MEETING_BOOK: 'meeting.book',
  OFFER_CHANGE_TERMS: 'offer.change_terms',
  AUDIT_DELETE_EVENT: 'audit.delete_event',
  SUPPRESSION_OVERRIDE: 'suppression.override',
  EXCEPTION_APPROVE: 'exception.approve',
  CALL_REVIEW: 'call.review',
  DASHBOARD_VIEW_TEAM: 'dashboard.view_team',
  RECORD_RETURN_INCOMPLETE: 'record.return_incomplete',
  COMPLIANCE_RULE_CHANGE: 'compliance.rule_change',
  PAYMENT_STATE_CHANGE: 'payment.state_change',
  AUTOMATION_PUBLISH: 'automation.publish',
  ROUTING_CONFIGURE: 'routing.configure',
  DATA_CONFIGURE: 'data.configure',
  INTEGRATION_CONFIGURE: 'integration.configure',
  RECONCILIATION_RUN: 'reconciliation.run',
  PRODUCT_CLAIM_APPROVE: 'product_claim.approve',
  COMMERCIAL_EXCEPTION_APPROVE: 'commercial_exception.approve',
  LEGAL_POLICY_APPROVE: 'legal_policy.approve',
  ESCALATION_RECEIVE: 'escalation.receive',
  HANDOFF_ACCEPT: 'handoff.accept',
  HANDOFF_BYPASS: 'handoff.bypass',
  ONBOARDING_MANAGE: 'onboarding.manage',
  IDENTITY_MERGE_REVIEW: 'identity.merge_review',
  SOURCE_RECORD_PROMOTE: 'source_record.promote',
  IMPORT_COMMIT: 'import.commit',
  IMPORT_ROLLBACK: 'import.rollback',
  CONSENT_PURPOSE_MANAGE: 'consent.purpose_manage',
  DSAR_FULFIL: 'dsar.fulfil',
  ERASURE_EXECUTE: 'erasure.execute',
  CAMPAIGN_CONFIGURE: 'campaign.configure',
} as const;

/**
 * The nine actors, in the order the SOP introduces them.
 *
 * ORDER IS NOT PRECEDENCE. Nothing reads this list positionally; a role's
 * authority is exactly its two permission lists. Anyone tempted to add "the
 * later entry wins" logic should add an explicit field instead.
 */
export const ROLE_DEFINITIONS: RoleDefinition[] = [
  {
    key: 'sales_rep',
    label: 'Sales Rep / SDR',
    purpose: 'Works assigned leads and owns the next action on each.',
    canDo: [
      PERMISSIONS.LEAD_WORK_ASSIGNED,
      PERMISSIONS.MESSAGE_SEND_APPROVED,
      PERMISSIONS.STAGE_UPDATE,
      PERMISSIONS.NEXT_ACTION_CREATE,
      PERMISSIONS.MEETING_BOOK,
    ],
    requiresApproval: [
      PERMISSIONS.OFFER_CHANGE_TERMS,
      PERMISSIONS.AUDIT_DELETE_EVENT,
      PERMISSIONS.SUPPRESSION_OVERRIDE,
      PERMISSIONS.LEAD_BULK_EXPORT,
      PERMISSIONS.MESSAGE_PUBLISH_TEMPLATE,
    ],
    sopBasis: 'SOP §28 "Rep" row, quoted directly on both sides.',
  },
  {
    key: 'backup_rep',
    label: 'Backup Rep',
    purpose: 'Named second owner who carries a lead when the owner cannot.',
    canDo: [
      PERMISSIONS.LEAD_WORK_ASSIGNED,
      PERMISSIONS.MESSAGE_SEND_APPROVED,
      PERMISSIONS.STAGE_UPDATE,
      PERMISSIONS.NEXT_ACTION_CREATE,
      PERMISSIONS.MEETING_BOOK,
    ],
    requiresApproval: [
      PERMISSIONS.OFFER_CHANGE_TERMS,
      PERMISSIONS.AUDIT_DELETE_EVENT,
      PERMISSIONS.SUPPRESSION_OVERRIDE,
      PERMISSIONS.LEAD_BULK_EXPORT,
      PERMISSIONS.MESSAGE_PUBLISH_TEMPLATE,
    ],
    sopBasis:
      'ELABORATION. §28 has no Backup row; the save gate requires "owner + backup" on every open record, so the backup must be able to do everything the owner can — a backup who cannot act is not cover. Identical to sales_rep by design: if these two ever diverge, the divergence is the bug.',
  },
  {
    key: 'sales_manager',
    label: 'Sales Manager',
    purpose: 'Owns the team queue, approves exceptions and returns incomplete work.',
    canDo: [
      PERMISSIONS.LEAD_REASSIGN,
      PERMISSIONS.EXCEPTION_APPROVE,
      PERMISSIONS.CALL_REVIEW,
      PERMISSIONS.DASHBOARD_VIEW_TEAM,
      PERMISSIONS.RECORD_RETURN_INCOMPLETE,
    ],
    requiresApproval: [
      PERMISSIONS.COMPLIANCE_RULE_CHANGE,
      PERMISSIONS.PAYMENT_STATE_CHANGE,
      PERMISSIONS.AUTOMATION_PUBLISH,
    ],
    sopBasis:
      'SOP §28 "Manager" row. The SOP says these three may not be changed "alone", which is an approval requirement rather than a prohibition.',
  },
  {
    key: 'revenue_operations',
    label: 'Revenue Operations',
    purpose: 'Configures the machine: data, routing, automation, integrations, reconciliation.',
    canDo: [
      PERMISSIONS.DATA_CONFIGURE,
      PERMISSIONS.ROUTING_CONFIGURE,
      PERMISSIONS.AUTOMATION_PUBLISH,
      PERMISSIONS.MESSAGE_PUBLISH_TEMPLATE,
      PERMISSIONS.DASHBOARD_VIEW_TEAM,
      PERMISSIONS.INTEGRATION_CONFIGURE,
      PERMISSIONS.RECONCILIATION_RUN,
    ],
    requiresApproval: [
      PERMISSIONS.PRODUCT_CLAIM_APPROVE,
      PERMISSIONS.COMMERCIAL_EXCEPTION_APPROVE,
      PERMISSIONS.LEGAL_POLICY_APPROVE,
    ],
    sopBasis: 'SOP §28 "RevOps" row, quoted directly on both sides.',
  },
  {
    key: 'leadership',
    label: 'Leadership',
    purpose: 'Approves its controlled areas and receives defined escalations.',
    canDo: [
      PERMISSIONS.ESCALATION_RECEIVE,
      PERMISSIONS.DASHBOARD_VIEW_TEAM,
      PERMISSIONS.COMMERCIAL_EXCEPTION_APPROVE,
      PERMISSIONS.PRODUCT_CLAIM_APPROVE,
    ],
    requiresApproval: [PERMISSIONS.HANDOFF_BYPASS, PERMISSIONS.AUDIT_DELETE_EVENT],
    sopBasis:
      'SOP §28 "Leadership / Product / Finance / CS" row, narrowed to Leadership. The SOP forbids editing "unrelated operational evidence", which is scoping rather than a permission — enforced by the ABAC policy bundle, not expressible as a role grant.',
  },
  {
    key: 'client_success',
    label: 'Client Success / Onboarding',
    purpose: 'Accepts the handoff at Closed Won and owns delivery continuity.',
    canDo: [
      PERMISSIONS.HANDOFF_ACCEPT,
      PERMISSIONS.ONBOARDING_MANAGE,
      PERMISSIONS.MEETING_BOOK,
      PERMISSIONS.NEXT_ACTION_CREATE,
      PERMISSIONS.ESCALATION_RECEIVE,
    ],
    requiresApproval: [PERMISSIONS.HANDOFF_BYPASS, PERMISSIONS.PAYMENT_STATE_CHANGE],
    sopBasis:
      'SOP §28 "…/ CS" plus the §28 save gate: Closed Won stays nonterminal until onboarding is ACCEPTED and calendarized, so accepting the handoff is this role\'s defining act.',
  },
  {
    key: 'data_steward',
    label: 'Data Steward',
    purpose: 'Adjudicates identity merges, promotions and governed imports.',
    canDo: [
      PERMISSIONS.IDENTITY_MERGE_REVIEW,
      PERMISSIONS.SOURCE_RECORD_PROMOTE,
      PERMISSIONS.IMPORT_COMMIT,
      PERMISSIONS.IMPORT_ROLLBACK,
      PERMISSIONS.DATA_CONFIGURE,
    ],
    requiresApproval: [PERMISSIONS.LEAD_BULK_EXPORT, PERMISSIONS.AUDIT_DELETE_EVENT],
    sopBasis:
      'ELABORATION. §28 names no steward, but its "Source Event — immutable proof of why the record exists" object needs an adjudicator, and the trust ladder requires a human decision to promote a candidate to linked. Grants are scoped to that adjudication only.',
  },
  {
    key: 'privacy_officer',
    label: 'Privacy Officer',
    purpose: 'Owns consent purposes, DSAR fulfilment and erasure.',
    canDo: [
      PERMISSIONS.CONSENT_PURPOSE_MANAGE,
      PERMISSIONS.DSAR_FULFIL,
      PERMISSIONS.ERASURE_EXECUTE,
      PERMISSIONS.SUPPRESSION_OVERRIDE,
      PERMISSIONS.LEGAL_POLICY_APPROVE,
      PERMISSIONS.COMPLIANCE_RULE_CHANGE,
    ],
    requiresApproval: [PERMISSIONS.AUDIT_DELETE_EVENT],
    sopBasis:
      'ELABORATION from §28\'s "Consent / Suppression" object. This is the ONE role that may override suppression unaided — every other role needs approval for it — because honouring a revocation is its job rather than an exception to it. Note it still cannot delete an audit event unaided: the record of a privacy action must outlive the person taking it.',
  },
  {
    key: 'marketing_ops',
    label: 'Marketing Ops',
    purpose: 'Owns source adapters, campaign wiring and template publication.',
    canDo: [
      PERMISSIONS.CAMPAIGN_CONFIGURE,
      PERMISSIONS.INTEGRATION_CONFIGURE,
      PERMISSIONS.MESSAGE_PUBLISH_TEMPLATE,
      PERMISSIONS.DASHBOARD_VIEW_TEAM,
    ],
    requiresApproval: [
      PERMISSIONS.SUPPRESSION_OVERRIDE,
      PERMISSIONS.LEAD_BULK_EXPORT,
      PERMISSIONS.PRODUCT_CLAIM_APPROVE,
    ],
    sopBasis:
      'ELABORATION. §29 repeatedly names "RevOps + Marketing" as the failure-queue owner for every inbound source adapter, which is a distinct standing duty from RevOps.',
  },
];

/** Look up one role by key. */
export function roleByKey(key: string): RoleDefinition | undefined {
  return ROLE_DEFINITIONS.find((role) => role.key === key);
}

/**
 * Every permission any role can exercise unaided.
 *
 * Derived, never hand-maintained — a second hand-written list is a second thing
 * to forget.
 */
export function allGrantedPermissions(): string[] {
  return [...new Set(ROLE_DEFINITIONS.flatMap((role) => role.canDo))].sort();
}

/** Whether a role may take an action without a second party. */
export function canDoUnaided(roleKey: string, permission: string): boolean {
  return roleByKey(roleKey)?.canDo.includes(permission) ?? false;
}

/** Whether an action is open to a role but gated behind approval. */
export function needsApproval(roleKey: string, permission: string): boolean {
  return roleByKey(roleKey)?.requiresApproval.includes(permission) ?? false;
}
