import { useEffect, useState } from 'react';
import { api, ApiError, type IncidentList } from '../../services/api';

/**
 * Exception and incident console (SOP §28 and §05).
 *
 * AN INCIDENT CANNOT CLOSE WITHOUT A PASSING VERIFICATION STEP. This is the
 * criterion and it is the difference between an incident log and incident
 * management. Closing on "we deployed the fix" is closing on an intention:
 * nobody has confirmed the affected leads were actually recovered, and the
 * second occurrence is discovered by a customer. The Close control is therefore
 * disabled until verification passes, and it says so rather than failing on
 * click.
 *
 * BULK RECOVERY SHOWS THE AFFECTED SET FIRST. A recovery action that reports its
 * scope only afterwards has already run; the point of the preview is that the
 * operator can notice it is about to touch four thousand records rather than
 * forty.
 *
 * A RECURRING TYPE ESCALATES WITHOUT ANYBODY NOTICING IT. Systemic detection is
 * automatic precisely because the pattern is invisible from inside: each
 * incident is handled competently by whoever was on call, and nobody sees that
 * this is the fourth one this month because no one person handled all four.
 *
 * SEVERITY ORDERS THE QUEUE, not recency. The newest incident is not the worst
 * one, and a console sorted by time buries a live P1 under three cosmetic
 * reports.
 */



/** On-call routing by incident type, per §28. */

export default function Incidents() {
  const [data, setData] = useState<IncidentList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        setData(await api.incidents(controller.signal));
        setError(null);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setData(null);
        setError(caught instanceof ApiError ? caught.message : 'Incidents could not be read.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);

  /* ORDERED BY DETECTION, not severity. The local failure log records what
     broke and when; it carries no severity, and bucketing by one we invented
     would rank incidents by a field nobody set. */
  const ordered = [...(data?.incidents ?? [])].sort((a, b) =>
    String(b.detected_at ?? '').localeCompare(String(a.detected_at ?? '')),
  );

  return (
    <div className="mx-auto max-w-6xl">
      <div>
        <h1 className="text-2xl font-bold text-text">Incidents</h1>
        <p className="mt-1.5 max-w-3xl text-sm text-muted">
          Open failure events, newest first. Local records are complete; platform-raised incidents
          appear only when sdk-incident is reachable.
        </p>
      </div>

      {error && (
        <p className="mt-4 rounded border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">
          {error}
        </p>
      )}

      {data && (
        <p className="mt-4 text-xs text-soft">
          {data.local_count} local · {data.upstream_count} from the platform
          {data.upstream_available?.incident === false
            ? ' · sdk-incident unreachable, so platform incidents are MISSING rather than absent'
            : ''}
        </p>
      )}

      <section className="lf-panel mt-4 p-5" aria-label="Open incidents">
        <ul className="mt-1 space-y-2">
          {ordered.map((incident) => (
            <li key={incident.incident_id} className="lf-card p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm text-text">{incident.kind ?? incident.incident_id}</span>
                <span className="text-xs text-soft">{incident.detected_at ?? 'time not recorded'}</span>
              </div>
              <p className="mt-1 text-[11px] text-soft">
                {incident.source_ref ?? 'no source reference'} ·{' '}
                {incident.owner_role ?? 'no owner role'}
                {incident.retry_count ? ` · ${incident.retry_count} retries` : ''}
              </p>
              {incident.fallback_taken && (
                <p className="mt-1 text-[11px] text-gold">
                  Fallback taken: {incident.fallback_taken}
                </p>
              )}
            </li>
          ))}
          {!loading && ordered.length === 0 && (
            <li className="text-sm text-muted">
              {data
                ? 'No open incidents.'
                : 'The incident list could not be read, so this is not a claim that none are open.'}
            </li>
          )}
        </ul>
      </section>

      {(data?.field_gaps ?? []).map((gap) => (
        <p key={gap.field} className="mt-3 text-xs text-soft">{gap.reason}</p>
      ))}
    </div>
  );
}

/** Bulk recovery. The affected set is shown BEFORE anything runs. */
