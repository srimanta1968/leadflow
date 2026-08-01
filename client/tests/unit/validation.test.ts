import { describe, expect, it } from 'vitest';
import {
  MIN_PASSWORD_LENGTH,
  mapApiError,
  validateEmail,
  validateEnum,
  validateFields,
  validateOptionalText,
  validatePassword,
  validateRequiredText,
} from '../../src/utils/validation';
import { ApiError } from '../../src/services/api';

/**
 * These tests exist to keep the client validators in lockstep with
 * `server/src/validators/`. Each case states the input and the verdict the
 * SERVER gives it — if the server's rule changes and this module is not updated,
 * one of these fails, which is the whole point. A client that accepts what the
 * server rejects produces a pointless round trip; a client that rejects what the
 * server accepts blocks legitimate input and is worse.
 */

/** One boundary case: an input and whether the server accepts it. */
interface BoundaryCase {
  label: string;
  input: string;
  /** True when the server accepts this input. */
  accepted: boolean;
  /** Fragment the rejection message must contain. */
  expects?: string;
}

/** The verdict a validator returned, normalised for comparison. */
type Verdict = { accepted: boolean; message: string | null };

/** Run a validator and describe its verdict. */
function verdictOf(result: string | null): Verdict {
  return { accepted: result === null, message: result };
}

describe('validateEmail — mirrors EMAIL_PATTERN in authValidators.ts', () => {
  it('accepts an ordinary address', () => {
    expect(validateEmail('ada@company.com')).toBeNull();
  });

  it('accepts a subdomain and a plus tag', () => {
    expect(validateEmail('ada+leads@mail.company.co.uk')).toBeNull();
  });

  it('rejects a blank value as required', () => {
    expect(validateEmail('')).toBe('Email is required.');
  });

  it('rejects an address with no @', () => {
    expect(validateEmail('not-an-email')).toContain('valid email address');
  });

  it('rejects an address with no dot in the domain', () => {
    expect(validateEmail('a@b')).toContain('valid email address');
  });

  it('rejects a single-character TLD, matching the {2,} in the server pattern', () => {
    expect(validateEmail('a@b.c')).toContain('valid email address');
  });

  it('accepts a two-character TLD', () => {
    expect(validateEmail('a@b.co')).toBeNull();
  });

  it('rejects an address containing whitespace', () => {
    expect(validateEmail('ada lovelace@company.com')).toContain('valid email address');
  });

  it('accepts an address of exactly 255 characters, the server maximum', () => {
    // 250 + '@b.co' = 255. The server checks `length > max`, so 255 is valid.
    expect(validateEmail(`${'a'.repeat(250)}@b.co`)).toBeNull();
  });

  it('rejects an address one character over the 255-character maximum', () => {
    expect(validateEmail(`${'a'.repeat(251)}@b.co`)).toContain('at most 255');
  });
});

describe('validatePassword — mirrors MIN_PASSWORD_LENGTH in authValidators.ts', () => {
  it('rejects a blank password', () => {
    expect(validatePassword('')).toBe('Password is required.');
  });

  it(`rejects a password one character under the ${MIN_PASSWORD_LENGTH}-character minimum`, () => {
    expect(validatePassword('a'.repeat(MIN_PASSWORD_LENGTH - 1))).toContain(
      `at least ${MIN_PASSWORD_LENGTH}`
    );
  });

  it('accepts a password exactly at the minimum', () => {
    expect(validatePassword('a'.repeat(MIN_PASSWORD_LENGTH))).toBeNull();
  });

  it('rejects a password over the 200-character server maximum', () => {
    expect(validatePassword('a'.repeat(201))).toContain('at most 200');
  });
});

describe('validateRequiredText', () => {
  it('rejects a value that is only whitespace', () => {
    expect(validateRequiredText('name', '   ')).toBe('Full name is required.');
  });

  it('accepts a value once trimmed', () => {
    expect(validateRequiredText('name', '  Ada  ')).toBeNull();
  });

  it('measures length after trimming, as the server does', () => {
    expect(validateRequiredText('name', `  ${'x'.repeat(255)}  `)).toBeNull();
    expect(validateRequiredText('name', 'x'.repeat(256))).toContain('at most 255');
  });
});

describe('validateOptionalText', () => {
  it('accepts blank, because the server treats blank as absent', () => {
    expect(validateOptionalText('company', '')).toBeNull();
    expect(validateOptionalText('company', '   ')).toBeNull();
  });

  it('still enforces the maximum when a value is present', () => {
    expect(validateOptionalText('company', 'y'.repeat(256))).toContain('at most 255');
  });

  it('enforces the 4000-character maximum on message', () => {
    expect(validateOptionalText('message', 'z'.repeat(4000))).toBeNull();
    expect(validateOptionalText('message', 'z'.repeat(4001))).toContain('at most 4000');
  });

  it('enforces the 40-character maximum on phone', () => {
    expect(validateOptionalText('phone', '1'.repeat(41))).toContain('at most 40');
  });
});

describe('validateEnum — mirrors the source and origin lists in leadValidators.ts', () => {
  const sources = ['web_form', 'landing_page', 'api'] as const;

  it('accepts a listed value', () => {
    expect(validateEnum('source', 'web_form', sources)).toBeNull();
  });

  it('rejects an unlisted value', () => {
    expect(validateEnum('source', 'carrier_pigeon', sources)).toContain('supported values');
  });

  it('rejects a blank value as required', () => {
    expect(validateEnum('source', '', sources)).toBe('Source channel is required.');
  });
});

describe('validateFields', () => {
  it('returns an empty object when everything passes', () => {
    const errors = validateFields({ name: 'Ada', email: 'ada@company.com' }, [
      { field: 'name', validate: (v) => validateRequiredText('name', v) },
      { field: 'email', validate: (v) => validateEmail(v) },
    ]);
    expect(errors).toEqual({});
  });

  it('reports every failure rather than stopping at the first', () => {
    const errors = validateFields({ name: '', email: 'bad' }, [
      { field: 'name', validate: (v) => validateRequiredText('name', v) },
      { field: 'email', validate: (v) => validateEmail(v) },
    ]);
    expect(Object.keys(errors).sort()).toEqual(['email', 'name']);
  });

  it('treats a missing key as an empty value', () => {
    const errors = validateFields({}, [
      { field: 'name', validate: (v) => validateRequiredText('name', v) },
    ]);
    expect(errors.name).toBe('Full name is required.');
  });
});

describe('length boundaries agree with the server column widths', () => {
  /**
   * Each row was confirmed against the live API. The 256-character email case is
   * why this table exists: it returned 500 INTERNAL_ERROR before
   * `validateLeadCapture` gained its length check, because the value reached the
   * VARCHAR(255) column unbounded.
   */
  const emailCases: BoundaryCase[] = [
    { label: '254 characters', input: `${'a'.repeat(247)}@bnd.co`, accepted: true },
    { label: '255 characters — exactly the maximum', input: `${'a'.repeat(248)}@bnd.co`, accepted: true },
    {
      label: '256 characters — one over',
      input: `${'a'.repeat(249)}@bnd.co`,
      accepted: false,
      expects: 'at most 255',
    },
  ];

  it.each(emailCases)('email of $label', ({ input, accepted, expects }) => {
    const verdict = verdictOf(validateEmail(input));
    expect(verdict.accepted).toBe(accepted);
    if (expects) {
      expect(verdict.message).toContain(expects);
    }
  });

  const nameCases: BoundaryCase[] = [
    { label: '255 characters', input: 'x'.repeat(255), accepted: true },
    { label: '256 characters', input: 'x'.repeat(256), accepted: false, expects: 'at most 255' },
  ];

  it.each(nameCases)('name of $label', ({ input, accepted, expects }) => {
    const verdict = verdictOf(validateRequiredText('name', input));
    expect(verdict.accepted).toBe(accepted);
    if (expects) {
      expect(verdict.message).toContain(expects);
    }
  });
});

describe('mapApiError — places a server rejection on the right field', () => {
  it('uses details.field for a VALIDATION_ERROR', () => {
    const error = new ApiError(400, 'VALIDATION_ERROR', "'source' must be one of: web_form", {
      field: 'source',
    });
    expect(mapApiError(error)).toEqual({
      fieldErrors: { source: "'source' must be one of: web_form" },
      formError: null,
    });
  });

  it('falls back to a form-level message when VALIDATION_ERROR carries no field', () => {
    const error = new ApiError(400, 'VALIDATION_ERROR', 'Body is malformed');
    const mapped = mapApiError(error);
    expect(mapped.fieldErrors).toEqual({});
    expect(mapped.formError).toBe('Body is malformed');
  });

  it('puts EMAIL_ALREADY_EXISTS on the email field', () => {
    const mapped = mapApiError(new ApiError(409, 'EMAIL_ALREADY_EXISTS', 'exists'));
    expect(mapped.fieldErrors.email).toContain('already exists');
    expect(mapped.formError).toBeNull();
  });

  it('puts USERNAME_ALREADY_EXISTS on the username field', () => {
    const mapped = mapApiError(new ApiError(409, 'USERNAME_ALREADY_EXISTS', 'taken'));
    expect(mapped.fieldErrors.username).toContain('already taken');
  });

  it('keeps INVALID_CREDENTIALS form-level, naming neither field', () => {
    const mapped = mapApiError(new ApiError(401, 'INVALID_CREDENTIALS', 'nope'));
    expect(mapped.fieldErrors).toEqual({});
    expect(mapped.formError).toBe('Email or password is incorrect.');
  });

  it('explains a rate limit in terms the submitter can act on', () => {
    const mapped = mapApiError(new ApiError(429, 'RATE_LIMITED', 'too many'));
    expect(mapped.formError).toContain('try again shortly');
  });

  it('explains an unreachable API rather than showing a raw message', () => {
    const mapped = mapApiError(new ApiError(0, 'UPSTREAM_UNAVAILABLE', 'fetch failed'));
    expect(mapped.formError).toContain('Could not reach LeadFlow');
  });

  it('handles a non-ApiError without leaking its contents', () => {
    const mapped = mapApiError(new TypeError('undefined is not a function'));
    expect(mapped.formError).toBe('Something went wrong. Please try again.');
    expect(mapped.fieldErrors).toEqual({});
  });
});
