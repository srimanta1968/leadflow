import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type CoverageConsole as CoverageConsoleData } from '../../services/api';
import { useToast } from '../../components/feedback/ToastProvider';

/**
 * Coverage administration (SOP §02 and §26).
 *
 * A SHARED QUEUE IS NOT COVERAGE. Every business window must resolve to a NAMED
 * AVAILABLE PERSON, and that single rule is what the whole screen enforces. The
 * failure it prevents is the most common one in inbound sales and the hardest to
 * see: a queue that everybody can reach is a queue nobody owns, so a 4:59pm lead
 * sits in it until morning while four people each assume one of the others has
 * it. A window whose `covered_by` is null is drawn as a GAP, not as "the team".
 *
 * GAPS ALERT BEFORE THE WINDOW OPENS. An alert at 8:45 that nobody is covering
 * 9:00 is actionable; the same alert at 9:30 is a post-mortem. The detector
 * therefore reports UPCOMING gaps and the console leads with them.
 *
 * LATE COVERAGE IS ENFORCED AND VISIBLE. The 4:30-5:30 roster exists because a
 * lead arriving at 4:59 is entitled to the same response window as one arriving
 * at 9:00, and the only way that survives contact with a Friday is if somebody's
 * name is against it.
 */

/** The 8:45am checklist, in the SOP's order. */
const OPENING_CHECKS = [
  { key: 'phone', label: 'Phone verified' },
  { key: 'email', label: 'Email verified' },
  { key: 'sms', label: 'SMS verified' },
  { key: 'calendar', label: 'Calendar verified' },
];

export default function CoverageConsole() {
  const [data, setData] = useState<CoverageConsoleData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [queueCleared, setQueueCleared] = useState(false);
  const [managerConfirmed, setManagerConfirmed] = useState(false);
  const { notify } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.coverageConsole());
      setError(null);
    } catch (caught) {
      setData(null);
      setError(caught instanceof ApiError ? caught.message : 'Coverage could not be read.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The manager's confirmation is the LAST gate, not one checkbox among five.
  // Opening validation exists so that somebody accountable has looked, and a
  // form that treats their sign-off as equivalent to "phone verified" loses
  // exactly that.
  const allChecked =
    OPENING_CHECKS.every((check) => checks[check.key]) && queueCleared;

  const submitOpening = async () => {
    try {
      await api.recordOpeningValidation({
        checks,
        overnight_queue_cleared: queueCleared,
        manager_confirmed: managerConfirmed,
      });
      notify({ tone: 'success', title: 'Opening validation recorded' });
      void load();
    } catch (caught) {
      notify({
        tone: 'error',
        title: 'The opening validation was not recorded',
        detail: caught instanceof ApiError ? caught.message : undefined,
      });
    }
  };

  return (
    <div className="mx-auto max-w-6xl">
      <div>
        <h1 className="text-2xl font-bold text-text">Coverage</h1>
        <p className="mt-1.5 max-w-3xl text-sm text-muted">
          Every business window resolves to a named available person. A shared queue is not
          coverage: a queue everybody can reach is a queue nobody owns.
        </p>
      </div>

      {error && (
        <p className="mt-4 rounded border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">
          {error}
        </p>
      )}

      {/* ------------------------------------------- gaps, before they open */}
      <section className="lf-panel mt-6 p-5" aria-label="Coverage gaps">
        <h2 className="lf-eyebrow">Upcoming coverage gaps</h2>
        <p className="mt-1 text-xs text-soft">
          Detected before the window begins. An alert after it opens is a post-mortem.
        </p>

        <ul className="mt-3 space-y-2">
          {(data?.upcoming_gaps ?? []).map((gap) => (
            <li
              key={`${gap.window}:${gap.starts_at}`}
              className="rounded-lg border border-red/40 bg-red/10 p-3 text-sm"
            >
              <p className="text-text">
                {gap.window} opens {gap.starts_at} with nobody named.
              </p>
              <p className="mt-0.5 text-xs text-soft">{gap.reason}</p>
            </li>
          ))}
          {!loading && (data?.upcoming_gaps ?? []).length === 0 && (
            <li className="text-sm text-muted">
              {data
                ? 'No gap is detected in the windows ahead.'
                : 'The coverage register could not be read, so no gap can be claimed either way.'}
            </li>
          )}
        </ul>
      </section>

      {/* --------------------------------------------------- the windows */}
      <section className="lf-panel mt-4 p-5" aria-label="Coverage windows">
        <h2 className="lf-eyebrow">Windows</h2>
        <ul className="mt-3 space-y-2">
          {(data?.windows ?? []).map((window) => (
            <li key={window.label} className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
              <span className="text-text">{window.label}</span>
              <span className={window.covered_by ? 'text-muted' : 'text-red'}>
                {/* A window with no name is a GAP, never "the team". */}
                {window.covered_by ?? 'Uncovered - no named person'}
              </span>
            </li>
          ))}
          {!loading && (data?.windows ?? []).length === 0 && (
            <li className="text-sm text-muted">No windows are configured.</li>
          )}
        </ul>
      </section>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {/* ------------------------------------------ opening validation */}
        <section className="lf-panel p-5" aria-label="Opening validation">
          <h2 className="lf-eyebrow">Opening validation</h2>
          <p className="mt-1 text-xs text-soft">
            Run at 8:45am. Four channels verified and the overnight queue cleared, then the
            manager confirms coverage.
          </p>

          <ul className="mt-3 space-y-2">
            {OPENING_CHECKS.map((check) => (
              <li key={check.key}>
                <button
                  type="button"
                  name={`check_${check.key}`}
                  onClick={() =>
                    setChecks((current) => ({ ...current, [check.key]: !current[check.key] }))
                  }
                  aria-pressed={Boolean(checks[check.key])}
                  className={`w-full rounded-lg border px-3 py-2 text-left text-sm ${
                    checks[check.key]
                      ? 'border-green/50 bg-green/10 text-text'
                      : 'border-line bg-panel2 text-muted'
                  }`}
                >
                  {check.label}
                </button>
              </li>
            ))}

            <li>
              <button
                type="button"
                name="check_overnight_queue"
                onClick={() => setQueueCleared((current) => !current)}
                aria-pressed={queueCleared}
                className={`w-full rounded-lg border px-3 py-2 text-left text-sm ${
                  queueCleared
                    ? 'border-green/50 bg-green/10 text-text'
                    : 'border-line bg-panel2 text-muted'
                }`}
              >
                Overnight queue cleared
              </button>
            </li>
          </ul>

          <button
            type="button"
            name="manager_confirms_coverage"
            onClick={() => setManagerConfirmed((current) => !current)}
            aria-pressed={managerConfirmed}
            disabled={!allChecked}
            className={`mt-3 w-full rounded-lg border px-3 py-3 text-left text-sm disabled:cursor-not-allowed disabled:opacity-50 ${
              managerConfirmed ? 'border-blue/60 bg-panel3 text-text' : 'border-line bg-panel2 text-muted'
            }`}
          >
            Manager confirms coverage for the day
          </button>
          {!allChecked && (
            <p className="mt-1 text-xs text-soft">
              The manager confirms last. Their sign-off is the accountable step, not one check
              among five.
            </p>
          )}

          <button
            type="button"
            name="record_opening_validation"
            disabled={!managerConfirmed}
            onClick={() => void submitOpening()}
            className="lf-btn-primary mt-3 w-full px-4 py-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Record opening validation
          </button>

          <p className="mt-2 text-xs text-soft">
            {data?.opening_validation?.recorded_at
              ? `Last recorded ${data.opening_validation.recorded_at}`
              : 'Not recorded today.'}
          </p>
        </section>

        {/* ------------------------------------------------ late coverage */}
        <section className="lf-panel p-5" aria-label="Late coverage">
          <h2 className="lf-eyebrow">Late coverage</h2>
          <p className="mt-1 text-sm text-muted">
            A 4:59pm lead gets its full response window. There is no early sign-off, and the
            roster below is who is accountable for that.
          </p>

          <ul className="mt-3 space-y-1">
            {(data?.late_coverage?.roster ?? []).map((person) => (
              <li key={person} className="text-sm text-text">
                {person}
              </li>
            ))}
            {!loading && (data?.late_coverage?.roster ?? []).length === 0 && (
              <li className="text-sm text-red">
                Nobody is rostered for late coverage, so a 4:59pm lead has no named owner.
              </li>
            )}
          </ul>

          <p className="mt-3 text-xs text-soft">
            {data?.late_coverage?.note ?? 'Enforced to 5:30pm.'}
          </p>
        </section>
      </div>

      {/* --------------------------------------- schedules, PTO, on call */}
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <section className="lf-panel p-5" aria-label="Schedules">
          <h2 className="lf-eyebrow">Schedules</h2>
          <ul className="mt-3 space-y-2">
            {(data?.schedules ?? []).map((schedule) => (
              <li key={schedule.rep} className="text-sm">
                <p className="text-text">{schedule.rep}</p>
                <p className="text-xs text-soft">
                  {schedule.hours} · {schedule.timezone} · {schedule.status}
                </p>
              </li>
            ))}
            {!loading && (data?.schedules ?? []).length === 0 && (
              <li className="text-sm text-muted">No schedules recorded.</li>
            )}
          </ul>
        </section>

        <section className="lf-panel p-5" aria-label="Time off and holidays">
          <h2 className="lf-eyebrow">Time off &amp; holidays</h2>
          <ul className="mt-3 space-y-2">
            {(data?.time_off ?? []).map((entry, index) => (
              <li key={`${entry.rep}:${index}`} className="text-sm">
                <p className="text-text">{entry.rep}</p>
                <p className="text-xs text-soft">
                  {entry.from} to {entry.to} · {entry.kind}
                </p>
              </li>
            ))}
            {(data?.holiday_calendar ?? []).map((holiday) => (
              <li key={holiday.date} className="text-sm">
                <p className="text-text">{holiday.name}</p>
                <p className="text-xs text-soft">{holiday.date}</p>
              </li>
            ))}
            {!loading &&
              (data?.time_off ?? []).length === 0 &&
              (data?.holiday_calendar ?? []).length === 0 && (
                <li className="text-sm text-muted">Nothing recorded.</li>
              )}
          </ul>
        </section>

        <section className="lf-panel p-5" aria-label="Manager on duty">
          <h2 className="lf-eyebrow">Manager on duty</h2>
          <ul className="mt-3 space-y-2">
            {(data?.manager_on_duty ?? []).map((entry) => (
              <li key={entry.date} className="text-sm">
                <p className="text-text">{entry.manager ?? 'Nobody named'}</p>
                <p className="text-xs text-soft">{entry.date}</p>
              </li>
            ))}
            {!loading && (data?.manager_on_duty ?? []).length === 0 && (
              <li className="text-sm text-muted">No roster recorded.</li>
            )}
          </ul>
        </section>
      </div>
    </div>
  );
}
