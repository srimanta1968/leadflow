import { useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type EnrichmentQueue as Queue,
  type EnrichmentRequest,
  type EnrichmentStatus,
} from '../../services/api';
import { useToast } from '../../components/feedback/ToastProvider';
import { DataCreditsDrawer } from '../../components/app/DataCreditsDrawer';
import { ContactEnrichmentModal } from '../../components/app/ContactEnrichmentModal';

/**
 * Permissioned Data Capabilities / Enrichment Queue (#view-enrichment).
 *
 * NO PROVIDER OR VENDOR NAME APPEARS ANYWHERE ON THIS SCREEN (AC1), and the
 * reason it cannot is upstream rather than a rule this file follows carefully:
 * the endpoint composes every field by hand and the broker never projects a
 * provider. The one tile the mockup asks for that WOULD have leaked provider
 * behaviour - a provider-fallback count - comes back permanently null with a
 * named reason, and this screen renders the reason rather than a zero. A count
 * of how often we failed over describes the shape of the provider chain even
 * without printing a brand.
 *
 * NULL IS NOT ZERO, AND THE RAIL RENDERS THEM DIFFERENTLY. An unread register
 * shows a dash and says why; an empty one shows 0. Collapsing the two is how a
 * screen reports "nothing awaiting approval" during an outage.
 */

const STATUS_SEGMENTS: { key: EnrichmentStatus | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'awaiting', label: 'Awaiting' },
  { key: 'processing', label: 'Processing' },
  { key: 'complete', label: 'Complete' },
  { key: 'blocked', label: 'Blocked' },
];

const VERDICT_LABEL: Record<string, string> = {
  approval: 'Approval',
  eligible: 'Eligible',
  denied: 'Denied',
};

const STATUS_LABEL: Record<string, string> = {
  awaiting: 'Awaiting',
  processing: 'Processing',
  complete: 'Complete',
  blocked: 'Blocked',
};

/** A figure, or a dash when it could not be read. Never a substituted zero. */
const figure = (value: number | null | undefined): string =>
  typeof value === 'number' ? value.toLocaleString() : '--';

const percent = (rate: number | null): string =>
  rate === null ? '--' : `${Math.round(rate * 100)}%`;

const timestamp = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString() : '--';

export default function EnrichmentQueue() {
  const [queue, setQueue] = useState<Queue | null>(null);
  const [filter, setFilter] = useState<EnrichmentStatus | 'all'>('all');
  const [loading, setLoading] = useState(true);
  const [creditsOpen, setCreditsOpen] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);
  const [explaining, setExplaining] = useState<EnrichmentRequest | null>(null);
  const { notify } = useToast();

  const load = useCallback(async (status: EnrichmentStatus | 'all') => {
    setLoading(true);
    try {
      setQueue(await api.enrichmentQueue(status === 'all' ? undefined : status));
    } catch (error) {
      notify({
        tone: 'error',
        title: 'The enrichment register could not be loaded.',
        detail: error instanceof ApiError ? error.message : undefined,
      });
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void load(filter);
  }, [filter, load]);

  const kpis = queue?.kpis;
  const fallbackGap = queue?.metric_gaps?.find((gap) => gap.metric === 'provider_fallbacks');

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-text">Permissioned Data Capabilities</h1>
          {/*
            The framing line, and it is the product's whole claim about this
            screen: you buy an OUTCOME at a stated price, and who answers it is
            not part of what you are buying.
          */}
          <p className="mt-1.5 max-w-2xl text-sm text-muted">
            Buy an outcome at a stated price. Every request is reserved before it runs, and no
            result creates permission to contact anybody.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            name="credits_and_budgets"
            onClick={() => setCreditsOpen(true)}
            className="lf-btn-secondary px-4 py-2"
          >
            Credits &amp; Budgets
          </button>
          <button
            type="button"
            name="new_request"
            onClick={() => setRequestOpen(true)}
            className="lf-btn-primary px-4 py-2"
          >
            New Request
          </button>
        </div>
      </div>

      {/* ------------------------------------------------------- the KPI rail */}
      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <section className="lf-card p-4">
          <h2 className="text-sm font-semibold text-text">Awaiting Approval</h2>
          <p className="mt-1 text-2xl font-bold text-text">
            {figure(kpis?.awaiting_approval?.count)}
          </p>
          <p className="text-sm text-muted">
            {figure(kpis?.awaiting_approval?.estimated_credits)} credits estimated
          </p>
        </section>

        <section className="lf-card p-4">
          <h2 className="text-sm font-semibold text-text">Processing</h2>
          <p className="mt-1 text-2xl font-bold text-text">{figure(kpis?.processing?.count)}</p>
          {/*
            The gap is PRINTED, not hidden. A blank line here would read as
            "zero fallbacks"; the sentence says the number is deliberately not
            available and why, which is the honest state of this tile.
          */}
          <p className="text-sm text-muted">{fallbackGap?.reason ?? 'Provider fallbacks are not reported.'}</p>
        </section>

        <section className="lf-card p-4">
          <h2 className="text-sm font-semibold text-text">Completed Today</h2>
          <p className="mt-1 text-2xl font-bold text-text">
            {figure(kpis?.completed_today?.count)}
          </p>
          <p className="text-sm text-muted">
            {figure(kpis?.completed_today?.matched)} successful matches
          </p>
        </section>

        <section className="lf-card p-4">
          <h2 className="text-sm font-semibold text-text">No Match</h2>
          <p className="mt-1 text-2xl font-bold text-text">{figure(kpis?.no_match?.count)}</p>
          <p className="text-sm text-muted">{kpis?.no_match?.policy ?? 'No-charge policy applied'}</p>
        </section>

        <section className="lf-card p-4">
          <h2 className="text-sm font-semibold text-text">Cache Reuse</h2>
          {/* AC3 - both figures are computed from the rows, never a counter. */}
          <p className="mt-1 text-2xl font-bold text-text">{percent(kpis?.cache_reuse?.rate ?? null)}</p>
          <p className="text-sm text-muted">
            {figure(kpis?.cache_reuse?.credits_saved)} credits saved
          </p>
        </section>

        <section className="lf-card p-4">
          <h2 className="text-sm font-semibold text-text">Budget Remaining</h2>
          <p className="mt-1 text-2xl font-bold text-text">
            {figure(kpis?.budget_remaining?.available)}
          </p>
          <p className="text-sm text-muted">
            {figure(kpis?.budget_remaining?.reserved)} reserved
          </p>
        </section>
      </div>

      {/* --------------------------------------------------- request register */}
      <div className="mt-8 flex flex-wrap items-center gap-2">
        {STATUS_SEGMENTS.map((segment) => (
          <button
            key={segment.key}
            type="button"
            name={`filter_${segment.key}`}
            onClick={() => setFilter(segment.key)}
            className={`lf-pill px-3 py-1.5 ${
              filter === segment.key ? 'border-blue bg-blue/10 text-blue' : 'border-line2 text-muted'
            }`}
          >
            {segment.label}
            {segment.key !== 'all' && queue?.status_counts?.[segment.key] !== undefined && (
              <span className="ml-2">{queue.status_counts[segment.key]}</span>
            )}
          </button>
        ))}
      </div>

      {loading && <p className="mt-4 text-sm text-muted">Loading the register...</p>}

      {queue && !loading && queue.requests.length === 0 && (
        <p className="mt-4 text-sm text-muted">
          {queue.upstream_available.requests
            ? 'No requests in this window.'
            : 'The request register could not be read, so this is not an empty queue.'}
        </p>
      )}

      {queue && queue.requests.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-muted">
              <tr>
                <th className="py-2">Request</th>
                <th>Contact</th>
                <th>Capabilities</th>
                <th>Purpose</th>
                <th>Requested by</th>
                <th>Estimate</th>
                <th>Policy verdict</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {queue.requests.map((row) => (
                <tr key={row.request_id ?? timestamp(row.created_at)} className="border-t border-line2">
                  <td className="py-2">
                    <span className="block font-semibold text-text">{row.request_id ?? '--'}</span>
                    <span className="block text-xs text-muted">{timestamp(row.created_at)}</span>
                  </td>
                  {/* A dash, because the broker keeps only a fingerprint. */}
                  <td>{row.contact ?? '--'}</td>
                  <td>
                    {row.capabilities.map((key) => (
                      <span key={key} className="lf-pill mr-1 border-line2 text-muted">
                        {key}
                      </span>
                    ))}
                  </td>
                  <td>{row.purpose ?? '--'}</td>
                  <td>{row.requested_by ?? '--'}</td>
                  <td>{figure(row.estimate)}</td>
                  <td>{VERDICT_LABEL[row.policy_verdict] ?? row.policy_verdict}</td>
                  <td>{STATUS_LABEL[row.status] ?? row.status}</td>
                  <td>
                    {/*
                      AC2 - a refusal always offers Explain, and the reason it
                      shows is QUOTED from the credit ledger rather than composed
                      here. A sentence written in the UI would read as
                      authoritative while agreeing with nothing.
                    */}
                    {row.explain_reason ? (
                      <button
                        type="button"
                        name="explain"
                        onClick={() => setExplaining(row)}
                        className="lf-btn-secondary px-3 py-1.5 text-xs"
                      >
                        Explain
                      </button>
                    ) : (
                      <span className="text-xs text-soft">{row.action}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {explaining && (
        <p className="mt-3 rounded-md bg-surface-2 p-3 text-sm text-text">
          <span className="block font-semibold">Why this was refused</span>
          <span className="block text-muted">{explaining.explain_reason}</span>
        </p>
      )}

      {/* ------------------------------------------------ capability catalog */}
      <h2 className="mt-10 text-lg font-semibold text-text">Capability Catalog</h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {(queue?.capabilities ?? []).map((capability) => (
          <section key={capability.key} className="lf-card p-4">
            <div className="flex items-start justify-between gap-3">
              <h3 className="text-sm font-semibold text-text">{capability.outcome_label}</h3>
              {/* Null price prints a dash: a zero would read as free. */}
              <span className="whitespace-nowrap text-sm text-muted">
                {capability.credit_price === null
                  ? '--'
                  : `${capability.credit_price} ${capability.credit_price === 1 ? 'credit' : 'credits'}`}
              </span>
            </div>
            {capability.description && (
              <p className="mt-1 text-sm text-muted">{capability.description}</p>
            )}
            {!capability.offered && (
              <p className="mt-1 text-sm text-muted">Not enabled for your organization.</p>
            )}
            <ul className="mt-2 space-y-1">
              {capability.caveats.map((caveat) => (
                <li key={caveat} className="text-xs text-muted">
                  {caveat}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <DataCreditsDrawer open={creditsOpen} onClose={() => setCreditsOpen(false)} />
      <ContactEnrichmentModal
        open={requestOpen}
        onClose={() => setRequestOpen(false)}
        subjectRef="new-request"
        contactLabel="New request"
      />
    </div>
  );
}
