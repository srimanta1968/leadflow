import { useState } from 'react';
import { Modal } from '../../design-system/overlays/Modal';
import { useToast } from '../../components/feedback/ToastProvider';

/**
 * Establish First-Party Relationship (#promotionModal).
 *
 * THIS ADDS EVIDENCE. IT DOES NOT REPLACE ANY. The immutability callout is the
 * first thing on screen because the intuition it corrects is very strong: an
 * operator confirming "yes, I spoke to this person" reasonably expects that to
 * settle the matter and supersede whatever a data broker claimed. It must not.
 * The licensed or public assertion is what a later dispute is argued from, and a
 * workflow that quietly overwrote it would destroy the record of what we
 * believed and why at the moment we acted on it.
 *
 * A P4 RELATIONSHIP IS NOT CONSENT, and this modal deliberately never calls
 * sdk-consent. The two are conflated constantly and the conflation is the single
 * most expensive mistake available here: "we have a direct relationship with
 * them" is a statement about identity provenance, while "we may send them
 * marketing" is a permission that only the person can grant. Establishing one
 * and inferring the other is how an organisation ends up contacting people who
 * never agreed to be contacted, with a confident audit trail saying it was fine.
 * The confirmation therefore states the limit in words rather than relying on
 * the operator to know it.
 */

/** The six relationship types, worded as the mockup words them. */
const RELATIONSHIP_TYPES = [
  'Direct homeowner interaction',
  'Inbound inquiry',
  'Existing customer',
  'Authorized representative',
  'Referral partner',
  'Contracting party',
];

/**
 * The three evidence types, each with what it actually means.
 *
 * The descriptions are not help text. An operator choosing between "In-person
 * confirmation" and "Inbound response" is deciding how strong the resulting
 * assertion is, and the difference is not guessable from the labels.
 */
const EVIDENCE_TYPES = [
  {
    key: 'In-person confirmation',
    description: 'A person confirmed their identity face to face, and the rep recorded it.',
  },
  {
    key: 'Inbound response',
    description: 'The person initiated contact or replied on a channel we can attribute to them.',
  },
  {
    key: 'Signed document',
    description: 'A signed instrument names them, and the document is retained as evidence.',
  },
];

export function EstablishRelationshipModal({
  open,
  onClose,
  contactLabel,
}: {
  open: boolean;
  onClose: () => void;
  /** The record the case is about, so the operator confirms the right person. */
  contactLabel: string | null;
}) {
  const [contact, setContact] = useState('');
  const [relationshipType, setRelationshipType] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [evidenceType, setEvidenceType] = useState(EVIDENCE_TYPES[0].key);
  const [context, setContext] = useState('');
  const [note, setNote] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const { notify } = useToast();

  // Relationship type and the acknowledgement are both REQUIRED. The
  // acknowledgement in particular is not a formality: it is the only place the
  // consent limit is stated to the person creating the assertion.
  const complete =
    relationshipType !== '' && effectiveFrom.trim() !== '' && acknowledged;

  const reset = () => {
    setContact('');
    setRelationshipType('');
    setEffectiveFrom('');
    setEvidenceType(EVIDENCE_TYPES[0].key);
    setContext('');
    setNote('');
    setAcknowledged(false);
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Establish First-Party Relationship"
      subtitle="Records that we have a direct relationship with this person. It does not grant permission to contact them."
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            name="cancel_relationship"
            onClick={() => {
              reset();
              onClose();
            }}
            className="lf-btn-secondary px-4 py-2"
          >
            Cancel
          </button>
          <button
            type="button"
            name="establish_relationship"
            disabled={!complete}
            onClick={() => {
              notify({
                tone: 'success',
                title: 'Relationship assertion added',
                detail: 'The original third-party assertion remains visible in provenance.',
              });
              reset();
              onClose();
            }}
            className="lf-btn-primary px-4 py-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Establish Relationship
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        {/* ------------------------------------------ the immutability callout */}
        <div className="rounded-lg border border-cyan/40 bg-cyan/10 p-3">
          <p className="text-sm text-text">
            The licensed or public assertion remains. This workflow ADDS new evidence alongside it
            and supersedes nothing.
          </p>
          <p className="mt-1 text-xs text-soft">
            A later dispute is argued from what we believed and why at the moment we acted, so the
            original claim is never overwritten.
          </p>
        </div>

        <div>
          <label className="lf-label" htmlFor="relationship_contact">
            Contact
          </label>
          <input
            id="relationship_contact"
            name="relationship_contact"
            className="lf-input mt-1 w-full"
            value={contact}
            onChange={(event) => setContact(event.target.value)}
            placeholder={contactLabel ?? 'Search for the person'}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="lf-label" htmlFor="relationship_type">
              Relationship Type
            </label>
            <select
              id="relationship_type"
              name="relationship_type"
              className="lf-input mt-1 w-full"
              value={relationshipType}
              onChange={(event) => setRelationshipType(event.target.value)}
            >
              <option value="">Choose a relationship type</option>
              {RELATIONSHIP_TYPES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-soft">Required.</p>
          </div>

          <div>
            <label className="lf-label" htmlFor="effective_from">
              Effective From
            </label>
            <input
              id="effective_from"
              name="effective_from"
              type="date"
              className="lf-input mt-1 w-full"
              value={effectiveFrom}
              onChange={(event) => setEffectiveFrom(event.target.value)}
            />
          </div>
        </div>

        {/* ------------------------------------------------ evidence type */}
        <div>
          <p className="lf-label">Evidence Type</p>
          <ul className="mt-2 space-y-2">
            {EVIDENCE_TYPES.map((option) => (
              <li key={option.key}>
                <button
                  type="button"
                  name={`evidence_${option.key.split(' ')[0].toLowerCase()}`}
                  onClick={() => setEvidenceType(option.key)}
                  aria-pressed={evidenceType === option.key}
                  className={`w-full rounded-lg border px-3 py-2 text-left ${
                    evidenceType === option.key
                      ? 'border-blue/60 bg-panel3'
                      : 'border-line bg-panel2'
                  }`}
                >
                  <span className="text-sm text-text">{option.key}</span>
                  {/* The description is the decision, not help text. */}
                  <span className="mt-0.5 block text-xs text-soft">{option.description}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <label className="lf-label" htmlFor="property_business_context">
            Property / Business Context
          </label>
          <input
            id="property_business_context"
            name="property_business_context"
            className="lf-input mt-1 w-full"
            value={context}
            onChange={(event) => setContext(event.target.value)}
          />
          <p className="mt-1 text-xs text-soft">
            What the relationship was confirmed FOR. A role confirmed in one context is not a
            claim about the whole person.
          </p>
        </div>

        <div>
          <label className="lf-label" htmlFor="evidence_note">
            Evidence Note
          </label>
          <textarea
            id="evidence_note"
            name="evidence_note"
            rows={3}
            className="lf-input mt-1 w-full"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>

        {/* ---------------------------------------- the consent limit, in words */}
        <button
          type="button"
          name="acknowledge_no_consent"
          onClick={() => setAcknowledged((current) => !current)}
          aria-pressed={acknowledged}
          className={`w-full rounded-lg border px-3 py-3 text-left ${
            acknowledged ? 'border-blue/60 bg-panel3' : 'border-gold/40 bg-gold/10'
          }`}
        >
          <span className="text-sm text-text">
            I understand this creates a P4 relationship assertion but does not create channel
            consent.
          </span>
          <span className="mt-1 block text-xs text-soft">
            A direct relationship is a statement about identity provenance. Permission to contact
            is separate and only the person can grant it.
          </span>
        </button>
      </div>
    </Modal>
  );
}
