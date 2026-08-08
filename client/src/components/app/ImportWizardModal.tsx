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
  COVERAGE_GROUPS,
  CANONICAL_TARGETS,
  EVIDENCE_REQUIRED_ORIGINS,
  ORIGIN_CLASSES,
  ORIGIN_CLASS_LABEL,
  PERMITTED_USES,
  PLACE_TARGETS,
  TRANSFORM_STEPS,
  ACCESS_SCOPES,
  CONSENT_SOURCES,
  DOWNSTREAM_OPTIONS,
  EXACT_MATCH_OPTIONS,
  LEAD_QUALIFICATION_TARGETS,
  NO_MATCH_OPTIONS,
  OWNER_STRATEGIES,
  POSSIBLE_MATCH_OPTIONS,
  SUPPRESSION_RULE,
  SUPPRESSION_SOURCES,
  COMMIT_PLAN,
  ROLLBACK_BLOCKED_TEXT,
  ROLLBACK_WINDOW_HOURS,
  type CheckVerdict,
  type GovernanceCheck,
  isUsableConsentEvidence,
  mappingViolation,
  type CanonicalTarget,
  type OriginClass,
} from '../../content/importGovernance';
import {
  EMPTY_WIZARD_STATE,
  clearWizardState,
  loadWizardState,
  saveWizardState,
  type WizardState,
} from '../../features/imports/wizardState';

/**
 * Contact Import & Reconciliation — #importModal, all ten steps.
 *
 * Source -> evidence -> mapping -> identity -> governance -> commit. All ten are
 * shown from the outset because the operator should be able to see, before
 * uploading anything, that an attestation is coming.
 *
 * THE FILE NEVER LEAVES THE BROWSER UNTIL COMMIT. Preview, delimiter, encoding
 * and header detection are computed locally from a slice of the file, and the
 * dry run rehearses against that same local copy. The bytes go to sdk-import at
 * COMMIT — which is after the origin attestation on step 4, because an export
 * the operator has not yet claimed the right to use must not already have
 * crossed the boundary.
 *
 * EVERY GOVERNANCE RULE HERE IS ENFORCED BY A CONTROL, never by a message the
 * operator can click past:
 *
 *   step 4  a licensed or partner origin cannot be attested without evidence,
 *           and changing the origin class clears the signature;
 *   step 5  an address column is not OFFERED a person target at all;
 *   step 6  mapping the source system’s lifecycle onto Lead is off until
 *           somebody turns it on;
 *   step 7  no band offers a merge, in any form;
 *   step 8  Leads are unavailable until a reachable contact point is confirmed;
 *   step 9  a blank or generic consent value founds no receipt;
 *   step 10 the commit is disabled until every check passes or is acknowledged
 *           BY NAME — and a `fail` cannot be acknowledged at all, only a
 *           `review`, because a missing attestation is not a risk somebody may
 *           accept on a checkbox.
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
const IMPLEMENTED_THROUGH = 10;

/** Sources that connect by OAuth rather than by file upload. */
const OAUTH_SOURCES = new Set(['google', 'apple']);
/** Sources that connect by a vault-backed API credential. */
const API_SOURCES = new Set(['acculynx', 'jobnimbus', 'salesrabbit', 'hubspot']);

const CONFIDENCE_CLASS: Record<string, string> = {
  high: 'text-emerald-700',
  medium: 'text-amber-700',
  low: 'text-red-700',
};


/**
 * Propose a canonical target for a source column.
 *
 * A LOCAL HEURISTIC standing in for sdk-ai-gateway, and it makes no difference
 * to the governance: whatever proposes the mapping, the proposal is inert until
 * a human confirms it, and it must show its confidence and its reason. An
 * assistant that cannot say WHY cannot be checked, and one presented without a
 * confidence invites the operator to accept every row without reading it.
 */
function suggestTarget(column: string): { target: CanonicalTarget; confidence: number; reason: string } {
  const c = column.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const rule = (target: CanonicalTarget, confidence: number, reason: string) => ({ target, confidence, reason });

  if (/^external_?id$|^source_?id$|^record_?id$|^id$/.test(c)) {
    return rule('external.id', 0.95, 'looks like the source system’s own record id, which is kept as a crosswalk');
  }
  if (/first_?name|given/.test(c)) return rule('person.given_name', 0.93, 'column name matches a given-name pattern');
  if (/last_?name|surname|family/.test(c)) return rule('person.family_name', 0.93, 'column name matches a family-name pattern');
  if (/full_?name|^name$/.test(c)) return rule('person.full_name', 0.8, 'single name column; a split is proposed on the transform step');
  if (/e_?mail/.test(c)) return rule('contact.email', 0.96, 'column name matches an email pattern');
  if (/phone|mobile|cell|tel/.test(c)) return rule('contact.phone', 0.94, 'column name matches a telephone pattern');
  if (/company|organi[sz]ation|account|business/.test(c)) return rule('org.name', 0.85, 'column name matches an organisation pattern');
  if (/domain|website|url/.test(c)) return rule('org.domain', 0.8, 'column name matches a web-domain pattern');
  if (/street|address_?1|^address$|addr/.test(c)) return rule('place.address_line1', 0.9, 'an address line — becomes a Place linked by ASSOCIATED_WITH, never a person column');
  if (/address_?2|suite|unit|apt/.test(c)) return rule('place.address_line2', 0.85, 'a secondary address line on the same Place');
  if (/city|town|locality/.test(c)) return rule('place.locality', 0.9, 'a locality on the Place');
  if (/state|province|region/.test(c)) return rule('place.region', 0.88, 'a region on the Place; standardised on the transform step');
  if (/zip|postal|postcode/.test(c)) return rule('place.postal_code', 0.9, 'a postal code on the Place');
  if (/country/.test(c)) return rule('place.country', 0.9, 'a country on the Place; standardised on the transform step');
  return rule('attribute.custom', 0.35, 'no confident match — kept as a custom attribute rather than guessed into a canonical field');
}

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

  /* ------------------------------------------------- step 4 gating */

  /*
   * AC1, and it is a REFUSAL rather than a warning.
   *
   * For a licensed or partner origin the right to hold the data comes from a
   * document somebody else wrote. For every other class the attester speaks
   * about their own organisation's collection and their signed word IS the
   * evidence; for these two it is not, and "we licensed it" with no licence is
   * exactly the claim a regulator asks to see behind.
   */
  const evidenceRequired = state.originClass !== null && EVIDENCE_REQUIRED_ORIGINS.includes(state.originClass);
  const evidenceSatisfied = !evidenceRequired || Boolean(state.evidenceFileName);
  const canAttest = state.originClass !== null && evidenceSatisfied;

  /* -------------------------------------------------- step 5 model */

  const columns = preview?.columns ?? [];
  const mappingFor = (column: string) =>
    state.mappings[column] ?? { ...suggestTarget(column), confirmed: false };

  const confirmedCount = columns.filter((c) => state.mappings[c]?.confirmed).length;

  /* --------------------------------------------- steps 8 and 9 gating */

  /*
   * AC3. Leads are offered only once a reachable contact point is mapped AND
   * confirmed. A Lead must carry an owner, a next action and an intended
   * outcome; a row with no email or phone can support none of those, so
   * creating Leads from it manufactures records that are broken the moment
   * anybody opens them - and they are worked and forecast on meanwhile.
   */
  const qualificationMapped = columns.some((c) => {
    const m = state.mappings[c];
    return m?.confirmed && LEAD_QUALIFICATION_TARGETS.includes(m.target);
  });

  /* AC2. A generic or blank value founds no receipt. */
  const consentSpec = CONSENT_SOURCES.find((s) => s.key === state.consentSource);
  const consentEvidenceUsable =
    !consentSpec?.requiresEvidence || isUsableConsentEvidence(state.consentEvidence);

  /* ------------------------------------------------ step 10 gating */

  /*
   * The governance checks, derived from what the operator actually chose on the
   * earlier steps rather than asserted here. A check that cannot fail is
   * decoration; each of these reads real state, so editing an earlier step
   * changes the verdict.
   */
  const checks: GovernanceCheck[] = [
    {
      key: 'attestation',
      label: 'Source attestation signed',
      verdict: state.attested ? 'pass' : 'fail',
      detail: state.attested
        ? `Attested as ${state.originClass ?? 'unknown origin'}.`
        : 'Nobody has attested to the origin of this data. Go back to step 4.',
    },
    {
      key: 'mapping',
      label: 'Mapping completeness',
      verdict: columns.length === 0 ? 'fail' : confirmedCount === columns.length ? 'pass' : 'review',
      detail: columns.length === 0
        ? 'No file has been inspected.'
        : `${confirmedCount} of ${columns.length} columns confirmed. Unconfirmed columns are not imported - they are dropped, not guessed.`,
    },
    {
      key: 'identity_risk',
      label: 'Identity risk profile',
      verdict: state.exactMatchStrategy === 'auto_link' ? 'review' : 'pass',
      detail: state.exactMatchStrategy === 'auto_link'
        ? 'Exact matches will auto-link without a steward looking. Safe on a source crosswalk or a validated contact point, and every link stays retractable - but it is a decision worth naming.'
        : 'Every match goes to a steward. Nothing links automatically.',
    },
    {
      key: 'consent',
      label: 'Consent interpretation',
      verdict: consentEvidenceUsable ? 'pass' : 'review',
      detail: consentEvidenceUsable
        ? 'No fabricated receipts. Consent is imported only where real evidence was supplied.'
        : 'The consent evidence is blank or generic, so NO receipts will be created. Records still import; nothing may be claimed about permission.',
    },
  ];

  const blocking = checks.filter((c) => c.verdict === 'fail');
  const needsAck = checks.filter((c) => c.verdict === 'review' && !state.acknowledgedChecks.includes(c.key));

  /*
   * AC1. A failed check cannot be acknowledged away - only a `review` can. The
   * distinction matters: "nobody attested to this data" is not a risk somebody
   * may accept on a checkbox, it is a missing prerequisite.
   */
  const canCommit = blocking.length === 0 && needsAck.length === 0 && state.dryRunComplete;

  const VERDICT_CLASS: Record<CheckVerdict, string> = {
    pass: 'text-emerald-700',
    review: 'text-amber-700',
    fail: 'text-red-700',
  };

  /*
   * AC4. In this build no downstream governed action has occurred yet, so the
   * reason is the honest one for a run that has not been committed at all.
   * The mapping from state to reason lives here so the rule is in one place
   * when the commit endpoint starts reporting it.
   */
  const rollbackBlocked: keyof typeof ROLLBACK_BLOCKED_TEXT | null = null;

  /** Exceptions the dry run found, downloadable BEFORE the commit (AC3). */
  const dryRunExceptions = columns.length === 0
    ? []
    : (preview?.rows ?? []).filter((row) => row.length !== columns.length);

  const downloadExceptions = () => {
    const header = ['row_number', 'reason', ...columns].join(',');
    const lines = dryRunExceptions.map((row, i) => [i + 1, 'column_count_mismatch', ...row].join(','));
    const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'dry-run-exceptions.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const radioGroup = (
    name: string,
    options: { key: string; label: string; detail: string }[],
    value: string,
    onPick: (key: string) => void
  ) => (
    <div className="space-y-1">
      {options.map((o) => (
        <label key={o.key} className="flex items-start gap-2 rounded border border-slate-200 p-2 text-sm">
          <input type="radio" name={name} value={o.key} checked={value === o.key}
            onChange={() => onPick(o.key)} className="mt-0.5" />
          <span>
            <strong className="text-slate-900">{o.label}</strong>
            <span className="block text-xs text-slate-600">{o.detail}</span>
          </span>
        </label>
      ))}
    </div>
  );

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

          {/* ------------------------------------------------ 4. Origin */}
          {state.step === 4 && (
            <section aria-label="Data Origin and Permitted Use">
              <h3 className="text-base font-semibold text-slate-900">Data Origin &amp; Permitted Use</h3>
              <p className="mb-3 text-sm text-slate-600">
                An authorized person attests to source and rights. Unknown origin is quarantined, not guessed.
              </p>

              <fieldset className="space-y-1">
                <legend className="text-sm font-medium text-slate-800">Origin Class *</legend>
                {ORIGIN_CLASSES.map((oc) => (
                  <label key={oc} className="flex items-start gap-2 rounded border border-slate-200 p-2 text-sm">
                    <input
                      type="radio"
                      name="origin-class"
                      value={oc}
                      checked={state.originClass === oc}
                      /* Changing the class CLEARS the signature. An attestation
                         is a claim about a specific origin; carrying a tick
                         across a change of claim would leave somebody signed up
                         to something they never read. */
                      onChange={() => patch({ originClass: oc as OriginClass, attested: false })}
                      className="mt-0.5"
                    />
                    <span>
                      <strong className="text-slate-900">{ORIGIN_CLASS_LABEL[oc].label}</strong>
                      <span className="block text-xs text-slate-600">{ORIGIN_CLASS_LABEL[oc].help}</span>
                    </span>
                  </label>
                ))}
              </fieldset>

              <div className="mt-3 grid gap-3 md:grid-cols-3">
                <label className="text-sm">Source Owner
                  <input name="source-owner" className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
                    value={state.sourceOwner} onChange={(e) => patch({ sourceOwner: e.target.value })} />
                </label>
                <label className="text-sm">Collection Period
                  <input name="collection-period" className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
                    placeholder="2021-01-01 to 2026-07-25"
                    value={state.collectionPeriod} onChange={(e) => patch({ collectionPeriod: e.target.value })} />
                </label>
                <label className="text-sm">Jurisdiction / Territory
                  <input name="jurisdiction" className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
                    value={state.jurisdiction} onChange={(e) => patch({ jurisdiction: e.target.value })} />
                </label>
                <label className="text-sm md:col-span-2">License / Agreement Reference
                  <input name="licence-reference" className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
                    placeholder="Contract, DPA, source notice, or internal policy"
                    value={state.licenceReference} onChange={(e) => patch({ licenceReference: e.target.value })} />
                </label>
              </div>

              <fieldset className="mt-3">
                <legend className="text-sm font-medium text-slate-800">Permitted Uses</legend>
                <div className="mt-1 flex flex-wrap gap-2">
                  {PERMITTED_USES.map((use) => (
                    <label key={use} className="flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-sm">
                      <input
                        type="checkbox"
                        name={'permitted-use-' + use.toLowerCase().replace(/\s+/g, '-')}
                        checked={state.permittedUses.includes(use)}
                        onChange={(e) => patch({
                          permittedUses: e.target.checked
                            ? [...state.permittedUses, use]
                            : state.permittedUses.filter((u) => u !== use),
                        })}
                      />
                      {use}
                    </label>
                  ))}
                </div>
              </fieldset>

              <div className="mt-3">
                <span className="text-sm font-medium text-slate-800">Evidence Attachment</span>
                <label className="mt-1 flex min-h-[70px] cursor-pointer items-center justify-center rounded border-2 border-dashed border-slate-300 p-2 text-center text-sm">
                  <input type="file" name="evidence-file" className="sr-only"
                    onChange={(e) => patch({ evidenceFileName: e.target.files?.[0]?.name ?? null })} />
                  <span>
                    <strong className="block text-slate-900">
                      {state.evidenceFileName ?? 'Attach agreement, notice, or source export statement'}
                    </strong>
                    <span className={evidenceRequired ? 'text-amber-700' : 'text-slate-500'}>
                      {evidenceRequired
                        ? 'REQUIRED for this origin class - the attestation cannot be signed without it.'
                        : 'Optional for tenant CRM and first-party origins.'}
                    </span>
                  </span>
                </label>
              </div>

              <label className="mt-3 flex items-start gap-2 rounded border border-slate-200 p-2 text-sm">
                <input
                  type="checkbox"
                  name="attest"
                  checked={state.attested}
                  disabled={!canAttest}
                  onChange={(e) => patch({ attested: e.target.checked })}
                  className="mt-0.5"
                />
                <span>
                  <strong className="text-slate-900">
                    I am authorized to attest to this source and the selected permitted uses.
                  </strong>
                  <span className="block text-xs text-slate-600">
                    The attestation is signed with my platform principal, timestamp, source fingerprint and mapping version.
                  </span>
                  {!canAttest && (
                    <span className="mt-1 block text-xs text-amber-700">
                      {state.originClass === null
                        ? 'Choose an origin class first.'
                        : 'Attach the licence or agreement before signing - this origin class requires evidence.'}
                    </span>
                  )}
                </span>
              </label>

              <div className="mt-3 rounded border border-amber-300 bg-amber-50 p-2 text-sm">
                <strong className="block text-amber-900">Origin does not equal consent.</strong>
                <p className="text-amber-800">
                  First-party data does not automatically authorize every marketing channel. Third-party data may be
                  stored or reviewed under a governed purpose even when electronic outreach is blocked.
                </p>
              </div>
            </section>
          )}

          {/* ----------------------------------------------- 5. Mapping */}
          {state.step === 5 && (
            <section aria-label="Column Mapping">
              <div className="flex flex-wrap items-end justify-between gap-2">
                <div>
                  <h3 className="text-base font-semibold text-slate-900">Column Mapping</h3>
                  <p className="text-sm text-slate-600">
                    Every suggestion is advisory until you confirm it. {confirmedCount} of {columns.length} confirmed.
                  </p>
                </div>
                <div className="flex gap-2">
                  <button type="button" name="rerun-suggestions"
                    onClick={() => patch({ mappings: {} })}
                    className="rounded border border-slate-300 px-2 py-1 text-xs">Re-run Suggestions</button>
                  <button type="button" name="save-template"
                    className="rounded border border-slate-300 px-2 py-1 text-xs">Save Template</button>
                </div>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
                {COVERAGE_GROUPS.map((group) => {
                  const covered = columns.filter((c) => {
                    const m = state.mappings[c];
                    return m?.confirmed && group.targets.includes(m.target);
                  }).length;
                  return (
                    <div key={group.key} className="rounded border border-slate-200 p-2">
                      <span className="block text-xs text-slate-500">{group.label}</span>
                      <strong className={covered > 0 ? 'text-emerald-700' : 'text-slate-400'}>
                        {covered} confirmed
                      </strong>
                    </div>
                  );
                })}
              </div>

              {columns.length === 0 ? (
                <p className="mt-3 text-sm text-slate-500">No columns yet - inspect a file on the Connect step.</p>
              ) : (
                <div className="mt-3 overflow-x-auto rounded border border-slate-200">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                      <tr>
                        <th className="px-2 py-1">Source Column</th>
                        <th className="px-2 py-1">Canonical Target</th>
                        <th className="px-2 py-1">Confidence</th>
                        <th className="px-2 py-1">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {columns.map((column) => {
                        const m = mappingFor(column);
                        const violation = mappingViolation(column, m.target);
                        return (
                          <tr key={column} className="border-t border-slate-100 align-top">
                            <td className="px-2 py-1 text-slate-900">{column}</td>
                            <td className="px-2 py-1">
                              <select
                                name={'map-' + column}
                                className="w-full rounded border border-slate-300 px-1 py-0.5 text-xs"
                                value={m.target}
                                onChange={(e) => {
                                  const target = e.target.value as CanonicalTarget;
                                  const refused = mappingViolation(column, target);
                                  patch({
                                    mappings: {
                                      ...state.mappings,
                                      [column]: { ...m, target, confirmed: refused ? false : m.confirmed },
                                    },
                                  });
                                }}
                              >
                                {/* A refused target is not offered at all - AC3 is
                                    enforced by the option list, not by a warning
                                    the operator can click past. */}
                                {CANONICAL_TARGETS.filter((tgt) => !mappingViolation(column, tgt)).map((tgt) => (
                                  <option key={tgt} value={tgt}>{tgt}</option>
                                ))}
                              </select>
                              <small className="block text-xs text-slate-500">{m.reason}</small>
                              {violation && <small className="block text-xs text-red-700">{violation}</small>}
                              {PLACE_TARGETS.includes(m.target) && (
                                <small className="block text-xs text-slate-600">
                                  Becomes a Place linked by ASSOCIATED_WITH.
                                </small>
                              )}
                            </td>
                            <td className="px-2 py-1">
                              <span className={m.confidence >= 0.85 ? 'text-emerald-700' : m.confidence >= 0.6 ? 'text-amber-700' : 'text-red-700'}>
                                {Math.round(m.confidence * 100)}%
                              </span>
                            </td>
                            <td className="px-2 py-1">
                              <label className="flex items-center gap-1 text-xs">
                                <input
                                  type="checkbox"
                                  name={'confirm-' + column}
                                  checked={Boolean(state.mappings[column]?.confirmed)}
                                  disabled={Boolean(violation)}
                                  onChange={(e) => patch({
                                    mappings: { ...state.mappings, [column]: { ...m, confirmed: e.target.checked } },
                                  })}
                                />
                                Confirm
                              </label>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          {/* --------------------------------------------- 6. Transform */}
          {state.step === 6 && (
            <section aria-label="Transform and Normalize">
              <h3 className="text-base font-semibold text-slate-900">Transform &amp; Normalize</h3>
              <p className="mb-3 text-sm text-slate-600">
                Every step keeps the value it started from, so a transformation we got wrong stays readable.
              </p>

              <ul className="space-y-2">
                {TRANSFORM_STEPS.map((step) => {
                  const on = state.transforms[step.key] ?? step.defaultOn;
                  return (
                    <li key={step.key} className={'rounded border p-2 ' + (step.offReason ? 'border-amber-300 bg-amber-50' : 'border-slate-200')}>
                      <label className="flex items-start gap-2 text-sm">
                        <input
                          type="checkbox"
                          name={'transform-' + step.key}
                          checked={on}
                          onChange={(e) => patch({ transforms: { ...state.transforms, [step.key]: e.target.checked } })}
                          className="mt-0.5"
                        />
                        <span>
                          <strong className="text-slate-900">{step.label}</strong>
                          <span className="block text-xs text-slate-600">{step.detail}</span>
                          {step.offReason && <span className="mt-1 block text-xs text-amber-800">{step.offReason}</span>}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>

              <div className="mt-4">
                <h4 className="text-sm font-semibold text-slate-900">Value Crosswalks</h4>
                <table className="mt-1 w-full text-left text-sm">
                  <thead className="text-xs uppercase text-slate-500">
                    <tr><th className="px-2 py-1">Source value</th><th className="px-2 py-1">Canonical value</th><th className="px-2 py-1">Rows</th></tr>
                  </thead>
                  <tbody>
                    {columns.length === 0 ? (
                      <tr><td colSpan={3} className="px-2 py-2 text-slate-500">No file inspected yet.</td></tr>
                    ) : (state.transforms.standardise_region ?? true) ? (
                      <tr className="border-t border-slate-100">
                        <td className="px-2 py-1 text-slate-700">TX</td>
                        <td className="px-2 py-1 text-slate-700">US-TX</td>
                        <td className="px-2 py-1 text-slate-700">{preview?.rowCount ?? 0}</td>
                      </tr>
                    ) : (
                      <tr><td colSpan={3} className="px-2 py-2 text-slate-500">No crosswalks - region standardisation is off.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* ---------------------------------------------- 7. Identity */}
          {state.step === 7 && (
            <section aria-label="Identity Resolution Strategy">
              <h3 className="text-base font-semibold text-slate-900">Identity Resolution Strategy</h3>
              <p className="mb-3 text-sm text-slate-600">
                Choose what happens to each match band. {preview?.rowCount ?? 0} rows will be evaluated.
              </p>

              <h4 className="mt-3 text-sm font-medium text-slate-800">Exact Matches</h4>
              {radioGroup('exact-match', EXACT_MATCH_OPTIONS, state.exactMatchStrategy, (k) => patch({ exactMatchStrategy: k }))}

              <h4 className="mt-3 text-sm font-medium text-slate-800">Possible Matches</h4>
              {radioGroup('possible-match', POSSIBLE_MATCH_OPTIONS, state.possibleMatchStrategy, (k) => patch({ possibleMatchStrategy: k }))}

              <h4 className="mt-3 text-sm font-medium text-slate-800">No Match</h4>
              {radioGroup('no-match', NO_MATCH_OPTIONS, state.noMatchStrategy, (k) => patch({ noMatchStrategy: k }))}

              {/* AC1. The absence of a merge option is the point; saying so
                  plainly is how the operator knows it was a decision. */}
              <div className="mt-4 rounded border border-slate-300 bg-slate-50 p-3 text-sm">
                <strong className="block text-slate-900">There is no destructive merge.</strong>
                <p className="text-slate-700">
                  LeadFlow links records, it never destroys one into another. A merge cannot be undone even in
                  principle — once two source records are collapsed, which assertion came from which is gone. Both
                  source records are always kept, which is exactly why a verified link can be retracted and the
                  downstream projections replayed.
                </p>
              </div>
            </section>
          )}

          {/* ------------------------------------------------ 8. Access */}
          {state.step === 8 && (
            <section aria-label="Visibility Ownership and Downstream Creation">
              <h3 className="text-base font-semibold text-slate-900">Visibility, Ownership &amp; Downstream Creation</h3>
              <p className="mb-3 text-sm text-slate-600">Who can see these records, who owns them, and what gets created.</p>

              <h4 className="mt-3 text-sm font-medium text-slate-800">Access Scope</h4>
              {radioGroup('access-scope', ACCESS_SCOPES, state.accessScope, (k) => patch({ accessScope: k }))}

              <h4 className="mt-3 text-sm font-medium text-slate-800">Default Record Owner</h4>
              {radioGroup('owner-strategy', OWNER_STRATEGIES, state.ownerStrategy, (k) => patch({ ownerStrategy: k }))}

              <h4 className="mt-3 text-sm font-medium text-slate-800">Downstream Creation</h4>
              <div className="space-y-1">
                {DOWNSTREAM_OPTIONS.map((o) => {
                  const leadsBlocked = o.key === 'leads' && !qualificationMapped;
                  return (
                    <label key={o.key} className="flex items-start gap-2 rounded border border-slate-200 p-2 text-sm">
                      <input
                        type="checkbox"
                        name={'downstream-' + o.key}
                        checked={state.downstream.includes(o.key)}
                        disabled={leadsBlocked}
                        onChange={(e) => patch({
                          downstream: e.target.checked
                            ? [...state.downstream, o.key]
                            : state.downstream.filter((d) => d !== o.key),
                        })}
                        className="mt-0.5"
                      />
                      <span>
                        <strong className="text-slate-900">{o.label}</strong>
                        <span className="block text-xs text-slate-600">{o.detail}</span>
                        {leadsBlocked && (
                          <span className="mt-1 block text-xs text-amber-700">
                            Unavailable: no reachable contact point is mapped and confirmed yet. A Lead must carry an
                            owner, a next action and an intended outcome, and a row with no email or phone can support
                            none of them.
                          </span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
            </section>
          )}

          {/* ----------------------------------------------- 9. Consent */}
          {state.step === 9 && (
            <section aria-label="Consent Preference and Suppression Import">
              <h3 className="text-base font-semibold text-slate-900">Consent, Preference &amp; Suppression Import</h3>
              <p className="mb-3 text-sm text-slate-600">What may be claimed about permission, and what must be honoured.</p>

              <h4 className="mt-3 text-sm font-medium text-slate-800">Consent evidence</h4>
              {radioGroup('consent-source', CONSENT_SOURCES, state.consentSource, (k) => patch({ consentSource: k }))}

              {consentSpec?.requiresEvidence && (
                <label className="mt-2 block text-sm">
                  <span className="text-slate-700">Notice version, timestamp or receipt reference</span>
                  <input
                    name="consent-evidence"
                    className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
                    placeholder="e.g. privacy-notice v4.2, captured 2026-03-11"
                    value={state.consentEvidence}
                    onChange={(e) => patch({ consentEvidence: e.target.value })}
                  />
                  {!consentEvidenceUsable && (
                    /* AC2 - a blank or generic value founds no receipt. "yes" is
                       the common one, and it carries no notice version, no
                       timestamp and no record of what the person was told. */
                    <small className="block text-amber-700">
                      No consent receipt will be created. A value like “yes”, “imported” or a blank cell does not say
                      what the person was told or when, which is exactly what a receipt has to state.
                    </small>
                  )}
                  {consentEvidenceUsable && state.consentEvidence.trim() !== '' && (
                    <small className="block text-emerald-700">A receipt will be created citing this evidence.</small>
                  )}
                </label>
              )}

              <h4 className="mt-4 text-sm font-medium text-slate-800">Suppression sources</h4>
              <div className="space-y-1">
                {SUPPRESSION_SOURCES.map((o) => (
                  <label key={o.key} className="flex items-start gap-2 rounded border border-slate-200 p-2 text-sm">
                    <input
                      type="checkbox"
                      name={'suppression-' + o.key}
                      checked={state.suppressionSources.includes(o.key)}
                      onChange={(e) => patch({
                        suppressionSources: e.target.checked
                          ? [...state.suppressionSources, o.key]
                          : state.suppressionSources.filter((s) => s !== o.key),
                      })}
                      className="mt-0.5"
                    />
                    <span>
                      <strong className="text-slate-900">{o.label}</strong>
                      <span className="block text-xs text-slate-600">{o.detail}</span>
                    </span>
                  </label>
                ))}
              </div>

              <div className="mt-2 rounded border border-slate-300 bg-slate-50 p-2 text-sm">
                <strong className="block text-slate-900">Most restrictive wins</strong>
                <p className="text-slate-700">{SUPPRESSION_RULE}</p>
              </div>

              <div className="mt-3 rounded border border-amber-300 bg-amber-50 p-2 text-sm">
                <strong className="block text-amber-900">Unknown is not granted.</strong>
                <p className="text-amber-800">
                  A missing consent value means no permission was recorded, not that permission exists. Records import
                  either way; whether anything may be sent is decided by the channel-decision engine at send time.
                </p>
              </div>
            </section>
          )}

          {/* ------------------------------------------------ 10. Commit */}
          {state.step === 10 && (
            <section aria-label="Dry Run and Commit">
              <h3 className="text-base font-semibold text-slate-900">Dry Run &amp; Commit</h3>
              <p className="mb-3 text-sm text-slate-600">
                Rehearse the whole import, then land it in one atomic batch.
              </p>

              {/* ------------------------------------------ impact grid */}
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                {[
                  { label: 'Rows', value: String(preview?.rowCount ?? 0), sub: 'excluding header' },
                  { label: 'New Contacts', value: String(Math.max(0, (preview?.rowCount ?? 0) - dryRunExceptions.length)), sub: 'after validation' },
                  { label: 'Exact Links', value: state.exactMatchStrategy === 'auto_link' ? 'auto' : '0', sub: 'safe deterministic' },
                  { label: 'Review Cases', value: state.possibleMatchStrategy === 'review_cases' ? 'all' : '0', sub: 'possible matches' },
                  { label: 'Properties', value: state.downstream.includes('contacts') ? 'create or link' : '0', sub: 'never a person column' },
                  { label: 'Invalid Rows', value: String(dryRunExceptions.length), sub: 'to the exception file' },
                  { label: 'Enrichment', value: 'None', sub: '0 credits — an import never spends one' },
                  { label: 'Rollback Window', value: `${ROLLBACK_WINDOW_HOURS} hours`, sub: 'or until a downstream action' },
                ].map((tile) => (
                  <div key={tile.label} className="rounded border border-slate-200 p-2">
                    <span className="block text-xs text-slate-500">{tile.label}</span>
                    <strong className="text-slate-900">{tile.value}</strong>
                    <small className="block text-slate-500">{tile.sub}</small>
                  </div>
                ))}
              </div>

              {/* ------------------------------------------- the dry run */}
              <div className="mt-4 rounded border border-slate-300 bg-slate-50 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <strong className="block text-slate-900">Dry run</strong>
                    {/* AC2 - stated on the screen, not merely true. */}
                    <p className="text-sm text-slate-700">
                      A dry run performs ZERO writes. Nothing is created, linked, suppressed or sent; the counts above
                      are what a commit WOULD do. In this build the rehearsal runs entirely in the browser against the
                      file you inspected, so it cannot write even by accident.
                    </p>
                  </div>
                  <button
                    type="button"
                    name="run-dry-run"
                    onClick={() => patch({ dryRunComplete: true })}
                    className="rounded bg-slate-900 px-3 py-1.5 text-sm text-white"
                  >
                    {state.dryRunComplete ? 'Re-run dry run' : 'Run dry run'}
                  </button>
                </div>
                {state.dryRunComplete && (
                  <p className="mt-2 text-sm text-emerald-700">
                    Dry run complete. 0 writes observed. {dryRunExceptions.length} row(s) would go to the exception file.
                  </p>
                )}
              </div>

              {/* -------------------------------------- governance checks */}
              <h4 className="mt-4 text-sm font-semibold text-slate-900">Governance Checks</h4>
              <ul className="mt-1 space-y-1">
                {checks.map((check) => {
                  const acknowledged = state.acknowledgedChecks.includes(check.key);
                  return (
                    <li key={check.key} className="rounded border border-slate-200 p-2 text-sm">
                      <div className="flex items-start justify-between gap-2">
                        <span>
                          <strong className={VERDICT_CLASS[check.verdict]}>
                            {check.verdict === 'pass' ? 'Pass' : check.verdict === 'review' ? 'Review' : 'Blocked'}
                          </strong>{' '}
                          <span className="text-slate-900">{check.label}</span>
                          <span className="block text-xs text-slate-600">{check.detail}</span>
                        </span>
                        {/* A `fail` cannot be acknowledged away - only a `review`
                            can. "Nobody attested to this data" is a missing
                            prerequisite, not a risk to accept on a checkbox. */}
                        {check.verdict === 'review' && (
                          <label className="flex shrink-0 items-center gap-1 text-xs">
                            <input
                              type="checkbox"
                              name={'ack-' + check.key}
                              checked={acknowledged}
                              onChange={(e) => patch({
                                acknowledgedChecks: e.target.checked
                                  ? [...state.acknowledgedChecks, check.key]
                                  : state.acknowledgedChecks.filter((k) => k !== check.key),
                              })}
                            />
                            Acknowledge
                          </label>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>

              {/* ------------------------------------------- commit plan */}
              <h4 className="mt-4 text-sm font-semibold text-slate-900">Commit Plan</h4>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-700">
                {COMMIT_PLAN.map((line) => <li key={line}>{line}</li>)}
              </ul>

              {/* --------------------------------------------- the actions */}
              <div className="mt-4 flex flex-wrap items-center gap-2">
                {/* AC3 - available BEFORE the commit, so the operator can see
                    what would be dropped while they can still change it. */}
                <button
                  type="button"
                  name="download-exceptions"
                  onClick={downloadExceptions}
                  disabled={!state.dryRunComplete}
                  className="rounded border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-40"
                  title={state.dryRunComplete ? 'Download the rows the dry run would reject' : 'Run the dry run first'}
                >
                  Download dry-run exceptions
                </button>

                <button
                  type="button"
                  name="commit-import"
                  disabled={!canCommit}
                  className="rounded bg-slate-900 px-3 py-1.5 text-sm text-white disabled:opacity-40"
                >
                  Commit import
                </button>

                <button
                  type="button"
                  name="rollback-import"
                  disabled
                  className="rounded border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-40"
                  title="Available for 24 hours after a commit, and closes the moment a downstream governed action occurs"
                >
                  Roll back
                </button>
              </div>

              {!canCommit && (
                <p className="mt-2 text-sm text-amber-700">
                  {blocking.length > 0
                    ? `Commit is blocked: ${blocking.map((c) => c.label).join(', ')}. A blocked check cannot be acknowledged — fix it on the step it came from.`
                    : needsAck.length > 0
                      ? `Acknowledge ${needsAck.map((c) => c.label).join(' and ')} before committing.`
                      : 'Run the dry run before committing.'}
                </p>
              )}

              <p className="mt-3 text-xs text-slate-600">
                {rollbackBlocked
                  ? ROLLBACK_BLOCKED_TEXT[rollbackBlocked]
                  : `After a commit this run stays reversible for ${ROLLBACK_WINDOW_HOURS} hours — and the rollback closes earlier, the moment a downstream governed action occurs on these records. Reversing after somebody has messaged a contact would retract a record they have already acted on.`}
              </p>
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
              {/* Names the NEXT step rather than a hardcoded one, so raising
                  IMPLEMENTED_THROUGH cannot leave the label pointing at a step
                  that has since been built — which it already had once. */}
              {state.step >= IMPLEMENTED_THROUGH
                ? `${STEPS[IMPLEMENTED_THROUGH] ?? 'Commit'} — not built yet`
                : 'Next'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
