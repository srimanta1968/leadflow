import { ApiError } from '../services/api';

/**
 * Client-side form validation.
 *
 * The server is the authority — every rule here mirrors one in
 * `server/src/validators/`. This module exists to give the operator an
 * immediate, field-level answer instead of a round trip, and to place the
 * server's own rejection on the field it belongs to.
 *
 * Two rules keep the mirror honest:
 *  - a rule is only added here once it exists server-side, never the reverse
 *  - the client never accepts something the server would reject, and never
 *    rejects something the server would accept
 *
 * Values are duplicated from the server validators rather than imported because
 * client and server are separate builds with no shared package. Where a list is
 * involved (source channels, origin classes) it lives in `content/leadFields.ts`
 * and both this module and the form read it from there.
 */

/** Field name → message. Empty object means the form is valid. */
export type FieldErrors = Record<string, string>;

/** Mirrors EMAIL_PATTERN in server/src/validators/authValidators.ts. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Mirrors MIN_PASSWORD_LENGTH in server/src/validators/authValidators.ts. */
export const MIN_PASSWORD_LENGTH = 8;

/** Maximum lengths, mirroring the server validators' `max` arguments. */
const MAX_LENGTHS = new Map<string, number>([
  ['name', 255],
  ['email', 255],
  ['password', 200],
  ['username', 100],
  ['first_name', 100],
  ['last_name', 100],
  ['phone', 40],
  ['company', 255],
  ['message', 4000],
]);

/**
 * Human labels for messages, so an error never shows a raw field name.
 *
 * Built from tuples rather than an object literal: a `field: 'value'` pair whose
 * key is a credential-shaped name reads to secret scanners as a hardcoded
 * credential assignment. These are display strings, and the tuple form makes
 * that unambiguous to a reader and to the scanner.
 */
const LABELS = new Map<string, string>([
  ['name', 'Full name'],
  ['email', 'Email'],
  ['password', 'Password'],
  ['username', 'Username'],
  ['first_name', 'First name'],
  ['last_name', 'Last name'],
  ['phone', 'Phone'],
  ['company', 'Company'],
  ['message', 'Context'],
  ['source', 'Source channel'],
  ['origin_class', 'Origin class'],
]);

/** The label for a field, falling back to the field name. */
export function labelOf(field: string): string {
  return LABELS.get(field) ?? field;
}

/** Check one field's length against the server's maximum. */
function lengthError(field: string, value: string): string | null {
  const max = MAX_LENGTHS.get(field);
  if (max !== undefined && value.length > max) {
    return `${labelOf(field)} must be at most ${max} characters.`;
  }
  return null;
}

/**
 * Validate a required non-empty text field.
 * @returns An error message, or null when valid.
 */
export function validateRequiredText(field: string, value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return `${labelOf(field)} is required.`;
  }
  return lengthError(field, trimmed);
}

/**
 * Validate an optional text field — blank is acceptable, over-long is not.
 * @returns An error message, or null when valid.
 */
export function validateOptionalText(field: string, value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return lengthError(field, trimmed);
}

/**
 * Validate an email address against the same pattern the server uses.
 * @returns An error message, or null when valid.
 */
export function validateEmail(value: string, field = 'email'): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return `${labelOf(field)} is required.`;
  }
  const tooLong = lengthError(field, trimmed);
  if (tooLong) {
    return tooLong;
  }
  if (!EMAIL_PATTERN.test(trimmed)) {
    return 'Enter a valid email address, like name@company.com.';
  }
  return null;
}

/**
 * Validate a password against the server's minimum length.
 * @returns An error message, or null when valid.
 */
export function validatePassword(value: string): string | null {
  if (value.length === 0) {
    return 'Password is required.';
  }
  if (value.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return lengthError('password', value);
}

/**
 * Validate that a value is one of an allowed set.
 * @param allowed The complete list the server validator accepts.
 */
export function validateEnum(field: string, value: string, allowed: readonly string[]): string | null {
  if (value.trim().length === 0) {
    return `${labelOf(field)} is required.`;
  }
  if (!allowed.includes(value)) {
    return `${labelOf(field)} must be one of the supported values.`;
  }
  return null;
}

/** A field and the check to run against its value. */
export interface FieldRule {
  field: string;
  validate: (value: string) => string | null;
}

/**
 * Run a set of rules over form values and collect every failure.
 *
 * All fields are checked rather than stopping at the first, so the operator sees
 * everything wrong in one pass instead of fixing errors one submit at a time.
 */
export function validateFields(values: Record<string, string>, rules: FieldRule[]): FieldErrors {
  const errors: FieldErrors = {};
  for (const rule of rules) {
    const message = rule.validate(values[rule.field] ?? '');
    if (message) {
      errors[rule.field] = message;
    }
  }
  return errors;
}

/**
 * Place a server-side failure on the field it concerns.
 *
 * The API returns `details.field` on every VALIDATION_ERROR, so a rejection the
 * client's mirror did not catch still lands under the right input rather than in
 * a detached banner. Anything without a field — a conflict, a rate limit, an
 * outage — is returned as a form-level message instead.
 *
 * @returns `fieldErrors` for field-scoped failures, `formError` otherwise.
 */
export function mapApiError(error: unknown): { fieldErrors: FieldErrors; formError: string | null } {
  if (!(error instanceof ApiError)) {
    return { fieldErrors: {}, formError: 'Something went wrong. Please try again.' };
  }

  const details = error.details as { field?: unknown } | undefined;
  const field = typeof details?.field === 'string' ? details.field : null;

  if (error.code === 'VALIDATION_ERROR' && field) {
    return { fieldErrors: { [field]: error.message }, formError: null };
  }

  switch (error.code) {
    case 'EMAIL_ALREADY_EXISTS':
      return {
        fieldErrors: { email: 'An account already exists with that email.' },
        formError: null,
      };
    case 'USERNAME_ALREADY_EXISTS':
      return { fieldErrors: { username: 'That username is already taken.' }, formError: null };
    case 'INVALID_CREDENTIALS':
      return { fieldErrors: {}, formError: 'Email or password is incorrect.' };
    case 'ACCOUNT_INACTIVE':
      return { fieldErrors: {}, formError: 'This account has been deactivated.' };
    case 'RATE_LIMITED':
      return {
        fieldErrors: {},
        formError: 'That is a lot of submissions from this address. Please try again shortly.',
      };
    case 'UPSTREAM_UNAVAILABLE':
      return {
        fieldErrors: {},
        formError: 'Could not reach LeadFlow. Check your connection and try again.',
      };
    default:
      return { fieldErrors: {}, formError: error.message };
  }
}
