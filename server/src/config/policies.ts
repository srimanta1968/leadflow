import { ROLE_DEFINITIONS, PERMISSIONS } from './roles';

/**
 * The ABAC bundle — SOP §28's permission matrix as evaluable rules.
 *
 * DERIVED FROM `roles.ts`, NOT RETYPED. The role file already states who may do
 * what unaided and what needs a second party, so restating it here would create
 * two permission models that agree until the day someone edits one. The rules
 * below add only what a role list cannot express: conditions on the RESOURCE and
 * the obligations a permit carries.
 *
 * Three effects, not two. `requires_approval` exists because §28's wording is
 * "cannot do without approval" — an escalation path, not a prohibition.
 * Collapsing it into deny would make the product unable to offer the very
 * workflow the business runs on, and would train people to work around it.
 */

/** What the PDP concluded. */
export type PolicyEffect = 'permit' | 'deny' | 'requires_approval';

/** A condition attached to a permit that the caller must satisfy. */
export interface PolicyObligation {
  /** Machine-readable obligation type. */
  type: 'second_party_approval' | 'audit_purpose' | 'own_record_only' | 'business_unit_scope';
  /** What the caller has to supply or respect. */
  detail: string;
}

/** One rule in the bundle. */
export interface PolicyRule {
  /** Permission this rule governs. */
  action: string;
  /** Role keys the rule applies to. Empty means every role. */
  roles: string[];
  effect: PolicyEffect;
  /** Why, in the SOP's own terms — surfaced to the caller on a refusal. */
  reason: string;
  obligations?: PolicyObligation[];
}

/**
 * Rules that OVERRIDE the plain role grants.
 *
 * Deliberately short. Anything expressible as "this role may do this" already
 * lives in `roles.ts`; a rule earns its place here only by adding a condition or
 * an obligation. A bundle that restates the role file is a bundle nobody can
 * audit.
 */
export const POLICY_OVERRIDES: PolicyRule[] = [
  {
    action: PERMISSIONS.LEAD_WORK_ASSIGNED,
    roles: ['sales_rep', 'backup_rep'],
    effect: 'permit',
    reason: 'SOP §28: a Rep works ASSIGNED leads.',
    obligations: [
      {
        type: 'own_record_only',
        // The word "assigned" is the whole constraint, and a role grant cannot
        // carry it: without this a Rep holding lead.work_assigned could work
        // every lead in the tenant.
        detail: 'Caller must be the owner or the named backup on the lead.',
      },
    ],
  },
  {
    action: PERMISSIONS.LEAD_REASSIGN,
    roles: ['sales_manager'],
    effect: 'permit',
    reason: 'SOP §28: a Manager may reassign.',
    obligations: [
      {
        type: 'business_unit_scope',
        detail: 'Lead must belong to a business unit the manager is scoped to.',
      },
    ],
  },
  {
    action: PERMISSIONS.SLA_ALERT_ACKNOWLEDGE,
    roles: ['sales_rep', 'backup_rep', 'sales_manager'],
    effect: 'permit',
    reason: 'An escalation is cleared by the person it was raised against.',
    obligations: [
      {
        type: 'own_record_only',
        // Without this the grant reads "may acknowledge alerts" full stop, and
        // one manager could quietly clear another's escalation — which is not a
        // permission question but a way to make a breach disappear.
        detail: 'Caller may acknowledge only alerts addressed to them.',
      },
    ],
  },
  {
    action: PERMISSIONS.SUPPRESSION_OVERRIDE,
    roles: ['privacy_officer'],
    effect: 'permit',
    reason:
      'Honouring and lifting a suppression is the Privacy Officer\'s own duty, not an exception to it.',
    obligations: [
      {
        type: 'audit_purpose',
        detail: 'A purpose must be recorded with the override.',
      },
    ],
  },
  {
    action: PERMISSIONS.AUDIT_DELETE_EVENT,
    roles: [],
    effect: 'deny',
    // The one hard DENY in the bundle. Every other restriction is an approval
    // gate; this is not, because an audit trail a sufficiently senior person can
    // erase is not an audit trail. Approval cannot rescue it — the approver
    // would be recorded in the very log being deleted.
    reason: 'Audit events are immutable. No role may delete one, with or without approval.',
  },
  {
    action: PERMISSIONS.ERASURE_EXECUTE,
    roles: ['privacy_officer'],
    effect: 'permit',
    reason: 'SOP: erasure is the Privacy Officer\'s duty under a data-subject request.',
    obligations: [
      {
        type: 'audit_purpose',
        // Erasing the person does not erase the fact that they asked.
        detail: 'A DSAR reference must be recorded; the erasure event itself is retained.',
      },
    ],
  },
  {
    action: PERMISSIONS.IMPORT_COMMIT,
    roles: ['data_steward'],
    effect: 'permit',
    reason: 'SOP: a governed import is committed by the Data Steward.',
    obligations: [
      {
        type: 'audit_purpose',
        detail: 'A signed rights attestation must accompany the commit.',
      },
    ],
  },
];

/**
 * The bundle as sdk-policy receives it.
 *
 * Built from the role definitions plus the overrides above, so registration
 * cannot drift from what the app evaluates locally.
 */
export function buildPolicyBundle(): {
  name: string;
  version: string;
  rules: PolicyRule[];
} {
  const fromRoles: PolicyRule[] = [];

  for (const role of ROLE_DEFINITIONS) {
    for (const action of role.canDo) {
      fromRoles.push({
        action,
        roles: [role.key],
        effect: 'permit',
        reason: `${role.label} may ${action} unaided (${role.sopBasis.split('.')[0]}).`,
      });
    }
    for (const action of role.requiresApproval) {
      fromRoles.push({
        action,
        roles: [role.key],
        effect: 'requires_approval',
        reason: `SOP §28: ${role.label} may not ${action} without approval.`,
        obligations: [
          {
            type: 'second_party_approval',
            detail: 'A second party holding the approving role must sign off.',
          },
        ],
      });
    }
  }

  return {
    name: 'leadflow-sop-28',
    // Bumped by hand when the matrix changes, so a tenant can be asked which
    // version it is enforcing. A content hash would change on a comment edit.
    version: '1.0.0',
    // Overrides FIRST, because the engine takes the FIRST match: a rule that
    // carries a resource condition or an obligation has to beat the plain role
    // grant it refines. Put them last and every override would be shadowed by
    // the generic permit — the bundle would look right and enforce nothing.
    rules: [...POLICY_OVERRIDES, ...fromRoles],
  };
}
