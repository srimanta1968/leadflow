/**
 * The provenance vocabulary, and the one rule that matters about it.
 *
 * A SUPERSEDED ASSERTION MUST CARRY THE REASON IT LOST. That is the task's
 * acceptance condition, and it is enforced HERE, in the type, rather than by a
 * component remembering to render a field:
 *
 *   type Assertion = … | { status: 'Superseded'; supersededReason: string; … }
 *
 * so an assertion that says "Superseded" and nothing else does not compile. A
 * runtime check would have been the obvious approach and it is weaker in the way
 * that matters: it fires when somebody is already looking at the screen, which is
 * exactly when a bare status word has already misled them.
 *
 * Why it matters at all: "Superseded" alone tells an operator their data was
 * overruled without saying by what or on what grounds. The survivorship decision
 * IS the product here — a CRM that silently picks one of two phone numbers and
 * shows a status word has hidden the only interesting part.
 */

/** The mockup's status vocabulary, verbatim. */
export const ASSERTION_STATUS = ['Primary', 'Survives', 'Assertion', 'Superseded'] as const;
export type AssertionStatus = (typeof ASSERTION_STATUS)[number];

/** The mockup's column set, in order. Used by the table and asserted by its test. */
export const ASSERTION_COLUMNS = [
  'Assertion',
  'Value',
  'Source / Crosswalk',
  'Origin Class',
  'Confidence',
  'Effective',
  'Retrieved',
  'Status',
] as const;

interface AssertionBase {
  id: string;
  /** The field being asserted, e.g. 'Mobile phone'. */
  assertion: string;
  value: string;
  /** Where it came from, and the crosswalk id if there is one. */
  source: string;
  crosswalkRef?: string;
  originClass: string;
  /** 0..1. Null when the source does not score itself — not the same as 0. */
  confidence: number | null;
  effectiveAt: string | null;
  retrievedAt: string | null;
  /** Opens the underlying blob or record through an audited reveal. */
  evidenceRef?: string;
  /** True when the value is masked until an audited reveal. */
  sensitive?: boolean;
}

/**
 * One row. The union is the enforcement: only the Superseded arm carries
 * `supersededReason`, and it is REQUIRED there.
 */
export type Assertion =
  | (AssertionBase & { status: Exclude<AssertionStatus, 'Superseded'>; supersededReason?: never })
  | (AssertionBase & {
      status: 'Superseded';
      /**
       * Why this lost, in the words of the survivorship engine — sourced from
       * sdk-projection's `/explained` endpoint, not composed here. A reason the
       * UI invented would read as authoritative while agreeing with nothing.
       */
      supersededReason: string;
      /** The assertion that won, so the operator can go and look at it. */
      supersededBy?: string;
    });

/** True when the row must show a reason. Narrows for the renderer. */
export function isSuperseded(a: Assertion): a is Extract<Assertion, { status: 'Superseded' }> {
  return a.status === 'Superseded';
}

/* ------------------------------------------------------------------ upstream */

/**
 * The shapes sdk-projection actually returns, transcribed from
 * ProjexCloud/packages/sdk-projection/src/services/explainedProjectionService.ts.
 *
 * Transcribed rather than guessed, and kept in one place so the mapping below is
 * the only thing that has to change when the upstream contract moves. The two
 * differ in ways that would have been silent bugs: upstream says `attribute`
 * where the mockup's column says "Assertion", and its `confidence` is a plain
 * number — there is no "unscored" case to render, so a UI that showed one would
 * be inventing a state the data cannot express.
 */
export interface UpstreamAssertionRecord {
  assertion_id: string;
  attribute: string;
  value: string;
  origin_class: string;
  origin_ref: string | null;
  confidence: number;
  verification_state: 'unverified' | 'verified' | 'rejected';
  observed_at: string;
  recorded_at: string;
  superseded_by: string | null;
}

export interface UpstreamLosingAssertion {
  assertion: UpstreamAssertionRecord;
  /** The full sentence. Upstream guarantees it is never a bare status word. */
  reason: string;
  decided_by: {
    criterion: string;
    criterion_index: number;
    losing_value: string | number;
    winning_value: string | number;
  };
}

/**
 * Map one upstream record onto a display row.
 *
 * THE TWO DATE COLUMNS ARE NOT INTERCHANGEABLE and the mapping is the decision
 * worth recording: "Effective" is `observed_at` — when the world produced the
 * fact — and "Retrieved" is `recorded_at`, when we came to know it. Swapping them
 * makes a record imported today look like a fact that only became true today,
 * which is exactly the confusion the provenance tab exists to remove.
 */
export function fromUpstream(
  record: UpstreamAssertionRecord,
  losing?: UpstreamLosingAssertion,
): Assertion {
  const base = {
    id: record.assertion_id,
    assertion: record.attribute,
    value: record.value,
    source: record.origin_ref ?? record.origin_class,
    crosswalkRef: record.origin_ref ?? undefined,
    originClass: record.origin_class,
    confidence: record.confidence,
    effectiveAt: record.observed_at,
    retrievedAt: record.recorded_at,
    evidenceRef: record.origin_ref ?? undefined,
  };

  if (losing) {
    return {
      ...base,
      status: 'Superseded',
      // Upstream's sentence, verbatim. Composing our own here would read as
      // authoritative while agreeing with nothing the engine actually decided.
      supersededReason: losing.reason,
      supersededBy: record.superseded_by ?? undefined,
    };
  }

  return {
    ...base,
    status: record.verification_state === 'verified' ? 'Primary' : 'Assertion',
  };
}

/**
 * The P0–P4 trust ladder plus Consent — the six nodes of the status rail.
 *
 * Consent sits alongside rather than inside the ladder deliberately: a record can
 * be fully verified (P4) and still have no permission to contact, and collapsing
 * the two would let a confident-looking rail imply a permission nobody granted.
 */
export const TRUST_RAIL_NODES = [
  { key: 'P0_CAPTURED', label: 'P0 Captured', hint: 'Raw evidence stored exactly as it arrived' },
  { key: 'P1_NORMALIZED', label: 'P1 Normalized', hint: 'Parsed into fields, original evidence retained' },
  { key: 'P2_CANDIDATE', label: 'P2 Candidate', hint: 'Possible match proposed, awaiting a human' },
  { key: 'P3_LINKED', label: 'P3 Linked', hint: 'Linked to an entity by a governed decision' },
  { key: 'P4_DIRECT', label: 'P4 Direct', hint: 'Confirmed by direct interaction' },
  { key: 'CONSENT', label: 'Consent', hint: 'Permission to contact, tracked separately from identity' },
] as const;

export type TrustRailNodeKey = (typeof TRUST_RAIL_NODES)[number]['key'];

/** How far along the rail a subject has reached. */
export type RailState = 'reached' | 'current' | 'pending' | 'blocked';
