import { ROLE_DEFINITIONS, roleByKey, allGrantedPermissions } from '../../config/roles';
import { buildPolicyBundle } from '../../config/policies';
import { evaluate, PolicyDecision } from '../../platform/policy/policyEngine';
import { assignableLocalRoles, sopRolesForLocalRole } from '../../platform/policy/governed';

/**
 * What a local role MEANS, in the terms the person granting it thinks in.
 *
 * THE PROBLEM THIS SOLVES IS NAMED IN THE TASK: "steward" tells an operator
 * nothing, and "can promote a source record and review identity merges" tells
 * them everything. `users.role` stores five short words; the authority those
 * words carry lives two files away, in the SOP role definitions the local value
 * bridges to. A picker that shows only the five words asks an administrator to
 * grant an authority the product has declined to describe.
 *
 * EVERYTHING HERE IS DERIVED. The local values come from the bridge in
 * governed.ts, the SOP roles from config/roles.ts, and the verdicts from the
 * same PDP the enforcement path calls. Nothing in this file is a written-down
 * copy of any of them, because a copy is a second permission model that agrees
 * with the first until somebody edits one — and this one would be the copy an
 * administrator READS while the other is the one that RUNS.
 */

/** One SOP actor a local role speaks for. */
export interface SopRoleSummary {
  key: string;
  label: string;
  purpose: string;
  /** Permissions held unaided, as `<object>.<action>` strings. */
  can_do: string[];
  /** Permissions open to the role only with a second party. */
  requires_approval: string[];
  sop_basis: string;
}

/** One assignable `users.role` value, with the authority it confers. */
export interface LocalRoleSummary {
  /** The value written into `users.role`. */
  key: string;
  /** The SOP actors this value bridges to. */
  sop_roles: SopRoleSummary[];
  /**
   * The union of what the holder may do unaided.
   *
   * A UNION, because a local value can bridge to several actors and the holder
   * gets all of them — `admin` is four SOP roles at once. Presenting them per
   * actor and leaving the reader to union them by eye is how somebody concludes
   * that `admin` cannot work a lead.
   */
  can_do: string[];
  /** The union of what the holder may do only with approval, minus anything already unaided. */
  requires_approval: string[];
  /** True when the bridge does not recognise the value — it grants nothing at all. */
  grants_nothing: boolean;
}

/** Build the summary for one SOP role key. */
function summariseSopRole(key: string): SopRoleSummary | null {
  const role = roleByKey(key);
  if (!role) {
    return null;
  }
  return {
    key: role.key,
    label: role.label,
    purpose: role.purpose,
    can_do: [...role.canDo],
    requires_approval: [...role.requiresApproval],
    sop_basis: role.sopBasis,
  };
}

/**
 * Every value an administrator may write into `users.role`.
 *
 * Sorted by breadth of authority, widest first, so the picker reads as a ladder
 * rather than as whatever order an object literal happened to be typed in.
 */
export function localRoleCatalogue(): LocalRoleSummary[] {
  const summaries = assignableLocalRoles().map((local): LocalRoleSummary => {
    const sopRoles = sopRolesForLocalRole(local)
      .map(summariseSopRole)
      .filter((entry): entry is SopRoleSummary => entry !== null);

    const canDo = [...new Set(sopRoles.flatMap((entry) => entry.can_do))].sort();
    const requiresApproval = [...new Set(sopRoles.flatMap((entry) => entry.requires_approval))]
      // An action one of the holder's roles may take UNAIDED is not an action
      // they need approval for. Without this subtraction `admin` would be shown
      // as needing sign-off for `automation.publish`, which RevOps holds
      // outright — the union of roles is a union of authority, never a
      // narrowing of it, and the policy engine already resolves it that way.
      .filter((action) => !canDo.includes(action))
      .sort();

    return {
      key: local,
      sop_roles: sopRoles,
      can_do: canDo,
      requires_approval: requiresApproval,
      grants_nothing: sopRoles.length === 0,
    };
  });

  return summaries.sort((a, b) => b.can_do.length - a.can_do.length || a.key.localeCompare(b.key));
}

/** Whether a value may be written to `users.role`. */
export function isAssignableLocalRole(value: string): boolean {
  return assignableLocalRoles().includes(value);
}

/** Every action the policy bundle can be asked about, deduplicated and ordered. */
export function allPolicyActions(): string[] {
  const fromRoles = allGrantedPermissions();
  const fromBundle = buildPolicyBundle().rules.map((rule) => rule.action);
  return [...new Set([...fromRoles, ...fromBundle])].sort();
}

/** One SOP role's row in the permission matrix, as the PDP decided it. */
export interface MatrixRow {
  role_key: string;
  role_label: string;
  decisions: {
    action: string;
    effect: PolicyDecision['effect'];
    reason: string;
    obligations: PolicyDecision['obligations'];
    decision_ref: string;
  }[];
}

/**
 * The permission matrix, evaluated rather than described.
 *
 * ONE `evaluate` CALL PER (role, action), through the SAME function that decides
 * whether a request is allowed to proceed. The alternative — reading
 * ROLE_DEFINITIONS and rendering its two arrays — would produce a grid that
 * ignores POLICY_OVERRIDES entirely, so `audit.delete_event` would appear
 * available to Leadership with approval when the bundle denies it to everyone
 * unconditionally. A matrix that disagrees with the enforcement on the one rule
 * that has no escalation path is worse than no matrix.
 */
export function permissionMatrix(): MatrixRow[] {
  const actions = allPolicyActions();

  return ROLE_DEFINITIONS.map((role) => ({
    role_key: role.key,
    role_label: role.label,
    decisions: actions
      .map((action) => evaluate({ action, resourceType: 'permission_matrix' }, [role.key]))
      // Denials are dropped from the row, not rendered as blanks. The matrix
      // lists what a role HOLDS beside what it must escalate; with forty-odd
      // actions and a handful held per role, keeping the denials would make the
      // grid a wall of empty cells that hides the few that matter.
      .filter((decision) => decision.effect !== 'deny')
      .map((decision) => ({
        action: decision.action,
        effect: decision.effect,
        reason: decision.reason,
        obligations: decision.obligations,
        decision_ref: decision.decisionRef,
      })),
  }));
}
