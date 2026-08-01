import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AnalyticsFilters,
  AnalyticsOverview,
  api,
  ApiError,
  LeadSource,
  SessionUser,
} from '../../services/api';
import { useToast } from '../../components/feedback/ToastProvider';
import { failureFor } from '../../content/messages';
import { SOURCE_GROUPS, SOURCE_OPTIONS } from '../../content/leadFields';
import { subscribeToEvents } from '../../services/eventStream';
import {
  AnalyticsPreferences,
  SourceSortKey,
  ariaSortFor,
  clearPreferences,
  defaultPreferences,
  loadPreferences,
  nextSourceSort,
  orderDailyRows,
  savePreferences,
  sortSourceRows,
  withWindow,
} from '../../utils/analyticsView';
import { asDuration, asPercent } from '../../utils/analyticsFormat';

/** Human labels for the source channel enum, from the shared vocabulary. */
const SOURCE_LABELS = new Map(SOURCE_OPTIONS.map((option) => [option.value as string, option.label]));

/** The text rendered for a channel, including the unattributed bucket. */
function labelForSource(source: LeadSource | null): string {
  return source ? (SOURCE_LABELS.get(source) ?? source) : 'Unattributed';
}

/** Preset reporting windows, in days. */
const RANGE_PRESETS: { label: string; days: number }[] = [
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
];

/** The by-source columns, in display order, with the ones that can be sorted. */
const SOURCE_COLUMNS: { key: SourceSortKey; label: string; numeric: boolean }[] = [
  { key: 'source', label: 'Source', numeric: false },
  { key: 'captured', label: 'Captured', numeric: true },
  { key: 'responded', label: 'Responded', numeric: true },
  { key: 'breached', label: 'Breached', numeric: true },
  { key: 'average_response_seconds', label: 'Avg response', numeric: true },
];

interface StatTileProps {
  label: string;
  value: string;
  /** One line of context under the number: what it is measured over. */
  detail: string;
  /** Token name for the value colour. Defaults to plain text. */
  tone?: 'text' | 'green' | 'gold' | 'red' | 'blue';
}

/** One headline figure. */
function StatTile({ label, value, detail, tone = 'text' }: StatTileProps) {
  const toneClass = {
    text: 'text-text',
    green: 'text-green',
    gold: 'text-gold',
    red: 'text-red',
    blue: 'text-blue',
  }[tone];

  return (
    <div className="lf-panel p-5">
      <p className="lf-eyebrow">{label}</p>
      <p className={`mt-2 font-cond text-3xl font-bold tabular-nums ${toneClass}`}>{value}</p>
      <p className="mt-1 text-xs leading-relaxed text-soft">{detail}</p>
    </div>
  );
}

/**
 * A horizontal bar sized as a share of the largest value in its group.
 *
 * Scaled against the group maximum rather than the total, because the point of
 * comparison on this screen is "which channel is biggest and by how much",
 * which a share-of-total bar flattens once there are a dozen channels.
 */
function Bar({ value, max, tone }: { value: number; max: number; tone: string }) {
  const width = max === 0 ? 0 : Math.round((value / max) * 100);
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-panel3" aria-hidden="true">
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${width}%` }} />
    </div>
  );
}

/**
 * The analytics dashboard.
 *
 * Answers two questions the operational screens deliberately do not: how fast
 * are we responding, and where are we losing leads. The Capture Inbox shows
 * which clocks need somebody right now; this shows whether the queue as a whole
 * is working, aggregated over a window the viewer chooses.
 *
 * Response time is reported as average, median AND p90 together, because an
 * average alone hides the tail — a queue answering most leads in two minutes and
 * a handful in six hours has a respectable mean and a real problem, and only the
 * p90 shows it.
 *
 * The screen re-reads on a push event, so a colleague routing or answering a
 * lead moves these numbers without anyone pressing refresh.
 */
export default function Analytics() {
  const { notify } = useToast();

  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [owners, setOwners] = useState<SessionUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [live, setLive] = useState(false);

  // Filters, sort and daily order are one object because they are one thing:
  // the view this operator works in. Held as strings because that is what the
  // form controls produce, and restored from the last visit so somebody who
  // works a single channel is not re-picking it every morning.
  const [view, setView] = useState<AnalyticsPreferences>(() => loadPreferences());

  const { from, to, source, owner_user_id: ownerUserId, sourceSort, dailyOrder } = view;

  useEffect(() => {
    savePreferences(view);
  }, [view]);

  const load = useCallback(async (): Promise<void> => {
    setLoadError(null);
    try {
      const filters: AnalyticsFilters = {
        from,
        to,
        source: source ? (source as LeadSource) : undefined,
        owner_user_id: ownerUserId || undefined,
      };
      setOverview(await api.analyticsOverview(filters));
    } catch (error) {
      // The server's own message is preferred over the catalogue entry for a
      // 400: "'to' must be after 'from'" names the filter the viewer just
      // changed, where the generic wording would leave them guessing which one.
      const code = error instanceof ApiError ? error.code : 'INTERNAL_ERROR';
      const detail = error instanceof ApiError ? error.message : undefined;
      const message = failureFor(code, detail);
      setLoadError(message.detail ? `${message.title}. ${message.detail}` : message.title);
    } finally {
      setLoading(false);
    }
  }, [from, to, source, ownerUserId]);

  // Only the four SERVER filters are in the dependency list. Sorting and daily
  // order are applied to what has already been fetched, so changing them must
  // not spend a round trip re-asking for the same aggregate.
  useEffect(() => {
    void load();
  }, [load]);

  // The owner filter needs the roster. Loaded once, separately from the rollup,
  // so changing a filter does not re-fetch a list that cannot have changed.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.listUsers(true);
        if (!cancelled) {
          setOwners(result.users);
        }
      } catch {
        // A roster that will not load costs the owner filter, not the screen.
        // The numbers are still correct and still worth showing.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // Reloads are coalesced: a sweep that routes fifty leads emits fifty events
    // and would otherwise trigger fifty overlapping aggregate queries.
    let timer: ReturnType<typeof setTimeout> | null = null;

    const unsubscribe = subscribeToEvents(() => {
      setLive(true);
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = null;
        void load();
      }, 400);
    });

    return () => {
      if (timer) {
        clearTimeout(timer);
      }
      unsubscribe();
    };
  }, [load]);

  function applyPreset(days: number): void {
    setView((current) => withWindow(current, days));
  }

  function resetFilters(): void {
    // The stored copy is removed as well as the state reset. Leaving it behind
    // would mean "Clear filters" cleared the screen and the next visit brought
    // the old selection straight back.
    clearPreferences();
    setView(defaultPreferences());
    notify({ title: 'Filters cleared', tone: 'info' });
  }

  function sortBy(key: SourceSortKey): void {
    setView((current) => ({ ...current, sourceSort: nextSourceSort(current.sourceSort, key) }));
  }

  const funnel = overview?.funnel;
  const maxSourceCaptured = Math.max(1, ...(overview?.by_source ?? []).map((row) => row.captured));
  const maxDailyCaptured = Math.max(1, ...(overview?.daily ?? []).map((row) => row.captured));

  // Re-sorting only when the rollup or the choice changes: a push event that
  // leaves the numbers alone should not rebuild these arrays and re-render the
  // whole table.
  const sortedSources = useMemo(
    () => sortSourceRows(overview?.by_source ?? [], sourceSort, labelForSource),
    [overview, sourceSort]
  );
  const orderedDaily = useMemo(
    () => orderDailyRows(overview?.daily ?? [], dailyOrder),
    [overview, dailyOrder]
  );

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="lf-h1">Analytics</h1>
          <p className="mt-1 text-sm text-muted">
            Response times and conversion across the capture funnel.
            {live && (
              <span className="ml-2 inline-flex items-center gap-1.5 text-xs text-green">
                <span className="h-1.5 w-1.5 rounded-full bg-green" aria-hidden="true" />
                Live
              </span>
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {RANGE_PRESETS.map((preset) => (
            <button
              key={preset.days}
              type="button"
              className="lf-btn lf-btn-ghost text-xs"
              onClick={() => applyPreset(preset.days)}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </header>

      {/* Filters. Named exactly as the API query parameters so what the screen
          asks for and what the endpoint documents are the same vocabulary. */}
      <section className="lf-panel p-5" aria-label="Filters">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <div>
            <label className="lf-label" htmlFor="analytics-from">
              From
            </label>
            <input
              id="analytics-from"
              name="from"
              type="date"
              className="lf-input"
              value={from}
              onChange={(event) => setView((current) => ({ ...current, from: event.target.value }))}
            />
          </div>

          <div>
            <label className="lf-label" htmlFor="analytics-to">
              To
            </label>
            <input
              id="analytics-to"
              name="to"
              type="date"
              className="lf-input"
              value={to}
              onChange={(event) => setView((current) => ({ ...current, to: event.target.value }))}
            />
          </div>

          <div>
            <label className="lf-label" htmlFor="analytics-source">
              Source
            </label>
            <select
              id="analytics-source"
              name="source"
              className="lf-input"
              value={source}
              onChange={(event) =>
                setView((current) => ({ ...current, source: event.target.value }))
              }
            >
              <option value="">All sources</option>
              {SOURCE_GROUPS.map((group) => (
                <optgroup key={group} label={group}>
                  {SOURCE_OPTIONS.filter((option) => option.group === group).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          <div>
            <label className="lf-label" htmlFor="analytics-owner">
              Owner
            </label>
            <select
              id="analytics-owner"
              name="owner_user_id"
              className="lf-input"
              value={ownerUserId}
              onChange={(event) =>
                setView((current) => ({ ...current, owner_user_id: event.target.value }))
              }
            >
              <option value="">Everyone</option>
              {owners.map((owner) => (
                <option key={owner.id} value={owner.id}>
                  {owner.first_name || owner.last_name
                    ? `${owner.first_name ?? ''} ${owner.last_name ?? ''}`.trim()
                    : owner.email}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-end">
            <button type="button" className="lf-btn lf-btn-secondary w-full" onClick={resetFilters}>
              Clear filters
            </button>
          </div>
        </div>
      </section>

      {loadError ? (
        <p className="rounded-xl border border-red/40 bg-red/10 px-4 py-3 text-sm text-red" role="alert">
          {loadError}
        </p>
      ) : loading ? (
        <p className="text-sm text-muted">Loading analytics…</p>
      ) : !overview || overview.funnel.captured === 0 ? (
        <div className="lf-panel p-8 text-center">
          <h2 className="text-lg font-bold">No leads in this window</h2>
          <p className="mt-2 text-sm text-muted">
            Nothing arrived between these dates with the filters applied. Widen the range or clear
            the filters.
          </p>
        </div>
      ) : (
        <>
          <section aria-label="Key metrics" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Captured"
              value={String(funnel?.captured ?? 0)}
              detail="Leads that arrived in this window"
            />
            <StatTile
              label="Median response"
              value={asDuration(overview.response_times.median_seconds)}
              detail="Half of answered leads were faster than this"
              tone="green"
            />
            <StatTile
              label="90th percentile"
              value={asDuration(overview.response_times.p90_seconds)}
              detail="The slow tail — one lead in ten waited at least this long"
              tone="gold"
            />
            <StatTile
              label="Breach rate"
              value={asPercent(overview.conversion.breach_rate)}
              detail="Of clocks that have closed, not of all leads"
              tone="red"
            />
          </section>

          {/* The funnel, as counts and as the rate between each pair of stages.
              Both are shown because a rate without its denominator invites the
              wrong conclusion at small volumes. */}
          <section className="lf-panel p-5" aria-label="Conversion funnel">
            <h2 className="lf-h2 text-base">Conversion funnel</h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              <div>
                <p className="text-xs uppercase tracking-wide text-soft">Captured → Routed</p>
                <p className="mt-1 font-cond text-2xl font-bold tabular-nums text-text">
                  {asPercent(overview.conversion.routed_rate)}
                </p>
                <p className="mt-1 text-xs text-soft">
                  {funnel?.routed ?? 0} of {funnel?.captured ?? 0} reached an owner
                </p>
                <div className="mt-2">
                  <Bar value={funnel?.routed ?? 0} max={funnel?.captured ?? 0} tone="bg-blue" />
                </div>
              </div>

              <div>
                <p className="text-xs uppercase tracking-wide text-soft">Routed → Responded</p>
                <p className="mt-1 font-cond text-2xl font-bold tabular-nums text-text">
                  {asPercent(overview.conversion.response_rate)}
                </p>
                <p className="mt-1 text-xs text-soft">
                  {funnel?.responded ?? 0} of {funnel?.routed ?? 0} were answered
                </p>
                <div className="mt-2">
                  <Bar value={funnel?.responded ?? 0} max={funnel?.routed ?? 0} tone="bg-green" />
                </div>
              </div>

              <div>
                <p className="text-xs uppercase tracking-wide text-soft">Average response</p>
                <p className="mt-1 font-cond text-2xl font-bold tabular-nums text-text">
                  {asDuration(overview.response_times.average_seconds)}
                </p>
                <p className="mt-1 text-xs text-soft">
                  Measured from arrival, not from assignment
                </p>
              </div>
            </div>
          </section>

          <section className="lf-panel p-5" aria-label="By source">
            <h2 className="lf-h2 text-base">By source</h2>
            <p className="mt-1 text-xs text-soft">
              Where leads come from, and how well each channel is served. Click a column to sort —
              channels with nothing answered sit at the bottom either way.
            </p>

            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[36rem] text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-soft">
                    {SOURCE_COLUMNS.map((column) => (
                      <th
                        key={column.key}
                        scope="col"
                        className={`pb-2 font-semibold ${column.key === 'average_response_seconds' ? '' : 'pr-4'}`}
                        aria-sort={ariaSortFor(sourceSort, column.key)}
                      >
                        {/* A real button, not a click handler on the cell: sorting
                            has to be reachable by keyboard, and a header that
                            only responds to a mouse locks a screen-reader user
                            out of the ordering entirely. */}
                        <button
                          type="button"
                          className="flex items-center gap-1 uppercase tracking-wide hover:text-text"
                          onClick={() => sortBy(column.key)}
                        >
                          {column.label}
                          <span aria-hidden="true" className="text-[0.65rem]">
                            {sourceSort.key === column.key
                              ? sourceSort.direction === 'asc'
                                ? '▲'
                                : '▼'
                              : '↕'}
                          </span>
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedSources.map((row) => (
                    <tr key={row.source ?? 'unattributed'} className="border-b border-line/50">
                      <td className="py-2.5 pr-4">
                        <span className="font-medium text-text">{labelForSource(row.source)}</span>
                        <div className="mt-1.5 w-32">
                          <Bar value={row.captured} max={maxSourceCaptured} tone="bg-blue" />
                        </div>
                      </td>
                      <td className="py-2.5 pr-4 tabular-nums text-muted">{row.captured}</td>
                      <td className="py-2.5 pr-4 tabular-nums text-green">{row.responded}</td>
                      <td className="py-2.5 pr-4 tabular-nums text-red">{row.breached}</td>
                      <td className="py-2.5 tabular-nums text-muted">
                        {asDuration(row.average_response_seconds)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="lf-panel p-5" aria-label="Daily volume">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="lf-h2 text-base">Daily volume</h2>
                <p className="mt-1 text-xs text-soft">
                  Captured, answered and breached per day across the window.
                </p>
              </div>

              <button
                type="button"
                className="lf-btn lf-btn-ghost text-xs"
                onClick={() =>
                  setView((current) => ({
                    ...current,
                    dailyOrder: current.dailyOrder === 'newest' ? 'oldest' : 'newest',
                  }))
                }
              >
                {dailyOrder === 'newest' ? 'Newest first' : 'Oldest first'}
              </button>
            </div>

            <ul className="mt-4 space-y-2">
              {orderedDaily.map((point) => (
                <li key={point.day} className="flex items-center gap-3 text-xs">
                  <span className="w-24 shrink-0 tabular-nums text-soft">{point.day}</span>
                  <span className="flex-1">
                    <Bar value={point.captured} max={maxDailyCaptured} tone="bg-blue" />
                  </span>
                  <span className="w-32 shrink-0 text-right tabular-nums text-muted">
                    {point.captured} in · <span className="text-green">{point.responded}</span> ·{' '}
                    <span className="text-red">{point.breached}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
