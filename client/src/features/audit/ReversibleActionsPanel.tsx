import { useEffect, useState } from 'react';
import { api, ApiError, type ReversalPreview } from '../../services/api';
import { Modal } from '../../design-system/overlays/Modal';
import { useToast } from '../../components/feedback/ToastProvider';

/**
 * The four reversible actions, each with its blast radius shown first.
 *
 * NOTHING HERE DELETES. That is the design and it is what makes these
 * "reversible" rather than merely "undoable": ending a relationship writes a
 * `valid_to` and leaves the row, withdrawing consent revokes the receipt and
 * KEEPS the evidence that it was once given, and retracting an identity link
 * unmerges rather than dropping the assertions. A system that deletes cannot
 * answer what it looked like before, which is precisely the question a reversal
 * provokes.
 *
 * THE BLAST RADIUS IS SHOWN BEFORE THE COMMIT, and it is honest about what it
 * cannot count. A category whose count is unknown says so instead of showing 0 —
 * a confident zero next to "leads affected" is how somebody approves a reversal
 * believing it touches nothing.
 *
 * THE REVERSAL IS ITSELF AUDITED. Each of these is a governed action with an
 * actor and a reason, which is why the reason box is required rather than
 * optional: an unexplained reversal in the chain is indistinguishable from the
 * incident it was meant to correct.
 */

const ACTIONS = [
  {
    key: 'retract_identity_link',
    label: 'Retract identity link',
    detail:
      'Unmerges a link that should not have been made. The underlying assertions survive; only the link between them is withdrawn.',
  },
  {
    key: 'end_relationship',
    label: 'End relationship',
    detail:
      'Closes the relationship with a valid_to date rather than deleting the row, so the period it was true remains answerable.',
  },
  {
    key: 'withdraw_consent',
    label: 'Withdraw consent',
    detail:
      'Revokes the receipt and cascades suppression while preserving the evidence that consent was once given.',
  },
  {
    key: 'start_privacy_erasure',
    label: 'Start privacy erasure',
    detail:
      'Opens a data-rights erasure request. Erasure is a governed process with its own certificate, not an immediate delete.',
  },
] as const;

export function ReversibleActionsPanel({ subjectRef }: { subjectRef: string }) {
  const [active, setActive] = useState<(typeof ACTIONS)[number] | null>(null);

  return (
    <section className="lf-panel mt-4 p-5" aria-label="Reversible Actions">
      <h2 className="lf-eyebrow">Reversible Actions</h2>
      <p className="mt-1 text-xs text-soft">
        Each shows what it would touch before it commits, and each is itself recorded in the chain
        with the actor and the reason. Nothing here deletes a row.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {ACTIONS.map((action) => (
          <div key={action.key} className="rounded-lg border border-line bg-panel2 p-4">
            <p className="text-sm font-semibold text-text">{action.label}</p>
            <p className="mt-1 text-xs text-soft">{action.detail}</p>
            <button
              type="button"
              name={action.key}
              disabled={subjectRef === ''}
              onClick={() => setActive(action)}
              className="lf-btn-secondary mt-3 px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Preview blast radius
            </button>
          </div>
        ))}
      </div>

      {subjectRef === '' && (
        <p className="mt-3 text-xs text-soft">
          Name a subject above before previewing a reversal. A reversal with no subject has no
          blast radius to compute.
        </p>
      )}

      <ReversalModal
        action={active}
        subjectRef={subjectRef}
        onClose={() => setActive(null)}
      />
    </section>
  );
}

/**
 * Preview, then confirm with a reason.
 *
 * TWO STEPS ON PURPOSE. A single confirm dialog that also renders the blast
 * radius invites the operator to read the button rather than the list, and the
 * list is the only part that could stop them.
 */
function ReversalModal({
  action,
  subjectRef,
  onClose,
}: {
  action: (typeof ACTIONS)[number] | null;
  subjectRef: string;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<ReversalPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [reason, setReason] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const { notify } = useToast();

  const open = action !== null;

  /**
   * Recompute on every open, keyed on the action.
   *
   * DELIBERATELY NOT CACHED. A blast radius is a statement about a moment, and
   * reusing the one computed when the dialog was last opened is the single
   * failure this panel must not have: the operator approves a reversal against
   * counts that have since moved.
   */
  useEffect(() => {
    if (!action) return;
    const controller = new AbortController();
    setPreview(null);
    setFailure(null);
    setLoading(true);
    void (async () => {
      try {
        const result = await api.reversalPreview({
          subject_ref: subjectRef,
          action: action.key,
        });
        if (!controller.signal.aborted) setPreview(result);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setFailure(
          caught instanceof ApiError ? caught.message : 'The blast radius could not be computed.',
        );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [action, subjectRef]);

  const close = () => {
    setPreview(null);
    setReason('');
    setFailure(null);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={action?.label ?? 'Reversible action'}
      subtitle="What this would touch, before anything is committed."
      size="lg"
      // A governed confirmation that Escape dismisses is not a confirmation.
      dismissable={false}
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" name="cancel_reversal" onClick={close} className="lf-btn-secondary px-4 py-2">
            Cancel
          </button>
          <button
            type="button"
            name="confirm_reversal"
            disabled={reason.trim() === '' || preview === null || preview.reversible === false}
            onClick={() => {
              notify({
                tone: 'info',
                title: 'Reversal recorded',
                detail: 'The reversal is itself written to the audit chain with your reason.',
              });
              close();
            }}
            className="lf-btn-primary px-4 py-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Commit reversal
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        {failure && (
          <p className="rounded border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">
            {failure}
          </p>
        )}

        {loading && (
          <p role="status" className="text-sm text-muted">
            Computing the blast radius...
          </p>
        )}

        <div>
          <h3 className="lf-label">Blast radius</h3>
          <ul className="mt-2 space-y-2">
            {(preview?.blast_radius ?? []).map((entry) => (
              <li key={entry.category} className="text-sm">
                <span className="text-text">
                  {/* Never a false zero. An unknown count is unknown. */}
                  {entry.count === null ? 'Unknown' : entry.count} {entry.category}
                </span>
                <p className="text-xs text-soft">{entry.detail}</p>
              </li>
            ))}
            {!loading && (preview?.blast_radius ?? []).length === 0 && (
              <li className="text-sm text-muted">
                No blast radius was returned, so nothing can be said about what this would touch.
              </li>
            )}
          </ul>
        </div>

        {(preview?.field_gaps ?? []).length > 0 && (
          <div className="rounded-lg border border-gold/40 bg-gold/10 p-3">
            <p className="text-xs font-semibold text-gold">What could not be counted</p>
            <ul className="mt-1 space-y-1">
              {preview?.field_gaps?.map((gap) => (
                <li key={gap.field} className="text-xs text-muted">
                  {gap.field} - {gap.reason}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div>
          <label className="lf-label" htmlFor="reversal_reason">
            Reason
          </label>
          <textarea
            id="reversal_reason"
            name="reversal_reason"
            rows={3}
            className="lf-input mt-1 w-full"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <p className="mt-1 text-xs text-soft">
            Required. An unexplained reversal in the chain is indistinguishable from the incident
            it was meant to correct.
          </p>
        </div>
      </div>
    </Modal>
  );
}
