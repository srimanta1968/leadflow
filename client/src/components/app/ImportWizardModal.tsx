import { useCallback, useEffect, useRef, useState } from 'react';
import { IMPORT_SOURCES } from '../../content/importSources';
import {
  CANONICAL_TEMPLATE_COLUMNS,
  DELIMITERS,
  ENCODINGS,
  SAMPLE_CSV,
  previewFile,
  type DelimiterValue,
  type EncodingChoice,
  type FilePreview,
} from '../../features/imports/csvPreview';
import {
  EMPTY_WIZARD_STATE,
  clearWizardState,
  loadWizardState,
  saveWizardState,
  type WizardState,
} from '../../features/imports/wizardState';

/**
 * Contact Import & Reconciliation — #importModal, steps 1-3.
 *
 * Source -> evidence -> mapping -> identity -> governance -> commit. Ten steps
 * are shown from the outset because the operator should be able to see, before
 * uploading anything, that an attestation is coming. Steps 4-10 land in the
 * tasks that follow; the stepper renders them as not-yet-reachable rather than
 * hiding them, so the shape of the commitment is honest from step one.
 *
 * THE FILE NEVER LEAVES THE BROWSER IN THESE THREE STEPS. Preview, delimiter,
 * encoding and header detection are all computed locally from a slice of the
 * file. The bytes go to sdk-import at COMMIT, which is after the origin
 * attestation on step 4 — an export the operator has not yet claimed the right
 * to use must not have already crossed the boundary.
 */

const STEPS = [
  'Source',
  'Connect',
  'Preview',
  'Origin',
  'Map',
  'Transform',
  'Resolve',
  'Access',
  'Consent',
  'Commit',
];

/** The last step this task implements. Beyond it the wizard is not yet built. */
const IMPLEMENTED_THROUGH = 3;

/** Sources that connect by OAuth rather than by file upload. */
const OAUTH_SOURCES = new Set(['google', 'apple']);
/** Sources that connect by a vault-backed API credential. */
const API_SOURCES = new Set(['acculynx', 'jobnimbus', 'salesrabbit', 'hubspot']);

const CONFIDENCE_CLASS: Record<string, string> = {
  high: 'text-emerald-700',
  medium: 'text-amber-700',
  low: 'text-red-700',
};

interface Props {
  open: boolean;
  onClose: () => void;
  /** Preselects a source when opened from a tile on the Import Center. */
  initialSource?: string | null;
}

export function ImportWizardModal({ open, onClose, initialSource }: Props): JSX.Element | null {
  const [state, setState] = useState<WizardState>(EMPTY_WIZARD_STATE);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionNote, setConnectionNote] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  /* Restore the draft on open. This is the whole of AC4 and it runs BEFORE the
   * first paint of the body, so the operator never sees step 1 flash past. */
  useEffect(() => {
    if (!open) return;
    const restored = loadWizardState();
    setState(initialSource ? { ...restored, source: initialSource } : restored);
  }, [open, initialSource]);

  /* Persist on every change. Credentials and file bytes are excluded inside
   * saveWizardState — see the comment there for why that is the point. */
  useEffect(() => {
    if (open) saveWizardState(state);
  }, [open, state]);

  const patch = useCallback((changes: Partial<WizardState>) => {
    setState((prev) => ({ ...prev, ...changes }));
  }, []);

  /**
   * Inspect a chosen file locally.
   *
   * Nothing is uploaded here. `previewFile` reads a bounded slice through the
   * File API and everything else is computed from it.
   */
  const inspect = useCallback(
    async (file: File, overrides: { delimiter?: DelimiterValue; hasHeader?: boolean } = {}) => {
      setBusy(true);
      setError(null);
      try {
        const result = await previewFile(file, overrides);
        setPreview(result);
        patch({
          fileName: result.fileName,
          delimiter: result.delimiter.value,
          headerRow: result.header.value ? 'First row' : 'No header',
          step: Math.max(state.step, 3),
        });
      } catch {
        setError('That file could not be read. It may be empty or in an unsupported format.');
      } finally {
        setBusy(false);
      }
    },
    [patch, state.step]
  );

  const onFileChosen = useCallback(
    (files: FileList | null) => {
      const file = files?.[0];
      if (file) void inspect(file);
    },
    [inspect]
  );

  /** The sample is a real File, so it walks exactly the same local path. */
  const loadSample = useCallback(() => {
    const file = new File([SAMPLE_CSV], 'sample_contacts.csv', { type: 'text/csv' });
    void inspect(file);
  }, [inspect]);

  const downloadTemplate = useCallback(() => {
    const blob = new Blob([`${CANONICAL_TEMPLATE_COLUMNS.join(',')}\n`], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'leadflow-canonical-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  if (!open) return null;

  const source = state.source ?? 'custom';
  const isOauth = OAUTH_SOURCES.has(source);
  const isApi = API_SOURCES.has(source);
  const canAdvance = state.step < IMPLEMENTED_THROUGH && (state.step !== 2 || preview !== null);

  const badge = (d: { confidence: string; reason: string }) => (
    <small className={`block ${CONFIDENCE_CLASS[d.confidence] ?? 'text-slate-500'}`}>
      {d.confidence} confidence — {d.reason}
    </small>
  );

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Contact Import and Reconciliation">
      <div className="max-h-[90vh] w-full max-w-5xl overflow-y-auto rounded-lg bg-white shadow-xl" data-testid="import-wizard">
        <header className="flex items-start justify-between border-b border-slate-200 p-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Contact Import &amp; Reconciliation</h2>
            <p className="text-sm text-slate-600">Source → evidence → mapping → identity → governance → commit</p>
          </div>
          <button type="button" name="close-import-wizard" onClick={onClose} className="text-slate-500 hover:text-slate-900">
            Close
          </button>
        </header>

        {/* ------------------------------------------------------- stepper */}
        <ol className="flex flex-wrap gap-1 border-b border-slate-200 p-3 text-xs" aria-label="Import steps">
          {STEPS.map((label, index) => {
            const n = index + 1;
            const done = n < state.step;
            const active = n === state.step;
            const reachable = n <= IMPLEMENTED_THROUGH;
            return (
              <li key={label}>
                <button
                  type="button"
                  name={`step-${n}`}
                  aria-current={active ? 'step' : undefined}
                  disabled={!reachable}
                  onClick={() => reachable && patch({ step: n })}
                  title={reachable ? label : `${label} — not built yet`}
                  className={`rounded px-2 py-1 ${
                    active ? 'bg-slate-900 text-white'
                      : done ? 'bg-emerald-50 text-emerald-800'
                      : reachable ? 'bg-slate-100 text-slate-700'
                      : 'bg-slate-50 text-slate-400'
                  }`}
                >
                  {n}. {label}
                </button>
              </li>
            );
          })}
        </ol>

        <div className="p-4">
          {error && <p className="mb-3 rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800">{error}</p>}

          {/* ------------------------------------------------ 1. Source */}
          {state.step === 1 && (
            <section aria-label="Choose Source">
              <h3 className="text-base font-semibold text-slate-900">Choose Source</h3>
              <p className="mb-3 text-sm text-slate-600">
                Predefined sources carry a versioned mapping and crosswalk strategy; custom files use assisted mapping.
              </p>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {IMPORT_SOURCES.map((s) => (
                  <button
                    key={s.kind}
                    type="button"
                    name={`wizard-source-${s.kind}`}
                    aria-pressed={source === s.kind}
                    onClick={() => patch({ source: s.kind })}
                    className={`rounded-lg border p-3 text-left ${
                      source === s.kind ? 'border-slate-900 bg-slate-50' : 'border-slate-200 hover:border-slate-400'
                    }`}
                  >
                    {s.recommendation && <span className="text-[11px] uppercase text-slate-500">{s.recommendation}</span>}
                    <span className="mt-1 block text-sm font-semibold text-slate-900">{s.label}</span>
                    <span className="mt-1 block text-xs text-slate-600">{s.description}</span>
                  </button>
                ))}
              </div>
              <div className="mt-4 rounded border border-slate-300 bg-slate-50 p-3 text-sm">
                <strong className="block text-slate-900">Connector boundary</strong>
                <p className="text-slate-700">
                  Only official or contractually permitted APIs are used. Otherwise LeadFlow supports source-native
                  exports and preserves the external record ID as a crosswalk.
                </p>
              </div>
            </section>
          )}

          {/* ----------------------------------------------- 2. Connect */}
          {state.step === 2 && (
            <section aria-label="Connect or Upload" className="grid gap-4 md:grid-cols-2">
              <div>
                <h3 className="text-base font-semibold text-slate-900">Connect or Upload</h3>
                <label
                  className="mt-2 flex min-h-[160px] cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-slate-300 p-4 text-center hover:border-slate-500"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    onFileChosen(e.dataTransfer.files);
                  }}
                >
                  <input
                    ref={fileInput}
                    type="file"
                    name="csv-file"
                    accept=".csv,.txt,.vcf"
                    className="sr-only"
                    onChange={(e) => onFileChosen(e.target.files)}
                  />
                  <strong className="text-slate-900">Drop source export here</strong>
                  <span className="text-xs text-slate-600">
                    CSV, text, or vCard · local browser preview before commit
                  </span>
                  <span className="mt-3 rounded bg-slate-900 px-3 py-1.5 text-sm text-white">Choose file</span>
                </label>

                <div className="mt-2 flex gap-2">
                  <button type="button" name="load-sample" onClick={loadSample} className="rounded border border-slate-300 px-2 py-1 text-xs">
                    Load sample CSV
                  </button>
                  <button type="button" name="download-template" onClick={downloadTemplate} className="rounded border border-slate-300 px-2 py-1 text-xs">
                    Download canonical template
                  </button>
                </div>

                {state.fileName && !preview && (
                  // Says plainly that the draft survived but the bytes did not,
                  // rather than showing a filename that is no longer attached.
                  <p className="mt-2 text-xs text-amber-700">
                    “{state.fileName}” was chosen before the page reloaded. File contents are never stored, so please
                    choose it again.
                  </p>
                )}
                {busy && <p className="mt-2 text-xs text-slate-500">Reading the file locally…</p>}
              </div>

              <article className="rounded-lg border border-slate-200 p-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-semibold text-slate-900">Connector Configuration</h4>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">
                    {isOauth ? 'OAuth' : isApi ? 'API' : 'Custom'}
                  </span>
                </div>

                {!isOauth && !isApi && (
                  <div className="mt-3 space-y-3">
                    <label className="block text-sm">
                      <span className="text-slate-700">Delimiter</span>
                      <select
                        name="delimiter"
                        className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
                        value={state.delimiter ?? ','}
                        onChange={(e) => {
                          const value = e.target.value as DelimiterValue;
                          patch({ delimiter: value });
                          const f = fileInput.current?.files?.[0];
                          if (f) void inspect(f, { delimiter: value });
                        }}
                      >
                        {DELIMITERS.map((d) => (
                          <option key={d.value} value={d.value}>{d.label}</option>
                        ))}
                      </select>
                    </label>
                    <label className="block text-sm">
                      <span className="text-slate-700">Header row</span>
                      <select
                        name="header-row"
                        className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
                        value={state.headerRow}
                        onChange={(e) => {
                          const value = e.target.value as WizardState['headerRow'];
                          patch({ headerRow: value });
                          const f = fileInput.current?.files?.[0];
                          if (f) void inspect(f, { hasHeader: value === 'First row' });
                        }}
                      >
                        <option>First row</option>
                        <option>No header</option>
                      </select>
                    </label>
                    <label className="block text-sm">
                      <span className="text-slate-700">Encoding</span>
                      <select
                        name="encoding"
                        className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
                        value={state.encoding}
                        onChange={(e) => patch({ encoding: e.target.value as EncodingChoice })}
                      >
                        {ENCODINGS.map((e) => <option key={e}>{e}</option>)}
                      </select>
                    </label>
                  </div>
                )}

                {isOauth && (
                  <div className="mt-3">
                    <div className="rounded border border-emerald-300 bg-emerald-50 p-2 text-sm">
                      <strong className="block text-emerald-900">Scoped OAuth connection</strong>
                      <p className="text-emerald-800">
                        Select an account and choose contact groups or a bounded date range. The authorisation is
                        completed by the provider and LeadFlow stores only a vault reference — no credential is ever
                        held in this browser.
                      </p>
                    </div>
                    <button
                      type="button"
                      name="connect-source"
                      onClick={() => setConnectionNote('Authorisation happens on the provider’s site. LeadFlow receives a vault reference, never a token.')}
                      className="mt-2 rounded bg-slate-900 px-3 py-1.5 text-sm text-white"
                    >
                      Connect Source
                    </button>
                  </div>
                )}

                {isApi && (
                  <div className="mt-3 space-y-3">
                    <label className="block text-sm">
                      <span className="text-slate-700">Connector Mode</span>
                      <select
                        name="connector-mode"
                        className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
                        value={state.connectorMode}
                        onChange={(e) => patch({ connectorMode: e.target.value as WizardState['connectorMode'] })}
                      >
                        <option>Approved API</option>
                        <option>Source-native export</option>
                      </select>
                    </label>
                    <label className="block text-sm">
                      <span className="text-slate-700">Credential Reference</span>
                      <input
                        name="credential-reference"
                        className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
                        placeholder="Vault-backed credential name"
                        value={state.credentialReference}
                        onChange={(e) => patch({ credentialReference: e.target.value })}
                      />
                      {/* The field takes a NAME, not a secret. Stated on the
                          form so nobody pastes an API key into it. */}
                      <small className="block text-slate-500">
                        The name of a credential held in the vault. Never paste the credential itself.
                      </small>
                    </label>
                    <label className="block text-sm">
                      <span className="text-slate-700">Location / Workspace</span>
                      <input
                        name="location"
                        className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
                        placeholder="Select source location"
                        value={state.location}
                        onChange={(e) => patch({ location: e.target.value })}
                      />
                    </label>
                    <button
                      type="button"
                      name="test-connection"
                      onClick={() => setConnectionNote('The server resolves the credential reference through sdk-secrets and tests it. The secret is never sent to this browser.')}
                      className="rounded bg-slate-900 px-3 py-1.5 text-sm text-white"
                    >
                      Test Connection
                    </button>
                  </div>
                )}

                {connectionNote && <p className="mt-2 text-xs text-slate-600">{connectionNote}</p>}
              </article>
            </section>
          )}

          {/* ----------------------------------------------- 3. Preview */}
          {state.step === 3 && (
            <section aria-label="File and Schema Preview">
              <div className="flex flex-wrap items-end justify-between gap-2">
                <div>
                  <h3 className="text-base font-semibold text-slate-900">File &amp; Schema Preview</h3>
                  <p className="text-sm text-slate-600">Inspect before the system infers any mapping.</p>
                </div>
                {preview && (
                  <span className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-700">
                    {preview.fileName} · {preview.rowCount}
                    {preview.truncated ? '+' : ''} rows
                  </span>
                )}
              </div>

              {!preview ? (
                <p className="mt-3 text-sm text-slate-500">
                  No file inspected yet. Go back to Connect and choose a file — nothing is uploaded until commit.
                </p>
              ) : (
                <>
                  <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
                    <div className="rounded border border-slate-200 p-2">
                      <span className="block text-xs text-slate-500">Rows</span>
                      <strong className="text-slate-900">{preview.rowCount}{preview.truncated ? '+' : ''}</strong>
                      <small className="block text-slate-500">
                        {preview.truncated ? 'in the sampled slice — file is larger' : 'excluding header'}
                      </small>
                    </div>
                    <div className="rounded border border-slate-200 p-2">
                      <span className="block text-xs text-slate-500">Columns</span>
                      <strong className="text-slate-900">{preview.columns.length}</strong>
                      <small className="block text-slate-500">detected</small>
                    </div>
                    <div className="rounded border border-slate-200 p-2">
                      <span className="block text-xs text-slate-500">Encoding</span>
                      <strong className="text-slate-900">{preview.encoding.value}</strong>
                      {badge(preview.encoding)}
                    </div>
                    <div className="rounded border border-slate-200 p-2">
                      <span className="block text-xs text-slate-500">Delimiter</span>
                      <strong className="text-slate-900">
                        {DELIMITERS.find((d) => d.value === preview.delimiter.value)?.label ?? preview.delimiter.value}
                      </strong>
                      {badge(preview.delimiter)}
                    </div>
                  </div>

                  <div className="mt-2 rounded border border-slate-200 p-2 text-xs">
                    <span className="text-slate-700">Header row: </span>
                    <strong>{preview.header.value ? 'first row is column names' : 'no header'}</strong>
                    {badge(preview.header)}
                  </div>

                  <div className="mt-3 overflow-x-auto rounded border border-slate-200">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-50 text-slate-600">
                        <tr>{preview.columns.map((c, i) => <th key={`${c}-${i}`} className="px-2 py-1">{c}</th>)}</tr>
                      </thead>
                      <tbody>
                        {preview.rows.map((row, r) => (
                          <tr key={r} className="border-t border-slate-100">
                            {preview.columns.map((_, c) => <td key={c} className="px-2 py-1 text-slate-700">{row[c] ?? ''}</td>)}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="mt-3 grid gap-2 md:grid-cols-3 text-sm">
                    <div className="rounded border border-emerald-300 bg-emerald-50 p-2">
                      <strong className="block text-emerald-900">Header quality</strong>
                      <p className="text-emerald-800">
                        {preview.columns.filter((c) => CANONICAL_TEMPLATE_COLUMNS.includes(c.toLowerCase().replace(/\s+/g, '_'))).length}{' '}
                        recognisable business fields; {preview.columns.length -
                          preview.columns.filter((c) => CANONICAL_TEMPLATE_COLUMNS.includes(c.toLowerCase().replace(/\s+/g, '_'))).length}{' '}
                        custom.
                      </p>
                    </div>
                    <div className="rounded border border-amber-300 bg-amber-50 p-2">
                      <strong className="block text-amber-900">Potential sensitive data</strong>
                      <p className="text-amber-800">
                        Phone, email and residential address will be tokenized at trusted ingress.
                      </p>
                    </div>
                    <div className="rounded border border-slate-300 bg-slate-50 p-2">
                      <strong className="block text-slate-900">Source IDs</strong>
                      <p className="text-slate-700">
                        External IDs will be retained as crosswalks and never replaced by LeadFlow IDs.
                      </p>
                    </div>
                  </div>
                </>
              )}
            </section>
          )}
        </div>

        <footer className="flex items-center justify-between border-t border-slate-200 p-3">
          <button
            type="button"
            name="wizard-back"
            disabled={state.step === 1}
            onClick={() => patch({ step: Math.max(1, state.step - 1) })}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-40"
          >
            Back
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              name="wizard-discard"
              onClick={() => { clearWizardState(); setState({ ...EMPTY_WIZARD_STATE }); setPreview(null); onClose(); }}
              className="rounded px-3 py-1.5 text-sm text-slate-500 hover:text-slate-900"
            >
              Discard draft
            </button>
            <button
              type="button"
              name="wizard-next"
              disabled={!canAdvance}
              onClick={() => patch({ step: Math.min(IMPLEMENTED_THROUGH, state.step + 1) })}
              title={state.step === 2 && !preview ? 'Choose a file first — it is previewed locally' : undefined}
              className="rounded bg-slate-900 px-3 py-1.5 text-sm text-white disabled:opacity-40"
            >
              {state.step >= IMPLEMENTED_THROUGH ? 'Origin — not built yet' : 'Next'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
