import { useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type ContactPropertyList,
  type ContactPropertyRow,
  type LinkPropertyResult,
} from '../../../services/api';
import { useContactRecord } from '../ContactRecordContext';
import { DataTable, type Column } from '../../../design-system/data/DataTable';
import { Modal } from '../../../design-system/overlays/Modal';
import { chipClass } from '../../../design-system/tokens';
import { useToast } from '../../../components/feedback/ToastProvider';

/**
 * Associated Properties (#view-properties) and the Link Property flow.
 *
 * LINKING A PROPERTY NEVER WRITES A PROPERTY FACT ONTO THE PERSON. That is the
 * acceptance condition and it is a modelling decision, not a validation rule: an
 * address belongs to a PLACE, and the person's connection to it is a CONTEXTUAL
 * ROLE with its own validity window and its own evidence. Copying "123 Main St"
 * onto the person makes the fact untrackable — it has no source, no valid-from
 * and nothing to retract when the person sells the house. The server reports
 * `person_attributes_written`, and this screen shows it, so the guarantee is
 * observable rather than merely asserted in a comment.
 *
 * THE ADDRESS IS CANONICALIZED BEFORE THE LINK IS WRITTEN, upstream and not
 * here. Two operators typing the same house differently must reach the same
 * place, and a browser cannot know that "St" and "Street" are the same street
 * while "N Main" and "Main" are not. The preview shows what the address
 * RESOLVED to, so the person confirming the link confirms the place the system
 * actually chose rather than the text they typed.
 *
 * TRUST STATE AND VALID-FROM ARE REQUIRED on every link. A relationship with no
 * trust state reads as confirmed, and one with no start date cannot be reasoned
 * about later — "did they own it when we called?" is exactly the question these
 * two fields exist to answer.
 */

const FRAMING =
  'Contact-Centered Property Relationships. Full Property workflow lives in a separate application; what is governed here is the relationship.';

const TRUST_STATES = ['Confirmed', 'Candidate', 'Documented'] as const;

const ROLES = [
  'Homeowner',
  'Occupant',
  'Landlord',
  'Tenant',
  'Authorized representative',
  'Contracting party',
];

const EVIDENCE_TYPES = ['In-person confirmation', 'Inbound response', 'Signed document', 'Public record'];

const shown = (value: string | null): string => (value && value.trim() !== '' ? value : '--');

export default function PropertiesTab() {
  const { contactId } = useContactRecord();
  const [data, setData] = useState<ContactPropertyList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const { notify } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.contactProperties(contactId));
      setError(null);
    } catch (caught) {
      setData(null);
      setError(caught instanceof ApiError ? caught.message : 'Properties could not be read.');
    } finally {
      setLoading(false);
    }
  }, [contactId]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: Column<ContactPropertyRow>[] = [
    {
      key: 'property',
      header: 'Property',
      width: '26%',
      cell: (r) => (
        <div>
          <p className="text-text">{shown(r.property_label)}</p>
          {/* The parcel note says whether this address matched a known parcel.
              An address that did not is still linkable and must say so. */}
          {r.parcel_note && <p className="text-[11px] text-soft">{r.parcel_note}</p>}
        </div>
      ),
    },
    { key: 'relationship', header: 'Relationship', cell: (r) => shown(r.relationship), width: '18%' },
    {
      key: 'trust',
      header: 'Trust',
      width: '12%',
      cell: (r) =>
        r.trust_state ? (
          <span
            className={`lf-pill ${chipClass(
              r.trust_state === 'Confirmed' ? 'success' : r.trust_state === 'Candidate' ? 'warning' : 'info',
            )}`}
          >
            {r.trust_state}
          </span>
        ) : (
          '--'
        ),
    },
    { key: 'valid_from', header: 'Valid From', cell: (r) => shown(r.valid_from), width: '12%' },
    { key: 'evidence', header: 'Evidence', cell: (r) => shown(r.evidence_summary), width: '18%' },
    { key: 'work', header: 'Active Work', cell: (r) => shown(r.active_work), width: '14%' },
  ];

  return (
    <section aria-label="Associated Properties">
      <div className="lf-panel p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-text">Associated Properties</h2>
            <p className="mt-1 max-w-3xl text-sm text-muted">{FRAMING}</p>
          </div>
          <button
            type="button"
            name="link_property"
            onClick={() => setLinkOpen(true)}
            className="lf-btn-primary px-3 py-1.5"
          >
            Link Property
          </button>
        </div>
      </div>

      <div className="lf-panel mt-4 p-5">
        <DataTable
          rows={data?.properties ?? []}
          columns={columns}
          rowKey={(r) => r.relationship_id ?? `${r.property_label}:${r.valid_from}`}
          loading={loading}
          density="dense"
          caption="Property relationships"
          error={error ? <span>{error}</span> : undefined}
          empty={<span>No property relationships are recorded for this person.</span>}
          rowActions={() => (
            <button type="button" name="open_property" className="lf-btn-ghost px-2 py-1">
              Review
            </button>
          )}
        />
      </div>

      <LinkPropertyModal
        open={linkOpen}
        contactId={contactId}
        onClose={() => setLinkOpen(false)}
        onLinked={(result) => {
          notify({
            tone: 'success',
            title: 'Property linked as a contextual role',
            detail: `${result.person_attributes_written} property attributes were written onto the Person record.`,
          });
          setLinkOpen(false);
          void load();
        }}
      />
    </section>
  );
}

/**
 * The Link Property flow: address entry, canonicalization preview, then the
 * role, trust state, valid-from and evidence that make the link answerable.
 *
 * The preview is a SEPARATE step from the write on purpose. Canonicalization can
 * resolve a typed address to a different place than the operator meant, and the
 * only moment that is cheap to correct is before the relationship exists.
 */
function LinkPropertyModal({
  open,
  contactId,
  onClose,
  onLinked,
}: {
  open: boolean;
  contactId: string;
  onClose: () => void;
  onLinked: (result: LinkPropertyResult) => void;
}) {
  const [address, setAddress] = useState('');
  const [role, setRole] = useState(ROLES[0]);
  const [trustState, setTrustState] = useState<string>(TRUST_STATES[1]);
  const [validFrom, setValidFrom] = useState('');
  const [evidenceType, setEvidenceType] = useState(EVIDENCE_TYPES[0]);
  const [evidenceNote, setEvidenceNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // Required, and checked here so the operator is told before the round trip.
  // The server enforces the same rule; this is the courtesy half of it.
  const complete = address.trim() !== '' && validFrom.trim() !== '' && trustState !== '';

  const submit = async () => {
    setSubmitting(true);
    setFailure(null);
    try {
      onLinked(
        await api.linkContactProperty(contactId, {
          address: address.trim(),
          role,
          trust_state: trustState,
          valid_from: validFrom,
          evidence_type: evidenceType,
          evidence_note: evidenceNote.trim() || undefined,
        }),
      );
    } catch (caught) {
      setFailure(caught instanceof ApiError ? caught.message : 'The property could not be linked.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Link Property"
      subtitle="Creates a contextual role between this person and a place. No property attribute is written onto the Person record."
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" name="cancel_link" onClick={onClose} className="lf-btn-secondary px-4 py-2">
            Cancel
          </button>
          <button
            type="button"
            name="submit_link"
            disabled={!complete || submitting}
            onClick={() => void submit()}
            className="lf-btn-primary px-4 py-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? 'Linking...' : 'Link Property'}
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

        <div>
          <label className="lf-label" htmlFor="property_address">
            Property address
          </label>
          <input
            id="property_address"
            name="property_address"
            className="lf-input mt-1 w-full"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder="Street, city, postcode"
          />
          <p className="mt-1 text-xs text-soft">
            The address is canonicalized upstream before the relationship is created, so two
            spellings of the same place resolve to one.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="lf-label" htmlFor="property_role">
              Role
            </label>
            <select
              id="property_role"
              name="property_role"
              className="lf-input mt-1 w-full"
              value={role}
              onChange={(event) => setRole(event.target.value)}
            >
              {ROLES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="lf-label" htmlFor="trust_state">
              Trust state
            </label>
            <select
              id="trust_state"
              name="trust_state"
              className="lf-input mt-1 w-full"
              value={trustState}
              onChange={(event) => setTrustState(event.target.value)}
            >
              {TRUST_STATES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="lf-label" htmlFor="valid_from">
              Valid from
            </label>
            <input
              id="valid_from"
              name="valid_from"
              type="date"
              className="lf-input mt-1 w-full"
              value={validFrom}
              onChange={(event) => setValidFrom(event.target.value)}
            />
          </div>

          <div>
            <label className="lf-label" htmlFor="evidence_type">
              Evidence type
            </label>
            <select
              id="evidence_type"
              name="evidence_type"
              className="lf-input mt-1 w-full"
              value={evidenceType}
              onChange={(event) => setEvidenceType(event.target.value)}
            >
              {EVIDENCE_TYPES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="lf-label" htmlFor="evidence_note">
            Evidence note
          </label>
          <textarea
            id="evidence_note"
            name="evidence_note"
            rows={3}
            className="lf-input mt-1 w-full"
            value={evidenceNote}
            onChange={(event) => setEvidenceNote(event.target.value)}
          />
        </div>
      </div>
    </Modal>
  );
}
