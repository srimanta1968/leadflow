import { useState } from 'react';
import { Modal } from '../../design-system/overlays/Modal';
import { useToast } from '../../components/feedback/ToastProvider';

/**
 * Onboarding handoff record and CS accept-or-reject (SOP §19 and §22).
 *
 * EVERY PROMISE IS A DISCRETE ITEM, NOT A PARAGRAPH. This is the criterion that
 * makes the rest work. A free-text "notes" box containing "told them we could do
 * the Salesforce sync by March" is unauditable: nobody can diff it against what
 * was delivered, so the promise-versus-delivery check degrades into somebody
 * reading prose and forming an impression. As separate items each one can be
 * marked delivered or not, and the divergence becomes a fact rather than an
 * argument.
 *
 * CS MAY REJECT, AND THE REASON IS REQUIRED. A handoff that CS cannot refuse is
 * not a handoff, it is a notification — and the failure it produces is the
 * expensive one in §22: a customer who bought one thing and is being onboarded
 * onto another, discovered in week three. Rejection returns it to the AE, who is
 * the only person who can say what was actually promised.
 *
 * NO SECTION IS OPTIONAL. The form refuses to submit with a required field empty
 * because the missing field is always the one that mattered — nobody omits the
 * customer's name, they omit "unresolved concerns".
 */

/** The six sections and their required fields, per §19. */
const SECTIONS = [
  {
    key: 'commercial',
    label: 'Commercial truth',
    fields: [
      'Offer version',
      'Quantity',
      'Payment state',
      'Approved exceptions',
      'Variable charges discussed',
    ],
  },
  {
    key: 'business_case',
    label: 'Business case',
    fields: [
      'Problems',
      'Impact',
      'Desired 90-day outcome',
      'Success measures',
      'Urgency',
    ],
  },
  {
    key: 'stakeholders',
    label: 'Stakeholders',
    fields: [
      'Decision maker',
      'Admin',
      'Users',
      'Technical contact',
      'Financial contact',
    ],
  },
  {
    key: 'product_scope',
    label: 'Product scope',
    fields: [
      'Live features purchased',
      'Beta and roadmap discussed',
      'Explicit exclusions',
      'Integrations',
    ],
  },
  {
    key: 'promises_risk',
    label: 'Promises and risk',
    fields: [
      'Unresolved concerns',
      'Adoption risk',
      'Deadlines',
    ],
  },
  {
    key: 'kickoff',
    label: 'Kickoff',
    fields: [
      'Accepted date and time',
      'Onboarding owner',
      'Prework status',
      'Meeting link',
    ],
  },
];

export default function OnboardingHandoff() {
  const [values, setValues] = useState<Record<string, string>>({});
  const [promises, setPromises] = useState<string[]>([]);
  const [draftPromise, setDraftPromise] = useState('');
  const [rejectOpen, setRejectOpen] = useState(false);
  const { notify } = useToast();

  const requiredKeys = SECTIONS.flatMap((section) =>
    section.fields.map((field) => `${section.key}:${field}`),
  );
  const missing = requiredKeys.filter((key) => (values[key] ?? '').trim() === '');
  const complete = missing.length === 0;

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-text">Onboarding Handoff</h1>
          <p className="mt-1.5 max-w-3xl text-sm text-muted">
            What sales sold, in the words that were used, so onboarding delivers the thing that
            was bought. Customer Success may reject this and send it back.
          </p>
        </div>
        <button
          type="button"
          name="reject_handoff"
          onClick={() => setRejectOpen(true)}
          className="lf-btn-secondary px-4 py-2"
        >
          Reject with reason
        </button>
      </div>

      {/* ---------------------------------------------------- the sections */}
      {SECTIONS.map((section) => (
        <section key={section.key} className="lf-panel mt-4 p-5" aria-label={section.label}>
          <h2 className="lf-eyebrow">{section.label}</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {section.fields.map((field) => {
              const key = `${section.key}:${field}`;
              const empty = (values[key] ?? '').trim() === '';
              return (
                <div key={key}>
                  <label className="lf-label" htmlFor={key}>
                    {field}
                  </label>
                  <input
                    id={key}
                    name={key}
                    className={`lf-input mt-1 w-full ${empty ? 'border-gold/40' : ''}`}
                    value={values[key] ?? ''}
                    onChange={(event) =>
                      setValues((current) => ({ ...current, [key]: event.target.value }))
                    }
                  />
                </div>
              );
            })}
          </div>
        </section>
      ))}

      {/* --------------------------------------------- promises as items */}
      <section className="lf-panel mt-4 p-5" aria-label="Promises made">
        <h2 className="lf-eyebrow">Promises made</h2>
        <p className="mt-1 text-xs text-soft">
          One commitment per item. A paragraph containing three promises cannot be checked
          against what was delivered, which is the whole point of recording them.
        </p>

        <div className="mt-3 flex gap-2">
          <input
            id="promise_text"
            name="promise_text"
            className="lf-input flex-1"
            value={draftPromise}
            onChange={(event) => setDraftPromise(event.target.value)}
            placeholder="One commitment, in the words it was made in"
          />
          <button
            type="button"
            name="add_promise"
            disabled={draftPromise.trim() === ''}
            onClick={() => {
              setPromises((current) => [...current, draftPromise.trim()]);
              setDraftPromise('');
            }}
            className="lf-btn-secondary px-3 py-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Add promise
          </button>
        </div>

        <ul className="mt-3 space-y-2">
          {promises.map((promise, index) => (
            <li key={`${promise}:${index}`} className="lf-card p-3 text-sm text-text">
              {promise}
            </li>
          ))}
          {promises.length === 0 && (
            <li className="text-sm text-muted">
              No promises recorded. If none were made, that is itself worth stating to CS.
            </li>
          )}
        </ul>
      </section>

      {/* ------------------------------------------------------- submit */}
      <div className="lf-panel mt-4 p-5">
        {!complete && (
          <p className="mb-3 rounded border border-gold/40 bg-gold/10 px-3 py-2 text-sm text-gold">
            {missing.length} required fields are empty. The missing field is always the one that
            mattered - nobody omits the customer's name, they omit unresolved concerns.
          </p>
        )}

        <button
          type="button"
          name="submit_handoff"
          disabled={!complete}
          onClick={() => notify({ tone: 'success', title: 'Handoff submitted to Customer Success' })}
          className="lf-btn-primary px-4 py-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Submit handoff
        </button>
      </div>

      {/* ------------------------------------- promise versus delivery */}
      <section className="lf-panel mt-4 p-5" aria-label="Promise versus delivery">
        <h2 className="lf-eyebrow">Promise versus delivery</h2>
        <p className="mt-1 text-sm text-muted">
          Each promise is checked against what onboarding actually delivered, and any divergence
          is flagged to the manager. A customer who bought one thing and is being onboarded onto
          another is discovered in week three otherwise.
        </p>
      </section>

      <RejectModal open={rejectOpen} onClose={() => setRejectOpen(false)} />
    </div>
  );
}

/** CS rejection. The reason is required and it goes back to the AE. */
function RejectModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const { notify } = useToast();

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Reject this handoff"
      subtitle="Returns it to the AE, who is the only person who can say what was actually promised."
      size="sm"
      dismissable={false}
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" name="cancel_reject" onClick={onClose} className="lf-btn-secondary px-4 py-2">
            Cancel
          </button>
          <button
            type="button"
            name="confirm_reject"
            disabled={reason.trim() === ''}
            onClick={() => {
              notify({ tone: 'info', title: 'Handoff returned to the AE' });
              setReason('');
              onClose();
            }}
            className="lf-btn-primary px-4 py-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Reject and return
          </button>
        </div>
      }
    >
      <div>
        <label className="lf-label" htmlFor="rejection_reason">
          Reason
        </label>
        <textarea
          id="rejection_reason"
          name="rejection_reason"
          rows={4}
          className="lf-input mt-1 w-full"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        <p className="mt-1 text-xs text-soft">
          Required. A rejection with no reason gives the AE nothing to fix and turns the handoff
          into a loop.
        </p>
      </div>
    </Modal>
  );
}
