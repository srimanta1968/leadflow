/**
 * The SOP coaching scorecard, the LACE frame, and the approved objection
 * library.
 *
 * TRANSCRIBED FROM THE SOP, NOT PARAPHRASED. The criterion is that the
 * scorecard matches the SOP coaching dimensions EXACTLY, so this file is a
 * transcription and the test asserts the list rather than describing it.
 *
 * One wording note worth keeping: the SOP says "listening", and an earlier
 * restatement of this task called it "listening ratio". The ratio is one way to
 * MEASURE the dimension, not the dimension — a rep can hold a perfect talk/listen
 * ratio while hearing nothing. Renaming it would also stop the screen matching
 * the paper form the manager is coaching from, which is the practical reason
 * "exactly" is in the criterion at all.
 */

export interface CoachingDimension {
  /** Stable key, used in stored scorecards. */
  key: string;
  /** The SOP's own wording. */
  label: string;
  /** What a manager is looking for, drawn from the SOP call structure. */
  lookFor: string;
}

/** The ten dimensions, in the SOP's order. */
export const COACHING_DIMENSIONS: CoachingDimension[] = [
  {
    key: 'opening_context',
    label: 'Opening/context',
    lookFor: 'Confirms who they are, why the call is happening, and the time available.',
  },
  {
    key: 'agenda_contract',
    label: 'Agenda contract',
    lookFor:
      'States the agenda and the decision outcome, and asks permission to adjust it. The SOP allots the first three minutes to exactly this.',
  },
  {
    key: 'question_quality',
    label: 'Question quality',
    lookFor: 'Open, specific questions that advance understanding rather than confirm a pitch.',
  },
  {
    key: 'listening',
    label: 'Listening',
    lookFor:
      'Uses the prospect’s own language back to them, and stops talking once the buyer has answered.',
  },
  {
    key: 'problem_impact_depth',
    label: 'Problem/impact depth',
    lookFor: 'Gets past the stated problem to its cost, and confirms the priority.',
  },
  {
    key: 'tailored_demo',
    label: 'Tailored demo',
    lookFor:
      'Shows two to four relevant moments with check-in questions, not every feature. The SOP is explicit that breadth is the failure mode here.',
  },
  {
    key: 'feature_status_honesty',
    label: 'Feature-status honesty',
    lookFor:
      'Labels each capability LIVE, BETA, ROADMAP, USAGE/THIRD PARTY or NOT INCLUDED, and attaches no date to a roadmap item unless it is in the approved terms.',
  },
  {
    key: 'objection_diagnosis',
    label: 'Objection diagnosis',
    lookFor:
      'Diagnoses what the objection actually is before answering it — amount, timing or confidence, not a reflexive rebuttal.',
  },
  {
    key: 'clear_ask',
    label: 'Clear ask',
    lookFor: 'Makes one unambiguous request, calmly and without manufactured urgency.',
  },
  {
    key: 'scheduled_next',
    label: 'Scheduled NEXT',
    lookFor:
      'Books the next step live and sends the invite before goodbye. An unscheduled next step is the SOP’s definition of a stalled record.',
  },
];

export function dimensionByKey(key: string): CoachingDimension | undefined {
  return COACHING_DIMENSIONS.find((dimension) => dimension.key === key);
}

/**
 * LACE — the SOP's objection frame.
 *
 * Named in order because the order IS the method: acknowledging before
 * listening is placation, and executing a next step before clarifying is the
 * reflexive rebuttal the frame exists to prevent.
 */
export const LACE_STEPS = [
  { key: 'listen', label: 'Listen' },
  { key: 'acknowledge', label: 'Acknowledge' },
  { key: 'clarify', label: 'Clarify' },
  { key: 'execute', label: 'Execute a next step' },
] as const;

export interface ApprovedObjection {
  key: string;
  /** The objection as the SOP records a buyer saying it. */
  objection: string;
  /** The approved human response. */
  response: string;
  /** The approved next action. */
  nextAction: string;
}

/**
 * The approved objection library.
 *
 * THE COACH NEVER INVENTS A RESPONSE. An objection that does not match an entry
 * here is reported as unmapped so a human handles it. An invented rebuttal is
 * how an unapproved claim reaches a prospect wearing the authority of the SOP —
 * and it would carry that authority precisely because it appeared in the
 * coaching tool.
 */
export const APPROVED_OBJECTIONS: ApprovedObjection[] = [
  {
    key: 'too_expensive',
    objection: 'It is too expensive.',
    response:
      'It sounds like the investment is not yet justified by the value you see. Is the concern the amount, the timing, or confidence that the outcome will happen? Then quantify the problem and compare only to approved terms.',
    nextAction: 'Resolve value/scope; book decision; no unapproved discount.',
  },
  {
    key: 'need_to_think',
    objection: 'I need to think about it.',
    response:
      'Absolutely. Usually "think about it" means a question is still unresolved. What specifically do you need to become comfortable with?',
    nextAction: 'Name question, owner, decision date, and next meeting.',
  },
  {
    key: 'send_information',
    objection: 'Send me information.',
    response:
      'Happy to. To avoid sending a generic pile, what question should the information help you answer?',
    nextAction: 'Send one relevant asset; set 10-minute review time.',
  },
  {
    key: 'have_a_crm',
    objection: 'We already have a CRM.',
    response:
      'That may be the right answer. What does it do well, and where does your team still work around it?',
    nextAction: 'Identify gap/fit; do not attack competitor.',
  },
  {
    key: 'too_busy',
    objection: 'We are too busy.',
    response:
      'That makes sense. Is the busyness a reason to wait, or part of the problem you need the system to reduce?',
    nextAction: 'Offer short fit call or buyer-selected future date.',
  },
  {
    key: 'prelaunch_risky',
    objection: 'Prelaunch feels risky.',
    response:
      'That is a fair concern. What risk matters most: reliability, support, roadmap, data, adoption, or the commercial terms?',
    nextAction: 'Answer with approved evidence; document gap; schedule risk review.',
  },
  {
    key: 'need_partner_team',
    objection: 'I need my partner/team.',
    response:
      'Of course. What will they care about most, and can we include them so you are not carrying the whole explanation?',
    nextAction: 'Book stakeholder meeting; send tailored recap.',
  },
  {
    key: 'need_roadmap_feature',
    objection: 'We need a roadmap feature.',
    response:
      'I do not want to sell you a future promise. Today that is the current status. Is it a must-have for purchase, or could the current workflow solve enough value without it?',
    nextAction: 'Record dependency; Product answer in writing; qualify honestly.',
  },
  {
    key: 'not_now',
    objection: 'Not now.',
    response:
      'Understood. What would need to happen for this to become relevant - and when should I check back?',
    nextAction: 'Nurture reason + exact date/event.',
  },
  {
    key: 'no',
    objection: 'No.',
    response:
      'Thank you for being direct. Was it fit, timing, trust, investment, or something we could have handled better?',
    nextAction: 'Close Lost with learning; respect contact preference.',
  },
];

export function objectionByKey(key: string): ApprovedObjection | undefined {
  return APPROVED_OBJECTIONS.find((entry) => entry.key === key);
}

/**
 * The SOP's "what not to do" list, kept machine-readable because these are the
 * behaviours the coach must be able to flag by name rather than describe.
 */
export const COACHING_ANTIPATTERNS = [
  'interrupt',
  'debate',
  'minimize',
  'stack_features',
  'create_fake_urgency',
  'promise_roadmap_dates',
  'keep_talking_after_the_buyer_has_answered',
] as const;
