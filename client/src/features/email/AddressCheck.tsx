import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type AddressVerification } from '../../services/api';

/**
 * "Can we actually reach this address?", asked while somebody is still typing.
 *
 * WHY A SHARED PIECE RATHER THAN A LINE IN EACH FORM. Three screens take an
 * address that something will later be sent to — the invite form, quick capture
 * and the marketing lead form — and the wrong answer costs a different thing on
 * each. Written three times they would disagree about which verdicts are worth
 * showing, which is exactly the drift that makes a warning meaningless.
 *
 * IT NEVER BLOCKS SUBMISSION. The server decides what may be sent, and it
 * refuses only facts (see sendDecision on the server side). A client that
 * disabled its own submit button on `risky` would refuse addresses the server
 * would have accepted, and a client that did so on `unknown` would refuse real
 * customers whenever our own resolver had a bad minute.
 */

export interface AddressCheckState {
  /** Null until a check has been run for the current address. */
  verification: AddressVerification | null;
  checking: boolean;
  /** Run the check. Safe to call on blur repeatedly; identical input is a no-op. */
  check: (email: string) => void;
  /** Forget the verdict — call when the field is cleared or the form resets. */
  reset: () => void;
}

export function useAddressCheck(): AddressCheckState {
  const [verification, setVerification] = useState<AddressVerification | null>(null);
  const [checking, setChecking] = useState(false);
  // What we last ASKED about, so a blur with an unchanged value costs nothing.
  const asked = useRef<string | null>(null);
  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => () => inFlight.current?.abort(), []);

  const reset = useCallback((): void => {
    inFlight.current?.abort();
    inFlight.current = null;
    asked.current = null;
    setVerification(null);
    setChecking(false);
  }, []);

  const check = useCallback((email: string): void => {
    const value = email.trim();
    if (value === '') {
      reset();
      return;
    }
    if (asked.current === value) return;
    asked.current = value;

    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setChecking(true);

    void api
      .verifyEmailAddress(value, { signal: controller.signal })
      .then((report) => {
        setVerification(report.results[0] ?? null);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        /* SILENT. This is an advisory check: if it cannot run, the form behaves
           exactly as it did before it existed. Showing "the address check
           failed" beside an email field tells the user about our plumbing and
           gives them nothing to do about it. */
        if (error instanceof ApiError) {
          asked.current = null;
        }
        setVerification(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setChecking(false);
      });
  }, [reset]);

  return { verification, checking, check, reset };
}

const TONE: Record<string, string> = {
  undeliverable: 'text-red',
  risky: 'text-amber-700',
  deliverable: 'text-green',
  unknown: 'text-soft',
};

/**
 * The verdict, in one line under the field.
 *
 * `unknown` RENDERS NOTHING. It means our check could not run, which is not a
 * fact about the address and not something the person typing can act on.
 */
export function AddressVerdict({
  verification,
  checking,
  onAcceptSuggestion,
}: {
  verification: AddressVerification | null;
  checking?: boolean;
  /** Offered only when the caller can actually apply it to its field. */
  onAcceptSuggestion?: (address: string) => void;
}): JSX.Element | null {
  if (checking) {
    return <p className="mt-1 text-xs text-soft">Checking whether that address can receive email…</p>;
  }
  if (!verification || verification.verdict === 'unknown') return null;

  const tone = TONE[verification.verdict] ?? 'text-soft';

  return (
    <p className={`mt-1 text-xs ${tone}`} role={verification.verdict === 'undeliverable' ? 'alert' : undefined}>
      {verification.verdict === 'deliverable' ? (
        <>
          {/* The exchanger is named because it is the evidence. "Looks fine" is
              an opinion; "gmail-smtp-in.l.google.com answers for this domain" is
              the reason the opinion is held. */}
          That address can receive email
          {verification.mail_exchangers[0] ? ` — ${verification.domain} is served by ${verification.mail_exchangers[0]}.` : '.'}
        </>
      ) : (
        verification.reason
      )}
      {verification.did_you_mean && onAcceptSuggestion && (
        <>
          {' '}
          <button
            type="button"
            className="underline decoration-dotted underline-offset-2"
            onClick={() => onAcceptSuggestion(verification.did_you_mean as string)}
          >
            Use {verification.did_you_mean}
          </button>
        </>
      )}
    </p>
  );
}
