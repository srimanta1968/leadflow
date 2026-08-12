import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type PermissionMatrixResponse } from '../../services/api';
import { PermissionMatrix, toMatrixRows } from '../../features/admin/PermissionMatrix';
import type { PolicyDecision } from '../../platform/permissions';

/**
 * The SOP §28 permission matrix, routed at last.
 *
 * `features/admin/PermissionMatrix.tsx` has existed for some time, has never
 * contained a single interactive element, and was NOT ROUTED — unreachable dead
 * code sitting next to a product where three screens were permanently Locked for
 * everybody because nobody could see, let alone grant, the roles that unlock
 * them. This page is the route it was missing; the grid itself is imported
 * unchanged rather than rebuilt.
 *
 * IT STAYS READ-ONLY, and that is a decision rather than an omission. Roles and
 * policies are defined in server/src/config/roles.ts and policies.ts and
 * evaluated by the policy decision point. An editable grid in a browser would
 * imply the policy set is per-tenant configuration when it is versioned code,
 * and would create two sources of truth for the one thing in this system that
 * must have exactly one. The screen says so out loud, because a grid with no
 * edit control reads as unfinished unless it explains itself.
 *
 * THE ROWS ARE DECISIONS, NOT A COPY OF THE ROLE TABLE. The server evaluates
 * every action against every role through the same `evaluate()` the enforcement
 * path calls, so an override — `audit.delete_event`, denied to everyone with no
 * escalation path — appears here exactly as it is enforced. A grid rendered from
 * the role definitions alone would show it as available to Leadership with
 * approval, and a matrix that disagrees with enforcement on the one rule that
 * cannot be escalated is worse than no matrix.
 */
export default function PermissionMatrixScreen() {
  const [data, setData] = useState<PermissionMatrixResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        setData(await api.permissionMatrix(controller.signal));
        setError(null);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setData(null);
        setError(
          caught instanceof ApiError ? caught.message : 'The permission matrix could not be read.'
        );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);

  // Regrouped into the shape `toMatrixRows` already understands rather than
  // giving this screen its own grouping: the component is asserted against that
  // function, and a second grouping here would be a second thing to keep true.
  const decisionsByRole = new Map<string, PolicyDecision[]>(
    (data?.rows ?? []).map((row) => [row.role_key, row.decisions as PolicyDecision[]])
  );
  const rows = toMatrixRows(
    (data?.rows ?? []).map((row) => ({ key: row.role_key, label: row.role_label })),
    decisionsByRole
  );

  return (
    <div className="mx-auto max-w-7xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-text">Permission Matrix</h1>
          <p className="mt-1.5 max-w-3xl text-sm text-muted">
            What each SOP role may do unaided, and what it may do only with a second party.
            Every cell is a live verdict from the policy decision point, not a description of
            one.
          </p>
        </div>
        <Link to="/app/admin/users" className="lf-btn-ghost px-4 py-2">
          Back to the user register
        </Link>
      </div>

      <section className="lf-panel mt-6 p-5" aria-label="Why this grid is read-only">
        <h2 className="lf-eyebrow">This grid is read-only, on purpose</h2>
        <p className="mt-1 text-sm text-muted">
          Roles and policies are versioned code, evaluated by the policy decision point. An
          editable grid here would imply the policy set is per-tenant configuration and would
          create two sources of truth for the one thing that must have exactly one. To change
          what a role grants, change the role definition and ship it.
        </p>
        <p className="mt-2 text-xs text-soft">
          Source: {data?.source ?? 'server/src/config/roles.ts + server/src/config/policies.ts'}
        </p>
      </section>

      {error && (
        <p className="mt-4 rounded border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">
          {error}
        </p>
      )}

      <div className="lf-panel mt-4 p-5">
        <PermissionMatrix rows={rows} loading={loading} />
      </div>

      <section className="lf-panel mt-4 p-5" aria-label="Needs approval is not denied">
        <h2 className="lf-eyebrow">Needs approval is not denied</h2>
        <p className="mt-1 text-sm text-muted">
          The SOP's wording is "cannot do without approval", which is an escalation path rather
          than a prohibition. A role listed under Needs approval may take that action with a
          second party holding the approving role. Collapsing the two would tell somebody they
          may not do a thing they may in fact do, and people told that reliably work around the
          product instead of through it.
        </p>
      </section>
    </div>
  );
}
