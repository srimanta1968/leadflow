/**
 * The user-facing message catalogue.
 *
 * Every confirmation and failure the application shows is defined here rather
 * than inline, for three reasons: the wording stays consistent across screens,
 * the tone stays consistent (state what happened and what to do, never blame the
 * user), and a copy change is one edit instead of a search.
 *
 * Tone rules applied throughout:
 *  - say what happened, not that "an error occurred"
 *  - give the next action when there is one
 *  - never claim an outcome that has not actually happened — a deferred upstream
 *    assertion is reported as deferred, not as success
 */

/** Severity of a message, which selects its colour and icon. */
export type MessageTone = 'success' | 'error' | 'warning' | 'info';

export interface Message {
  tone: MessageTone;
  title: string;
  /** Optional second line with the detail or the next step. */
  detail?: string;
}

/** Confirmations for actions that completed. */
export const SUCCESS = {
  leadCaptured: (name: string): Message => ({
    tone: 'success',
    title: 'Lead captured',
    detail: `${name} is in the Capture Inbox with a response clock running.`,
  }),
  leadCapturedDeferred: (name: string): Message => ({
    tone: 'warning',
    title: 'Lead captured — upstream assertion deferred',
    detail: `${name} is saved and visible now. The ProjexCloud provenance assertion has not landed yet and will reconcile.`,
  }),
  signedOut: (): Message => ({
    tone: 'info',
    title: 'Signed out',
  }),
  inboxRefreshed: (count: number): Message => ({
    tone: 'info',
    title: count === 1 ? '1 capture loaded' : `${count} captures loaded`,
  }),
} as const;

/**
 * Failures, keyed by the server's error code where one applies.
 *
 * Branching on `code` rather than on message text means a wording change on
 * either side cannot silently change behaviour.
 */
export const FAILURE: Record<string, Message> = {
  VALIDATION_ERROR: {
    tone: 'error',
    title: 'Some fields need attention',
    detail: 'The highlighted fields below explain what to change.',
  },
  EMAIL_ALREADY_EXISTS: {
    tone: 'error',
    title: 'That email is already registered',
    detail: 'Sign in instead, or use a different address.',
  },
  USERNAME_ALREADY_EXISTS: {
    tone: 'error',
    title: 'That username is taken',
    detail: 'Choose another one.',
  },
  INVALID_CREDENTIALS: {
    tone: 'error',
    title: 'Email or password is incorrect',
  },
  ACCOUNT_INACTIVE: {
    tone: 'error',
    title: 'This account has been deactivated',
    detail: 'Ask an administrator to reactivate it.',
  },
  UNAUTHENTICATED: {
    tone: 'error',
    title: 'Your session has ended',
    detail: 'Sign in again to continue.',
  },
  CONFIRMATION_REQUIRED: {
    tone: 'error',
    title: 'Confirm what will be sent',
    // Names the safeguard rather than the rule. An operator who sees "capture
    // must be confirmed" learns a hoop to jump through; one who sees that
    // nothing leaves the page unreviewed learns what the product guarantees
    // them — and is far more likely to actually read the preview.
    detail: 'Nothing leaves the page until you have reviewed the transmission preview and approved it.',
  },
  FORBIDDEN_FIELD: {
    tone: 'error',
    title: 'That capture contained something it should not',
    detail:
      'Cookies, tokens and hidden fields are never read or sent. The capture was refused rather than cleaned up, so this can be investigated.',
  },
  ORIGIN_CLASS_REQUIRED: {
    tone: 'error',
    title: 'Choose where this came from',
    // Says WHY rather than restating the rule. An operator told only "origin
    // class is required" reaches for whichever option clears the error; told
    // that the choice governs what may be done with the record, they pick the
    // true one. The claim is the point, not the field.
    detail:
      'Every capture records how we obtained the data. That claim decides what may be done with it, so it cannot be guessed for you.',
  },
  APPROVAL_REQUIRED: {
    tone: 'error',
    // NOT a refusal, and it must not read like one. The action is open to this
    // person; it needs a second pair of eyes. Told "you cannot do this", people
    // find a way around the product instead of through it.
    title: 'This needs a second approval',
    detail: 'You may make this change, but someone else has to sign it off first.',
  },
  NOT_IMPLEMENTED: {
    tone: 'error',
    title: 'Not available in this deployment',
    detail: 'Sign in through your organisation’s identity provider instead.',
  },
  INVALID_TOKEN: {
    tone: 'error',
    title: 'Your session has expired',
    detail: 'Sign in again to continue.',
  },
  FORBIDDEN: {
    tone: 'error',
    title: 'You do not have permission for that',
    detail: 'Your role does not include this action.',
  },
  NOT_FOUND: {
    tone: 'error',
    title: 'That record no longer exists',
    detail: 'It may have been removed or merged.',
  },
  CONFLICT: {
    tone: 'error',
    title: 'That conflicts with something already saved',
    detail: 'Reload to see the current state, then try again.',
  },
  RATE_LIMITED: {
    tone: 'warning',
    title: 'Too many submissions from this address',
    detail: 'Wait a moment and try again.',
  },
  UPSTREAM_UNAVAILABLE: {
    tone: 'error',
    title: 'Could not reach LeadFlow',
    detail: 'Check your connection, then retry.',
  },
  INTERNAL_ERROR: {
    tone: 'error',
    title: 'Something went wrong on our side',
    detail: 'The failure was logged. Please retry.',
  },
};

/**
 * The message for an error code, falling back to a generic one.
 *
 * @param code   The server's error code.
 * @param detail Optional override, used when the server's own message is more
 *               specific than the catalogue entry (a field-level rejection).
 */
export function failureFor(code: string, detail?: string): Message {
  const base = FAILURE[code] ?? FAILURE.INTERNAL_ERROR;
  return detail ? { ...base, detail } : base;
}
