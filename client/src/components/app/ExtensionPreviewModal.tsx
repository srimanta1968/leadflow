import { useEffect, useState } from 'react';
import {
  buildTransmissionPreview,
  hasTransmittableSelection,
  readSelection,
  TransmissionRow,
} from '../../features/capture/browserSelection';

interface ExtensionPreviewModalProps {
  open: boolean;
  onClose: () => void;
}

/** How each inclusion class reads and colours. */
const INCLUSION_TONE: Record<TransmissionRow['inclusion'], { label: string; className: string }> = {
  always: { label: 'Always sent', className: 'border-green/40 bg-green/10 text-green' },
  optional: { label: 'Your choice', className: 'border-blue/40 bg-blue/10 text-blue' },
  never: { label: 'Never sent', className: 'border-red/40 bg-red/10 text-red' },
};

/**
 * Extension Preview — what a browser capture would transmit, before it does.
 *
 * SHOWS THE OPERATOR'S REAL SELECTION, not a canned sample. A preview built
 * from example text proves nothing about the build in front of them; reading
 * the actual selection through the same `readSelection` boundary the extension
 * uses means what they see here is what the extension can see, full stop.
 *
 * The NEVER row is the reason this screen exists. An operator cannot tell a
 * build that does not send cookies from one that sends them and stays quiet
 * about it, so the promise is listed rather than merely kept.
 *
 * Nothing here transmits. The modal has no send control at all — it is the
 * preview half of the confirmation, and the capture itself happens in the
 * extension against a live page.
 */
export function ExtensionPreviewModal({ open, onClose }: ExtensionPreviewModalProps) {
  const [selectedText, setSelectedText] = useState('');
  const [retainSourceUrl, setRetainSourceUrl] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    // Read once, on open. Opening the modal collapses the page selection, so a
    // later read would always return empty and the preview would claim the
    // operator had selected nothing.
    setSelectedText(readSelection(typeof window === 'undefined' ? null : window.getSelection()));
  }, [open]);

  if (!open) {
    return null;
  }

  const sourceUrl = typeof window === 'undefined' ? null : window.location.href;
  const rows = buildTransmissionPreview({ selectedText, sourceUrl, retainSourceUrl });
  const hasSelection = hasTransmittableSelection(selectedText);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="extension-preview-title"
    >
      <div className="lf-panel-raised my-8 w-full max-w-2xl p-7">
        <header>
          <p className="lf-eyebrow">Browser capture</p>
          <h2 id="extension-preview-title" className="mt-1 text-xl font-bold text-text">
            Extension Preview
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            Exactly what a capture from this page would transmit. Selected visible text is the
            capture; everything else is listed so the promise is checkable.
          </p>
        </header>

        <section className="mt-6" aria-label="Selected text">
          <p className="lf-label">Your selection</p>
          {hasSelection ? (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-xl border border-line bg-panel2 p-4 font-mono text-xs leading-relaxed text-text">
              {selectedText}
            </pre>
          ) : (
            <p className="rounded-xl border border-line bg-panel2 p-4 text-sm text-soft">
              Nothing is selected. Highlight visible text on the page and open this preview again —
              a cursor is not a choice, so a collapsed selection captures nothing.
            </p>
          )}
        </section>

        <label className="mt-5 flex items-start gap-3 text-sm text-muted">
          <input
            type="checkbox"
            name="retainSourceUrl"
            checked={retainSourceUrl}
            onChange={(event) => setRetainSourceUrl(event.target.checked)}
            className="mt-0.5"
          />
          <span>
            Retain the source URL as provenance
            <span className="mt-0.5 block text-xs text-soft">{sourceUrl}</span>
          </span>
        </label>

        <section className="mt-6" aria-label="Transmission preview">
          <p className="lf-label">Transmission</p>
          <ul className="divide-y divide-line/70 rounded-xl border border-line bg-panel2">
            {rows.map((row) => {
              const tone = INCLUSION_TONE[row.inclusion];
              return (
                <li key={row.field} className="flex items-start justify-between gap-4 px-4 py-3">
                  <div>
                    <p className="text-sm font-semibold text-text">{row.field}</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-soft">{row.note}</p>
                  </div>
                  <span className={`lf-pill shrink-0 ${tone.className}`}>
                    {row.included ? 'Included' : tone.label}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>

        <footer className="mt-7 flex justify-end">
          <button type="button" name="close" onClick={onClose} className="lf-btn-secondary px-5 py-2">
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}

export default ExtensionPreviewModal;
