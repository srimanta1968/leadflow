/**
 * SOP §03's signal table, as ONE decision.
 *
 * The whole point is that this is a table and not a pile of conditionals. The
 * same question — "does this signal become a sales record, and if so how" — is
 * asked by the webhook receiver, the social connector, the chat handoff and the
 * checkout hook. Answered in each of them separately, the four drift, and the
 * one that drifts is the one nobody re-reads. Answered here, changing the
 * policy is an edit to this file and a diff a non-engineer can review.
 *
 * EVERY RULE CARRIES ITS REASON, and the reason is returned with the decision.
 * A classification with no stated basis is unauditable: six months later
 * nobody can say why a comment became a lead and an impression did not, and the
 * only way to find out is to re-read the code as it was that day.
 */

/** What becomes of the signal. */
export type SignalDecision =
  /** A new sales record. */
  | 'CREATE'
  /** Folded into an existing record — the person is already known. */
  | 'MERGE'
  /** No sales record at all, and no identity inferred. */
  | 'NO_RECORD'
  /** A completed purchase: straight to the closed-won path. */
  | 'CLOSED_WON';

/** How urgently the resulting record must be worked. */
export type SignalPriority = 'highest' | 'high' | 'normal' | 'none';

export interface SignalRule {
  /** Stable key, used in the audit entry. */
  key: string;
  /** Signal kinds this rule matches. */
  matches: string[];
  decision: SignalDecision;
  priority: SignalPriority;
  /**
   * True when the rule only applies to an identifiable person.
   *
   * A public comment is the case: "interested" from a named account is a lead,
   * the same word from an account we cannot resolve is not, and the difference
   * must not be papered over by inventing an identity.
   */
  requiresIdentifiable: boolean;
  /** The initial path, in the SOP's own terms. */
  actions: string[];
  /** WHY. Returned with every decision, recorded on the audit entry. */
  reason: string;
}

/**
 * The table, in evaluation order.
 *
 * ORDER IS MEANINGFUL and the specific rules come first. `checkout_started`
 * would otherwise be swallowed by a generic web rule and lose its highest
 * priority — the single most expensive misclassification available here, since
 * an abandoned checkout is someone who tried to pay us.
 */
export const SIGNAL_RULES: SignalRule[] = [
  {
    key: 'purchase_completed',
    matches: ['license_purchase_completed', 'purchase_completed', 'payment_succeeded'],
    decision: 'CLOSED_WON',
    priority: 'normal',
    requiresIdentifiable: false,
    actions: ['route_to_closed_won', 'trigger_onboarding_handoff', 'stop_sales_sequences'],
    reason:
      'SOP §03: a completed licence purchase is not a lead. Creating one would put a paying customer back into a sales sequence, which is the most reliable way to annoy somebody who has just given you money.',
  },
  {
    key: 'checkout_started',
    matches: ['checkout_started', 'cart_abandoned', 'payment_failed'],
    decision: 'CREATE',
    // The only `highest` in the table, and deliberately so.
    priority: 'highest',
    requiresIdentifiable: false,
    actions: [
      'create_payment_assistance_task',
      'same_day_rep_outreach_if_permitted',
      'flag_highest_priority',
    ],
    reason:
      'SOP §03: someone who started a checkout and did not finish has the highest demonstrated intent of any signal — they tried to pay and something stopped them. Treated at HIGHEST priority because the window in which help is useful is hours, not days.',
  },
  {
    key: 'known_contact_revisit',
    matches: ['pricing_revisit', 'known_contact_reply', 'known_contact_revisit'],
    decision: 'MERGE',
    priority: 'high',
    requiresIdentifiable: true,
    actions: [
      'merge_into_existing_record',
      'rescore',
      'pause_generic_nurture',
      'create_urgent_owner_task',
    ],
    reason:
      'SOP §03: a known contact returning to pricing is a buying signal on an EXISTING relationship. Creating a second record would split their history and let generic nurture keep running at somebody actively evaluating — so it merges, rescores, and pauses the sequence rather than starting a new thread.',
  },
  {
    key: 'lead_form',
    matches: ['website_lead_form', 'social_lead_form', 'lead_form', 'demo_request'],
    decision: 'CREATE',
    priority: 'high',
    requiresIdentifiable: false,
    actions: ['acknowledge', 'assign_owner', 'start_sla_clock'],
    reason:
      'SOP §03: a submitted lead form is explicit, high intent, and carries the permission fields collected with it. Acknowledged, assigned and clocked immediately — the 30-minute response window starts here.',
  },
  {
    key: 'direct_conversation',
    matches: ['dm', 'chat', 'inbound_call', 'referral', 'chat_handoff'],
    decision: 'CREATE',
    priority: 'high',
    requiresIdentifiable: false,
    actions: [
      'respond_in_channel',
      'capture_and_verify_contact_data',
      'create_next_action_live',
    ],
    reason:
      'SOP §03: a person opened a conversation with us. The record is created immediately, but the contact data is CAPTURED AND VERIFIED rather than assumed — a DM handle is not an email address, and treating it as one produces a record nobody can contact.',
  },
  {
    key: 'interested_comment',
    matches: ['comment_interested', 'comment_demo', 'comment_info'],
    decision: 'CREATE',
    priority: 'normal',
    // The distinguishing condition in the whole table.
    requiresIdentifiable: true,
    actions: [
      'public_acknowledgement',
      'compliant_private_reply',
      'merge_into_crm_if_matched',
    ],
    reason:
      'SOP §03: a public comment expressing interest becomes a record ONLY when the person is identifiable. Acknowledged publicly and answered privately, because the reply carries information the commenter may not want under a public post.',
  },
  {
    key: 'anonymous_engagement',
    matches: ['like', 'view', 'impression', 'anonymous_visit', 'page_view', 'scroll'],
    decision: 'NO_RECORD',
    priority: 'none',
    requiresIdentifiable: false,
    actions: ['retarget_anonymously'],
    reason:
      'SOP §03: a like, a view or an anonymous visit is NOT a sales signal. No record, no identity, no consent inferred. Retargeting happens against the anonymous audience, which needs no identity — and inventing one from an impression would fabricate both a person and a lawful basis to contact them.',
  },
];

export interface SignalContext {
  /** Whether the person behind the signal is resolvable. */
  identifiable: boolean;
  /** An existing record, when the signal is from someone already known. */
  existingLeadId?: string | null;
}

export interface Classification {
  signalKind: string;
  decision: SignalDecision;
  priority: SignalPriority;
  /** The rule that decided, so the table row is traceable from the outcome. */
  ruleKey: string;
  /** WHY, in the SOP's terms. Recorded on the audit entry. */
  reason: string;
  actions: string[];
  /** True only for CREATE, MERGE and CLOSED_WON. */
  createsRecord: boolean;
  /**
   * True when an identity may be attached.
   *
   * Reported separately from `createsRecord` because they are different
   * refusals: NO_RECORD means nothing is stored at all, whereas a signal can
   * legitimately create a record with no identity attached to it yet.
   */
  mayInferIdentity: boolean;
}

/** The answer for a signal nothing in the table matches. */
function unmatched(signalKind: string): Classification {
  return {
    signalKind,
    // DEFAULT TO NO_RECORD. A signal the table does not describe is one nobody
    // has decided about, and defaulting to CREATE would let an unreviewed
    // event type start manufacturing leads — and, worse, identities.
    decision: 'NO_RECORD',
    priority: 'none',
    ruleKey: 'unmatched',
    reason:
      'No rule in the SOP §03 table describes this signal, so no record is created. An unclassified signal is one nobody has decided about, and guessing CREATE would let an unreviewed event type manufacture leads and identities.',
    actions: [],
    createsRecord: false,
    mayInferIdentity: false,
  };
}

/**
 * Classify one signal.
 *
 * FIRST MATCH WINS, over a deliberately ordered table. The specific rules come
 * before the general ones so `checkout_started` cannot be absorbed by a broad
 * web rule and quietly lose its highest priority.
 *
 * A rule needing an identifiable person and not getting one falls through to
 * NO_RECORD rather than to the next rule. That is the distinction the whole
 * table turns on: "interested" from a named account is a lead, and the same
 * word from an account we cannot resolve is not — and the gap between them must
 * never be closed by inventing an identity.
 */
export function classifySignal(signalKind: string, context: SignalContext): Classification {
  const kind = (signalKind ?? '').trim().toLowerCase();
  const rule = SIGNAL_RULES.find((candidate) => candidate.matches.includes(kind));

  if (!rule) {
    return unmatched(kind);
  }

  if (rule.requiresIdentifiable && !context.identifiable) {
    return {
      signalKind: kind,
      decision: 'NO_RECORD',
      priority: 'none',
      ruleKey: rule.key,
      // Names the rule that WOULD have applied, so the near miss is legible:
      // "this would have been a lead if we could tell who it was" is the useful
      // fact, not a bare refusal.
      reason: `${rule.reason} This signal matched that rule but the person could not be identified, so no record and no identity were created.`,
      actions: [],
      createsRecord: false,
      mayInferIdentity: false,
    };
  }

  return {
    signalKind: kind,
    decision: rule.decision,
    priority: rule.priority,
    ruleKey: rule.key,
    reason: rule.reason,
    actions: rule.actions,
    createsRecord: rule.decision !== 'NO_RECORD',
    // Never true for NO_RECORD. This is the flag the capture path reads before
    // it is allowed to resolve or store a person.
    mayInferIdentity: rule.decision !== 'NO_RECORD',
  };
}

/** Every signal kind the table recognises, for validation and for the docs. */
export function knownSignalKinds(): string[] {
  return SIGNAL_RULES.flatMap((rule) => rule.matches);
}
