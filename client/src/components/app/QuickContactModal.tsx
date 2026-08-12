import { FormEvent, useMemo, useState } from 'react';
import { Modal } from '../../design-system/overlays/Modal';
import { api, ApiError, QuickCaptureResult } from '../../services/api';
import {
  CAPTURE_MODES,
  CAPTURE_ORIGIN_OPTIONS,
  CaptureModeId,
  CaptureOriginClass,
  RELATIONSHIP_OPTIONS,
  VISIBILITY_OPTIONS,
} from '../../content/captureOriginClasses';

/** One field a parser proposed, with how sure it is. */
export interface DetectedField {
  field: string;
  value: string;
  /** 0..1. Shown as a percentage, never as a verdict. */
  confidence: number;
}

/** The parser's proposal, grouped the way the operator has to review it. */
export interface DetectedCandidate {
  person: DetectedField[];
  contactPoints: DetectedField[];
  property: DetectedField[];
  organization: DetectedField[];
  notes: DetectedField[];
}

const EMPTY_CANDIDATE: DetectedCandidate = {
  person: [],
  contactPoints: [],
  property: [],
  organization: [],
  notes: [],
};

/**
 * Split pasted text into candidate entities with a confidence per field.
 *
 * LOCAL AND DELIBERATELY MODEST. This is a client-side heuristic that proposes;
 * it decides nothing. Running it here rather than calling an enrichment service
 * is the point — the modal must never spend a Data Credit, and the surest way to
 * guarantee that is to have no code path that could.
 *
 * Confidence is REPORTED, not thresholded. Nothing here auto-accepts above some
 * number: an email matched by a pattern is high confidence and still a proposal
 * the operator confirms. A threshold would quietly turn a guess into a fact, and
 * the whole reason this preview exists is so a human sees the guess as a guess.
 */
export function detectEntities(raw: string): DetectedCandidate {
  const text = raw.trim();
  if (!text) {
    return EMPTY_CANDIDATE;
  }

  const candidate: DetectedCandidate = {
    person: [],
    contactPoints: [],
    property: [],
    organization: [],
    notes: [],
  };

  const email = /[\w.+-]+@[\w-]+\.[\w.-]+/.exec(text);
  if (email) {
    // A syntactic match is strong evidence of an email address, and no evidence
    // at all that it belongs to the person named beside it.
    candidate.contactPoints.push({ field: 'Email', value: email[0], confidence: 0.95 });
  }

  const phone = /(\+?\d[\d\s().-]{7,}\d)/.exec(text);
  if (phone) {
    candidate.contactPoints.push({
      field: 'Phone',
      value: phone[1].trim(),
      // Lower than email: digit runs of this shape are also reference numbers,
      // postcodes in some formats, and order ids.
      confidence: 0.7,
    });
  }

  const name = /^\s*([A-Z][a-z]+(?:\s+[A-Z][a-z'-]+){1,2})/.exec(text);
  if (name) {
    candidate.person.push({ field: 'Full name', value: name[1].trim(), confidence: 0.6 });
  }

  const org = /\b([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*)*\s+(?:Ltd|Limited|LLC|Inc|PLC|GmbH))\b/.exec(
    text
  );
  if (org) {
    candidate.organization.push({ field: 'Organisation', value: org[1].trim(), confidence: 0.75 });
  }

  const address = /\b(\d+[\w\s.,'-]{4,}?(?:Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Drive|Dr|Way|Close))\b/i.exec(
    text
  );
  if (address) {
    candidate.property.push({
      field: 'Address',
      value: address[1].trim(),
      // The weakest of the four, and labelled so: a street-like string is a
      // long way from a property this person is connected to.
      confidence: 0.45,
    });
  }

  const leftover = text
    .replace(email?.[0] ?? '', '')
    .replace(phone?.[1] ?? '', '')
    .replace(name?.[1] ?? '', '')
    .replace(org?.[1] ?? '', '')
    .replace(address?.[1] ?? '', '')
    .replace(/[\s,|;]+/g, ' ')
    .trim();
  if (leftover.length > 2) {
    candidate.notes.push({ field: 'Unmatched text', value: leftover, confidence: 0.3 });
  }

  return candidate;
}

/** True when the parser found nothing at all. */
export function isEmptyCandidate(candidate: DetectedCandidate): boolean {
  return (
    candidate.person.length === 0 &&
    candidate.contactPoints.length === 0 &&
    candidate.property.length === 0 &&
    candidate.organization.length === 0 &&
    candidate.notes.length === 0
  );
}

interface QuickContactModalProps {
  open: boolean;
  onClose: () => void;
  onCaptured?: (result: QuickCaptureResult) => void;
}

const EXAMPLE_PASTE =
  'Priya Raman\nRaman Roofing Ltd\npriya@ramanroofing.example\n07700 900123\n42 Bridge Road, Leeds\nCalled about a leak above the kitchen';

/**
 * Quick Contact Capture.
 *
 * Creates a provisional P0 source record. Four modes — Smart Paste, Manual,
 * Business Card, Browser Capture — over one shared footer, because the
 * provenance decision is identical whichever way the text arrived and splitting
 * it per mode is how one of them ends up without it.
 *
 * THREE GUARANTEES THIS COMPONENT MAKES, each of which is a test:
 *
 *  1. ORIGIN CLASS HAS NO DEFAULT. `originClass` starts null and Save stays
 *     disabled until the operator picks one. Pre-selecting even the commonest
 *     value would put a provenance claim in their mouth, and the server would
 *     accept it — 422 protects against omission, not against a default the UI
 *     supplied.
 *  2. NO ENRICHMENT. Nothing here calls a paid lookup; the smart-paste preview
 *     is a local regex pass. The hard rule is that this modal never spends a
 *     Data Credit, and the only reliable way to keep it is to have no path that
 *     could.
 *  3. THE PREVIEW SEPARATES ENTITIES AND SHOWS PER-FIELD CONFIDENCE. Person,
 *     contact points, property, organisation and notes are listed apart, each
 *     with its own number, because "we are 95% sure of the email and 45% sure of
 *     the address" is a different thing to review than one blended score.
 */
export function QuickContactModal({ open, onClose, onCaptured }: QuickContactModalProps) {
  const [mode, setMode] = useState<CaptureModeId>('smart_paste');
  const [rawInput, setRawInput] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [proposal, setProposal] = useState<DetectedCandidate | null>(null);

  // NULL, not a value. This is guarantee 1.
  const [originClass, setOriginClass] = useState<CaptureOriginClass | null>(null);
  const [visibility, setVisibility] = useState('business_unit');
  const [relationshipHint, setRelationshipHint] = useState('none');
  const [recordOwner, setRecordOwner] = useState('');
  const [note, setNote] = useState('');
  const [searchAfterCapture, setSearchAfterCapture] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveRaw = mode === 'smart_paste' ? pasteText : rawInput;
  const canSave = originClass !== null && effectiveRaw.trim().length > 0 && !submitting;

  const candidate = useMemo(() => proposal ?? EMPTY_CANDIDATE, [proposal]);

  if (!open) {
    return null;
  }

  const parseAndPropose = (): void => {
    setProposal(detectEntities(pasteText));
  };

  const flatProposal = (): Record<string, unknown> | null => {
    if (!proposal) {
      return null;
    }
    const flat: Record<string, unknown> = {};
    for (const group of Object.values(proposal)) {
      for (const field of group) {
        flat[field.field] = field.value;
      }
    }
    return Object.keys(flat).length > 0 ? flat : null;
  };

  const submit = async (event: FormEvent, resolveAfter: boolean): Promise<void> => {
    event.preventDefault();
    // Defensive: the button is disabled, but a form can also be submitted by
    // keyboard, and a capture with no declared provenance must never leave here.
    if (originClass === null) {
      setError('Choose a data origin class before saving.');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const result = await api.quickCapture({
        // 'assisted' only when a proposal was actually produced — the server
        // uses this to decide whether to call the parser, and claiming
        // assistance we did not use would send it work it does not need.
        mode: proposal ? 'assisted' : 'manual',
        rawInput: effectiveRaw,
        parsedProposal: flatProposal(),
        originClass,
        visibility,
        relationshipHint,
        recordOwnerPersonaId: recordOwner.trim() || null,
        note: note.trim() || null,
        searchAfterCapture: resolveAfter || searchAfterCapture,
      });
      onCaptured?.(result);
      onClose();
    } catch (caught) {
      const message =
        caught instanceof ApiError
          ? caught.message
          : 'The capture could not be saved. Nothing was recorded.';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title="Quick Contact Capture"
      subtitle="Creates a provisional P0 source record. No paid enrichment or destructive merge."
    >
      <div className="lf-form-body">

        <div role="tablist" aria-label="Capture mode">
          {CAPTURE_MODES.map((option) => (
            <button
              key={option.id}
              type="button"
              role="tab"
              name={`mode-${option.id}`}
              aria-selected={mode === option.id}
              onClick={() => setMode(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>

        <form onSubmit={(event) => void submit(event, false)}>
          {mode === 'smart_paste' && (
            <section aria-label="Smart Paste">
              <label htmlFor="paste-input">Paste a signature, an email or a note</label>
              <textarea
                id="paste-input"
                name="rawInput"
                value={pasteText}
                onChange={(event) => setPasteText(event.target.value)}
                rows={6}
              />
              <button type="button" name="parseAndPropose" onClick={parseAndPropose}>
                Parse &amp; Propose
              </button>
              <button
                type="button"
                name="useExample"
                onClick={() => setPasteText(EXAMPLE_PASTE)}
              >
                Use example
              </button>

              {proposal && (
                <div aria-label="Detected Candidate">
                  <h3>Detected Candidate</h3>
                  {isEmptyCandidate(candidate) ? (
                    <p>Nothing was detected. You can still save the raw text as evidence.</p>
                  ) : (
                    <>
                      <CandidateGroup title="Person" fields={candidate.person} />
                      <CandidateGroup title="Contact Points" fields={candidate.contactPoints} />
                      <CandidateGroup title="Property candidate" fields={candidate.property} />
                      <CandidateGroup title="Organization" fields={candidate.organization} />
                      <CandidateGroup title="Notes" fields={candidate.notes} />
                      <p className="sub">
                        These are proposals. Nothing is linked or promoted until you review it.
                      </p>
                    </>
                  )}
                </div>
              )}
            </section>
          )}

          {mode === 'manual' && (
            <section aria-label="Manual">
              <label htmlFor="manual-input">Contact details</label>
              <textarea
                id="manual-input"
                name="rawInput"
                value={rawInput}
                onChange={(event) => setRawInput(event.target.value)}
                rows={6}
              />
              <label htmlFor="relationship">Relationship</label>
              <select
                id="relationship"
                name="relationshipHint"
                value={relationshipHint}
                onChange={(event) => setRelationshipHint(event.target.value)}
              >
                {RELATIONSHIP_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </section>
          )}

          {mode === 'business_card' && (
            <section aria-label="Business Card">
              <label htmlFor="card-upload">Business card image</label>
              <input id="card-upload" name="evidenceBlobRef" type="file" accept="image/*" />
              <p className="sub">
                Extraction creates proposals only. You review every field before it is used.
              </p>
              <label htmlFor="card-notes">What the card says</label>
              <textarea
                id="card-notes"
                name="rawInput"
                value={rawInput}
                onChange={(event) => setRawInput(event.target.value)}
                rows={4}
              />
            </section>
          )}

          {mode === 'browser_capture' && (
            <section aria-label="Browser Capture">
              <label htmlFor="selection">Selected text</label>
              <textarea
                id="selection"
                name="rawInput"
                value={rawInput}
                onChange={(event) => setRawInput(event.target.value)}
                rows={4}
              />
              <label htmlFor="source-page">Source page</label>
              <input
                id="source-page"
                name="sourcePage"
                type="url"
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
              <p className="sub" role="note">
                Some domains are restricted and cannot be captured from.
              </p>
              <button type="button" name="useSelection">
                Use Selection
              </button>
            </section>
          )}

          {/* SHARED FOOTER — identical in every mode. The provenance decision does
              not change with how the text arrived, and giving each mode its own
              footer is how one of them ends up missing it. */}
          <fieldset name="originClass">
            <legend>Data Origin Class (required)</legend>
            {CAPTURE_ORIGIN_OPTIONS.map((option) => (
              <label key={option.value} htmlFor={`origin-${option.value}`}>
                <input
                  id={`origin-${option.value}`}
                  type="radio"
                  name="originClass"
                  value={option.value}
                  checked={originClass === option.value}
                  onChange={() => setOriginClass(option.value)}
                />
                <span>{option.label}</span>
                <small>{option.meaning}</small>
              </label>
            ))}
          </fieldset>

          <label htmlFor="visibility">Visibility</label>
          <select
            id="visibility"
            name="visibility"
            value={visibility}
            onChange={(event) => setVisibility(event.target.value)}
          >
            {VISIBILITY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          <label htmlFor="record-owner">Record Owner</label>
          <input
            id="record-owner"
            name="recordOwnerPersonaId"
            value={recordOwner}
            onChange={(event) => setRecordOwner(event.target.value)}
          />

          <label htmlFor="search-after">
            <input
              id="search-after"
              name="searchAfterCapture"
              type="checkbox"
              checked={searchAfterCapture}
              onChange={(event) => setSearchAfterCapture(event.target.checked)}
            />
            Search existing canonical contacts after capture
          </label>

          <p role="note">
            Third-party is not converted by relabeling. Changing the origin class does not change
            where the data came from.
          </p>

          <p className="sub">
            Creates capture_id + raw evidence + source classification + audit event
          </p>

          {error && <p role="alert">{error}</p>}

          <footer>
            <button type="button" name="cancel" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" name="saveDraft" disabled={!canSave}>
              Save P0 Draft
            </button>
            <button
              type="button"
              name="saveAndResolve"
              disabled={!canSave}
              onClick={(event) => void submit(event, true)}
            >
              Save &amp; Resolve
            </button>
          </footer>
        </form>
      </div>
    </Modal>
  );
}

/** One group of detected fields, each with its own confidence. */
function CandidateGroup({ title, fields }: { title: string; fields: DetectedField[] }) {
  if (fields.length === 0) {
    return null;
  }
  return (
    <div aria-label={title}>
      <h4>{title}</h4>
      <ul>
        {fields.map((field) => (
          <li key={`${title}-${field.field}`}>
            <span>{field.field}</span>
            <span>{field.value}</span>
            {/* Per FIELD, not per candidate. One blended score would hide that
                the email is near-certain and the address is a guess. */}
            <span aria-label={`${field.field} confidence`}>
              {Math.round(field.confidence * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default QuickContactModal;
