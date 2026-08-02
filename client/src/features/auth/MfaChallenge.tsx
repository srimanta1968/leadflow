import { FormEvent, useState } from 'react';
import { Field, FormError } from '../../components/forms/Field';
import { Callout } from './AuthCard';

/** Digits in a challenge code. */
export const MFA_CODE_LENGTH = 6;

/**
 * Whether a typed code is worth submitting.
 *
 * Checked locally only for SHAPE, never for correctness — a wrong-but-well-formed
 * code must still go to the server, because only the server knows whether it
 * matches and how many attempts remain.
 *
 * @param code Raw input, possibly containing the spaces people paste.
 */
export function isSubmittableCode(code: string): boolean {
  const digits = code.replace(/\s/g, '');
  return new RegExp(`^\\d{${MFA_CODE_LENGTH}}$`).test(digits);
}

/** Strip the formatting people paste in from an authenticator or SMS. */
export function normaliseCode(code: string): string {
  return code.replace(/\D/g, '').slice(0, MFA_CODE_LENGTH);
}

interface MfaChallengeProps {
  /** Where the code was sent, shown so the person knows which device to check. */
  destinationHint: string;
  /** Verify the code. Rejects with an ApiError the caller maps to a message. */
  onVerify: (code: string) => Promise<void>;
  /** Request a new code. */
  onResend: () => Promise<void>;
}

/**
 * The second factor: enter the code we sent, or ask for another.
 *
 * ONE input, not six boxes. The six-box pattern in the mockup's visual language
 * looks tidy and is a keyboard trap in practice — it needs bespoke arrow, paste
 * and backspace handling to be usable, screen readers announce six unlabelled
 * fields, and pasting a code from a password manager fills only the first. A
 * single `inputMode="numeric"` field with `autoComplete="one-time-code"` lets
 * both iOS and Android offer the SMS code directly, is one tab stop, and pastes
 * correctly. That also keeps this a design-system `.input` rather than the
 * bespoke control the acceptance criterion forbids.
 */
export function MfaChallenge({ destinationHint, onVerify, onResend }: MfaChallengeProps) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resent, setResent] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);

    if (!isSubmittableCode(code)) {
      setError(`Enter the ${MFA_CODE_LENGTH}-digit code we sent you.`);
      return;
    }

    setSubmitting(true);
    try {
      await onVerify(normaliseCode(code));
    } catch (verifyError) {
      setSubmitting(false);
      // The code is cleared on failure: leaving a rejected code in the field
      // means the next attempt starts by deleting six characters.
      setCode('');
      setError(
        verifyError instanceof Error && verifyError.message
          ? verifyError.message
          : 'That code was not accepted. Try the most recent one.'
      );
    }
  }

  async function handleResend(): Promise<void> {
    setError(null);
    try {
      await onResend();
      setResent(true);
    } catch {
      setError('We could not send another code. Try again in a moment.');
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <Callout tone="info">
        We sent a {MFA_CODE_LENGTH}-digit code to {destinationHint}.
      </Callout>

      <div className="mt-5">
        <Field id="mfa-code" label="Verification code" required error={error ?? undefined}>
          {(wiring) => (
            <input
              {...wiring}
              name="code"
              // `one-time-code` is what lets the OS surface the SMS code above
              // the keyboard. Without it a person retypes it from a notification.
              autoComplete="one-time-code"
              inputMode="numeric"
              // Not type="number": that gives a spinner, accepts "e" and "-",
              // and silently drops a leading zero.
              type="text"
              maxLength={MFA_CODE_LENGTH}
              autoFocus
              value={code}
              onChange={(event) => setCode(normaliseCode(event.target.value))}
              placeholder="123456"
            />
          )}
        </Field>
      </div>

      <FormError error={error} />

      <button type="submit" className="lf-btn-primary mt-7 w-full" disabled={submitting}>
        {submitting ? 'Verifying…' : 'Verify and continue'}
      </button>

      {/*
        A real button, not a link with an onClick. It performs an action rather
        than navigating, and it has to be reachable by Tab and activated by both
        Enter and Space — which a <a> gives only for Enter.
      */}
      <button
        type="button"
        className="lf-btn-ghost mt-3 w-full text-sm"
        onClick={handleResend}
        disabled={submitting}
      >
        {resent ? 'Code sent again' : 'Send a new code'}
      </button>
    </form>
  );
}
