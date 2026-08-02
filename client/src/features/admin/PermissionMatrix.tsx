import { PolicyDecision } from '../../platform/permissions';

/** One row: what a role may do, and what it may do only with approval. */
export interface MatrixRow {
  roleKey: string;
  roleLabel: string;
  canDo: string[];
  requiresApproval: string[];
}

/**
 * Group live PDP verdicts into the SOP §28 grid.
 *
 * DERIVED FROM DECISIONS, not from a copy of the role table. A hand-maintained
 * grid is the thing this screen exists to replace: it looks authoritative and
 * drifts from the policy the moment either changes, so an administrator reading
 * it would be told something the server does not believe.
 *
 * Exported and pure so the grouping can be asserted without rendering.
 */
export function toMatrixRows(
  roles: { key: string; label: string }[],
  decisionsByRole: Map<string, PolicyDecision[]>
): MatrixRow[] {
  return roles.map((role) => {
    const decisions = decisionsByRole.get(role.key) ?? [];
    return {
      roleKey: role.key,
      roleLabel: role.label,
      canDo: decisions.filter((d) => d.effect === 'permit').map((d) => d.action),
      // requires_approval is its OWN column, not merged into denied. The SOP
      // distinction is the point of the screen: an administrator needs to see
      // which refusals have an escalation path and which do not.
      requiresApproval: decisions
        .filter((d) => d.effect === 'requires_approval')
        .map((d) => d.action),
    };
  });
}

/** A capability chip. */
function Pill({ label, tone }: { label: string; tone: 'green' | 'gold' }) {
  const toneClass =
    tone === 'green' ? 'border-green/40 bg-green/10 text-green' : 'border-gold/40 bg-gold/10 text-gold';
  return (
    <span className={`lf-pill mr-1.5 mb-1.5 inline-block border ${toneClass}`}>{label}</span>
  );
}

interface PermissionMatrixProps {
  rows: MatrixRow[];
  loading?: boolean;
}

/**
 * The role-by-capability grid from SOP §28.
 *
 * Two columns rather than a tick-per-capability grid: the capability list is
 * long and mostly empty per role, so a full matrix would be a wall of blanks
 * that hides the few cells that matter. Listing what a role HOLDS, beside what
 * it must escalate, is the shape a person actually reads.
 */
export function PermissionMatrix({ rows, loading = false }: PermissionMatrixProps) {
  if (loading) {
    return <p className="text-sm text-muted">Loading the permission matrix…</p>;
  }

  if (rows.length === 0) {
    // Never silently blank: an empty grid and a failed load look identical, and
    // an administrator would read "nobody can do anything" as fact.
    return (
      <p className="rounded-xl border border-line bg-panel2 px-4 py-3 text-sm text-muted">
        No policy decisions were returned, so the matrix cannot be shown. This is a loading
        failure, not an empty permission set.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[42rem] text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-soft">
            <th scope="col" className="pb-2 pr-4 font-semibold">
              Role
            </th>
            <th scope="col" className="pb-2 pr-4 font-semibold">
              Can do
            </th>
            <th scope="col" className="pb-2 font-semibold">
              Needs approval
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.roleKey} className="border-b border-line/50 align-top">
              <th scope="row" className="py-3 pr-4 text-left font-medium text-text">
                {row.roleLabel}
              </th>
              <td className="py-3 pr-4">
                {row.canDo.length === 0 ? (
                  <span className="text-xs text-soft">Nothing unaided</span>
                ) : (
                  row.canDo.map((action) => <Pill key={action} label={action} tone="green" />)
                )}
              </td>
              <td className="py-3">
                {row.requiresApproval.length === 0 ? (
                  <span className="text-xs text-soft">—</span>
                ) : (
                  row.requiresApproval.map((action) => (
                    <Pill key={action} label={action} tone="gold" />
                  ))
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
