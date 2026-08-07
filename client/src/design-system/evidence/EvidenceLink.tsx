import { useState } from 'react';

/**
 * The evidence link, and the audited PII reveal behind it.
 *
 * THE VALUE IS NOT HELD LOCALLY AND THEN UNMASKED. `reveal` is an async fetch,
 * so the only way to see a sensitive value is to make the call that records the
 * looking. A component that received the plaintext and hid it behind a CSS class
 * would emit an audit event as a courtesy — trivially bypassed by anyone reading
 * the network tab, and worse than no audit because the ledger would claim to be
 * complete.
 *
 * WHAT IS NOT WIRED, and why it is a seam rather than a stub. The reveal needs a
 * server route wrapped in `governed()`, which appends `pii.revealed.v1` on its
 * own — that part is a few lines. What it does NOT have is a policy action:
 * `pii.reveal` is absent from server/src/config/roles.ts, and that file states
 * that where the SOP is silent an entry must say so rather than invent authority,
 * because a fabricated permission is indistinguishable from a real one once it is
 * in the file. Deciding WHICH of the nine actors may reveal a customer's phone
 * number is a governance decision, not a frontend one. Until it is made this
 * component asks its caller for the fetch and refuses to guess.
 */

export interface EvidenceLinkProps {
  /** What is being opened, for the label and the audit trail. */
  label: string;
  /** Masked placeholder shown until revealed. */
  masked?: string;
  /**
   * Fetches the real value. MUST be the audited server call — if this resolves
   * from something already in the browser, the audit event is decoration.
   */
  reveal?: () => Promise<string>;
  /** Opens the underlying blob or record instead of revealing a value. */
  onOpen?: () => void;
}

export function EvidenceLink({ label, masked = '••••••', reveal, onOpen }: EvidenceLinkProps) {
  const [value, setValue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onReveal(): Promise<void> {
    if (!reveal || busy) return;
    setBusy(true);
    setError(null);
    try {
      setValue(await reveal());
    } catch (e) {
      // A failed reveal shows nothing and says so. Falling back to the masked
      // form with no message would read as "there is nothing to see".
      setError(e instanceof Error ? e.message : 'Could not reveal this value.');
    } finally {
      setBusy(false);
    }
  }

  if (onOpen && !reveal) {
    return (
      <button type="button" onClick={onOpen} className="text-xs text-blue underline-offset-2 hover:underline">
        {label}
      </button>
    );
  }

  if (value !== null) {
    return (
      <span className="inline-flex items-center gap-2">
        <span className="font-mono text-text">{value}</span>
        {/* Says the looking was recorded. An operator who knows it is logged
            behaves differently from one who assumes it is not, and that is the
            point of the audit rather than a side effect. */}
        <span className="text-[10px] uppercase tracking-wider text-soft">recorded</span>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-2">
      <span className="font-mono text-soft">{masked}</span>
      <button
        type="button"
        onClick={() => void onReveal()}
        disabled={busy || !reveal}
        title={reveal ? 'Revealing this value is recorded in the audit trail' : 'Reveal is not available'}
        className="text-xs text-blue underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:text-soft disabled:no-underline"
      >
        {busy ? 'Revealing…' : 'Reveal'}
      </button>
      {error && <span className="text-[11px] text-red">{error}</span>}
    </span>
  );
}
