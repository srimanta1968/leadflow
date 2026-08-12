/**
 * The 14-day active cadence and the nurture tracks. SOP §33 and §47.
 *
 * CONFIGURATION, NOT CODE. Thirteen steps with their timing, channel, objective
 * and required NEXT are declared here, so changing the cadence is an edit to a
 * list rather than a change to the executor. The executor reads this and knows
 * nothing about step 7 specifically.
 *
 * EVERY STEP NAMES ITS TEMPLATE. A step that composes its own copy bypasses the
 * approval gate, so the binding is to a template KEY and the executor refuses a
 * step whose template has no published version.
 */

export type Channel = 'email' | 'sms' | 'call' | 'voicemail';

export interface CadenceStep {
  /** 1-13, and the order the executor walks. */
  step: number;
  /** Minutes from enrolment. The SOP's own schedule. */
  offsetMinutes: number;
  channels: Channel[];
  /** What this step is for, in the words the authoring UI shows. */
  objective: string;
  /** The approved template each channel sends. */
  templateKeys: string[];
  /**
   * The NEXT this step must leave behind. SOP §01 applies inside a cadence too:
   * an automated touch that leaves no next action produces a record nobody owns
   * between steps.
   */
  requiredNext: { actionType: string; dueOffsetMinutes: number; purpose: string; intendedOutcome: string };
}

const H = 60;
const D = 24 * 60;

/** The thirteen steps of the active cadence, SOP §33. */
export const ACTIVE_CADENCE: readonly CadenceStep[] = [
  { step: 1, offsetMinutes: 0, channels: ['email', 'sms'],
    objective: 'Acknowledge, identify the rep, set the expectation and offer two times.',
    templateKeys: ['form_confirmation_immediate', 'sms_form_confirmation'],
    requiredNext: { actionType: 'call', dueOffsetMinutes: 30, purpose: 'First call inside the response SLA', intendedOutcome: 'Connected and qualified, or a booked time' } },

  { step: 2, offsetMinutes: 5, channels: ['call'],
    objective: 'Call #1 with a source-aware opening.',
    templateKeys: ['call_script_opening'],
    requiredNext: { actionType: 'call', dueOffsetMinutes: 3 * H, purpose: 'Second attempt at a different hour', intendedOutcome: 'A conversation or a definite decline' } },

  { step: 3, offsetMinutes: 25, channels: ['voicemail', 'sms', 'email'],
    objective: 'After no answer: voicemail, SMS #2 and Email #2. The 30-minute dedup window prevents a burst.',
    templateKeys: ['voicemail_first_attempt', 'sms_no_answer', 'no_answer_after_call'],
    requiredNext: { actionType: 'call', dueOffsetMinutes: 3 * H, purpose: 'Call #2 in a new window', intendedOutcome: 'Reached, or a reason they are not reachable' } },

  { step: 4, offsetMinutes: 4 * H, channels: ['call'],
    objective: 'Call #2 at a new time window, with one direct question.',
    templateKeys: ['call_script_opening'],
    requiredNext: { actionType: 'call', dueOffsetMinutes: 20 * H, purpose: 'Day 2 morning attempt', intendedOutcome: 'A conversation' } },

  { step: 5, offsetMinutes: 1 * D + 9 * H, channels: ['call', 'sms'],
    objective: 'Day 2 AM: Call #3 and SMS #3 carrying the value hypothesis.',
    templateKeys: ['call_script_opening', 'sms_no_answer'],
    requiredNext: { actionType: 'email', dueOffsetMinutes: 8 * H, purpose: 'Day 2 diagnostic email', intendedOutcome: 'A reply naming their priority' } },

  { step: 6, offsetMinutes: 1 * D + 16 * H, channels: ['email'],
    objective: 'Day 2 PM: a short diagnostic. Pauses on reply.',
    templateKeys: ['demo_recap_decision_step'],
    requiredNext: { actionType: 'call', dueOffsetMinutes: 2 * D, purpose: 'Day 4 priority call', intendedOutcome: 'Priority clarified' } },

  { step: 7, offsetMinutes: 3 * D + 9 * H, channels: ['call', 'sms'],
    objective: 'Day 4: Call #4 and SMS #4 clarifying priority.',
    templateKeys: ['call_script_opening', 'sms_no_answer'],
    requiredNext: { actionType: 'email', dueOffsetMinutes: 1 * D, purpose: 'Day 5 decision checklist', intendedOutcome: 'A decision step agreed' } },

  { step: 8, offsetMinutes: 4 * D + 10 * H, channels: ['email'],
    objective: 'Day 5: the decision checklist. Click and reply are tracked; no score-only automated sends.',
    templateKeys: ['checkout_commercial_follow_up'],
    requiredNext: { actionType: 'call', dueOffsetMinutes: 2 * D, purpose: 'Day 7 business-case call', intendedOutcome: 'Next step clarity' } },

  { step: 9, offsetMinutes: 6 * D + 10 * H, channels: ['call', 'email'],
    objective: 'Day 7: Call #5 and Email #5 on the business case and next-step clarity.',
    templateKeys: ['call_script_opening', 'demo_recap_decision_step'],
    requiredNext: { actionType: 'sms', dueOffsetMinutes: 2 * D, purpose: 'Day 9 low-friction choice', intendedOutcome: 'A yes or a no' } },

  { step: 10, offsetMinutes: 8 * D + 11 * H, channels: ['sms'],
    objective: 'Day 9: SMS #5, a low-friction choice. A reply pauses the cadence and alerts the owner.',
    templateKeys: ['sms_no_answer'],
    requiredNext: { actionType: 'call', dueOffsetMinutes: 1 * D, purpose: 'Day 10 call', intendedOutcome: 'A next step or a close' } },

  { step: 11, offsetMinutes: 9 * D + 10 * H, channels: ['call', 'email'],
    objective: 'Day 10: Call #6 and Email #6. Manager review when intent is high but no next step exists.',
    templateKeys: ['call_script_opening', 'demo_recap_decision_step'],
    requiredNext: { actionType: 'sms', dueOffsetMinutes: 2 * D, purpose: 'Day 12 permission check', intendedOutcome: 'Permission to continue, or not' } },

  { step: 12, offsetMinutes: 11 * D + 11 * H, channels: ['sms'],
    objective: 'Day 12: a permission-based final active check.',
    templateKeys: ['sms_no_answer'],
    requiredNext: { actionType: 'call', dueOffsetMinutes: 2 * D, purpose: 'Day 14 close the loop', intendedOutcome: 'Booked, deferred or closed' } },

  { step: 13, offsetMinutes: 13 * D + 10 * H, channels: ['call', 'email', 'sms'],
    objective: 'Day 14: Call #7 and the breakup message offering 1=book, 2=later, 3=close.',
    templateKeys: ['call_script_opening', 'close_the_loop_recycle', 'sms_no_answer'],
    requiredNext: { actionType: 'task', dueOffsetMinutes: 1 * D, purpose: 'Route to Nurture or Closed Lost with a reason', intendedOutcome: 'A dated future NEXT in whichever track it lands' } },
];

/** The terminal routing SOP §33 requires after step 13. */
export const DAY_14_ROUTES = ['nurture', 'closed_lost'] as const;
export type Day14Route = (typeof DAY_14_ROUTES)[number];

/* ------------------------------------------------------------- nurture §47 */

export type NurtureSegment =
  | 'timing_or_season' | 'budget_or_approval' | 'current_contract'
  | 'product_gap' | 'trust_or_prelaunch' | 'no_response' | 'no_fit_today';

export interface NurtureTrack {
  segment: NurtureSegment;
  label: string;
  /** Days from entry. The cadence differs BY REASON, which is the whole point. */
  touchDays: number[];
  /** What each touch is for. Changing the reason, not just the subject line. */
  approach: string;
  /** Constraints that are part of the segment rather than of the message. */
  constraint: string | null;
}

/**
 * A distinct cadence per reason.
 *
 * SEGMENTED BY REASON, NOT BY LIST. One nurture stream serving six different
 * reasons sends the same thing to somebody waiting on a budget cycle and
 * somebody who is mid-contract with a competitor, and the only thing that
 * changes is the subject line. The reason decides the timing AND the content.
 */
export const NURTURE_TRACKS: readonly NurtureTrack[] = [
  { segment: 'timing_or_season', label: 'Timing or season', touchDays: [30, 45, 60, 90],
    approach: 'Value touch at 30-60 days, then a reminder 14 days before their stated date.',
    constraint: 'Anchored on the buyer-approved date rather than on our calendar.' },
  { segment: 'budget_or_approval', label: 'Budget or approval cycle', touchDays: [30, 60, 90],
    approach: 'Business-case asset, planning reminder, stakeholder prep.',
    constraint: 'NEVER repeated discounting. Discounting on a schedule teaches the buyer to wait.' },
  { segment: 'current_contract', label: 'Current contract or tool', touchDays: [30, 60, 90],
    approach: 'Check in 90, 60 and 30 days before their renewal date.',
    constraint: 'Anchored on the renewal date, not on entry.' },
  { segment: 'product_gap', label: 'Product or integration gap', touchDays: [30, 60, 90],
    approach: 'Verified status updates only.',
    constraint: 'NO vague coming-soon. A gap closed is news; a gap still open is not worth a message.' },
  { segment: 'trust_or_prelaunch', label: 'Trust or prelaunch risk', touchDays: [30, 45, 60, 90],
    approach: 'Proof, process transparency and updated approved terms.', constraint: null },
  { segment: 'no_response', label: 'No response after the active cadence', touchDays: [30, 60, 90],
    approach: 'Day 30, 60, 90 then quarterly at most.',
    constraint: 'Change the REASON, not just the subject line. The same ask re-sent is why people stop opening.' },
  { segment: 'no_fit_today', label: 'No fit today', touchDays: [],
    approach: 'Not nurtured at all unless a specific future change could create fit.',
    constraint: 'Requires a named future change AND permission to contact. Enforced by a CHECK constraint.' },
];

/** What returns a nurtured record to an active owner. SOP §47. */
export const REACTIVATION_TRIGGERS = [
  'reply', 'direct_question', 'booking', 'pricing_activity',
  'checkout_activity', 'referral', 'product_milestone',
] as const;
export type ReactivationTrigger = (typeof REACTIVATION_TRIGGERS)[number];

/* ------------------------------------------------------------- stop rules */

/**
 * Every reactive signal, and what it does to a running cadence. SOP §08, §33.
 *
 * STOP OR REPLACE, NEVER CONTINUE UNCHANGED. Automation must not argue with a
 * human: somebody who has replied, booked or paid should never receive the next
 * generic step, and the failure mode is not merely embarrassing — a payment
 * followed by a "still interested?" message is the one customers screenshot.
 *
 * REPLACE IS DISTINCT FROM STOP. A booked meeting does not end the relationship,
 * it makes the booking CTA wrong; logistics reminders for that meeting SHOULD
 * continue. Collapsing the two would either spam somebody who has booked or go
 * silent on somebody expecting a reminder.
 */
export const STOP_RULES = [
  { signal: 'inbound_reply', action: 'stop', because: 'A human replied. Every generic step after that argues with them.' },
  { signal: 'booking_made', action: 'replace', because: 'The booking CTA is now wrong. Logistics reminders for the accepted meeting continue.' },
  { signal: 'callback_requested', action: 'replace', because: 'They named a time. Generic prospecting is replaced by that commitment.' },
  { signal: 'opt_out', action: 'stop', because: 'They said stop. Nothing further is sent on any channel.' },
  { signal: 'hard_bounce', action: 'stop', because: 'The channel is invalid. Continuing damages sender reputation for everybody.' },
  { signal: 'payment_verified', action: 'stop', because: 'They bought. Presale messaging to a customer is the most visible failure this list prevents.' },
  { signal: 'status_change', action: 'stop', because: 'They are no longer the person this cadence was written for.' },
  { signal: 'rep_activity', action: 'pause', because: 'A live rep is working the record. Automation waits rather than talking over them.' },
  { signal: 'service_issue', action: 'stop', because: 'A higher-priority service problem outranks any sales cadence.' },
] as const;

export type StopSignal = (typeof STOP_RULES)[number]['signal'];
export type StopAction = 'stop' | 'replace' | 'pause';

export const STOP_SIGNALS: readonly string[] = STOP_RULES.map((r) => r.signal);

export function stopRuleFor(signal: string): (typeof STOP_RULES)[number] | undefined {
  return STOP_RULES.find((r) => r.signal === signal);
}
