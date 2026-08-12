import { useState } from 'react';
import { api, ApiError } from '../../services/api';
import { Modal } from '../../design-system/overlays/Modal';

/**
 * Save the NEXT action on a record.
 *
 * EVERY FIELD IS REQUIRED, and that is the point rather than an oversight. The
 * save gate refuses a NEXT without a type, a date, a purpose and an intended
 * outcome, because each one is what makes the commitment answerable later:
 * without a date nothing will ever surface the record again, and without an
 * intended outcome nobody can say afterwards whether it worked.
 *
 * A PREVIOUS OPEN NEXT IS COMPLETED, NOT DELETED. What the record was waiting
 * on before is part of its history, so the server closes it rather than
 * overwriting it — stated here so the operator is not surprised by a second
 * entry appearing on the timeline.
 */

/** The action types the pipeline recognises. */
const ACTION_TYPES = [
  { value: 'call', label: 'Call' },
  { value: 'email', label: 'Email' },
  { value: 'sms', label: 'SMS' },
  { value: 'meeting', label: 'Meeting' },
  { value: 'task', label: 'Task' },
];

export function NextActionModal({
  open,
  subjectRef,
  onClose,
  onCreated,
}: {
  open: boolean;
  subjectRef: string;
  onClose: () => void;
  onCreated?: () => void;
}) {
  const [actionType, setActionType] = useState('call');
  const [dueAt, setDueAt] = useState('');
  const [purpose, setPurpose] = useState('');
  const [outcome, setOutcome] = useState('');
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const ready = dueAt !== '' && purpose.trim() !== '' && outcome.trim() !== '';

  const save = async () => {
    if (!ready) return;
    setSaving(true);
    setFailure(null);
    try {
      await api.createNextAction(subjectRef, {
        action_type: actionType,
        // The picker gives local time; the server stores an instant.
        due_at: new Date(dueAt).toISOString(),
        purpose: purpose.trim(),
        intended_outcome: outcome.trim(),
      });
      setDueAt(''); setPurpose(''); setOutcome('');
      onCreated?.();
    } catch (caught) {
      setFailure(
        caught instanceof ApiError ? caught.message : 'The NEXT action could not be saved.',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create Lead — set the NEXT action"
      subtitle="A record with no dated NEXT is one nothing will ever surface again."
      size="sm"
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" name="cancel_next_action" onClick={onClose} className="lf-btn-secondary px-4 py-2">
            Cancel
          </button>
          <button
            type="button"
            name="save_next_action"
            disabled={!ready || saving}
            onClick={() => void save()}
            className="lf-btn-primary px-4 py-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save NEXT action'}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="lf-label block" htmlFor="na_action_type">Action</label>
          <select
            id="na_action_type"
            name="action_type"
            className="lf-input mt-1 w-full"
            value={actionType}
            onChange={(e) => setActionType(e.target.value)}
          >
            {ACTION_TYPES.map((a) => (
              <option key={a.value} value={a.value}>{a.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="lf-label block" htmlFor="na_due_at">Due</label>
          <input
            id="na_due_at"
            name="due_at"
            type="datetime-local"
            className="lf-input mt-1 w-full"
            value={dueAt}
            onChange={(e) => setDueAt(e.target.value)}
          />
        </div>

        <div>
          <label className="lf-label block" htmlFor="na_purpose">Purpose</label>
          <input
            id="na_purpose"
            name="purpose"
            className="lf-input mt-1 w-full"
            placeholder="Why this contact is being made"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
          />
        </div>

        <div>
          <label className="lf-label block" htmlFor="na_outcome">Intended outcome</label>
          <input
            id="na_outcome"
            name="intended_outcome"
            className="lf-input mt-1 w-full"
            placeholder="What would make this a success"
            value={outcome}
            onChange={(e) => setOutcome(e.target.value)}
          />
          <p className="mt-1 text-xs text-soft">
            Stated up front so somebody can say afterwards whether it worked. A NEXT with no
            intended outcome cannot be reviewed, only counted.
          </p>
        </div>

        {failure && <p role="alert" className="text-sm text-danger">{failure}</p>}

        <p className="text-xs text-soft">
          Any NEXT already open on this record is completed rather than deleted — what it was
          waiting on before stays in its history.
        </p>
      </div>
    </Modal>
  );
}
