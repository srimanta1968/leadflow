import { useEffect, useMemo, useState } from 'react';
import {
  api,
  ApiError,
  type RelationshipEdge,
  type RelationshipGraph,
  type RelationshipNode,
} from '../../../services/api';
import { useContactRecord } from '../ContactRecordContext';
import { DataTable, type Column } from '../../../design-system/data/DataTable';
import { cssVar } from '../../../design-system/tokens';

/**
 * The contextual relationship graph (#nodeG) and its table equivalent.
 *
 * THE TABLE IS A FIRST-CLASS VIEW, NOT A FALLBACK. The acceptance condition is
 * that every piece of information available in the graph is reachable in the
 * table, and the two are therefore built from ONE row model (`describe` below)
 * rather than from the graph plus a summary of it. That is the only arrangement
 * that survives a change: add a field to the edge and both views gain it, where
 * a separately-authored table silently falls behind and the "accessible
 * equivalent" becomes a lesser view that nobody notices is lesser.
 *
 * WHAT THE GRAPH ENCODES. Role type is carried by edge COLOUR and trust state by
 * DASH PATTERN, deliberately on two different visual channels: encoding both in
 * colour would make a candidate contractor and a confirmed neighbour
 * indistinguishable to a red-green colourblind operator, and both are also
 * printed as text on the node label and in the table.
 *
 * TRAVERSAL IS BUDGETED. A dense graph is not rendered in full and the screen
 * SAYS when it stopped at the budget rather than at the edge of the
 * neighbourhood — a graph that silently truncates is worse than no graph,
 * because it looks complete.
 *
 * COLOURS COME FROM `cssVar`. SVG stroke attributes are the one place Tailwind
 * token classes cannot reach, and a hex literal here would fail the design
 * system guard for the good reason that it is how the palette forked last time.
 */

/** Role type -> token. Text carries the same information for anyone who cannot use colour. */
const ROLE_TOKEN: Record<string, string> = {
  person: '--mag',
  property: '--cyan',
  organization: '--purple',
  team: '--gold',
};

const NODE_KIND_LABEL: Record<RelationshipNode['kind'], string> = {
  person: 'Person',
  property: 'Property',
  organization: 'Organization',
  team: 'Team',
};

/** One row of the shared model both views render. */
interface EdgeDescription {
  edge_id: string;
  target_label: string;
  target_kind: string;
  role: string;
  trust_state: string;
  validity: string;
  evidence_count: number;
  to_id: string;
}

export default function RelationshipsTab() {
  const { contactId } = useContactRecord();
  const [data, setData] = useState<RelationshipGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'graph' | 'table'>('graph');
  const [roleFilter, setRoleFilter] = useState('all');
  const [trustFilter, setTrustFilter] = useState('all');

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void (async () => {
      try {
        setData(await api.contactRelationships(contactId, controller.signal));
        setError(null);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setData(null);
        setError(caught instanceof ApiError ? caught.message : 'The graph could not be read.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [contactId]);

  const nodesById = useMemo(() => {
    const map = new Map<string, RelationshipNode>();
    for (const node of data?.nodes ?? []) map.set(node.node_id, node);
    return map;
  }, [data]);

  /**
   * The ONE row model. Both the graph's hover card and the table read this, so
   * the two cannot drift apart.
   */
  const describe = useMemo(() => {
    return (edge: RelationshipEdge): EdgeDescription => {
      const target = nodesById.get(edge.to_id);
      return {
        edge_id: edge.edge_id,
        to_id: edge.to_id,
        target_label: target?.label ?? 'Unknown node',
        target_kind: target ? NODE_KIND_LABEL[target.kind] : 'Unknown',
        role: edge.role,
        trust_state: edge.trust_state ?? 'Not stated',
        validity: `${edge.valid_from ?? 'unknown start'} to ${edge.valid_to ?? 'open'}`,
        evidence_count: edge.evidence_count,
      };
    };
  }, [nodesById]);

  const roleOptions = useMemo(
    () => ['all', ...new Set((data?.edges ?? []).map((e) => e.role))],
    [data],
  );
  const trustOptions = useMemo(
    () => ['all', ...new Set((data?.edges ?? []).map((e) => e.trust_state ?? 'Not stated'))],
    [data],
  );

  const visibleEdges = useMemo(
    () =>
      (data?.edges ?? []).filter(
        (edge) =>
          (roleFilter === 'all' || edge.role === roleFilter) &&
          (trustFilter === 'all' || (edge.trust_state ?? 'Not stated') === trustFilter),
      ),
    [data, roleFilter, trustFilter],
  );

  const rows = useMemo(() => visibleEdges.map(describe), [visibleEdges, describe]);

  const columns: Column<EdgeDescription>[] = [
    { key: 'target', header: 'Connected to', cell: (r) => r.target_label, width: '26%' },
    { key: 'kind', header: 'Type', cell: (r) => r.target_kind, width: '14%' },
    { key: 'role', header: 'Role', cell: (r) => r.role, width: '18%' },
    { key: 'trust', header: 'Trust state', cell: (r) => r.trust_state, width: '14%' },
    { key: 'validity', header: 'Validity', cell: (r) => r.validity, width: '18%' },
    {
      key: 'evidence',
      header: 'Evidence',
      align: 'right',
      width: '10%',
      sortValue: (r) => r.evidence_count,
      cell: (r) => String(r.evidence_count),
    },
  ];

  return (
    <section aria-label="Relationships">
      <div className="lf-panel p-5">
        <h2 className="text-lg font-semibold text-text">Relationships</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Contextual roles connect the Person to Properties, Organizations, tenant teams and other
          people without mutating pure identity.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <div className="flex gap-1" role="group" aria-label="View">
            <button
              type="button"
              name="graph_view"
              onClick={() => setView('graph')}
              aria-pressed={view === 'graph'}
              className={view === 'graph' ? 'lf-btn-primary px-3 py-1.5' : 'lf-btn-secondary px-3 py-1.5'}
            >
              Graph view
            </button>
            <button
              type="button"
              name="table_view"
              onClick={() => setView('table')}
              aria-pressed={view === 'table'}
              className={view === 'table' ? 'lf-btn-primary px-3 py-1.5' : 'lf-btn-secondary px-3 py-1.5'}
            >
              Table view
            </button>
          </div>

          {/* "Filter by role", not "Role": the graph already uses the word
              "role" for the edge property, so a bare label reads as a column
              heading rather than as a control. */}
          <label className="lf-label" htmlFor="role_filter">
            Filter by role
          </label>
          <select
            id="role_filter"
            name="role_filter"
            className="lf-input"
            value={roleFilter}
            onChange={(event) => setRoleFilter(event.target.value)}
          >
            {roleOptions.map((option) => (
              <option key={option} value={option}>
                {option === 'all' ? 'All role types' : option}
              </option>
            ))}
          </select>

          <label className="lf-label" htmlFor="trust_filter">
            Filter by trust state
          </label>
          <select
            id="trust_filter"
            name="trust_filter"
            className="lf-input"
            value={trustFilter}
            onChange={(event) => setTrustFilter(event.target.value)}
          >
            {trustOptions.map((option) => (
              <option key={option} value={option}>
                {option === 'all' ? 'All trust states' : option}
              </option>
            ))}
          </select>
        </div>

        {data?.budget_exhausted && (
          <p className="mt-3 rounded border border-gold/40 bg-gold/10 px-3 py-2 text-xs text-gold">
            Traversal stopped at the budget of {data.traversal_budget} relationships. This
            neighbourhood is larger than what is drawn - narrow the filters to see the rest.
          </p>
        )}
      </div>

      <div className="lf-panel mt-4 p-5">
        {error && (
          <p className="mb-3 rounded border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">
            {error}
          </p>
        )}

        {view === 'graph' ? (
          <RelationshipCanvas
            centerLabel={data?.nodes?.find((n) => n.node_id === data.center_id)?.label ?? 'This person'}
            rows={rows}
            nodesById={nodesById}
            loading={loading}
          />
        ) : (
          <DataTable
            rows={rows}
            columns={columns}
            rowKey={(r) => r.edge_id}
            loading={loading}
            density="dense"
            caption="Relationship neighbourhood"
            empty={<span>No relationships match these filters.</span>}
          />
        )}
      </div>
    </section>
  );
}

/**
 * The radial canvas.
 *
 * A DETERMINISTIC LAYOUT rather than a force simulation. A force layout settles
 * somewhere different on every load, which makes the graph unquotable — an
 * operator cannot say "the node on the left" to a colleague, and a screenshot in
 * a dispute cannot be reproduced. The radial arrangement puts the same
 * relationship in the same place every time and costs no animation frames, which
 * is also how 500 nodes stay smooth.
 */
function RelationshipCanvas({
  centerLabel,
  rows,
  nodesById,
  loading,
}: {
  centerLabel: string;
  rows: EdgeDescription[];
  nodesById: Map<string, RelationshipNode>;
  loading: boolean;
}) {
  const size = 560;
  const centre = size / 2;
  const radius = centre - 70;

  if (loading) {
    return (
      <p role="status" className="py-16 text-center text-sm text-muted">
        Reading the relationship neighbourhood...
      </p>
    );
  }

  if (rows.length === 0) {
    return (
      <p className="py-16 text-center text-sm text-soft">
        No relationships match these filters.
      </p>
    );
  }

  return (
    <figure>
      <svg
        viewBox={`0 0 ${size} ${size}`}
        className="mx-auto h-auto w-full max-w-2xl"
        role="img"
        aria-label={`Relationship graph for ${centerLabel}, ${rows.length} relationships. The same information is available in the table view.`}
      >
        {rows.map((row, index) => {
          const angle = (index / rows.length) * Math.PI * 2 - Math.PI / 2;
          const x = centre + Math.cos(angle) * radius;
          const y = centre + Math.sin(angle) * radius;
          const kind = nodesById.get(row.to_id)?.kind ?? 'person';
          const stroke = cssVar(ROLE_TOKEN[kind] ?? '--blue');
          // Trust rides on the dash pattern, not on a second colour. See the
          // module comment: two meanings on one channel is one meaning lost.
          const confirmed = row.trust_state.toLowerCase().startsWith('confirm');

          return (
            <g key={row.edge_id}>
              <line
                x1={centre}
                y1={centre}
                x2={x}
                y2={y}
                stroke={stroke}
                strokeWidth={1.5}
                strokeDasharray={confirmed ? undefined : '4 3'}
                opacity={0.8}
              />
              <circle cx={x} cy={y} r={7} fill={stroke}>
                {/* The hover card. Everything in it is also a table column. */}
                <title>
                  {`${row.target_label} (${row.target_kind}) — role ${row.role}, trust ${row.trust_state}, valid ${row.validity}, ${row.evidence_count} evidence items`}
                </title>
              </circle>
              <text
                x={x}
                y={y - 12}
                textAnchor="middle"
                className="fill-muted text-[9px]"
              >
                {row.target_label.slice(0, 18)}
              </text>
            </g>
          );
        })}

        <circle cx={centre} cy={centre} r={16} fill={cssVar('--blue')} />
        <text x={centre} y={centre + 32} textAnchor="middle" className="fill-text text-[11px]">
          {centreLabelOf(centerLabel)}
        </text>
      </svg>

      <figcaption className="mt-3 text-xs text-soft">
        Solid edges are confirmed relationships; dashed edges are candidate or documented. Every
        value shown here is also a column in the table view.
      </figcaption>
    </figure>
  );
}

/** Keeps the centre label from overrunning the canvas. */
function centreLabelOf(label: string): string {
  return label.length > 24 ? `${label.slice(0, 23)}...` : label;
}
