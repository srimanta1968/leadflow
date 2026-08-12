import { Link } from 'react-router-dom';
import { useContactRecord } from '../ContactRecordContext';

/**
 * Contact 360 Preferences & Consent.
 *
 * DELIBERATELY A POINTER, NOT A SECOND CONSENT SCREEN. The receipt register,
 * suppression controls and revocation flow already exist at /app/consent, and
 * building a per-contact copy of them is how two consent surfaces come to
 * disagree about the same person — the failure mode with the worst possible
 * consequence, since one of the two would be telling an operator they may
 * contact somebody who has revoked.
 *
 * The tab still exists rather than being dropped from the eight because the
 * mockup's tab list is the operator's map of what a contact HAS, and a missing
 * tab reads as "this record has no consent story".
 */

export default function ConsentTab() {
  const { summary } = useContactRecord();
  const consentNode = summary?.trust_rail?.find((node) => node.node === 'CONSENT');

  return (
    <section aria-label="Preferences and Consent" className="lf-panel p-5">
      <h2 className="text-lg font-semibold text-text">Preferences &amp; Consent</h2>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        Permission to contact is tracked separately from identity. A record can be fully verified
        and still carry no permission to contact.
      </p>

      <div className="mt-4 rounded-lg border border-line bg-panel2 p-4">
        <p className="lf-label">Consent state on this record</p>
        <p className="mt-1 text-sm text-text">
          {consentNode ? consentNode.state : 'Not read'}
        </p>
        <p className="mt-1 text-xs text-soft">
          {consentNode?.evidence ??
            'No consent evidence was returned with this record, so nothing is asserted about it here.'}
        </p>
      </div>

      <p className="mt-4 text-sm text-muted">
        Receipts, purposes and suppression are governed in one place so two screens can never
        disagree about the same person.
      </p>

      <Link to="/app/consent" className="lf-btn-secondary mt-3 inline-block px-3 py-1.5">
        Open Consent and Preferences
      </Link>
    </section>
  );
}
