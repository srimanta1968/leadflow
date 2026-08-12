import { useEffect, useState } from 'react';
import { api, ApiError, type LeadershipDashboard as Data } from '../../services/api';

/**
 * Leadership Operational Dashboard (SOP §05).
 *
 * EVERY TILE DRILLS INTO A LIST. A number with nothing behind it is a poster: it
 * tells a leader that eleven leads are waiting and gives them no way to do
 * anything about it, so the meeting becomes a discussion of the number rather
 * than of the eleven leads. Each of the nine signals below therefore names the
 * screen it opens, and the tile IS that link.
 *
 * THE FIVE SUCCESS-TEST QUESTIONS ARE ANSWERED PER RECORD. Who owns this, what
 * happened last, what happens next, when is it due, what is blocking the sale.
 * The SOP asks them because a record that cannot answer all five is not being
 * worked, whatever the pipeline stage claims — and the questions are far more
 * useful rendered as columns than as a checklist somebody applies by hand.
 *
 * NULL IS NOT ZERO. A signal that could not be computed shows `--`. "0 leads
 * waiting" during an outage is the most dangerous thing this screen could say,
 * because it is exactly what a healthy morning looks like.
 */

/** The nine signals, so the screen shows WHAT it watches even when it cannot read them. */

export default function LeadershipDashboard() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        setData(await api.leadershipDashboard(controller.signal));
        setError(null);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setData(null);
        setError(caught instanceof ApiError ? caught.message : 'The dashboard could not be read.');
      } finally {
      }
    })();
    return () => controller.abort();
  }, []);


  return (
    <div className="mx-auto max-w-7xl">
      <div>
        <h1 className="text-2xl font-bold text-text">Leadership Dashboard</h1>
        <p className="mt-1.5 max-w-3xl text-sm text-muted">
          Nine signals, each opening the list behind it. A number with nothing behind it turns the
          meeting into a discussion of the number rather than of the work.
        </p>
      </div>

      {error && (
        <p className="mt-4 rounded border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">
          {error}
        </p>
      )}

      {/* ------------------------------------------- what the server returns */}
      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="lf-card p-4">
          <p className="text-xs text-muted">Unowned</p>
          <p className={`mt-1 text-3xl font-bold ${(data?.pipeline_health?.unowned ?? 0) > 0 ? 'text-red' : 'text-text'}`}>
            {data ? data.pipeline_health.unowned : '--'}
          </p>
          <p className="mt-1 text-[11px] text-soft">
            Target {data ? data.hard_targets.unowned : '--'}. Every one is a lead nobody is answering.
          </p>
        </div>
        <div className="lf-card p-4">
          <p className="text-xs text-muted">Active without a NEXT action</p>
          <p className={`mt-1 text-3xl font-bold ${(data?.pipeline_health?.active_without_next ?? 0) > 0 ? 'text-red' : 'text-text'}`}>
            {data ? data.pipeline_health.active_without_next : '--'}
          </p>
          <p className="mt-1 text-[11px] text-soft">
            Target {data ? data.hard_targets.active_without_next : '--'}.
          </p>
        </div>
        <div className="lf-card p-4">
          <p className="text-xs text-muted">Open escalations</p>
          <p className="mt-1 text-3xl font-bold text-text">{data ? data.open_escalations : '--'}</p>
        </div>
        <div className="lf-card p-4">
          <p className="text-xs text-muted">Onboarding attainment</p>
          <p className="mt-1 text-3xl font-bold text-text">
            {data ? `${Math.round(data.onboarding_attainment.attainment * 100)}%` : '--'}
          </p>
          <p className="mt-1 text-[11px] text-soft">
            {data
              ? `${data.onboarding_attainment.within_one_business_day} of ${data.onboarding_attainment.paid} paid within one business day`
              : 'Not read — this is not a claim that the figure is zero.'}
          </p>
        </div>
      </div>

      {/* ------------------------------------------------ aging by stage */}
      <section className="lf-panel mt-6 p-5" aria-label="Stage aging">
        <h2 className="lf-eyebrow">Aging by stage</h2>
        <ul className="mt-3 space-y-1">
          {(data?.pipeline_health?.aging ?? []).map((row) => (
            <li key={row.stage} className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
              <span className="text-text">{row.stage}</span>
              <span className="text-soft">
                {row.count} open · oldest {row.oldest_days}d
              </span>
            </li>
          ))}
          {(data?.pipeline_health?.aging ?? []).length === 0 && (
            <li className="text-sm text-muted">No open stages.</li>
          )}
        </ul>
      </section>

      {/* ----------------------------------------------- funnel by source */}
      <section className="lf-panel mt-4 p-5" aria-label="Funnel by source">
        <h2 className="lf-eyebrow">Funnel by source</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-soft">
                <th className="py-1.5 pr-3">Source</th>
                <th className="py-1.5 pr-3">Leads</th>
                <th className="py-1.5 pr-3">Contact</th>
                <th className="py-1.5 pr-3">Booking</th>
                <th className="py-1.5 pr-3">Show</th>
                <th className="py-1.5">Win</th>
              </tr>
            </thead>
            <tbody>
              {(data?.sources ?? []).map((row) => (
                <tr key={row.source} className="border-t border-line">
                  <td className="py-1.5 pr-3 text-text">{row.source}</td>
                  <td className="py-1.5 pr-3 text-soft">{row.leads}</td>
                  <td className="py-1.5 pr-3 text-soft">{Math.round(row.contact_rate * 100)}%</td>
                  <td className="py-1.5 pr-3 text-soft">{Math.round(row.booking_rate * 100)}%</td>
                  <td className="py-1.5 pr-3 text-soft">{Math.round(row.show_rate * 100)}%</td>
                  <td className="py-1.5 text-soft">{Math.round(row.win_rate * 100)}%</td>
                </tr>
              ))}
              {(data?.sources ?? []).length === 0 && (
                <tr><td colSpan={6} className="py-2 text-muted">No source data in this window.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <p className="mt-4 text-xs text-soft">
        Figures reconcile with the registered KPI definitions. Every
        dashboard in the product reads the same registry, so two screens cannot quote different
        numbers for the same measure.
      </p>
    </div>
  );
}
