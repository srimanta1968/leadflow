import { describe, expect, it } from 'vitest';
import { initialsFor, secondaryLine } from '../../src/features/auth/ProfileChip';
import { isSubmittableCode, normaliseCode, MFA_CODE_LENGTH } from '../../src/features/auth/MfaChallenge';
import {
  nextStep,
  previousStep,
  validateStep,
  SIGNUP_STEPS,
} from '../../src/features/auth/TenantSignupWizard';

/**
 * The auth screens' decision logic.
 *
 * Only the parts a browser scenario cannot pin down precisely: which two
 * letters an avatar shows, the exact separator in the profile lock-up, what
 * counts as a submittable code, and which step follows which. The screens
 * themselves are covered by the Gherkin scenarios — per MUST-67 a .feature
 * scenario IS the end-to-end test, so nothing here restates navigation or form
 * submission.
 */

describe('profile chip lock-up', () => {
  it('takes the first and last initial, the way a person abbreviates a name', () => {
    expect(initialsFor('Ada Lovelace')).toBe('AL');
    // Not "AK" — a middle name is not the second initial anyone would use.
    expect(initialsFor('Ada King Lovelace')).toBe('AL');
  });

  it('uses two letters of a single-word name', () => {
    expect(initialsFor('Ada')).toBe('AD');
  });

  it('never renders an empty avatar, which reads as a broken image', () => {
    expect(initialsFor('')).toBe('·');
    expect(initialsFor('   ')).toBe('·');
  });

  it('renders the secondary line with the mockup separator exactly', () => {
    // A MIDDLE DOT with a space either side. The criterion pins this to the
    // mockup character-for-character, so it is asserted by codepoint rather
    // than by eye.
    const line = secondaryLine('Owner', 'LUP-1001');

    expect(line).toBe('Owner · LUP-1001');
    expect(line).toContain('·');
    expect(line).not.toContain('-1001 |');
  });
});

describe('MFA code handling', () => {
  it('accepts a complete code and rejects a short one', () => {
    expect(isSubmittableCode('123456')).toBe(true);
    expect(isSubmittableCode('12345')).toBe(false);
  });

  it('accepts a code pasted with spaces', () => {
    // Authenticator apps and SMS both hand out "123 456".
    expect(isSubmittableCode('123 456')).toBe(true);
  });

  it('rejects a code containing anything but digits', () => {
    expect(isSubmittableCode('12345a')).toBe(false);
  });

  it('strips formatting and caps the length while typing', () => {
    expect(normaliseCode('123-456')).toBe('123456');
    expect(normaliseCode('1234567890')).toHaveLength(MFA_CODE_LENGTH);
  });

  it('keeps a leading zero, which a numeric input would drop', () => {
    expect(normaliseCode('012345')).toBe('012345');
    expect(isSubmittableCode('012345')).toBe(true);
  });
});

describe('tenant signup wizard flow', () => {
  it('walks forward through every step and stops at the end', () => {
    expect(nextStep('workspace')).toBe('owner');
    expect(nextStep('owner')).toBe('confirm');
    expect(nextStep('confirm')).toBeNull();
  });

  it('walks back and stops at the start', () => {
    expect(previousStep('confirm')).toBe('owner');
    expect(previousStep('owner')).toBe('workspace');
    expect(previousStep('workspace')).toBeNull();
  });

  it('validates only the current step, so a later field cannot block progress', () => {
    // Naming the workspace must not be refused because no owner email has been
    // typed yet — the person has not reached that field.
    expect(validateStep('workspace', { workspaceName: 'Lynked-Up Pro' })).toEqual({});
  });

  it('refuses to advance past a step whose own required field is empty', () => {
    expect(Object.keys(validateStep('workspace', { workspaceName: '' }))).toContain(
      'workspaceName'
    );
  });

  it('checks the owner email is well formed, not merely present', () => {
    const errors = validateStep('owner', { ownerName: 'Ada', ownerEmail: 'not-an-email' });

    expect(Object.keys(errors)).toContain('ownerEmail');
  });

  it('asks nothing more on the confirm step', () => {
    expect(validateStep('confirm', {})).toEqual({});
  });

  it('orders the steps workspace, owner, confirm', () => {
    expect([...SIGNUP_STEPS]).toEqual(['workspace', 'owner', 'confirm']);
  });
});
