import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api, ApiError, type RoleDashboard } from '../../services/api';

/**
 * Manager, Rep, Marketing, Finance and Customer Success dashboards (SOP §47).
 *
 * FIVE DASHBOARDS, ONE KPI REGISTRY. The criterion is that all five share one
 * set of registered definitions, and the failure it prevents is the one that
 * quietly destroys trust in reporting: the manager's "response time" is a median
 * over business hours, marketing's is a mean over all hours, and the two numbers
 * differ by a factor of three in a meeting where both are on screen. Once that
 * has happened once, every figure is negotiable. The registry version is
 * therefore printed on every dashboard.
 *
 * ONE SCREEN, FIVE ROLES, DRIVEN BY THE ROUTE. Building five components would
 * guarantee that a fix to the SLA tile reaches three of them; the panels are
 * data from the server, which also means a role gaining a panel needs no
 * frontend release.
 *
 * PERMISSION IS THE SERVER'S ANSWER, NOT A ROLE STRING. The screen asks for a
 * role dashboard and renders whatever the PDP allows, including an explicit
 * refusal. Deciding in the browser which roles may see which dashboard puts the
 * access rule in the least trustworthy place available.
 */

const ROLES = [
  { key: 'manager', label: 'Manager' },
  { key: 'rep', label: 'Rep' },
  { key: 'marketing', label: 'Marketing' },
  { key: 'finance', label: 'Finance' },
  { key: 'cs', label: 'Customer Success' },
];

export default function RoleDashboards() {
  const { role = 'manager' } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<RoleDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void (async () => {
      try {
        setData(await api.roleDashboard(role, controller.signal));
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
  }, [role]);

  return (
    <div className="mx-auto max-w-6xl">
      <div>
        <h1 className="text-2xl font-bold text-text">Dashboards</h1>
        <p className="mt-1.5 max-w-3xl text-sm text-muted">
          Five views onto one set of registered KPI definitions. Two screens quoting different
          numbers for the same measure is how every figure becomes negotiable.
        </p>
      </div>

      {/* --------------------------------------------------- role switch */}
      <div className="mt-6 flex flex-wrap gap-2" role="group" aria-label="Dashboard role">
        {ROLES.map((option) => (
          <button
            key={option.key}
            type="button"
            name={`role_${option.key}`}
            onClick={() => navigate(`/app/dashboards/${option.key}`)}
            aria-pressed={role === option.key}
            className={`lf-pill px-3 py-1.5 ${
              role === option.key ? 'border-blue bg-blue/10 text-blue' : 'border-line2 text-muted'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {error && (
        <p className="mt-4 rounded border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">
          {error}
        </p>
      )}

      {/* The PDP's refusal, rendered rather than hidden. A dashboard that
          silently shows nothing is indistinguishable from an empty one. */}
      {data && !data.permitted && (
        <p className="mt-4 rounded border border-gold/40 bg-gold/10 px-3 py-2 text-sm text-gold">
          You do not have access to the {role} dashboard.{' '}
          {data.denied_reason ?? 'No reason was returned.'}
        </p>
      )}

      {loading && (
        <p role="status" className="mt-6 text-sm text-muted">
          Reading the dashboard...
        </p>
      )}

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        {(data?.panels ?? []).map((panel) => (
          <section key={panel.key} className="lf-panel p-5" aria-label={panel.label}>
            <h2 className="lf-eyebrow">{panel.label}</h2>
            <p className="mt-1 text-xs text-soft">{panel.description}</p>

            <dl className="mt-3 space-y-2">
              {panel.metrics.map((metric) => (
                <div key={metric.label} className="flex items-baseline justify-between gap-3">
                  <dt className="text-sm text-muted">{metric.label}</dt>
                  <dd className="text-sm font-semibold text-text">
                    {/* Null is not zero, on every dashboard. */}
                    {metric.value ?? '--'}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>

      {!loading && (data?.panels ?? []).length === 0 && !error && data?.permitted !== false && (
        <p className="mt-6 text-sm text-muted">
          No panels are configured for this role.
        </p>
      )}

      <p className="mt-6 text-xs text-soft">
        {data?.kpi_registry_version
          ? `KPI registry ${data.kpi_registry_version}. Every dashboard reads this same registry.`
          : 'KPI registry version not read. Figures cannot be reconciled until it is.'}
      </p>
    </div>
  );
}
