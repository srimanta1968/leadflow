import { useCallback, useEffect, useState } from 'react';
import { Modal } from '../../design-system/overlays/Modal';
import { api, ApiError } from '../../services/api';
import { useToast } from '../feedback/ToastProvider';

/**
 * The Contact Enrichment modal (#enrichDrawer).
 *
 * THE POLICY VERDICT IS LIVE, AND THAT IS THE POINT OF THE SCREEN. It is
 * re-asked whenever a capability is ticked or the business reason changes,
 * because the verdict genuinely depends on both: 'Find additional contact
 * points' under 'Data quality remediation' is a different question from the same
 * capability under 'Commercial account qualification'. A verdict computed once
 * on open would be stale by the time the operator pressed Reserve & Run, and it
 * is the callout they are relying on to decide whether to press it.
 *
 * RESERVE & RUN IS DISABLED, NOT MERELY WARNED, when the requester's tier needs
 * an approval. A warning next to a live button invites the press, and the press
 * spends the organization's money. The server refuses it too - this is the half
 * the operator can see.
 *
 * NOTHING HERE NAMES A PROVIDER. Each capability is described by its OUTCOME and
 * its price, which is the whole contract sdk-data-credits exists to keep.
 */

interface Capability {
  key: string;
  label: string;
  price: number;
  detail: string;
}

/** The four capabilities, priced and worded exactly as the mockup states them. */
const CAPABILITIES: readonly Capability[] = [
  {
    key: 'validate_phone',
    label: 'Validate primary phone',
    price: 1,
    detail: 'Line type, format, freshness and risk signals.',
  },
  {
    key: 'validate_email',
    label: 'Validate primary email',
    price: 1,
    detail: 'Domain and deliverability signals.',
  },
  {
    key: 'find_contact_points',
    label: 'Find additional contact points',
    price: 2,
    detail: 'Returns candidates only; does not create consent.',
  },
  {
    key: 'find_possible_profiles',
    label: 'Find possible external profiles',
    price: 1,
    detail: 'Human confirmation required before linking.',
  },
];

const BUSINESS_REASONS: readonly string[] = [
  'Inspection lead follow-up',
  'Existing customer service',
  'Commercial account qualification',
  'Data quality remediation',
];

interface Eligibility {
  eligible: boolean;
  verdict: 'allow' | 'review' | 'deny';
  headline: string;
  reason: string;
  estimated_credits: number;
  requires_approval: boolean;
  budget_tier: string;
  policy_reached: boolean;
}

export interface ContactEnrichmentModalProps {
  open: boolean;
  onClose: () => void;
  /** The contact the request is about. */
  subjectRef: string;
  contactLabel: string;
  contactContext?: string;
  requesterLabel?: string;
}

export function ContactEnrichmentModal({
  open,
  onClose,
  subjectRef,
  contactLabel,
  contactContext,
  requesterLabel,
}: ContactEnrichmentModalProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const [purpose, setPurpose] = useState<string>(BUSINESS_REASONS[0]);
  const [notes, setNotes] = useState('');
  const [eligibility, setEligibility] = useState<Eligibility | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { notify } = useToast();

  const estimate = selected.reduce(
    (total, key) => total + (CAPABILITIES.find((c) => c.key === key)?.price ?? 0),
    0,
  );

  /** Re-ask the policy. Cheap and non-spending by design; see the endpoint. */
  const refreshVerdict = useCallback(
    async (keys: string[], reason: string) => {
      if (keys.length === 0) {
        setEligibility(null);
        return;
      }
      try {
        setEligibility(await api.enrichmentEligibility({
          subject_ref: subjectRef,
          capability_keys: keys,
          purpose: reason,
        }));
      } catch (error) {
        // A verdict we could not obtain must not read as permission.
        setEligibility({
          eligible: false,
          verdict: 'review',
          headline: 'Needs review',
          reason:
            error instanceof ApiError
              ? error.message
              : 'The policy service could not be reached, so this needs a person to approve it.',
          estimated_credits: 0,
          requires_approval: true,
          budget_tier: 'unknown',
          policy_reached: false,
        });
      }
    },
    [subjectRef],
  );

  useEffect(() => {
    if (!open) return;
    void refreshVerdict(selected, purpose);
  }, [open, selected, purpose, refreshVerdict]);

  useEffect(() => {
    if (open) return;
    setSelected([]);
    setNotes('');
    setEligibility(null);
    setPurpose(BUSINESS_REASONS[0]);
  }, [open]);

  const toggle = (key: string): void => {
    setSelected((current) =>
      current.includes(key) ? current.filter((k) => k !== key) : [...current, key],
    );
  };

  const blocked = selected.length === 0 || eligibility?.requires_approval === true
    || eligibility?.verdict === 'deny';

  const submit = async (): Promise<void> => {
    setSubmitting(true);
    try {
      const body = await api.enrichmentRequest({
        subject_ref: subjectRef,
        capability_keys: selected,
        purpose,
        notes,
      });
      notify(
        body.executed
          ? { tone: 'success', title: 'Credits reserved and the run started.' }
          : {
            tone: 'warning',
            title: 'Nothing has run yet.',
            detail: body.blocked_reason
              ?? 'The credits were held, but the run has not started.',
          },
      );
      onClose();
    } catch (error) {
      notify({
        tone: 'error',
        title: 'The request could not be submitted.',
        detail: error instanceof ApiError ? error.message : undefined,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Contact Enrichment"
      size="lg"
      footer={
        <div className="flex justify-end gap-3">
          <button type="button" name="cancel" className="lf-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            name="reserve_and_run"
            className="lf-btn-primary"
            disabled={blocked || submitting}
            onClick={() => void submit()}
          >
            Reserve &amp; Run
          </button>
        </div>
      }
    >
      <div className="space-y-6">
        <section className="grid gap-4 sm:grid-cols-2">
          <div>
            <h3 className="text-sm font-semibold text-text">Contact</h3>
            <p className="text-sm text-text">{contactLabel}</p>
            {contactContext && <p className="text-sm text-muted">{contactContext}</p>}
          </div>
          <div>
            <h3 className="text-sm font-semibold text-text">Requester</h3>
            <p className="text-sm text-text">{requesterLabel ?? 'You'}</p>
            <p className="text-sm text-muted">
              {eligibility ? `${eligibility.budget_tier} - budget authority` : 'Budget authority'}
            </p>
          </div>
        </section>

        <section>
          <h3 className="text-sm font-semibold text-text">Select Capabilities</h3>
          <p className="text-sm text-muted">
            Credit estimate is reserved before provider invocation.
          </p>
          <ul className="mt-2 space-y-2">
            {CAPABILITIES.map((capability) => (
              <li key={capability.key}>
                <label className="flex items-start gap-3 text-sm">
                  <input
                    type="checkbox"
                    name={capability.key}
                    checked={selected.includes(capability.key)}
                    onChange={() => toggle(capability.key)}
                  />
                  <span>
                    <span className="block font-medium text-text">
                      {capability.label} - {capability.price}{' '}
                      {capability.price === 1 ? 'credit' : 'credits'}
                    </span>
                    <span className="block text-muted">{capability.detail}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h3 className="text-sm font-semibold text-text">Purpose &amp; Governance</h3>
          <label className="mt-2 block text-sm text-muted" htmlFor="business_reason">
            Business Reason
          </label>
          <select
            id="business_reason"
            name="business_reason"
            className="lf-input mt-1 w-full"
            value={purpose}
            onChange={(event) => setPurpose(event.target.value)}
          >
            {BUSINESS_REASONS.map((reason) => (
              <option key={reason} value={reason}>
                {reason}
              </option>
            ))}
          </select>

          <label className="mt-3 block text-sm text-muted" htmlFor="notes">
            Notes
          </label>
          <textarea
            id="notes"
            name="notes"
            className="lf-input mt-1 w-full"
            rows={2}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />

          {eligibility && (
            <p
              className="mt-3 rounded-md bg-surface-2 p-3 text-sm text-text"
              data-verdict={eligibility.verdict}
            >
              <span className="block font-semibold">{eligibility.headline}</span>
              <span className="block text-muted">{eligibility.reason}</span>
            </p>
          )}
        </section>

        <section>
          <h3 className="text-sm font-semibold text-text">Estimated Data Credits</h3>
          <p className="text-2xl font-bold text-text">{estimate}</p>
          <p className="text-sm text-muted">
            Technical failures and recent cache hits are not double-charged.
          </p>
        </section>
      </div>
    </Modal>
  );
}
