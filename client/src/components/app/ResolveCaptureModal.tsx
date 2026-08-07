import { useState } from 'react';
import { Modal } from '../../design-system/overlays/Modal';
import { api, ApiError, ResolveCaptureResult } from '../../services/api';

/** The four nodes on the status rail, in order, with the mockup's copy. */
export const RAIL_NODES = [
  { id: 'P0' as const, label: 'P0 Captured', caption: 'Raw evidence' },
  { id: 'P1' as const, label: 'P1 Normalize', caption: 'Review parse' },
  { id: 'P2' as const, label: 'P2 Candidate', caption: 'Search MDM' },
  { id: 'P3' as const, label: 'P3 Link', caption: 'Governed decision' },
];

export type RailNodeId = (typeof RAIL_NODES)[number]['id'];

/**
 * Which rail nodes are complete, which is current, and which are still ahead.
 *
 * DERIVED FROM THE RECORD'S REAL STATE, passed in from the server response —
 * never advanced locally when the steward clicks. A rail that moved on click
 * would show P2 for a record still sitting at P0 upstream, and the steward
 * would make a governed decision against a picture that is not true. The
 * button being pressed is not evidence that the promotion succeeded.
 */
export function railProgress(reached: RailNodeId): {
  id: RailNodeId;
  state: 'done' | 'current' | 'ahead';
}[] {
  const reachedIndex = RAIL_NODES.findIndex((node) => node.id === reached);
  return RAIL_NODES.map((node, index) => ({
    id: node.id,
    state: index < reachedIndex ? 'done' : index === reachedIndex ? 'current' : 'ahead',
  }));
}

/** One assistant-proposed field the steward may correct inline. */
export interface ProposalChip {
  field: string;
  label: string;
  value: string;
}

interface ResolveCaptureModalProps {
  open: boolean;
  captureId: string;
  /** The raw text exactly as captured. Displayed, never edited. */
  rawEvidence: string;
  sourceContext?: string;
  capturedAt?: string;
  /** What the assistant parsed, for the steward to check and correct. */
  proposal: ProposalChip[];
  onClose: () => void;
  onResolved?: (result: ResolveCaptureResult) => void;
}

/**
 * Resolve Quick Capture — raw evidence → normalized handles → candidate search.
 *
 * Three guarantees, each of which is a test:
 *
 *  1. THE RAIL REFLECTS THE RECORD, NOT THE CLICK. `reached` comes from the
 *     server's read-back of the trust state after the operation.
 *  2. EVERY PARSED FIELD IS CORRECTABLE BEFORE PROMOTION. The chips are inputs,
 *     not labels, and what the steward types is sent as `corrections`, which
 *     override the parse.
 *  3. AN ORGANIZATION CANDIDATE PROPOSES, IT DOES NOT MERGE. The callout offers
 *     a REPRESENTS relationship for review and has no merge affordance at all —
 *     a shared domain is evidence of association, not of identity.
 */
export function ResolveCaptureModal({
  open,
  captureId,
  rawEvidence,
  sourceContext,
  capturedAt,
  proposal,
  onClose,
  onResolved,
}: ResolveCaptureModalProps) {
  const [reached, setReached] = useState<RailNodeId>('P0');
  const [corrections, setCorrections] = useState<Record<string, string>>({});
  const [result, setResult] = useState<ResolveCaptureResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return null;
  }

  const valueFor = (chip: ProposalChip): string =>
    corrections[chip.field] !== undefined ? corrections[chip.field] : chip.value;

  const run = async (stage: 'normalize' | 'search'): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const resolved = await api.resolveCapture(captureId, { stage, corrections });
      // FROM THE RESPONSE. Not `setReached('P1')` because we clicked Save P1 —
      // if upstream declined to advance the record, the rail must show that.
      setReached(resolved.rail.reachedNode as RailNodeId);
      setResult(resolved);
      onResolved?.(resolved);
    } catch (caught) {
      const message =
        caught instanceof ApiError
          ? caught.message
          : 'The resolution could not be completed. Nothing was promoted.';
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  const progress = railProgress(reached);

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title="Resolve Quick Capture"
      subtitle="Raw evidence → normalized handles → candidate search."
    >
      <div>

        <ol aria-label="Trust state">
          {RAIL_NODES.map((node) => {
            const state = progress.find((entry) => entry.id === node.id)?.state ?? 'ahead';
            return (
              <li key={node.id} data-state={state} aria-current={state === 'current'}>
                <strong>{node.label}</strong>
                <span>{node.caption}</span>
              </li>
            );
          })}
        </ol>

        <section aria-label="Raw Capture">
          <h3>Raw Capture</h3>
          {/* Read-only, deliberately. The evidence is what arrived; correcting
              it here would destroy the thing every promotion is checked against. */}
          <pre>{rawEvidence}</pre>
          {sourceContext && <p className="sub">Source: {sourceContext}</p>}
          <p className="sub">
            The source URL is retained with this record{capturedAt ? `, captured ${capturedAt}` : ''}.
          </p>
        </section>

        <section aria-label="Normalization Proposal">
          <h3>Normalization Proposal</h3>
          <p className="sub">
            Parsed by an assistant. Correct anything that is wrong before promoting — what you
            type here overrides the parse.
          </p>
          {proposal.map((chip) => (
            <div key={chip.field}>
              <label htmlFor={`chip-${chip.field}`}>{chip.label}</label>
              <input
                id={`chip-${chip.field}`}
                name={chip.field}
                value={valueFor(chip)}
                onChange={(event) =>
                  setCorrections((current) => ({ ...current, [chip.field]: event.target.value }))
                }
              />
            </div>
          ))}
        </section>

        {result?.organizationCandidate && (
          <section aria-label="Organization candidate">
            <p role="note">
              {result.organizationCandidate.name} {result.organizationCandidate.rationale} Create
              Person and propose {result.organizationCandidate.proposedRelationship} relationship
              after review.
            </p>
            {/* NO merge control. The absence is the design: there is no
                affordance here that could collapse two records into one. */}
            <p className="sub">
              Proposed only — the relationship is not established until it is reviewed.
            </p>
          </section>
        )}

        {result?.reversalRef && (
          <p className="sub">
            This promotion is reversible. Reference {result.reversalRef}.
          </p>
        )}

        {error && <p role="alert">{error}</p>}

        <footer>
          <button type="button" name="cancel" onClick={onClose}>
            Cancel
          </button>
          <button type="button" name="saveP1" disabled={busy} onClick={() => void run('normalize')}>
            Save P1
          </button>
          <button
            type="button"
            name="searchCandidates"
            disabled={busy}
            onClick={() => void run('search')}
          >
            Search &amp; Create Candidates
          </button>
        </footer>
      </div>
    </Modal>
  );
}

export default ResolveCaptureModal;
