import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, type WorkflowDefinitionList } from '../../services/api';
import { cssVar } from '../../design-system/tokens';

/**
 * Workflow canvas, node palette and definition authoring (PRD §7).
 *
 * THE OUTLINE VIEW IS NOT AN ACCESSIBILITY FALLBACK, IT IS THE SAME EDITOR.
 * Every capability of the canvas is reachable from the keyboard outline, which
 * is the acceptance condition, and the only way to actually meet it is to build
 * both views over ONE model — the moment the canvas owns state the outline
 * cannot reach, the outline becomes a viewer and the claim quietly stops being
 * true. `nodes` and `connections` below are that model; both views render and
 * mutate it and neither owns anything.
 *
 * AN INCOMPATIBLE CONNECTION IS REFUSED WITH AN EXPLANATION. Silently dropping
 * the edge teaches the author that the canvas is unreliable, and a "connection
 * invalid" toast teaches them nothing. `explainConnection` returns the sentence,
 * and both views use it.
 *
 * A DEFINITION IS COMPILED, NOT SAVED. The canvas is an authoring surface over
 * sdk-workflow step definitions; treating the diagram as the source of truth is
 * how a workflow comes to mean something subtly different from what it runs.
 *
 * PERFORMANCE. Nodes are absolutely positioned in one SVG layer with no
 * per-node React state and no layout measurement, so a hundred nodes cost one
 * render rather than a hundred. There is no force simulation to settle.
 */

/** The nine node types of the palette. */
const NODE_TYPES = [
  { key: 'trigger', label: 'Trigger', token: '--green', description: 'Starts a run when something happens.' },
  { key: 'condition', label: 'Condition', token: '--gold', description: 'Splits the path on a predicate.' },
  { key: 'action', label: 'Action', token: '--blue', description: 'Does something outside the workflow.' },
  { key: 'delay', label: 'Delay', token: '--cyan', description: 'Waits for a duration or until a time.' },
  { key: 'loop', label: 'Loop', token: '--purple', description: 'Repeats over a collection.' },
  { key: 'webhook', label: 'Webhook', token: '--orange', description: 'Calls out, and can wait for a reply.' },
  { key: 'ai', label: 'AI', token: '--mag', description: 'Drafts or classifies, leaving the decision to a human.' },
  { key: 'approval', label: 'Approval', token: '--gold', description: 'Pauses until a named person decides.' },
  { key: 'crm_update', label: 'CRM Update', token: '--blue', description: 'Writes to the customer record.' },
];

interface CanvasNode {
  id: string;
  type: string;
  label: string;
  x: number;
  y: number;
}

interface CanvasConnection {
  id: string;
  from: string;
  to: string;
}

/**
 * The connection rules, in one place so the canvas and the outline cannot
 * disagree about what is legal.
 *
 * Returns null when the connection is allowed, or the SENTENCE explaining the
 * refusal. A boolean would force each caller to compose its own wording, which
 * is how two views come to refuse the same edge for two different stated
 * reasons.
 */
function explainConnection(from: CanvasNode | undefined, to: CanvasNode | undefined): string | null {
  if (!from || !to) return 'One end of this connection does not exist.';
  if (from.id === to.id) return 'A node cannot connect to itself - that is a loop with no exit.';
  if (to.type === 'trigger') {
    return 'A Trigger starts a run, so nothing can connect INTO it. Connect from the Trigger instead.';
  }
  if (from.type === 'approval' && to.type === 'trigger') {
    return 'An Approval cannot start a run. Approvals pause a run that is already going.';
  }
  return null;
}

export default function WorkflowStudio() {
  const [view, setView] = useState<'canvas' | 'outline'>('canvas');
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const [connections, setConnections] = useState<CanvasConnection[]>([]);
  // Undo depth is capped at 50 in `snapshot`. An unbounded stack on a canvas
  // holding a hundred nodes is a memory leak nobody notices until a long
  // authoring session.
  const [, setHistory] = useState<{ nodes: CanvasNode[]; connections: CanvasConnection[] }[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [connectFrom, setConnectFrom] = useState('');
  const [connectTo, setConnectTo] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const [definitions, setDefinitions] = useState<WorkflowDefinitionList | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        setDefinitions(await api.workflowDefinitions(controller.signal));
        setError(null);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setDefinitions(null);
        setError(caught instanceof ApiError ? caught.message : 'Definitions could not be read.');
      }
    })();
    return () => controller.abort();
  }, []);

  const snapshot = () =>
    setHistory((current) => [...current.slice(-49), { nodes, connections }]);

  const addNode = (type: string) => {
    snapshot();
    const index = nodes.length;
    setNodes((current) => [
      ...current,
      {
        id: `n${index + 1}`,
        type,
        label: NODE_TYPES.find((t) => t.key === type)?.label ?? type,
        // A deterministic grid rather than a random drop point: the same
        // definition must lay out the same way every time it is opened.
        x: 80 + (index % 4) * 150,
        y: 70 + Math.floor(index / 4) * 110,
      },
    ]);
  };

  const connect = () => {
    const from = nodes.find((n) => n.id === connectFrom);
    const to = nodes.find((n) => n.id === connectTo);
    const problem = explainConnection(from, to);
    if (problem) {
      setRefusal(problem);
      return;
    }
    snapshot();
    setRefusal(null);
    setConnections((current) => [
      ...current,
      { id: `${connectFrom}->${connectTo}`, from: connectFrom, to: connectTo },
    ]);
  };

  const undo = () => {
    setHistory((current) => {
      const previous = current[current.length - 1];
      if (previous) {
        setNodes(previous.nodes);
        setConnections(previous.connections);
      }
      return current.slice(0, -1);
    });
  };

  const nodesById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  return (
    <div className="mx-auto max-w-7xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-text">Workflow Studio</h1>
          <p className="mt-1.5 max-w-3xl text-sm text-muted">
            Author a definition on the canvas or in the outline. They are the same editor over the
            same model, so anything you can do with a pointer you can do from the keyboard.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            name="canvas_view"
            onClick={() => setView('canvas')}
            aria-pressed={view === 'canvas'}
            className={view === 'canvas' ? 'lf-btn-primary px-3 py-1.5' : 'lf-btn-secondary px-3 py-1.5'}
          >
            Canvas view
          </button>
          <button
            type="button"
            name="outline_view"
            onClick={() => setView('outline')}
            aria-pressed={view === 'outline'}
            className={view === 'outline' ? 'lf-btn-primary px-3 py-1.5' : 'lf-btn-secondary px-3 py-1.5'}
          >
            Outline view
          </button>
          <button type="button" name="undo" onClick={undo} className="lf-btn-secondary px-3 py-1.5">
            Undo
          </button>
          <button type="button" name="compile_definition" className="lf-btn-primary px-3 py-1.5">
            Compile
          </button>
        </div>
      </div>

      {error && (
        <p className="mt-4 rounded border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">
          {error}
        </p>
      )}

      <div className="mt-6 grid gap-4 lg:grid-cols-4">
        {/* ------------------------------------------------ node palette */}
        <section className="lf-panel p-4" aria-label="Node palette">
          <h2 className="lf-eyebrow">Node palette</h2>
          <ul className="mt-3 space-y-2">
            {NODE_TYPES.map((type) => (
              <li key={type.key}>
                <button
                  type="button"
                  name={`add_${type.key}`}
                  onClick={() => addNode(type.key)}
                  className="lf-card w-full p-2 text-left"
                >
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: cssVar(type.token) }}
                    />
                    <span className="text-sm text-text">{type.label}</span>
                  </span>
                  <span className="mt-0.5 block text-[11px] text-soft">{type.description}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        {/* ------------------------------------------- canvas or outline */}
        <section className="lf-panel p-4 lg:col-span-2" aria-label="Definition editor">
          {view === 'canvas' ? (
            <>
              <h2 className="lf-eyebrow">Canvas</h2>
              <svg
                viewBox="0 0 640 460"
                className="mt-3 h-auto w-full rounded-lg border border-line bg-bg2"
                role="img"
                aria-label={`Workflow canvas with ${nodes.length} nodes and ${connections.length} connections. The outline view offers the same editing.`}
              >
                {connections.map((connection) => {
                  const from = nodesById.get(connection.from);
                  const to = nodesById.get(connection.to);
                  if (!from || !to) return null;
                  return (
                    <line
                      key={connection.id}
                      x1={from.x + 45}
                      y1={from.y + 18}
                      x2={to.x + 45}
                      y2={to.y + 18}
                      stroke={cssVar('--line2')}
                      strokeWidth={1.5}
                    />
                  );
                })}

                {nodes.map((node) => {
                  const type = NODE_TYPES.find((t) => t.key === node.type);
                  return (
                    <g key={node.id}>
                      <rect
                        x={node.x}
                        y={node.y}
                        width={90}
                        height={36}
                        rx={8}
                        fill={cssVar('--panel2')}
                        stroke={cssVar(type?.token ?? '--blue')}
                        strokeWidth={selected === node.id ? 2.5 : 1.5}
                      />
                      <text
                        x={node.x + 45}
                        y={node.y + 22}
                        textAnchor="middle"
                        className="fill-text text-[10px]"
                      >
                        {node.label}
                      </text>
                    </g>
                  );
                })}

                {nodes.length === 0 && (
                  <text x={320} y={230} textAnchor="middle" className="fill-soft text-[12px]">
                    Add a node from the palette to begin.
                  </text>
                )}
              </svg>
            </>
          ) : (
            <>
              <h2 className="lf-eyebrow">Outline</h2>
              <p className="mt-1 text-xs text-soft">
                The same model as the canvas. Every capability here, reachable by keyboard.
              </p>
              <ol className="mt-3 space-y-2">
                {nodes.map((node) => (
                  <li key={node.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(node.id)}
                      aria-pressed={selected === node.id}
                      className="lf-card w-full p-2 text-left"
                    >
                      <span className="text-sm text-text">
                        {node.id}. {node.label}
                      </span>
                      <span className="mt-0.5 block text-[11px] text-soft">
                        connects to{' '}
                        {connections
                          .filter((c) => c.from === node.id)
                          .map((c) => c.to)
                          .join(', ') || 'nothing yet'}
                      </span>
                    </button>
                  </li>
                ))}
                {nodes.length === 0 && (
                  <li className="text-sm text-muted">
                    No nodes yet. Add one from the palette.
                  </li>
                )}
              </ol>
            </>
          )}

          {/* ------------------------------------- connection authoring */}
          <div className="mt-4 border-t border-line pt-4">
            <h3 className="lf-label">Connect two nodes</h3>
            <div className="mt-1 flex flex-wrap items-end gap-2">
              <div>
                <label className="sr-only" htmlFor="connect_from">
                  From
                </label>
                <select
                  id="connect_from"
                  name="connect_from"
                  className="lf-input"
                  value={connectFrom}
                  onChange={(event) => setConnectFrom(event.target.value)}
                >
                  <option value="">From</option>
                  {nodes.map((node) => (
                    <option key={node.id} value={node.id}>
                      {node.id} {node.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="sr-only" htmlFor="connect_to">
                  To
                </label>
                <select
                  id="connect_to"
                  name="connect_to"
                  className="lf-input"
                  value={connectTo}
                  onChange={(event) => setConnectTo(event.target.value)}
                >
                  <option value="">To</option>
                  {nodes.map((node) => (
                    <option key={node.id} value={node.id}>
                      {node.id} {node.label}
                    </option>
                  ))}
                </select>
              </div>

              <button
                type="button"
                name="connect_nodes"
                onClick={connect}
                disabled={connectFrom === '' || connectTo === ''}
                className="lf-btn-secondary px-3 py-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Connect
              </button>
            </div>

            {/* The refusal, with the reason. Never a silent drop. */}
            {refusal && (
              <p className="mt-2 rounded border border-gold/40 bg-gold/10 px-3 py-2 text-sm text-gold">
                {refusal}
              </p>
            )}
          </div>
        </section>

        {/* ------------------------------------------------- inspector */}
        <section className="lf-panel p-4" aria-label="Inspector">
          <h2 className="lf-eyebrow">Inspector</h2>
          {selected ? (
            <div className="mt-3 text-sm">
              <p className="text-text">{nodesById.get(selected)?.label}</p>
              <p className="mt-1 text-xs text-soft">
                {NODE_TYPES.find((t) => t.key === nodesById.get(selected)?.type)?.description}
              </p>
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted">Select a node to inspect it.</p>
          )}

          <h3 className="lf-label mt-5">Definitions</h3>
          <ul className="mt-2 space-y-2">
            {(definitions?.definitions ?? []).map((definition) => (
              <li key={definition.definition_id} className="text-sm">
                <p className="text-text">{definition.name}</p>
                <p className="text-[11px] text-soft">
                  v{definition.version ?? '--'} · {definition.status ?? 'unknown'}
                  {definition.kill_switch_engaged ? ' · kill switch engaged' : ''}
                </p>
              </li>
            ))}
            {(definitions?.definitions ?? []).length === 0 && (
              <li className="text-sm text-muted">No definitions are stored yet.</li>
            )}
          </ul>

          <p className="mt-4 text-xs text-soft">
            Publishing goes through an approval, and each workflow carries its own kill switch.
          </p>
        </section>
      </div>
    </div>
  );
}
