import { randomUUID } from 'crypto';
import { buildPolicyBundle, PolicyEffect, PolicyObligation } from '../../config/policies';
import { allGrantedPermissions } from '../../config/roles';

/** One action a caller wants a verdict on. */
export interface PolicyRequest {
  action: string;
  resourceType: string;
  resourceId?: string;
}

/** The PDP's answer for one action. */
export interface PolicyDecision {
  action: string;
  effect: PolicyEffect;
  /** Why, in the SOP's terms. Shown to the caller on anything but a permit. */
  reason: string;
  /** Conditions a permit is contingent on. A permit with unmet obligations is not a permit. */
  obligations: PolicyObligation[];
  /**
   * Stable id for this decision.
   *
   * Quoted by the caller on the mutating request it authorises, so a write and
   * the authorisation that allowed it can be joined afterwards. Without it an
   * audit can say a change happened and cannot say what permitted it.
   */
  decisionRef: string;
}

/** Every action the vocabulary knows. Anything else is a caller error, not a deny. */
export function isKnownAction(action: string): boolean {
  return allGrantedPermissions().includes(action) || knownRestrictedActions().includes(action);
}

/**
 * Actions that appear only in a `requiresApproval` or override list.
 *
 * They are real actions with real rules, but no role holds them unaided, so
 * `allGrantedPermissions()` alone would report them unknown — and rejecting
 * `offer.change_terms` as a typo would be exactly wrong.
 */
function knownRestrictedActions(): string[] {
  return [...new Set(buildPolicyBundle().rules.map((rule) => rule.action))];
}

/**
 * Evaluate one action for a caller holding `roles`.
 *
 * FIRST MATCH WINS, and the bundle puts overrides ahead of plain role grants so
 * a conditional rule beats the general one it refines.
 *
 * DEFAULT DENY. An action no rule mentions is refused, not allowed: a permission
 * model that fails open turns every future action into an accidental grant the
 * moment someone forgets to write its rule.
 */
export function evaluate(request: PolicyRequest, roles: string[]): PolicyDecision {
  const bundle = buildPolicyBundle();

  const match = bundle.rules.find(
    (rule) =>
      rule.action === request.action &&
      (rule.roles.length === 0 || rule.roles.some((role) => roles.includes(role)))
  );

  if (!match) {
    return {
      action: request.action,
      effect: 'deny',
      reason: 'No policy grants this action to the caller\'s roles.',
      obligations: [],
      decisionRef: newDecisionRef(),
    };
  }

  return {
    action: request.action,
    effect: match.effect,
    reason: match.reason,
    obligations: match.obligations ?? [],
    decisionRef: newDecisionRef(),
  };
}

/** Evaluate a whole screen's action set, preserving order. */
export function evaluateBatch(requests: PolicyRequest[], roles: string[]): PolicyDecision[] {
  // Order preserved so a caller can zip requests to decisions positionally
  // rather than matching on the action string, which would break the moment a
  // screen asks about the same action against two resources.
  return requests.map((request) => evaluate(request, roles));
}

/**
 * A decision reference.
 *
 * Random rather than derived from the request: two identical requests are two
 * separate authorisations, made at different moments and possibly under
 * different role assignments, and collapsing them would let one audit entry
 * appear to justify a second write it never saw.
 */
function newDecisionRef(): string {
  return `pdp_${randomUUID()}`;
}

/** True when a decision permits the write outright, with nothing outstanding. */
export function isUnconditionalPermit(decision: PolicyDecision): boolean {
  return decision.effect === 'permit' && decision.obligations.length === 0;
}
