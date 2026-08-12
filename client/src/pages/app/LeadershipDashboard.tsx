import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type LeadershipDashboard as Data } from '../../services/api';
import { DataTable, type Column } from '../../design-system/data/DataTable';
import { toneClass } from '../../design-system/tokens';

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
const SIGNALS = [
  { key: 'leads_waiting', label: 'Leads waiting', drill: '/app/leads' },
  { key: 'oldest_wait', label: 'Oldest wait', drill: '/app/leads' },
  { key: 'sla_at_risk', label: 'SLA at risk', drill: '/app/sla' },
  { key: 'sla_breached', label: 'SLA breached', drill: '/app/sla' },
  { key: 'unowned_records', label: 'Unowned records', drill: '/app/leads' },
  { key: 'missing_next', label: 'Missing NEXT', drill: '/app/pipeline' },
  { key: 'failed_messages', label: 'Failed messages', drill: '/app/inbox' },
  { key: 'purchases_awaiting_onboarding', label: 'Purchases awaiting onboarding', drill: '/app/handoffs' },
  { key: 'stale_opportunities', label: 'Stale opportunities', drill: '/app/pipeline' },
];

export default function LeadershipDashboard() {
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
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
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);

  const columns: Column<NonNullable<Data['success_test']>[number]>[] = [
    { key: 'record', header: 'Record', cell: (r) => r.record_id, width: '16%' },
    { key: 'owner', header: 'Who owns this lead?', cell: (r) => r.owner ?? 'Nobody', width: '16%' },
    {
      key: 'last',
      header: 'What happened last?',
      cell: (r) => r.last_activity ?? 'Nothing recorded',
      width: '20%',
    },
    {
      key: 'next',
      header: 'What happens next?',
      cell: (r) => r.next_action ?? 'No NEXT action',
      width: '20%',
    },
    { key: 'due', header: 'When is it due?', cell: (r) => r.due_at ?? 'No date', width: '12%' },
    {
      key: 'blocker',
      header: 'What is blocking the sale?',
      cell: (r) => r.blocker ?? 'Nothing recorded',
      width: '16%',
    },
  ];

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

      {/* ---------------------------------------------------- nine tiles */}
      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {SIGNALS.map((signal) => {
          const live = data?.signals.find((s) => s.key === signal.key);
          return (
            <Link
              key={signal.key}
              to={live?.drill_to ?? signal.drill}
              className="lf-card p-4"
            >
              <p className="text-xs text-muted">{live?.label ?? signal.label}</p>
              <p
                className={`mt-1 text-3xl font-bold ${
                  live?.role ? toneClass(live.role) : 'text-text'
                }`}
              >
                {/* Never a false zero. See the module comment. */}
                {live?.value === null || live?.value === undefined ? '--' : live.value}
              </p>
              <p className="mt-1 text-[11px] text-soft">
                {live?.detail ?? 'Not read - this is not a claim that the figure is zero.'}
              </p>
            </Link>
          );
        })}
      </div>

      {/* --------------------------------------- the five success questions */}
      <section className="lf-panel mt-6 p-5" aria-label="Success test">
        <h2 className="lf-eyebrow">The five questions, per record</h2>
        <p className="mb-3 mt-1 text-xs text-soft">
          A record that cannot answer all five is not being worked, whatever its pipeline stage
          says.
        </p>

        <DataTable
          rows={data?.success_test ?? []}
          columns={columns}
          rowKey={(r) => r.record_id}
          loading={loading}
          density="dense"
          height={420}
          caption="Success test per record"
          error={error ? <span>{error}</span> : undefined}
          empty={<span>No records are returned for the success test.</span>}
        />
      </section>

      <p className="mt-4 text-xs text-soft">
        Figures reconcile with the registered KPI definitions
        {data?.kpi_registry_version ? ` (registry ${data.kpi_registry_version})` : ''}. Every
        dashboard in the product reads the same registry, so two screens cannot quote different
        numbers for the same measure.
      </p>
    </div>
  );
}
