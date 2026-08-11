/**
 * The four capabilities the Enrichment screen names, in outcome language.
 *
 * WHY THIS LIVES ON THE SERVER RATHER THAN IN THE CLIENT'S content/ FOLDER.
 * `description` is presentational and could sit either side, but the two caveats
 * are not: "this does not create consent" and "a returned value needs human
 * confirmation" are governance claims about what the product will and will not
 * do with the answer. A claim of that kind belongs with the governed surface
 * that makes it, so it appears in the audited response and in the API docs QA
 * reads, rather than only in a React file nobody outside the frontend opens.
 *
 * THE CATALOG IS UPSTREAM'S, NOT OURS. Price and outcome label always come from
 * sdk-data-credits when it answers, because a tenant can hold a negotiated price
 * and a hard-coded number would quietly misquote them. What is fixed here is the
 * SET of four keys the screen shows and the prose around each — so a capability
 * the tenant is not entitled to still renders, marked unoffered.
 *
 * WHY AN UNOFFERED CARD IS SHOWN RATHER THAN DROPPED. A missing card reads as
 * "not a thing this product does"; a card marked unoffered reads as "not enabled
 * for you". Only the second tells the operator there is somebody to ask. The
 * same reasoning drives the Import Center's source tiles, and this is the same
 * decision applied to the same kind of grid.
 */

/** A capability card before upstream's price and label are merged in. */
export interface CapabilityCopy {
  /** Matches `data_credits.capability.key`. */
  key: string;
  /** The outcome, used only when upstream has no entry to quote. */
  fallbackOutcome: string;
  /** Plain language: what the operator gets, never how it is obtained. */
  description: string;
}

/**
 * The two caveats every card carries.
 *
 * Attached to EVERY capability rather than to the ones where they feel most
 * relevant. They are properties of the whole broker: nothing bought through it
 * is a permission to contact anybody, and nothing it returns is verified by the
 * act of returning it. Putting them on some cards and not others would imply the
 * others are exempt, which is the one reading that must not be available.
 */
export const CAPABILITY_CAVEATS: readonly string[] = [
  'Does not create consent. A returned contact point carries no permission to use it.',
  'Human confirmation required. A returned value is an assertion, not a verified fact.',
] as const;

/**
 * The four cards, in the order the mockup lays them out.
 *
 * Validation before discovery, because they are different kinds of act:
 * validating tests something the tenant already holds, while finding introduces
 * something they did not. Ordering them together would flatten a distinction the
 * operator needs before they spend anything.
 */
export const CAPABILITY_CATALOG: readonly CapabilityCopy[] = [
  {
    key: 'validate_phone',
    fallbackOutcome: 'Validate a phone number',
    description:
      'Confirms whether a number you already hold is reachable, and what kind of line it is.',
  },
  {
    key: 'validate_email',
    fallbackOutcome: 'Validate an email address',
    description:
      'Confirms whether an address you already hold can receive mail, without sending anything to it.',
  },
  {
    key: 'find_contact_points',
    fallbackOutcome: 'Find contact points',
    description:
      'Proposes additional ways to reach a contact you already have a relationship with.',
  },
  {
    key: 'find_possible_profiles',
    fallbackOutcome: 'Find possible profiles',
    description:
      'Proposes public professional profiles that may belong to this contact, for a person to judge.',
  },
] as const;

/** Every key the screen renders, for the composer's merge. */
export const CATALOG_KEYS: readonly string[] = CAPABILITY_CATALOG.map((entry) => entry.key);
