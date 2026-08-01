import { describe, expect, it } from 'vitest';
import { FAILURE, SUCCESS, failureFor } from '../../src/content/messages';
// Imported from the SERVER on purpose. `errors.ts` is dependency-free, so it
// loads cleanly here, and importing the real vocabulary means adding a server
// error code without a user-facing message fails this test instead of shipping
// as a raw INTERNAL_ERROR in the UI.
import { ErrorCodes } from '../../../server/src/utils/errors';

/**
 * The message catalogue is the only place user-facing wording is defined, so
 * these tests guard two things that would otherwise rot silently: that every
 * error code the server can return has a message, and that the messages keep the
 * tone rules the catalogue documents.
 */

describe('every server error code has a catalogue entry', () => {
  it.each(Object.values(ErrorCodes))('%s is covered', (code) => {
    expect(FAILURE[code], `no message defined for ${code}`).toBeDefined();
  });

  it('covers exactly the server vocabulary, with no orphan entries', () => {
    const serverCodes = new Set<string>(Object.values(ErrorCodes));
    const orphans = Object.keys(FAILURE).filter((code) => !serverCodes.has(code));
    expect(orphans, 'catalogue entries for codes the server never returns').toEqual([]);
  });
});

describe('failureFor', () => {
  it('returns the catalogue entry for a known code', () => {
    expect(failureFor('INVALID_CREDENTIALS').title).toBe('Email or password is incorrect');
  });

  it('falls back to INTERNAL_ERROR for an unrecognised code', () => {
    expect(failureFor('SOMETHING_NEW_FROM_THE_SERVER')).toEqual(FAILURE.INTERNAL_ERROR);
  });

  it('overrides the detail when the server message is more specific', () => {
    const message = failureFor('VALIDATION_ERROR', "'source' must be one of: web_form");
    expect(message.title).toBe(FAILURE.VALIDATION_ERROR.title);
    expect(message.detail).toBe("'source' must be one of: web_form");
  });

  it('does not mutate the catalogue when overriding the detail', () => {
    const original = FAILURE.VALIDATION_ERROR.detail;
    failureFor('VALIDATION_ERROR', 'a one-off detail');
    expect(FAILURE.VALIDATION_ERROR.detail).toBe(original);
  });
});

describe('tone assignment reflects severity', () => {
  it('treats a rate limit as a warning, not an error — it resolves by waiting', () => {
    expect(FAILURE.RATE_LIMITED.tone).toBe('warning');
  });

  it('treats an unreachable API as an error', () => {
    expect(FAILURE.UPSTREAM_UNAVAILABLE.tone).toBe('error');
  });

  it('reports a delivered upstream assertion as success', () => {
    expect(SUCCESS.leadCaptured('Ada').tone).toBe('success');
  });

  it('reports a DEFERRED upstream assertion as a warning, never as success', () => {
    // The capture is durable, but claiming the provenance assertion landed when
    // it has not is precisely the quiet lie this product exists to prevent.
    const message = SUCCESS.leadCapturedDeferred('Ada');
    expect(message.tone).toBe('warning');
    expect(message.title).toContain('deferred');
  });
});

describe('message content', () => {
  it('names the captured lead so the confirmation is specific', () => {
    expect(SUCCESS.leadCaptured('Priya Raman').detail).toContain('Priya Raman');
  });

  it('pluralises the inbox count correctly', () => {
    expect(SUCCESS.inboxRefreshed(1).title).toBe('1 capture loaded');
    expect(SUCCESS.inboxRefreshed(4).title).toBe('4 captures loaded');
  });

  it('gives a next action on every failure that has one', () => {
    const actionable = [
      'EMAIL_ALREADY_EXISTS',
      'USERNAME_ALREADY_EXISTS',
      'UNAUTHENTICATED',
      'INVALID_TOKEN',
      'RATE_LIMITED',
      'UPSTREAM_UNAVAILABLE',
    ];
    for (const code of actionable) {
      expect(FAILURE[code].detail, `${code} should tell the user what to do`).toBeTruthy();
    }
  });
});
