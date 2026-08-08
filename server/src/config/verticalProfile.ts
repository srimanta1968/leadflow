/**
 * THE VERTICAL PROFILE — every Lynked-Up-specific value in one file.
 *
 * LeadFlow is a template. The next vertical — a legal practice, a dental group,
 * an HVAC contractor — should be reachable by swapping this file and nothing
 * else. That only holds if the codebase never learns a fact about roofing, and
 * the way to keep it true is to give every such fact exactly one home.
 *
 * WHAT BELONGS HERE: anything a different customer in a different industry would
 * answer differently. Stage names, how long a stage may sit, priority bands and
 * their response targets, business hours and holidays, the brand as it appears
 * in outbound copy, consent-purpose labels, offer identifiers, disposition codes
 * and close reasons, KPI definitions.
 *
 * WHAT DOES NOT: anything structural. The P0-P4 trust ladder, the origin-class
 * precedence, the audit event vocabulary and the permission strings are the
 * PRODUCT, not the vertical — a dental group gets the same ones. Those live in
 * roles.ts, vocabulary.ts and assertions.ts and are deliberately not duplicated
 * here.
 *
 * THE STAGES ARE THE CUSTOMER'S, NOT OURS. All ten come from SOP §06, quoted in
 * docs/LinkedUp_Pro_SOP_Gap_Analysis.html, which also records that the incumbent
 * system shipped `Discovery → Qualification → Proposal → Negotiation → Closed
 * Won` instead — five stages, none of them the customer's, with no entry or exit
 * criteria, no staleness rule and no guard on invalid moves. Reproducing that
 * would reproduce the gap the customer is paying to close, so the entry and exit
 * evidence and the allowed transitions are declared here and enforced from here.
 *
 * `tests/unit/verticalNeutrality.test.ts` fails the build if a vertical value
 * appears anywhere else.
 */

/* ------------------------------------------------------------------- brand */

export interface BrandProfile {
  /** As it appears in outbound copy to a prospect. */
  tradingName: string;
  /** The prefix on a customer-visible account reference, e.g. LUP-1001. */
  accountReferencePrefix: string;
  /** The IANA zone every business-hours calculation is anchored to. */
  timezone: string;
}

export const BRAND: BrandProfile = {
  tradingName: 'Lynked Up Pro',
  accountReferencePrefix: 'LUP',
  timezone: 'America/New_York',
};

/* ------------------------------------------------------------------ stages */

export type StageKey =
  | 'NEW_UNWORKED'
  | 'ATTEMPTING_CONTACT'
  | 'CONNECTED_QUALIFYING'
  | 'DEMO_SCHEDULED'
  | 'DISCOVERY_COMPLETE'
  | 'COMMERCIAL_REVIEW'
  | 'AGREEMENT_SENT'
  | 'CLOSED_WON_ONBOARDING_PENDING'
  | 'NURTURE'
  | 'CLOSED_LOST';

export interface StageDefinition {
  key: StageKey;
  /** SOP §06 position, 1-10. Ordering for the pipeline board. */
  position: number;
  label: string;
  /**
   * What must be TRUE to enter. Not decoration: the stage guard refuses a move
   * whose evidence is absent, which is the check the incumbent system had no
   * form of at all.
   */
  entryEvidence: string[];
  /** What must be recorded before leaving. */
  exitEvidence: string[];
  /**
   * Business days before the stage is stale. Null where ageing is meaningless —
   * a closed record is not going stale, and Nurture is a holding pattern by
   * design rather than neglect.
   */
  staleAfterBusinessDays: number | null;
  /** Stages this one may move to. An empty list is terminal. */
  allowedNext: StageKey[];
  /** True for the stages that end the active pipeline. */
  terminal: boolean;
}

export const STAGES: StageDefinition[] = [
  {
    key: 'NEW_UNWORKED',
    position: 1,
    label: 'New — Unworked',
    entryEvidence: ['capture_record_exists'],
    exitEvidence: ['owner_assigned', 'next_action_recorded'],
    // The SOP's own number. A lead nobody has touched in a working week is the
    // single most common way an inbound pipeline leaks.
    staleAfterBusinessDays: 5,
    allowedNext: ['ATTEMPTING_CONTACT', 'NURTURE', 'CLOSED_LOST'],
    terminal: false,
  },
  {
    key: 'ATTEMPTING_CONTACT',
    position: 2,
    label: 'Attempting Contact',
    entryEvidence: ['owner_assigned', 'next_action_recorded'],
    exitEvidence: ['contact_attempt_logged'],
    staleAfterBusinessDays: 5,
    allowedNext: ['CONNECTED_QUALIFYING', 'NURTURE', 'CLOSED_LOST'],
    terminal: false,
  },
  {
    key: 'CONNECTED_QUALIFYING',
    position: 3,
    label: 'Connected — Qualifying',
    entryEvidence: ['two_way_contact_confirmed'],
    exitEvidence: ['qualification_recorded'],
    staleAfterBusinessDays: 5,
    allowedNext: ['DEMO_SCHEDULED', 'COMMERCIAL_REVIEW', 'NURTURE', 'CLOSED_LOST'],
    terminal: false,
  },
  {
    key: 'DEMO_SCHEDULED',
    position: 4,
    label: 'Demo Scheduled',
    entryEvidence: ['appointment_booked'],
    exitEvidence: ['appointment_outcome_recorded'],
    staleAfterBusinessDays: 10,
    allowedNext: ['DISCOVERY_COMPLETE', 'NURTURE', 'CLOSED_LOST'],
    terminal: false,
  },
  {
    key: 'DISCOVERY_COMPLETE',
    position: 5,
    label: 'Demo / Discovery Complete',
    entryEvidence: ['appointment_outcome_recorded'],
    exitEvidence: ['requirements_captured'],
    staleAfterBusinessDays: 5,
    allowedNext: ['COMMERCIAL_REVIEW', 'NURTURE', 'CLOSED_LOST'],
    terminal: false,
  },
  {
    key: 'COMMERCIAL_REVIEW',
    position: 6,
    label: 'Commercial Review',
    entryEvidence: ['requirements_captured'],
    exitEvidence: ['offer_selected', 'pricing_approved'],
    staleAfterBusinessDays: 5,
    allowedNext: ['AGREEMENT_SENT', 'NURTURE', 'CLOSED_LOST'],
    terminal: false,
  },
  {
    key: 'AGREEMENT_SENT',
    position: 7,
    label: 'Checkout / Agreement Sent',
    entryEvidence: ['offer_selected', 'agreement_dispatched'],
    exitEvidence: ['agreement_signed_or_declined'],
    staleAfterBusinessDays: 10,
    allowedNext: ['CLOSED_WON_ONBOARDING_PENDING', 'NURTURE', 'CLOSED_LOST'],
    terminal: false,
  },
  {
    key: 'CLOSED_WON_ONBOARDING_PENDING',
    position: 8,
    label: 'Closed Won — Onboarding Pending',
    entryEvidence: ['agreement_signed', 'payment_recorded'],
    exitEvidence: ['onboarding_started'],
    // Won and then dropped is the most expensive kind of stale there is, so this
    // is the tightest window in the pipeline.
    staleAfterBusinessDays: 3,
    allowedNext: [],
    terminal: true,
  },
  {
    key: 'NURTURE',
    position: 9,
    label: 'Nurture',
    entryEvidence: ['nurture_reason_recorded'],
    exitEvidence: ['re_engagement_signal'],
    // Deliberately null. Nurture is a holding pattern the operator CHOSE, and
    // ageing it would fill the stale queue with records that are exactly where
    // they are supposed to be — which is how a staleness signal gets ignored.
    staleAfterBusinessDays: null,
    allowedNext: ['ATTEMPTING_CONTACT', 'CONNECTED_QUALIFYING', 'CLOSED_LOST'],
    terminal: false,
  },
  {
    key: 'CLOSED_LOST',
    position: 10,
    label: 'Closed Lost',
    entryEvidence: ['close_reason_recorded'],
    exitEvidence: [],
    staleAfterBusinessDays: null,
    // Re-opening goes through Nurture rather than straight back into the funnel,
    // so a revived record carries a reason and does not silently rejoin the
    // pipeline at the stage it died in.
    allowedNext: ['NURTURE'],
    terminal: true,
  },
];

/* --------------------------------------------------------- priority bands */

export interface PriorityBand {
  key: string;
  label: string;
  /** Minutes to first response. The SLA target the band exists to express. */
  firstResponseMinutes: number;
  /** Minutes before the owner's manager is told. */
  escalateAfterMinutes: number;
}

export const PRIORITY_BANDS: PriorityBand[] = [
  { key: 'P0', label: 'Immediate', firstResponseMinutes: 5, escalateAfterMinutes: 15 },
  { key: 'P1', label: 'Same hour', firstResponseMinutes: 60, escalateAfterMinutes: 120 },
  { key: 'P2', label: 'Same day', firstResponseMinutes: 480, escalateAfterMinutes: 960 },
  { key: 'P3', label: 'Next working day', firstResponseMinutes: 1440, escalateAfterMinutes: 2880 },
];

/* ------------------------------------------------------- business calendar */

export interface BusinessCalendar {
  timezone: string;
  /** 0 = Sunday. Days the clock runs. */
  workingDays: number[];
  /** Local 24h times, inclusive start, exclusive end. */
  openHour: number;
  closeHour: number;
  /**
   * Dates the clock is paused, as YYYY-MM-DD in `timezone`.
   *
   * LOCAL ONLY AS A FALLBACK. ProjexCloud's sdk-sla holds the authoritative
   * tenant calendar, including pause windows this list cannot express; LeadFlow
   * uses these dates only when the gateway is unreachable, and the SLA services
   * say so where they degrade. Keeping a second list in step by hand would be
   * worse than having none, so it stays deliberately short.
   */
  holidays: string[];
}

export const BUSINESS_CALENDAR: BusinessCalendar = {
  timezone: BRAND.timezone,
  workingDays: [1, 2, 3, 4, 5],
  openHour: 8,
  closeHour: 18,
  holidays: [
    '2026-01-01',
    '2026-05-25',
    '2026-07-03',
    '2026-09-07',
    '2026-11-26',
    '2026-12-25',
  ],
};

/* ------------------------------------------------------ dispositions */

export interface DispositionCode {
  key: string;
  label: string;
  /** Which contact channel it applies to; `any` when it is channel-neutral. */
  channel: 'call' | 'email' | 'sms' | 'any';
  /** True when recording it satisfies `contact_attempt_logged`. */
  countsAsAttempt: boolean;
  /** True when it proves two-way contact, which is what qualifying needs. */
  countsAsConnection: boolean;
}

export const DISPOSITION_CODES: DispositionCode[] = [
  { key: 'CONNECTED', label: 'Connected — spoke with the prospect', channel: 'call', countsAsAttempt: true, countsAsConnection: true },
  { key: 'VOICEMAIL', label: 'Left voicemail', channel: 'call', countsAsAttempt: true, countsAsConnection: false },
  { key: 'NO_ANSWER', label: 'No answer', channel: 'call', countsAsAttempt: true, countsAsConnection: false },
  { key: 'WRONG_NUMBER', label: 'Wrong number', channel: 'call', countsAsAttempt: true, countsAsConnection: false },
  { key: 'CALLBACK_REQUESTED', label: 'Callback requested', channel: 'call', countsAsAttempt: true, countsAsConnection: true },
  { key: 'REPLIED', label: 'Prospect replied', channel: 'any', countsAsAttempt: true, countsAsConnection: true },
  { key: 'BOUNCED', label: 'Message bounced', channel: 'email', countsAsAttempt: true, countsAsConnection: false },
  { key: 'OPTED_OUT', label: 'Opted out', channel: 'any', countsAsAttempt: true, countsAsConnection: false },
  { key: 'NO_RESPONSE', label: 'Sent, no response yet', channel: 'any', countsAsAttempt: true, countsAsConnection: false },
];

/* ------------------------------------------------------- close reasons */

export interface CloseReason {
  key: string;
  label: string;
  outcome: 'won' | 'lost';
  /** True when the reason may be revisited later, so it belongs in Nurture. */
  revisitable: boolean;
}

export const CLOSE_REASONS: CloseReason[] = [
  { key: 'WON_STANDARD', label: 'Agreement signed', outcome: 'won', revisitable: false },
  { key: 'WON_REFERRAL', label: 'Signed via referral', outcome: 'won', revisitable: false },
  { key: 'LOST_PRICE', label: 'Price', outcome: 'lost', revisitable: true },
  { key: 'LOST_TIMING', label: 'Timing — not now', outcome: 'lost', revisitable: true },
  { key: 'LOST_COMPETITOR', label: 'Chose a competitor', outcome: 'lost', revisitable: true },
  { key: 'LOST_NO_CONTACT', label: 'Never reachable', outcome: 'lost', revisitable: true },
  { key: 'LOST_NOT_QUALIFIED', label: 'Outside what we serve', outcome: 'lost', revisitable: false },
  { key: 'LOST_DUPLICATE', label: 'Duplicate of another record', outcome: 'lost', revisitable: false },
  { key: 'LOST_OPTED_OUT', label: 'Asked not to be contacted', outcome: 'lost', revisitable: false },
];

/* ------------------------------------------------------------- offers */

export interface OfferIdentifier {
  key: string;
  label: string;
  /** The identifier the payment provider knows this offer by. */
  externalRef: string;
}

export const OFFERS: OfferIdentifier[] = [
  { key: 'STARTER', label: 'Starter', externalRef: 'lup_starter_monthly' },
  { key: 'PROFESSIONAL', label: 'Professional', externalRef: 'lup_professional_monthly' },
  { key: 'ENTERPRISE', label: 'Enterprise', externalRef: 'lup_enterprise_annual' },
];

/* ---------------------------------------------------- consent purpose labels */

/**
 * NOT HERE, DELIBERATELY. `config/consentPurposes.ts` already holds the key, the
 * label a person is shown and whether the purpose is service-necessary, and it
 * is already the source the consent screens and receipts read.
 *
 * Restating the labels here would create the second source of truth this file
 * exists to prevent, and the copy that lost would be the one on the consent
 * screen — the single place where stale wording is a compliance problem rather
 * than a cosmetic one. The configuration SURFACE is `src/config/**`, not one
 * file; a value having exactly one home matters, which file that is does not.
 *
 * `leadflow_purpose_taxonomy_map` is seeded from CONSENT_PURPOSES for the same
 * reason. See db/verticalSeed.ts.
 */

/* --------------------------------------------------------- KPI definitions */

export interface KpiDefinition {
  key: string;
  label: string;
  unit: 'percent' | 'minutes' | 'count' | 'currency';
  /** True when a rising number is good. Drives the arrow colour, not the value. */
  higherIsBetter: boolean;
  /** The number the dashboard draws its target line at. */
  target: number;
}

export const KPI_DEFINITIONS: KpiDefinition[] = [
  { key: 'sla_compliance', label: 'SLA compliance', unit: 'percent', higherIsBetter: true, target: 95 },
  { key: 'median_first_response', label: 'Median first response', unit: 'minutes', higherIsBetter: false, target: 10 },
  { key: 'unresolved_captures', label: 'Unresolved captures', unit: 'count', higherIsBetter: false, target: 0 },
  { key: 'stage_conversion', label: 'Stage conversion', unit: 'percent', higherIsBetter: true, target: 30 },
  { key: 'next_action_completeness', label: 'NEXT action completeness', unit: 'percent', higherIsBetter: true, target: 100 },
  { key: 'pipeline_value', label: 'Pipeline value', unit: 'currency', higherIsBetter: true, target: 0 },
];

/* ------------------------------------------------------------- lookups */

const STAGE_BY_KEY = new Map(STAGES.map((s) => [s.key, s]));

export function stage(key: string): StageDefinition | null {
  return STAGE_BY_KEY.get(key as StageKey) ?? null;
}

/**
 * Whether a stage move is permitted.
 *
 * Refuses an UNKNOWN stage rather than waving it through. `updateDealStage` in
 * the incumbent system allowed any stage to any stage, which is how a record
 * reached Closed Won having never been contacted.
 */
export function canMoveStage(from: string, to: string): { allowed: boolean; reason: string | null } {
  const source = stage(from);
  const target = stage(to);
  if (!source) return { allowed: false, reason: `${from} is not a stage` };
  if (!target) return { allowed: false, reason: `${to} is not a stage` };
  if (from === to) return { allowed: true, reason: null };
  if (!source.allowedNext.includes(target.key)) {
    return {
      allowed: false,
      reason: `${source.label} does not lead to ${target.label}. Permitted: ${
        source.allowedNext.length === 0
          ? 'none, this stage is terminal'
          : source.allowedNext.map((k) => stage(k)!.label).join(', ')
      }`,
    };
  }
  return { allowed: true, reason: null };
}

/** The evidence a move needs, which is the target's entry evidence. */
export function evidenceRequiredToEnter(to: string): string[] {
  return stage(to)?.entryEvidence ?? [];
}
