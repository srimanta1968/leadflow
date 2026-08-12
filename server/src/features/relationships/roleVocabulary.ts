/**
 * The six contextual roles, and why they are six rather than one.
 *
 * THE MOCKUP'S FRAMING LINE IS THE MODEL: roles are bitemporal relationship
 * contracts, and ownership, occupancy, management and decision authority remain
 * DISTINCT. A person can own a property they do not live in, live in one they do
 * not own, and be the decision maker for a third they have never seen. Those are
 * different authorities with different evidence and different lifespans, and
 * collapsing them into one "related to" edge forces a choice nobody should have
 * to make: lose the distinction, or overwrite a role that is still true.
 *
 * WHAT THE ROLE GRANTS IS NOT ENCODED HERE. This file names the vocabulary; the
 * policy bundle decides what each authority permits. Putting permissions on the
 * role would put two systems in charge of the same question, and the one that
 * lost would be the one anybody audits.
 */

/** The six roles LeadFlow understands. Anything else is refused at the edge. */
export const ROLES = [
  'OWNS',
  'OCCUPIES',
  'DECISION_MAKER',
  'AUTHORIZED_FOR',
  'REPRESENTS',
  'REFERRAL_SOURCE',
] as const;

export type Role = (typeof ROLES)[number];

/**
 * How sure we are the role is real, in sdk-rebac's own vocabulary.
 *
 * COPIED, NOT CHOSEN. These are `TRUST_STATES` from sdk-rebac's
 * contextualRoleService, and inventing a fourth locally would mean the screen
 * calls a role something the service that stores it has never heard of.
 */
export const TRUST_STATES = ['CANDIDATE', 'CONFIRMED', 'DOCUMENTED'] as const;

export type TrustState = (typeof TRUST_STATES)[number];

/**
 * The states whose whole meaning is "somebody checked".
 *
 * So they must say WHAT they checked. A CONFIRMED role with nothing behind it
 * reads as verified to every downstream reader while resting on nothing — worse
 * than an honest CANDIDATE, because nobody will ever question it again.
 * CANDIDATE requires no evidence by design: it is the state that says we have
 * not checked.
 */
export const EVIDENCE_REQUIRED_STATES: readonly TrustState[] = ['CONFIRMED', 'DOCUMENTED'];

export function requiresEvidence(trustState: TrustState): boolean {
  return EVIDENCE_REQUIRED_STATES.includes(trustState);
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function isTrustState(value: string): value is TrustState {
  return (TRUST_STATES as readonly string[]).includes(value);
}

/**
 * What each role means, in the words the screen uses.
 *
 * Held here rather than in the client so the API docs QA reads and the chip the
 * operator sees carry the same sentence — a role whose meaning is described in
 * two places is a role two teams will describe differently.
 */
export const ROLE_MEANING: Record<Role, string> = {
  OWNS: 'Holds title to the property. Says nothing about who lives there.',
  OCCUPIES: 'Lives at or operates from the property. Says nothing about who owns it.',
  DECISION_MAKER: 'Authorised to decide about work on the property, whether or not they own or occupy it.',
  AUTHORIZED_FOR: 'An organisation acting for the owner under a documented agreement.',
  REPRESENTS: 'Speaks for another party in this matter, such as an agent or a family member.',
  REFERRAL_SOURCE: 'Introduced this contact. Carries no authority over the property at all.',
};

/**
 * The traversal budget a reachability check runs under.
 *
 * MIRRORED FROM sdk-rebac's DEFAULT_BUDGET rather than invented: depth 4, visits
 * 1024. An unbounded walk over a cyclic relationship graph is not slow, it is
 * NON-TERMINATING, and the cap is what turns "we could not find a path" into a
 * statement with a defined meaning. A caller may narrow it; a caller may not
 * widen it past the platform cap, because a deny returned under a budget the
 * platform never honoured would be read as a stronger claim than was checked.
 */
export const MAX_DEPTH_CAP = 4;
export const MAX_VISIT_CAP = 1024;
export const DEFAULT_BUDGET = { depth_cap: MAX_DEPTH_CAP, visit_cap: MAX_VISIT_CAP };
