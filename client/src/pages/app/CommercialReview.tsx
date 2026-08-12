import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError, type OfferStaleness } from '../../services/api';
import { chipClass } from '../../design-system/tokens';

/**
 * Commercial Review workspace and offer version stamping (SOP §13 and §32).
 *
 * THE VERSION IS STAMPED ONTO THE RECORD AND ONTO EVERY RECAP. A dispute six
 * months later is settled by what the customer was actually shown, and "the
 * pricing page said something different then" is unanswerable unless the version
 * travelled with the conversation. Stamping only the opportunity is the
 * near-miss that fails in practice: the recap email is the artefact the customer
 * keeps, so it is the one that has to carry the version.
 *
 * A DISCOUNT CANNOT BE SPOKEN BEFORE IT IS APPROVED. The ordering is the whole
 * control. Once an exception has been said out loud it has been granted in the
 * customer's mind, and every approval after that is a negotiation about
 * withdrawing something rather than a decision about granting it.
 *
 * THE FEATURE MATRIX IS ON SCREEN DURING THE CALL. LIVE, BETA, ROADMAP and NOT
 * INCLUDED are four different promises, and a rep working from memory
 * collapses them into "yes". Rendering them inline is what makes the honest
 * answer the easy one.
 */

const FEATURE_STATUS = [
  { key: 'LIVE', label: 'LIVE', role: 'success', meaning: 'Available today, in the product now.' },
  { key: 'BETA', label: 'BETA', role: 'warning', meaning: 'Usable, but changing and not guaranteed.' },
  { key: 'ROADMAP', label: 'ROADMAP', role: 'info', meaning: 'Intended. No date may be promised.' },
  { key: 'NOT_INCLUDED', label: 'NOT INCLUDED', role: 'blocked', meaning: 'Not part of this offer at any price discussed.' },
] as const;

/** The fit summary the SOP asks a rep to compose before the decision meeting. */
const FIT_SUMMARY_PARTS = [
  { key: 'problem', label: 'Problem' },
  { key: 'impact', label: 'Impact' },
  { key: 'desired_outcome', label: 'Desired outcome' },
  { key: 'fit', label: 'Fit' },
  { key: 'honest_limitation', label: 'Honest limitation' },
  { key: 'decision', label: 'Decision' },
];

export default function CommercialReview() {
  const [params] = useSearchParams();
  const opportunityId = params.get('opportunity_id') ?? '';
  const [staleness, setStaleness] = useState<OfferStaleness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<Record<string, string>>({});
  const [exceptionRequested, setExceptionRequested] = useState(false);

  useEffect(() => {
    if (opportunityId === '') return;
    const controller = new AbortController();
    void (async () => {
      try {
        setStaleness(await api.offerStaleness(opportunityId, controller.signal));
        setError(null);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setStaleness(null);
        setError(
          caught instanceof ApiError ? caught.message : 'The offer version could not be read.',
        );
      }
    })();
    return () => controller.abort();
  }, [opportunityId]);

  return (
    <div className="mx-auto max-w-6xl">
      <div>
        <h1 className="text-2xl font-bold text-text">Commercial Review</h1>
        <p className="mt-1.5 max-w-3xl text-sm text-muted">
          The approved offer and terms version is stamped onto this record and onto every recap,
          so a later dispute is settled from evidence rather than from memory.
        </p>
      </div>

      {error && (
        <p className="mt-4 rounded border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">
          {error}
        </p>
      )}

      {/* --------------------------------------------- the staleness banner */}
      {staleness?.stale && (
        <div className="mt-4 rounded-lg border border-gold/40 bg-gold/10 p-4">
          <p className="text-sm font-semibold text-gold">
            The stamped offer version is no longer current.
          </p>
          <p className="mt-1 text-sm text-text">
            This record is stamped {staleness.stamped_version ?? 'an unknown version'} and the
            current version is {staleness.current_version ?? 'unknown'}.
          </p>
          <p className="mt-1 text-xs text-soft">{staleness.note}</p>
        </div>
      )}

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        {/* ------------------------------------------------ version stamp */}
        <section className="lf-panel p-5" aria-label="Offer version">
          <h2 className="lf-eyebrow">Offer version</h2>
          <dl className="mt-3 space-y-2 text-sm">
            <div>
              <dt className="lf-label">Stamped on this record</dt>
              <dd className="text-text">{staleness?.stamped_version ?? 'Not stamped'}</dd>
            </div>
            <div>
              <dt className="lf-label">Current published version</dt>
              <dd className="text-text">{staleness?.current_version ?? 'Not read'}</dd>
            </div>
          </dl>
          <p className="mt-3 text-xs text-soft">
            The version travels with every CRM recap. Stamping only the opportunity is the
            near-miss that fails in practice, because the recap is the artefact the customer
            keeps.
          </p>
          <button type="button" name="attach_offer" className="lf-btn-secondary mt-3 px-3 py-1.5">
            Attach approved offer
          </button>
        </section>

        {/* -------------------------------------------- the feature matrix */}
        <section className="lf-panel p-5" aria-label="Feature status matrix">
          <h2 className="lf-eyebrow">Feature status</h2>
          <p className="mt-1 text-xs text-soft">
            Four different promises. A rep working from memory collapses them into "yes".
          </p>
          <ul className="mt-3 space-y-2">
            {FEATURE_STATUS.map((status) => (
              <li key={status.key} className="flex items-baseline gap-3">
                <span className={`lf-pill ${chipClass(status.role)}`}>{status.label}</span>
                <span className="text-xs text-muted">{status.meaning}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {/* -------------------------------------------- exceptions and approval */}
      <section className="lf-panel mt-4 p-5" aria-label="Discounts and exceptions">
        <h2 className="lf-eyebrow">Discounts and exceptions</h2>
        <p className="mt-1 text-sm text-muted">
          Any discount or exception is routed for approval with a written record BEFORE it can be
          communicated. Once an exception has been said out loud it has been granted in the
          customer's mind, and every approval after that is a negotiation about withdrawing it.
        </p>

        <button
          type="button"
          name="request_exception_approval"
          onClick={() => setExceptionRequested(true)}
          className="lf-btn-secondary mt-3 px-3 py-1.5"
        >
          Request exception approval
        </button>

        <p className="mt-3 text-sm">
          {exceptionRequested ? (
            <span className="text-gold">
              Awaiting approval. This exception may not be communicated to the customer yet.
            </span>
          ) : (
            <span className="text-soft">
              No exception is requested. Nothing beyond the stamped offer may be communicated.
            </span>
          )}
        </p>
      </section>

      {/* ------------------------------------------- the fit summary composer */}
      <section className="lf-panel mt-4 p-5" aria-label="Fit summary">
        <h2 className="lf-eyebrow">Fit summary</h2>
        <p className="mt-1 text-xs text-soft">
          Composed before the decision meeting. The honest limitation is a required part, not an
          optional one - an offer with no stated limitation is not a fit assessment.
        </p>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {FIT_SUMMARY_PARTS.map((part) => (
            <div key={part.key}>
              <label className="lf-label" htmlFor={part.key}>
                {part.label}
              </label>
              <textarea
                id={part.key}
                name={part.key}
                rows={2}
                className="lf-input mt-1 w-full"
                value={summary[part.key] ?? ''}
                onChange={(event) =>
                  setSummary((current) => ({ ...current, [part.key]: event.target.value }))
                }
              />
            </div>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------ review logistics */}
      <section className="lf-panel mt-4 p-5" aria-label="Review logistics">
        <h2 className="lf-eyebrow">Review logistics</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <label className="lf-label" htmlFor="recipients">
              Recipients
            </label>
            <input id="recipients" name="recipients" className="lf-input mt-1 w-full" />
          </div>
          <div>
            <label className="lf-label" htmlFor="decision_meeting">
              Scheduled decision meeting
            </label>
            <input
              id="decision_meeting"
              name="decision_meeting"
              type="datetime-local"
              className="lf-input mt-1 w-full"
            />
          </div>
          <div className="sm:col-span-2">
            <label className="lf-label" htmlFor="questions_raised">
              Questions raised
            </label>
            <textarea
              id="questions_raised"
              name="questions_raised"
              rows={2}
              className="lf-input mt-1 w-full"
            />
          </div>
        </div>
      </section>
    </div>
  );
}
