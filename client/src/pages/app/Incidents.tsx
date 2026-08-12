import { useEffect, useState } from 'react';
import { api, ApiError, type IncidentList, type IncidentRow } from '../../services/api';
import { Modal } from '../../design-system/overlays/Modal';
import { chipClass } from '../../design-system/tokens';

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

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];

const SEVERITY_ROLE: Record<string, 'blocked' | 'warning' | 'info' | 'success'> = {
  critical: 'blocked',
  high: 'blocked',
  medium: 'warning',
  low: 'info',
};

/** On-call routing by incident type, per §28. */
const ON_CALL_ROUTING = [
  { type: 'Data or routing defect', role: 'RevOps' },
  { type: 'Response or coverage failure', role: 'Manager on duty' },
  { type: 'Integration or platform outage', role: 'Systems Admin' },
  { type: 'Payment or billing', role: 'Finance' },
];

export default function Incidents() {
  const [data, setData] = useState<IncidentList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recovering, setRecovering] = useState<IncidentRow | null>(null);

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

  // Severity, not recency. The newest incident is not the worst one.
  const ordered = [...(data?.incidents ?? [])].sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity ?? 'low') - SEVERITY_ORDER.indexOf(b.severity ?? 'low'),
  );

  return (
    <div className="mx-auto max-w-6xl">
      <div>
        <h1 className="text-2xl font-bold text-text">Incidents</h1>
        <p className="mt-1.5 max-w-3xl text-sm text-muted">
          Ordered by severity rather than by time, because the newest incident is not the worst
          one. Nothing closes until its verification step passes.
        </p>
      </div>

      {error && (
        <p className="mt-4 rounded border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">
          {error}
        </p>
      )}

      {/* ------------------------------------------- systemic escalation */}
      {(data?.systemic_patterns ?? []).length > 0 && (
        <section className="lf-panel mt-6 border-gold/40 p-5" aria-label="Systemic patterns">
          <h2 className="lf-eyebrow text-gold">Systemic patterns</h2>
          <p className="mt-1 text-xs text-soft">
            Detected automatically. Each incident was handled competently by whoever was on call,
            and nobody sees the pattern because no one person handled them all.
          </p>
          <ul className="mt-3 space-y-2">
            {data?.systemic_patterns?.map((pattern) => (
              <li key={pattern.type} className="text-sm">
                <p className="text-text">
                  {pattern.type} · {pattern.occurrences} occurrences
                  {pattern.escalated ? ' · escalated to leadership' : ' · not yet escalated'}
                </p>
                <p className="text-xs text-soft">{pattern.detail}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* -------------------------------------------- the severity queues */}
      {SEVERITY_ORDER.map((severity) => {
        const bucket = ordered.filter((incident) => (incident.severity ?? 'low') === severity);
        if (bucket.length === 0) return null;
        return (
          <section key={severity} className="lf-panel mt-4 p-5" aria-label={`${severity} incidents`}>
            <h2 className="lf-eyebrow capitalize">{severity}</h2>
            <ul className="mt-3 space-y-2">
              {bucket.map((incident) => (
                <li key={incident.incident_id} className="lf-card p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm text-text">{incident.title ?? incident.incident_id}</span>
                    <span className={`lf-pill ${chipClass(SEVERITY_ROLE[severity] ?? 'info')}`}>
                      {severity}
                    </span>
                  </div>

                  <p className="mt-1 text-[11px] text-soft">
                    {incident.type ?? 'untyped'} · {incident.owner ?? 'no owner'} ·{' '}
                    {incident.on_call_role ?? 'no on-call role'} · {incident.status ?? 'no status'}
                    {incident.affected_records !== null
                      ? ` · ${incident.affected_records} affected records`
                      : ''}
                  </p>

                  {/* The gate, stated on the card rather than discovered on click. */}
                  <p
                    className={`mt-1 text-[11px] ${
                      incident.verification.passed ? 'text-green' : 'text-gold'
                    }`}
                  >
                    {incident.verification.passed
                      ? 'Verification passed - may be closed'
                      : `Verification not passed - cannot close. ${incident.verification.detail ?? ''}`}
                  </p>

                  <div className="mt-2 flex gap-1">
                    <button
                      type="button"
                      name="bulk_recover"
                      onClick={() => setRecovering(incident)}
                      className="lf-btn-ghost px-2 py-1 text-xs"
                    >
                      Bulk recovery
                    </button>
                    <button
                      type="button"
                      name="close_incident"
                      disabled={!incident.verification.passed}
                      className="lf-btn-ghost px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Close
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      {!loading && ordered.length === 0 && (
        <p className="mt-6 text-sm text-muted">
          {data
            ? 'No incidents are open.'
            : 'The incident register could not be read, so this is not a claim that nothing is open.'}
        </p>
      )}

      {/* ----------------------------------------------- on-call routing */}
      <section className="lf-panel mt-4 p-5" aria-label="On-call routing">
        <h2 className="lf-eyebrow">On-call routing</h2>
        <p className="mt-1 text-xs text-soft">
          Routed by incident TYPE. A single on-call rota sends a billing failure to somebody who
          cannot act on it.
        </p>
        <ul className="mt-3 space-y-2">
          {ON_CALL_ROUTING.map((route) => {
            const live = data?.on_call?.find((o) => o.incident_type === route.type);
            return (
              <li key={route.type} className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span className="text-text">{route.type}</span>
                <span className="text-muted">
                  {route.role}
                  {live?.person ? ` · ${live.person}` : ' · nobody named'}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <BulkRecoveryModal incident={recovering} onClose={() => setRecovering(null)} />
    </div>
  );
}

/** Bulk recovery. The affected set is shown BEFORE anything runs. */
function BulkRecoveryModal({
  incident,
  onClose,
}: {
  incident: IncidentRow | null;
  onClose: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false);

  return (
    <Modal
      open={incident !== null}
      onClose={() => {
        setConfirmed(false);
        onClose();
      }}
      title="Bulk recovery"
      subtitle="What this would touch, before it runs."
      size="sm"
      dismissable={false}
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" name="cancel_recovery" onClick={onClose} className="lf-btn-secondary px-4 py-2">
            Cancel
          </button>
          <button
            type="button"
            name="run_recovery"
            disabled={!confirmed}
            onClick={onClose}
            className="lf-btn-primary px-4 py-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Run recovery
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-gold/40 bg-gold/10 p-3">
          <p className="text-xs font-semibold text-gold">Affected records</p>
          <p className="mt-1 text-sm text-text">
            {incident?.affected_records === null || incident?.affected_records === undefined
              ? 'The affected set could not be counted, so nothing may be recovered in bulk.'
              : `${incident.affected_records} records would be recovered.`}
          </p>
        </div>

        <button
          type="button"
          name="acknowledge_recovery_scope"
          onClick={() => setConfirmed((current) => !current)}
          aria-pressed={confirmed}
          disabled={incident?.affected_records === null || incident?.affected_records === undefined}
          className={`w-full rounded-lg border px-3 py-3 text-left text-sm disabled:cursor-not-allowed disabled:opacity-50 ${
            confirmed ? 'border-blue/60 bg-panel3 text-text' : 'border-line bg-panel2 text-muted'
          }`}
        >
          I have read the affected set above and accept it.
        </button>
      </div>
    </Modal>
  );
}
