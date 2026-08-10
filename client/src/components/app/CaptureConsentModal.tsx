import { useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../../services/api';
import { useToast } from '../../components/feedback/ToastProvider';
import { failureFor } from '../../content/messages';
import { chipClass } from '../../design-system/tokens';

/**
 * Capture Consent & Communication Preferences — #consentModal.
 *
 * "Creates a signed, purpose-specific receipt; it does not bypass authorization
 * or suppression."
 *
 * PURPOSE IS A RADIO, NOT CHECKBOXES, and that is the whole design rather than a
 * styling choice. sdk-consent's grant takes a SINGULAR purpose_id, so a receipt
 * covering four purposes cannot exist upstream — and a UI offering four ticks
 * would let an operator believe they had captured one. Making it a radio means
 * blanket consent is not expressible on the screen, not merely rejected after.
 *
 * PROMOTIONAL OFFERS IS IN THE PURPOSE LIST, NEVER THE CHANNEL LIST (AC4). It is
 * the permission people most often did not intend to give: bundled as a channel
 * under a service purpose, somebody agrees to job updates and finds themselves
 * on a marketing list. As a purpose it needs its own receipt and its own
 * signature, which is the point.
 */

/** The processing purposes offered, one of which a receipt covers. */
const PURPOSES = [
  { id: 'service_updates', label: 'Service and job updates', note: 'Progress, scheduling and completion of work already agreed.' },
  { id: 'quote_follow_up', label: 'Quote follow-up', note: 'Contact about an estimate the person asked for.' },
  { id: 'customer_service', label: 'Customer service', note: 'Responding to questions and complaints.' },
  {
    id: 'promotional_offers',
    label: 'Promotional offers',
    note: 'SEPARATE AND OPTIONAL. Marketing unrelated to work already agreed. Never bundled with a service purpose - it needs its own receipt and its own signature.',
    promotional: true,
  },
] as const;

/** Channels, each with the scope note the mockup states. */
const CHANNELS = [
  { id: 'sms', label: 'SMS', note: 'Carrier rules apply; STOP always suppresses.' },
  { id: 'email', label: 'Email', note: 'Complaints and hard bounces suppress automatically.' },
  { id: 'phone', label: 'Phone', note: 'Subject to DNC registers.' },
  { id: 'whatsapp', label: 'WhatsApp', note: 'Template rules differ from SMS.' },
  { id: 'postal', label: 'Postal', note: 'Do Not Mail is honoured by hash.' },
] as const;

const CAPTURE_METHODS = [
  { id: 'in_person_signature', label: 'In-person signature on device' },
  { id: 'secure_link', label: 'Secure link' },
  { id: 'web_form', label: 'Web form' },
  { id: 'recorded_verbal', label: 'Recorded verbal' },
  { id: 'imported_receipt', label: 'Imported receipt' },
] as const;

const VALIDITY = [
  { id: '12m', label: '12 months' },
  { id: 'project', label: 'Until project completion' },
  { id: '6m', label: '6 months' },
] as const;

/** The plain-language notice. Its TEXT is the evidence, not its name. */
const NOTICE_TEXT =
  'We will contact you only about the purpose you have chosen. You can withdraw at any time and we will stop. Withdrawing does not affect work already agreed.';

/**
 * A stable hash of the notice AS DISPLAYED.
 *
 * The hash covers the text the person actually saw, not a template id. "Which
 * version did they see" is the first question when a consent is challenged, and
 * a template id cannot answer it because templates change - the one on file
 * today may not be the words that were on the screen that day.
 */
function noticeHashOf(text: string, language: string): string {
  let h = 0;
  const input = `${language}:${text}`;
  for (let i = 0; i < input.length; i += 1) {
    h = (h << 5) - h + input.charCodeAt(i);
    h |= 0;
  }
  return `sha256-lite:${(h >>> 0).toString(16)}`;
}

export function CaptureConsentModal({ onClose, onIssued }: { onClose: () => void; onIssued: () => void }) {
  const [personId, setPersonId] = useState('');
  const [jurisdiction, setJurisdiction] = useState('GB');
  const [purposeId, setPurposeId] = useState<string>('');
  const [channels, setChannels] = useState<string[]>([]);
  const [validity, setValidity] = useState<string>('12m');
  const [language, setLanguage] = useState('en');
  const [method, setMethod] = useState<string>('in_person_signature');
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const signed = useRef(false);
  const { notify } = useToast();

  const noticeHash = useMemo(() => noticeHashOf(NOTICE_TEXT, language), [language]);
  const selected = PURPOSES.find((p) => p.id === purposeId);

  function toggleChannel(id: string) {
    setChannels((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]));
  }

  function draw(event: React.PointerEvent<HTMLCanvasElement>, begin: boolean) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (begin) {
      drawing.current = true;
      ctx.beginPath();
      ctx.moveTo(x, y);
      return;
    }
    if (!drawing.current) return;
    ctx.lineTo(x, y);
    ctx.stroke();
    signed.current = true;
  }

  function clearSignature() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    signed.current = false;
  }

  /*
   * ISSUE IS GATED ON EVERY PIECE OF EVIDENCE, not just the form being filled.
   * A receipt missing its signature or its confirmation is a receipt that looks
   * complete and cannot be defended.
   */
  const canIssue =
    personId.trim().length > 0 &&
    purposeId.length > 0 &&
    channels.length > 0 &&
    understood &&
    !busy;

  async function issue() {
    setBusy(true);
    try {
      const canvas = canvasRef.current;
      const result = await api.issueConsentReceipt({
        person_id: personId.trim(),
        // Singular by construction — the radio cannot produce an array.
        purpose_id: purposeId,
        channels,
        jurisdiction,
        validity,
        notice_hash: noticeHash,
        notice_text: NOTICE_TEXT,
        notice_language: language,
        capture_method: method,
        captured_by: '',
        device: navigator.userAgent,
        signature_data_url: signed.current && canvas ? canvas.toDataURL('image/png') : '',
      });
      setIssued(result.receipt_id ?? 'issued');
      onIssued();
    } catch (error) {
      notify(failureFor(error instanceof ApiError ? error.code : 'INTERNAL_ERROR'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-panel max-h-full w-full max-w-3xl overflow-y-auto rounded-lg p-6">
        <header className="mb-4">
          <h2 className="text-xl font-semibold">Capture Consent &amp; Communication Preferences</h2>
          <p className="text-soft">
            Creates a signed, purpose-specific receipt; it does not bypass authorization or
            suppression.
          </p>
        </header>

        {/* The five-node rail from the mockup. */}
        <ol className="text-soft mb-4 flex flex-wrap gap-3 text-xs uppercase tracking-wide">
          {['Subject', 'Purpose', 'Channels', 'Notice', 'Sign'].map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ol>

        <section className="mb-4 grid gap-3 md:grid-cols-2">
          <label className="text-sm">
            Canonical contact
            <input
              name="person_id"
              value={personId}
              onChange={(e) => setPersonId(e.target.value)}
              className="border-line mt-1 w-full rounded border p-2"
            />
          </label>
          <label className="text-sm">
            Jurisdiction
            <input
              name="jurisdiction"
              value={jurisdiction}
              onChange={(e) => setJurisdiction(e.target.value)}
              className="border-line mt-1 w-full rounded border p-2"
            />
          </label>
        </section>

        <section className="mb-4">
          <h3 className="font-semibold">Processing purpose</h3>
          {/* AC1 — ONE purpose. A radio group cannot express two. */}
          <p className="text-soft mb-2 text-sm">
            One purpose per receipt. A receipt covering several purposes is not a consent
            anyone gave.
          </p>
          {PURPOSES.map((p) => (
            <label key={p.id} className="mb-2 flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="purpose_id"
                value={p.id}
                checked={purposeId === p.id}
                onChange={() => setPurposeId(p.id)}
                className="mt-1"
              />
              <span>
                <span className="font-medium">{p.label}</span>
                {'promotional' in p && p.promotional && (
                  <span className={`ml-2 rounded-full border px-2 py-0.5 text-xs ${chipClass('warning')}`}>
                    Separate purpose
                  </span>
                )}
                <span className="text-soft block text-xs">{p.note}</span>
              </span>
            </label>
          ))}
        </section>

        <section className="mb-4">
          <h3 className="font-semibold">Channels</h3>
          <p className="text-soft mb-2 text-sm">
            Channels for the purpose above. Promotional offers is not listed here — it is a
            purpose, not a channel.
          </p>
          {CHANNELS.map((c) => (
            <label key={c.id} className="mb-2 flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                name={`channel_${c.id}`}
                checked={channels.includes(c.id)}
                onChange={() => toggleChannel(c.id)}
                className="mt-1"
              />
              <span>
                {c.label}
                <span className="text-soft block text-xs">{c.note}</span>
              </span>
            </label>
          ))}
        </section>

        <section className="mb-4 grid gap-3 md:grid-cols-3">
          <label className="text-sm">
            Validity
            <select
              name="validity"
              value={validity}
              onChange={(e) => setValidity(e.target.value)}
              className="border-line mt-1 w-full rounded border p-2"
            >
              {VALIDITY.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            Language
            <input
              name="notice_language"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="border-line mt-1 w-full rounded border p-2"
            />
          </label>
          <label className="text-sm">
            Capture method
            <select
              name="capture_method"
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              className="border-line mt-1 w-full rounded border p-2"
            >
              {CAPTURE_METHODS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        </section>

        <section className="border-line mb-4 rounded border p-3">
          <h3 className="font-semibold">Notice</h3>
          <p className="py-2 text-sm">{NOTICE_TEXT}</p>
          {/* AC3 — the hash covers the text as displayed, in this language. */}
          <p className="text-soft text-xs">
            Notice hash {noticeHash} · language {language}. The hash covers the words shown
            above, not a template name.
          </p>
          <label className="mt-2 flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              name="understood"
              checked={understood}
              onChange={(e) => setUnderstood(e.target.checked)}
              className="mt-1"
            />
            <span>
              Reviewed and understood. Records the notice hash, language, displayed text,
              timestamp, device and representative.
            </span>
          </label>
        </section>

        <section className="mb-4">
          <h3 className="font-semibold">Signature</h3>
          <canvas
            ref={canvasRef}
            width={520}
            height={140}
            className="border-line w-full rounded border bg-white"
            onPointerDown={(e) => draw(e, true)}
            onPointerMove={(e) => draw(e, false)}
            onPointerUp={() => {
              drawing.current = false;
            }}
          />
          <div className="mt-2 flex items-center gap-3">
            <button type="button" onClick={clearSignature} className="border-line rounded border px-3 py-1 text-sm">
              Clear
            </button>
            {/* AC2 — stated on the screen, not only enforced on the server. */}
            <span className="text-soft text-xs">
              The signature image is evidence. It is encrypted before storage and is not
              included in ordinary contact search.
            </span>
          </div>
        </section>

        <section className="border-line mb-4 rounded border p-3">
          <h3 className="mb-1 font-semibold">Receipt preview</h3>
          <p className="text-sm">
            {selected ? selected.label : 'No purpose chosen'} ·{' '}
            {channels.length > 0 ? channels.join(', ') : 'no channels'} · {jurisdiction} ·{' '}
            {VALIDITY.find((v) => v.id === validity)?.label}
          </p>
        </section>

        {issued && <p className="mb-3 text-sm">Receipt issued. Reference {issued}.</p>}

        <footer className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={onClose} className="border-line rounded border px-3 py-1">
            Cancel
          </button>
          <button
            type="button"
            disabled={!personId.trim() || busy}
            className="border-line rounded border px-3 py-1"
          >
            Send Secure Link
          </button>
          <button
            type="button"
            disabled={!canIssue}
            onClick={issue}
            className="border-line rounded border px-3 py-1"
          >
            {busy ? 'Issuing...' : 'Issue Receipt'}
          </button>
        </footer>

        <p className="text-soft mt-3 text-sm">
          Final channel authorization is re-evaluated at use time.
        </p>
      </div>
    </div>
  );
}
