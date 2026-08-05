import { isKnownPurpose } from './consentPurposes';

/**
 * The closed registry of audiences a campaign recommendation may name.
 *
 * A CLOSED SET, and the closure is the control — the same reasoning as the
 * research source registry next door. "Recommend the next audience" is an
 * instruction with no natural boundary: a model asked to find the most
 * responsive segment will happily propose "everyone who ever gave us an email
 * address", which is a real audience, is trivially derivable from data we hold,
 * and is not one anybody consented to be in. The difference between that and a
 * lawful segment is invisible in the recommendation itself.
 *
 * WHAT MAKES A SEGMENT GOVERNED is not that somebody wrote it down here. It is
 * that each one names the CONSENT PURPOSE it is contactable under and carries an
 * eligibility rule that can actually be evaluated against a row. A segment
 * without a purpose is a list; a segment whose eligibility is prose is a list
 * somebody will interpret generously under pressure.
 *
 * REFUSED, NOT FILTERED. A recommendation naming an unregistered segment is
 * rejected rather than silently narrowed to the governed part. Quietly filtering
 * would produce a recommendation that reads as approved while the reasoning
 * behind it was drawn from people who are not in the audience — and nobody
 * reviewing it could tell.
 */

export interface GovernedSegment {
  /** Stable key, recorded on every recommendation. Must never change. */
  key: string;
  label: string;
  /**
   * The consent purpose members are contactable under.
   *
   * Checked against the purpose registry at module load by
   * `assertSegmentsWellFormed`, so a typo here is a startup failure rather than
   * a segment that looks governed and names a purpose nobody ever registered.
   */
  purpose: string;
  /** Why this audience is lawful to contact, in the operator's terms. */
  basis: string;
  /**
   * The eligibility rule as a SQL predicate over `leads l`.
   *
   * SQL rather than prose because the rule has to be executable: a segment whose
   * membership cannot be computed cannot be checked, and "engaged prospects" is
   * whatever the person under quota pressure decides it means today.
   */
  predicate: string;
  /**
   * True when the segment is elective — the person opted IN to marketing rather
   * than merely transacting with us.
   *
   * Kept separate from `purpose` because it drives a different decision: an
   * elective audience may be used for promotional recommendations, a
   * service-necessary one may not, however well it performs.
   */
  elective: boolean;
}

export const GOVERNED_SEGMENTS: GovernedSegment[] = [
  {
    key: 'awaiting_first_response',
    label: 'Waiting on us',
    purpose: 'inspection_estimate',
    basis:
      'They asked for an estimate and have not been answered yet. Contacting them is completing the transaction they started, not marketing to them.',
    predicate: "l.first_response_at IS NULL AND l.activation_state = 'active'",
    elective: false,
  },
  {
    key: 'active_estimate_in_progress',
    label: 'Estimate in progress',
    purpose: 'project_operations',
    basis:
      'An open piece of work. Operational updates about their own job are service communication under the purpose they gave.',
    predicate: "l.first_response_at IS NOT NULL AND l.activation_state = 'active'",
    elective: false,
  },
  {
    key: 'promotions_opted_in',
    label: 'Opted in to seasonal promotions',
    // The ONLY segment a promotional campaign may target. Everything else in
    // this registry is service communication, and a promotion sent under a
    // service purpose is exactly the failure the purpose registry exists to
    // prevent.
    purpose: 'seasonal_promotions',
    basis:
      'Explicitly opted in to promotional contact. Elective, revocable, and the only audience a promotion may address.',
    // Deliberately requires a POSITIVE marker rather than an absence of a
    // suppression. "Not unsubscribed" is not consent — it is the condition
    // every person who has never been asked is also in.
    predicate: "l.activation_state = 'active' AND l.utm_medium = 'opt_in'",
    elective: true,
  },
  {
    key: 'referral_participants',
    label: 'Referral programme participants',
    purpose: 'referral_program',
    basis: 'Joined the referral programme, which is a standing elective relationship.',
    predicate: "l.activation_state = 'active' AND l.source = 'referral'",
    elective: true,
  },
];

/** Look up one segment. */
export function segmentByKey(key: string): GovernedSegment | undefined {
  return GOVERNED_SEGMENTS.find((segment) => segment.key === key);
}

/** Every registered key, for error messages and for tests. */
export function allSegmentKeys(): string[] {
  return GOVERNED_SEGMENTS.map((segment) => segment.key);
}

/**
 * Split a requested audience list into the governed ones and the rest.
 *
 * Returns BOTH halves rather than throwing, so the caller reports every refusal
 * at once instead of one per request — the same shape as
 * `partitionRequestedSources`, and for the same reason.
 */
export function partitionRequestedSegments(keys: string[]): {
  governed: string[];
  refused: string[];
} {
  const governed: string[] = [];
  const refused: string[] = [];

  for (const key of keys) {
    if (segmentByKey(key)) {
      governed.push(key);
    } else {
      refused.push(key);
    }
  }

  return { governed, refused };
}

/** Segments a PROMOTIONAL campaign may target. */
export function promotionalSegments(): GovernedSegment[] {
  return GOVERNED_SEGMENTS.filter((segment) => segment.elective);
}

/**
 * Check every segment names a purpose the consent registry knows.
 *
 * Called at module load. A segment naming an unregistered purpose is worse than
 * a missing segment: it LOOKS governed, passes every membership check, and the
 * lawful basis it claims does not exist.
 */
export function assertSegmentsWellFormed(): void {
  const bad = GOVERNED_SEGMENTS.filter((segment) => !isKnownPurpose(segment.purpose));
  if (bad.length > 0) {
    throw new Error(
      `Governed segments name purposes that are not in the consent registry: ${bad
        .map((segment) => `${segment.key} -> ${segment.purpose}`)
        .join(', ')}`
    );
  }
}

assertSegmentsWellFormed();
