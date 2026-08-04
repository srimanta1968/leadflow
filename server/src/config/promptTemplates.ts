/**
 * The versioned prompt library — every prompt this application may send.
 *
 * THERE IS NO PATH FOR FREE PROMPT TEXT. `complete()` takes a template KEY and a
 * slot map; it does not take a string. That is the difference between a prompt
 * library and a convention: a caller who can pass raw text is a caller who can
 * send unapproved copy, and the review that was supposed to happen once at
 * publication time silently becomes a review of every call site forever.
 *
 * PINNED HERE, ACTIVATED UPSTREAM. sdk-taxonomy owns the published templates and
 * which version is active; this file is the version LeadFlow was built and
 * tested against. When the taxonomy is reachable its active version wins — that
 * is the point of publishing centrally — and when it is not, generation
 * continues on the pinned version rather than stopping. See
 * `platform/ai/promptLibrary.ts` for why that fallback is safe here and is NOT
 * the general rule in this codebase.
 *
 * SLOTS ARE DECLARED, and rendering refuses an undeclared one. A template with
 * an open-ended interpolation is a template whose final text nobody approved.
 */

export interface PromptTemplate {
  /** Stable key, shared with sdk-taxonomy. Never rename — a rename orphans the history. */
  key: string;
  /**
   * The approved version of this template.
   *
   * Stamped onto every completion and onto every proposal it produces, so a
   * complaint about wording months later resolves to the copy that was approved
   * at the time rather than to whatever the library says today.
   */
  version: string;
  purpose: string;
  /**
   * Named slots the template accepts. Rendering refuses anything else, so a
   * caller cannot smuggle prose in through a variable.
   */
  slots: string[];
  /** The approved body, with `{slot}` markers. */
  body: string;
}

export const PROMPT_TEMPLATES: PromptTemplate[] = [
  {
    key: 'sdr_first_touch',
    // The same string migration 012's proposals were stamped with. Kept
    // identical deliberately: this file is now the single source for it, and
    // changing the value would orphan every proposal already stamped.
    version: 'sop-v3.0-email1',
    purpose:
      'Draft the SOP first-touch message. Personalisation is confined to the opening line and the reference to what the prospect responded to.',
    slots: ['first_name', 'reference', 'channel'],
    body: [
      'You are drafting a first touch for a sales rep to review.',
      'Open with the prospect first name: {first_name}.',
      'Reference what they responded to: {reference}.',
      'Channel: {channel}. Use the approved voice. State no price, no discount,',
      'no roadmap date and no guaranteed result. Offer a call and stop.',
    ].join('\n'),
  },
  {
    key: 'coach_call_review',
    version: 'sop-v3.0-coach1',
    purpose:
      'Summarise a recorded call against the coaching dimensions, for a manager to review.',
    slots: ['dimensions', 'transcript_ref'],
    body: [
      'Summarise the call at {transcript_ref} against these dimensions: {dimensions}.',
      'Quote only what was said. Do not infer intent the speaker did not state.',
      'Produce a summary a manager will review before it reaches the rep.',
    ].join('\n'),
  },
  {
    key: 'next_action_plan',
    version: 'sop-v3.0-next1',
    purpose: 'Suggest the next action on an open lead from its own history.',
    slots: ['lead_summary', 'last_activity_at'],
    body: [
      'Given this lead: {lead_summary}, last worked at {last_activity_at},',
      'suggest ONE next action with a due date. Suggest nothing that contacts',
      'the prospect directly — a message is a separate proposal a rep approves.',
    ].join('\n'),
  },
];

/** Look up one pinned template. */
export function promptTemplateByKey(key: string): PromptTemplate | undefined {
  return PROMPT_TEMPLATES.find((template) => template.key === key);
}

/**
 * The pinned version of a template, or a throw.
 *
 * Throws rather than returning undefined because every caller stamps the result
 * onto a stored record: a missing version would be written as `undefined` and
 * discovered months later by whoever is trying to work out what was said.
 */
export function promptTemplateVersion(key: string): string {
  const template = promptTemplateByKey(key);
  if (!template) {
    throw new Error(`No prompt template registered under '${key}'`);
  }
  return template.version;
}

/** Every registered key, for the taxonomy publisher and for tests. */
export function allPromptTemplateKeys(): string[] {
  return PROMPT_TEMPLATES.map((template) => template.key);
}
