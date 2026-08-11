import { useState } from 'react';
import { api, ApiError, type EvidenceBundle } from '../../services/api';
import { Modal } from '../../design-system/overlays/Modal';

/**
 * The signed evidence bundle.
 *
 * THE SIGNATURE IS THE PRODUCT. An export of audit rows that the exporting
 * system vouches for proves nothing to the party most likely to want it — the
 * regulator, the customer's lawyer, the counterparty in a dispute — because
 * they are being asked to trust the system whose behaviour is in question. A
 * bundle that verifies against a published key can be checked without us, which
 * is the only form of evidence that survives the argument it was produced for.
 * The algorithm is therefore shown alongside the signature: a signature with no
 * named algorithm cannot be verified by anybody who did not already know how.
 *
 * THE CONTENTS LIST DECLARES WHAT IS AND IS NOT IN THE PACKAGE, per section.
 * A bundle that silently omitted the trace spans would look complete and answer
 * a different question than the one asked of it.
 */

const SECTIONS = [
  { key: 'audit_chain', label: 'Audit chain segment' },
  { key: 'evidence_blobs', label: 'Referenced evidence blobs' },
  { key: 'policy_bundles', label: 'Policy bundle versions in force' },
  { key: 'consent_receipts', label: 'Consent receipts' },
  { key: 'trace_spans', label: 'Trace spans' },
];

export function EvidenceBundleModal({
  open,
  subjectRef,
  onClose,
}: {
  open: boolean;
  subjectRef: string;
  onClose: () => void;
}) {
  const [include, setInclude] = useState<string[]>(SECTIONS.map((s) => s.key));
  const [bundle, setBundle] = useState<EvidenceBundle | null>(null);
  const [building, setBuilding] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const toggle = (key: string) =>
    setInclude((current) =>
      current.includes(key) ? current.filter((k) => k !== key) : [...current, key],
    );

  const build = async () => {
    setBuilding(true);
    setFailure(null);
    try {
      setBundle(await api.evidenceBundle({ subject_ref: subjectRef, include }));
    } catch (caught) {
      setFailure(caught instanceof ApiError ? caught.message : 'The bundle could not be built.');
    } finally {
      setBuilding(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Export evidence bundle"
      subtitle="A portable package the recipient verifies independently, without trusting this system."
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" name="cancel_bundle" onClick={onClose} className="lf-btn-secondary px-4 py-2">
            Cancel
          </button>
          <button
            type="button"
            name="build_bundle"
            disabled={subjectRef === '' || include.length === 0 || building}
            onClick={() => void build()}
            className="lf-btn-primary px-4 py-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {building ? 'Building...' : 'Build bundle'}
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

        {subjectRef === '' && (
          <p className="rounded border border-gold/40 bg-gold/10 px-3 py-2 text-sm text-gold">
            Name a subject on the screen behind before building a bundle.
          </p>
        )}

        <div>
          <h3 className="lf-label">What to include</h3>
          <ul className="mt-2 space-y-2">
            {SECTIONS.map((section) => (
              <li key={section.key}>
                <button
                  type="button"
                  name={section.key}
                  onClick={() => toggle(section.key)}
                  aria-pressed={include.includes(section.key)}
                  className={`w-full rounded-lg border px-3 py-2 text-left text-sm ${
                    include.includes(section.key)
                      ? 'border-blue/60 bg-panel3 text-text'
                      : 'border-line bg-panel2 text-muted'
                  }`}
                >
                  {section.label}
                </button>
              </li>
            ))}
          </ul>
        </div>

        {bundle && (
          <div className="rounded-lg border border-line bg-panel2 p-3">
            <p className="lf-label">Bundle reference</p>
            <p className="break-all text-sm text-text">{bundle.bundle_ref ?? 'Not issued'}</p>

            <p className="lf-label mt-3">Signature</p>
            <p className="break-all font-mono text-xs text-text">
              {bundle.signature ?? 'Not signed'}
            </p>
            {/* Without the algorithm a signature can only be verified by
                somebody who already knew how, which is nobody outside. */}
            <p className="mt-1 text-xs text-soft">
              Algorithm {bundle.signature_algorithm ?? 'not stated'} - verify with the published
              key, not with this system.
            </p>

            <p className="lf-label mt-3">Contents</p>
            <ul className="mt-1 space-y-1">
              {bundle.contents.map((entry) => (
                <li key={entry.section} className="text-xs">
                  <span className={entry.included ? 'text-green' : 'text-muted'}>
                    {entry.included ? 'Included' : 'Omitted'}
                  </span>
                  <span className="text-soft"> — {entry.section}: {entry.detail}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}
