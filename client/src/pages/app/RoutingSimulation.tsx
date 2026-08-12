import { useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type FairShareAudit,
  type RoutingSimulation as Simulation,
} from '../../services/api';
import { DataTable, type Column } from '../../design-system/data/DataTable';

/**
 * Routing simulation sandbox and fair-share audit (SOP P1).
 *
 * A SIMULATION THAT CAN ASSIGN ANYTHING IS NOT A SIMULATION. The acceptance
 * condition is zero assignments, zero notifications and zero clocks, and this
 * screen renders those three counters as a first-class result rather than
 * trusting the endpoint's promise. That is deliberate: a manager is being asked
 * to replay REAL historical leads through an UNPUBLISHED configuration, and the
 * only thing standing between that and a hundred people being re-notified about
 * leads from last week is a side-effect-free code path. Showing the counters
 * makes the guarantee observable on every run instead of once at review time.
 *
 * THE DIFF IS THE DELIVERABLE, NOT THE TOTAL. "The new rules assign 40 leads" is
 * useless; "Dana goes from 3 P1s to 11 while Priya goes from 9 to 1" is the
 * decision. The table is therefore per-rep and per-band, with actual and
 * simulated side by side.
 *
 * FAIR SHARE DETECTS BOTH DIRECTIONS. Over-allocation is noticed because the rep
 * complains; STARVATION is not, because a rep with no leads has nothing to
 * complain about and looks like a low performer at review time.
 */

const WINDOWS = [7, 14, 30, 90];

export default function RoutingSimulation() {
  const [windowDays, setWindowDays] = useState(14);
  const [simulation, setSimulation] = useState<Simulation | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audit, setAudit] = useState<FairShareAudit | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        setAudit(await api.fairShareAudit(controller.signal));
      } catch {
        // The audit is a second, independent read. Its failure must not hide
        // the simulator, which is the reason somebody opened this screen.
        if (!controller.signal.aborted) setAudit(null);
      }
    })();
    return () => controller.abort();
  }, []);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      setSimulation(await api.simulateRouting({ window_days: windowDays, config_version: null }));
    } catch (caught) {
      setSimulation(null);
      setError(caught instanceof ApiError ? caught.message : 'The simulation could not be run.');
    } finally {
      setRunning(false);
    }
  };

  const value = (n: number | null): string => (n === null ? '--' : String(n));

  const columns: Column<NonNullable<Simulation['per_rep']>[number]>[] = [
    { key: 'rep', header: 'Rep', cell: (r) => r.rep, width: '24%' },
    {
      key: 'volume',
      header: 'Volume actual / simulated',
      width: '22%',
      cell: (r) => `${value(r.actual_volume)} / ${value(r.simulated_volume)}`,
    },
    {
      key: 'p1',
      header: 'P1 actual / simulated',
      width: '22%',
      cell: (r) => `${value(r.actual_p1)} / ${value(r.simulated_p1)}`,
    },
    {
      key: 'accept',
      header: 'Time to accept',
      width: '16%',
      cell: (r) => r.time_to_accept_delta ?? '--',
    },
  ];

  return (
    <div className="mx-auto max-w-6xl">
      <div>
        <h1 className="text-2xl font-bold text-text">Routing Simulation</h1>
        <p className="mt-1.5 max-w-3xl text-sm text-muted">
          Replay real historical leads through a candidate configuration and see the difference
          before it is published. The run assigns nothing, notifies nobody and starts no clock.
        </p>
      </div>

      <div className="lf-panel mt-6 p-5">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="lf-label block" htmlFor="window_days">
              Replay window
            </label>
            <select
              id="window_days"
              name="window_days"
              className="lf-input"
              value={windowDays}
              onChange={(event) => setWindowDays(Number(event.target.value))}
            >
              {WINDOWS.map((days) => (
                <option key={days} value={days}>
                  Last {days} days
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            name="run_simulation"
            onClick={() => void run()}
            disabled={running}
            className="lf-btn-primary px-4 py-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {running ? 'Replaying...' : 'Run simulation'}
          </button>
        </div>

        {error && (
          <p className="mt-3 rounded border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">
            {error}
          </p>
        )}
      </div>

      {/* -------------------------------------- the side-effect assertion */}
      <section className="lf-panel mt-4 p-5" aria-label="Side effects">
        <h2 className="lf-eyebrow">Side effects</h2>
        <p className="mt-1 text-xs text-soft">
          Reported on every run rather than promised once. A simulation replays real leads, so the
          only thing between it and re-notifying a hundred people is that these stay at zero.
        </p>

        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {[
            { key: 'assignments', label: 'Assignments made' },
            { key: 'notifications', label: 'Notifications sent' },
            { key: 'clocks', label: 'SLA clocks started' },
          ].map((counter) => {
            const count = simulation?.side_effects?.[counter.key as 'assignments'];
            return (
              <div key={counter.key} className="lf-card p-4">
                <p className="text-xs text-muted">{counter.label}</p>
                <p
                  className={`mt-1 text-2xl font-bold ${
                    count === undefined ? 'text-soft' : count === 0 ? 'text-green' : 'text-red'
                  }`}
                >
                  {count === undefined ? '--' : count}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      {/* ------------------------------------------------------- the diff */}
      <section className="lf-panel mt-4 p-5" aria-label="Per-rep diff">
        <h2 className="lf-eyebrow">Actual versus simulated, per rep</h2>
        <p className="mb-3 mt-1 text-xs text-soft">
          A total tells you nothing. What matters is who gains and who loses, and in which band.
        </p>

        <DataTable
          rows={simulation?.per_rep ?? []}
          columns={columns}
          rowKey={(r) => r.rep}
          density="dense"
          caption="Simulated routing versus actual"
          empty={
            <span>
              No simulation has been run yet, so there is nothing to compare.
            </span>
          }
        />

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="lf-card p-3">
            <p className="text-xs text-muted">Would-be breaches</p>
            <p className="mt-1 text-lg font-semibold text-text">
              {value(simulation?.would_be_breaches ?? null)}
            </p>
          </div>
          <div className="lf-card p-3">
            <p className="text-xs text-muted">Capacity violations</p>
            <p className="mt-1 text-lg font-semibold text-text">
              {value(simulation?.capacity_violations ?? null)}
            </p>
          </div>
          <div className="lf-card p-3">
            <p className="text-xs text-muted">Specialty match rate</p>
            <p className="mt-1 text-lg font-semibold text-text">
              {simulation?.specialty_match_rate === null ||
              simulation?.specialty_match_rate === undefined
                ? '--'
                : `${Math.round(simulation.specialty_match_rate * 100)}%`}
            </p>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------ fair share audit */}
      <section className="lf-panel mt-4 p-5" aria-label="Fair share audit">
        <h2 className="lf-eyebrow">Fair share audit</h2>
        <p className="mt-1 text-xs text-soft">
          Skew is noticed because the rep complains. Starvation is not - a rep with no leads has
          nothing to complain about and looks like a low performer at review time.
        </p>

        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <div>
            <h3 className="lf-label">Distribution</h3>
            <ul className="mt-2 space-y-2">
              {(audit?.distribution ?? []).map((entry, index) => (
                <li key={`${entry.owner_user_id ?? index}`} className="text-sm">
                  <p className="text-text">{entry.owner ?? 'Unassigned'}</p>
                  <p className="text-xs text-soft">
                    {entry.assigned} assigned · {entry.worked} worked ·{' '}
                    {Math.round(entry.share * 100)}% of the window
                  </p>
                </li>
              ))}
              {(audit?.distribution ?? []).length === 0 && (
                <li className="text-sm text-muted">
                  No assignments in the window, so no distribution can be reported.
                </li>
              )}
            </ul>
            {audit && (
              <p className="mt-2 text-xs text-soft">
                Mean {audit.mean_per_rep} per rep · spread {audit.spread} over{' '}
                {audit.window_days} days.
              </p>
            )}
          </div>

          <div>
            <h3 className="lf-label">Starved reps</h3>
            <ul className="mt-2 space-y-1">
              {(audit?.starved ?? []).map((rep, index) => (
                <li key={`${rep}:${index}`} className="text-sm text-gold">
                  {rep ?? 'Unassigned'}
                </li>
              ))}
              {(audit?.starved ?? []).length === 0 && (
                <li className="text-sm text-muted">Nobody is reported as starved.</li>
              )}
            </ul>

            {/* The server's own caveat, quoted rather than paraphrased: a rep
                with zero assignments has no rows to group by and therefore does
                not appear here at all. */}
            {audit?.note && <p className="mt-3 text-xs text-soft">{audit.note}</p>}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------ fair share audit */}
      <section className="lf-panel mt-4 p-5" aria-label="Fair share audit">
        <h2 className="lf-eyebrow">Fair share audit</h2>
        <p className="mt-1 text-xs text-soft">
          Skew is noticed because the rep complains. Starvation is not - a rep with no leads has
          nothing to complain about and looks like a low performer at review time.
        </p>

      </section>

      <p className="mt-4 text-xs text-soft">
        Publishing a routing change requires an approval, is versioned and is rollback-able.
      </p>
    </div>
  );
}
