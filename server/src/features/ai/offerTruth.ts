import { AppError, ErrorCodes } from '../../utils/errors';

/**
 * Offer-truth constraints on anything the product says to a prospect.
 *
 * The SOP permits "only approved price, terms, feature status, claims, and
 * scarcity", and separately: never promise results, never promise roadmap
 * dates, never create fake urgency, no unapproved discount.
 *
 * REJECTS, NEVER EDITS. Silently correcting a draft would make the generator
 * look like it is working while it keeps producing unusable copy, and nobody
 * would ever be told. A rejection with the offending phrase quoted is the only
 * version of this that improves anything.
 *
 * APPLIED TO REP EDITS TOO. Human review is the control the SOP asks for, but a
 * rep editing under time pressure can introduce the very promise these
 * constraints exist to prevent — and an unapproved discount is no more approved
 * for having been typed by a person.
 */

/** The five approved feature-status labels. Anything else is a claim. */
export const FEATURE_STATUS_LABELS = [
  'LIVE',
  'BETA',
  'ROADMAP',
  'USAGE / THIRD PARTY',
  'NOT INCLUDED',
] as const;

export interface OfferTruthRule {
  key: string;
  /** What the rule forbids, in the SOP's terms. */
  forbids: string;
  pattern: RegExp;
}

/**
 * The forbidden patterns.
 *
 * Deliberately narrow. A broad rule that fires on ordinary sales language would
 * be switched off within a week, and a disabled guardrail protects nothing —
 * so each pattern targets a specific commitment the SOP names, not a tone.
 */
export const OFFER_TRUTH_RULES: OfferTruthRule[] = [
  {
    key: 'guaranteed_result',
    forbids:
      'Promising an outcome. The SOP: never promise results or "everything forever" — an outcome depends on the buyer\'s own execution, so guaranteeing it is a claim we cannot keep.',
    pattern:
      /\b(guarantee[ds]?|guaranteed results?|we promise|promised results?|risk[- ]free results?)\b/i,
  },
  {
    key: 'roadmap_date',
    forbids:
      'Attaching a date to a roadmap item. The SOP: "We will not attach a guaranteed date unless it is written in the approved terms." A date in a first-touch email is never in the approved terms.',
    pattern:
      /\b(roadmap|coming soon|planned|in development|shipping)\b[^.!?]{0,60}\b(by|in|on|before|q[1-4]|january|february|march|april|may|june|july|august|september|october|november|december|\d{4})\b/i,
  },
  {
    key: 'unapproved_discount',
    forbids:
      'Offering a discount. Pricing comes from the approved Offer Data Sheet, and a discount invented in a draft is one the company has not agreed to honour.',
    pattern:
      /\b(discount|% off|percent off|special price|reduced price|knock off|waive the fee|free upgrade)\b/i,
  },
  {
    key: 'fake_urgency',
    forbids:
      'Manufactured scarcity. The SOP lists "create fake urgency" among the things not to do; scarcity must be approved and real, or it is a pressure tactic.',
    pattern:
      /\b(last chance|only \d+ (spots?|seats?|licen[cs]es?) left|act now|expires? (today|tonight|in \d+ hours?)|final call)\b/i,
  },
  {
    key: 'unlabelled_feature_status',
    forbids:
      'Describing a capability as available without the approved status label. The SOP requires LIVE / BETA / ROADMAP / USAGE-THIRD PARTY / NOT INCLUDED, because "it does that" reads as LIVE to every buyer who hears it.',
    pattern: /\b(already (does|supports)|fully supports|does everything)\b/i,
  },
];

export interface OfferTruthViolation {
  rule: string;
  forbids: string;
  /** The offending text, quoted so the author can see what tripped it. */
  quote: string;
}

/** Find every violation in a piece of copy. */
export function findOfferTruthViolations(text: string | null | undefined): OfferTruthViolation[] {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return [];
  }

  const violations: OfferTruthViolation[] = [];
  for (const rule of OFFER_TRUTH_RULES) {
    const match = rule.pattern.exec(text);
    if (match) {
      violations.push({ rule: rule.key, forbids: rule.forbids, quote: match[0] });
    }
  }
  return violations;
}

/**
 * Reject copy that breaks the constraints.
 *
 * Reports EVERY violation, not the first. A draft with three problems should
 * come back with three, or the author fixes one and resubmits into the next.
 */
export function assertOfferTruth(text: string | null | undefined, what: string): void {
  const violations = findOfferTruthViolations(text);
  if (violations.length === 0) {
    return;
  }

  const detail = violations.map((v) => `${v.rule} ("${v.quote}")`).join('; ');
  throw new AppError(
    422,
    ErrorCodes.OFFER_TRUTH_VIOLATION,
    `${what} violates the approved offer-truth constraints: ${detail}`
  );
}
