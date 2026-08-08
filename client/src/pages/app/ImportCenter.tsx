import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  ApiError,
  ImportCenter as ImportCenterData,
  ImportRunDetail,
  ImportRunEvidence,
  ImportRunReport,
  ImportRunSummary,
} from '../../services/api';
import { useToast } from '../../components/feedback/ToastProvider';
import { failureFor } from '../../content/messages';
import {
  IMPORT_SOURCES,
  ORIGIN_ATTESTATION_LABEL,
  RUN_FILTERS,
  RUN_STATUS_PRESENTATION,
  RunFilter,
  RunPresentationStatus,
} from '../../content/importSources';
import { chipClass } from '../../design-system/tokens';
import { ImportWizardModal } from '../../components/app/ImportWizardModal';

/**
 * Import Center — #view-import.
 *
 * ONE FETCH FOR THE WHOLE SCREEN. The server composes the register, the
 * templates and connector availability, and derives the status counts from the
 * same run list it returns, so a filter count can never disagree with the rows
 * beneath it. Fanning out from here would put that drift back and add two round
 * trips to first paint.
 *
 * NOTHING HERE STARTS AN IMPORT. This screen is the register and the review
 * surface; creating a run is the wizard's. That separation is why the reads are
 * gated on `import.run_read` rather than `import.commit` — being allowed to LOOK
 * at an import is not being allowed to APPLY one.
 */

const ROW_ACTION_TITLE: Record<RunPresentationStatus, string> = {
  review: 'Open the run and work through its mapping and candidates',
  complete: 'Compose the completed-run report',
  restricted: 'Read the third-party rights attestation behind this run',
  quarantined: 'Open the run to fix what stopped it',
};

/** Absolute, because an import is a dated event rather than a recent one. */
function when(value: string | null): string {
  if (!value) return '—';
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? '—' : new Date(parsed).toLocaleString();
}

/** Thousands separators, because these are record counts people read aloud. */
const num = (value: number | null | undefined): string =>
  value === null || value === undefined ? '—' : value.toLocaleString();

/**
 * Which runs a segment shows.
 *
 * "Needs review" is deliberately NOT the same as the Review status: a completed
 * run that left steward cases behind still needs somebody, and a quarantined
 * run needs somebody most of all. Equating the segment with the status would
 * hide both behind a label that promises to surface exactly them.
 */
function matchesFilter(run: ImportRunSummary, filter: RunFilter): boolean {
  const status = (run.presentation_status ?? 'review') as RunPresentationStatus;
  switch (filter) {
    case 'In progress':
      return status === 'review';
    case 'Needs review':
      return status === 'quarantined' || (run.review_count ?? 0) > 0;
    case 'Completed':
      return status === 'complete' || status === 'restricted';
    default:
      return true;
  }
}

export default function ImportCenter(): JSX.Element {
  const { notify } = useToast();
  const [data, setData] = useState<ImportCenterData | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<RunFilter>('All runs');

  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ImportRunDetail | null>(null);
  const [report, setReport] = useState<ImportRunReport | null>(null);
  const [evidence, setEvidence] = useState<ImportRunEvidence | null>(null);
  const [evidenceRefused, setEvidenceRefused] = useState<string | null>(null);

  const fail = useCallback(
    (error: unknown) => {
      notify(failureFor(error instanceof ApiError ? error.code : 'INTERNAL_ERROR'));
    },
    [notify]
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.importCenter());
    } catch (error) {
      fail(error);
    } finally {
      setLoading(false);
    }
  }, [fail]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * The one action the row offers, dispatched by status.
   *
   * Open and Fix both land on the drill-in — a quarantined run is opened to be
   * fixed, and the difference is what the operator finds there, not a different
   * screen. Report and Evidence each load their own panel.
   */
  const runAction = useCallback(
    async (run: ImportRunSummary) => {
      const runId = run.run_id;
      if (!runId) return;
      const status = (run.presentation_status ?? 'review') as RunPresentationStatus;

      setOpenRunId(runId);
      setDetail(null);
      setReport(null);
      setEvidence(null);
      setEvidenceRefused(null);

      try {
        setDetail(await api.importRun(runId));
        if (status === 'complete') {
          setReport(await api.importRunReport(runId));
        }
        if (status === 'restricted') {
          try {
            setEvidence(await api.importRunEvidence(runId));
          } catch (error) {
            // The ONE call on this screen that can be refused to somebody who
            // can see everything else, because it is gated more narrowly. A 403
            // is an explanation in place, not a generic error: the operator has
            // done nothing wrong and the screen should say who can.
            if (error instanceof ApiError && error.status === 403) {
              setEvidenceRefused(
                'The rights attestation is restricted to the Data Steward and the Privacy Officer. Everything else on this run stays visible to you.'
              );
            } else {
              throw error;
            }
          }
        }
      } catch (error) {
        fail(error);
      }
    },
    [fail]
  );

  const runs = useMemo(
    () => (data?.runs ?? []).filter((run) => matchesFilter(run, filter)),
    [data, filter]
  );

  /** Availability by connector kind, so a tile can say which it is. */
  const availability = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const source of data?.source_availability ?? []) {
      if (source.kind) map.set(source.kind, source.installed && source.available);
    }
    return map;
  }, [data]);

  const connectorsKnown = data?.upstream_available?.connectors !== false;

  /* The wizard, and which tile opened it. A source tile is a shortcut INTO the
   * wizard rather than a separate flow — the wizard still asks for the source on
   * step 1, it just arrives with the answer already filled in. */
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardSource, setWizardSource] = useState<string | null>(null);
  const openWizard = useCallback((sourceKind: string | null) => {
    setWizardSource(sourceKind);
    setWizardOpen(true);
  }, []);

  return (
    <div className="space-y-8" data-testid="import-center">
      {/* ------------------------------------------------------------ hero */}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl space-y-1">
          <p className="text-xs uppercase tracking-wide text-slate-500">
            Source-Specific Ingestion &amp; Reconciliation
          </p>
          <h1 className="text-2xl font-semibold text-slate-900">Import Center</h1>
          <p className="text-sm text-slate-600">
            Connect a supported source, upload a source-native export, or map any custom CSV. The assistant
            proposes transformations and identity candidates; the importer confirms every governed decision.
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" name="templates" className="rounded border border-slate-300 px-3 py-1.5 text-sm">
            Templates
          </button>
          <button
            type="button"
            name="start-import"
            onClick={() => openWizard(null)}
            className="rounded bg-slate-900 px-3 py-1.5 text-sm text-white"
          >
            Start Import
          </button>
        </div>
      </header>

      {/* ------------------------------------------------------ source grid */}
      <section aria-label="Import sources" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {IMPORT_SOURCES.map((source) => {
          // A file-based source needs no connector, so it is ALWAYS usable —
          // marking vCard unavailable because sdk-connectors was unreachable
          // would be false, and the operator can drag a .vcf in regardless.
          const usable = source.fileBased || availability.get(source.connectorKind ?? source.kind) === true;
          const unknown = !source.fileBased && !connectorsKnown;
          return (
            <article
              key={source.kind}
              data-source={source.kind}
              onClick={() => openWizard(source.kind)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') openWizard(source.kind); }}
              data-available={usable ? 'yes' : unknown ? 'unknown' : 'no'}
              className={`rounded-lg border p-3 ${
                usable ? 'border-slate-200' : 'border-dashed border-slate-300 bg-slate-50'
              }`}
            >
              {source.recommendation && (
                <span className="text-[11px] uppercase tracking-wide text-slate-500">
                  {source.recommendation}
                </span>
              )}
              <h2 className="mt-1 text-sm font-semibold text-slate-900">{source.label}</h2>
              <p className="mt-1 text-xs text-slate-600">{source.description}</p>
              {/* SHOWN AS UNAVAILABLE, NEVER HIDDEN. A missing tile reads as
                  "not supported"; this reads as "not connected yet", which is
                  the only one of the two the operator can act on. */}
              {!usable && (
                <p className="mt-2 text-xs text-amber-700">
                  {unknown ? 'Availability unknown — could not reach connectors.' : 'Not connected yet.'}
                </p>
              )}
            </article>
          );
        })}
      </section>

      {/* ------------------------------------------------------- run table */}
      <section aria-label="Import runs" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Import Runs</h2>
            <p className="text-sm text-slate-600">
              Every run remains reversible until downstream governed actions occur.
            </p>
          </div>
          <label className="text-sm">
            <span className="sr-only">Filter runs</span>
            <select
              name="run-filter"
              value={filter}
              onChange={(event) => setFilter(event.target.value as RunFilter)}
              className="rounded border border-slate-300 px-2 py-1 text-sm"
            >
              {RUN_FILTERS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2">Run</th>
                <th className="px-3 py-2">Source</th>
                <th className="px-3 py-2">Records</th>
                <th className="px-3 py-2">Created / Linked</th>
                <th className="px-3 py-2">Review</th>
                <th className="px-3 py-2">Origin Attestation</th>
                <th className="px-3 py-2">Mapping</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Started by</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={10} className="px-3 py-6 text-slate-500">
                    Loading the register…
                  </td>
                </tr>
              )}
              {!loading && runs.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-3 py-6 text-slate-500">
                    {/*
                      A SHARED STEM, then the reason. "No runs to show" is true in
                      both branches; the sentence after it says WHICH branch, which
                      is the distinction the panel exists to make — an unexplained
                      blank table is the one outcome that would be wrong.

                      The stem is not cosmetic. Without it the only assertable text
                      was one of two mutually exclusive sentences, so a test had to
                      guess which the environment would produce and broke whenever
                      the gateway came up or went down. That is exactly how this
                      wording was arrived at: the scenario failed twice, once on
                      each branch.
                    */}
                    No runs to show —{' '}
                    {data?.upstream_available?.runs === false
                      ? 'could not reach the import store, so the register is unavailable rather than empty.'
                      : `nothing matches “${filter}”.`}
                  </td>
                </tr>
              )}
              {runs.map((run) => {
                const status = (run.presentation_status ?? 'review') as RunPresentationStatus;
                const presentation = RUN_STATUS_PRESENTATION[status];
                const origin = ORIGIN_ATTESTATION_LABEL[run.origin_attestation ?? 'unknown'];
                return (
                  <tr key={run.run_id ?? Math.random()} className="border-t border-slate-100 align-top">
                    <td className="px-3 py-2">
                      <span className="block font-medium text-slate-900">{run.run_id ?? '—'}</span>
                      <span className="block text-xs text-slate-500">{when(run.created_at)}</span>
                    </td>
                    <td className="px-3 py-2 text-slate-700">
                      {run.file_name ?? run.source_kind ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-slate-700">{num(run.row_count)}</td>
                    <td className="px-3 py-2 text-slate-700">
                      {num(run.created_count)} / {num(run.linked_count)}
                    </td>
                    <td className="px-3 py-2 text-slate-700">
                      {status === 'quarantined' && run.exception_count
                        ? `${num(run.exception_count)} invalid`
                        : num(run.review_count)}
                    </td>
                    <td className="px-3 py-2">
                      <span className={`rounded border px-1.5 py-0.5 text-xs ${chipClass(origin.role)}`}>
                        {origin.label}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-slate-700">{run.mapping_template_id ?? 'Draft'}</td>
                    <td className="px-3 py-2">
                      <span className={`rounded border px-1.5 py-0.5 text-xs ${chipClass(presentation.role)}`}>
                        {presentation.label}
                      </span>
                      {run.quarantine_reason && (
                        <span className="mt-1 block text-xs text-amber-700">{run.quarantine_reason}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-slate-700">{run.started_by ?? '—'}</td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        name={`run-action-${run.run_id ?? ''}`}
                        title={ROW_ACTION_TITLE[status]}
                        onClick={() => void runAction(run)}
                        className="rounded border border-slate-300 px-2 py-1 text-xs hover:border-slate-500"
                      >
                        {presentation.action}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* -------------------------------------------------------- templates */}
      <section aria-label="Reusable mapping templates" className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Reusable Mapping Templates</h2>
          <p className="text-sm text-slate-600">
            Versioned schemas, transforms and source crosswalk contracts.
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          {(data?.templates ?? []).map((template) => (
            <article
              key={template.template_id ?? Math.random()}
              className="rounded-lg border border-slate-200 p-3"
              data-template={template.template_id ?? ''}
            >
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-sm font-semibold text-slate-900">
                  {template.name ?? 'Untitled'} v{template.version ?? 1}
                </h3>
                <span
                  className={`rounded border px-1.5 py-0.5 text-xs ${chipClass(
                    template.kind === 'certified' ? 'success' : 'warning'
                  )}`}
                >
                  {template.kind === 'certified' ? 'Certified' : 'Custom'}
                </span>
              </div>
              <p className="mt-2 text-xs text-slate-600">
                {num(template.canonical_field_count)} canonical fields · {num(template.transform_count)}{' '}
                transforms · used {num(template.use_count)} times.
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {/* The crosswalk note the mockup carries. Source ids are kept so
                    a re-import recognises what it already brought in rather than
                    creating a second copy of everybody. */}
                Source crosswalks are preserved, so a re-import links rather than duplicates.
              </p>
              <button
                type="button"
                name={`template-action-${template.template_id ?? ''}`}
                className="mt-3 rounded border border-slate-300 px-2 py-1 text-xs hover:border-slate-500"
              >
                {template.kind === 'certified' ? 'Inspect' : 'Use'}
              </button>
            </article>
          ))}
          {(data?.templates ?? []).length === 0 && (
            <p className="text-sm text-slate-500">
              {data?.upstream_available?.templates === false
                ? 'Could not reach the template library.'
                : 'No mapping templates yet.'}
            </p>
          )}
        </div>
      </section>

      <ImportWizardModal
        open={wizardOpen}
        initialSource={wizardSource}
        onClose={() => { setWizardOpen(false); void load(); }}
      />

      {/* --------------------------------------------------------- drill-in */}
      {openRunId && (
        <section
          aria-label="Run detail"
          data-testid="run-detail"
          className="rounded-lg border border-slate-300 bg-white p-4"
        >
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Run detail</h2>
              <p className="text-xs text-slate-500">{openRunId}</p>
            </div>
            <button
              type="button"
              name="close-run-detail"
              className="text-xs text-slate-500 hover:text-slate-900"
              onClick={() => setOpenRunId(null)}
            >
              Close
            </button>
          </div>

          {detail && (
            <div className="mt-3 space-y-4">
              <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
                <div>
                  <dt className="text-xs text-slate-500">Entities created</dt>
                  <dd className="text-slate-900">{detail.lineage.total}</dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">Already reversed</dt>
                  <dd className="text-slate-900">{detail.lineage.reversed}</dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">Exceptions</dt>
                  {/* "unknown" rather than 0 when the store was unreachable. */}
                  <dd className="text-slate-900">{num(detail.exception_count)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">Rollback</dt>
                  <dd className="text-slate-900">{detail.rollback.available ? 'Open' : 'Closed'}</dd>
                </div>
              </dl>

              <div>
                <h3 className="text-xs font-semibold uppercase text-slate-500">Governance checks</h3>
                {detail.governance.length === 0 ? (
                  <p className="mt-1 text-sm text-slate-500">
                    {/* "No checks ran" and "every check passed" are different
                        states, and for an unreviewed import that difference
                        matters more than anything else on this panel. */}
                    No governance checks recorded — this run has not been dry-run yet.
                  </p>
                ) : (
                  <ul className="mt-1 space-y-1">
                    {detail.governance.map((verdict, index) => (
                      <li key={verdict.check ?? index} className="text-sm">
                        <span className={verdict.passed ? 'text-emerald-700' : 'text-red-700'}>
                          {verdict.passed ? 'Passed' : 'Failed'}
                        </span>{' '}
                        <span className="text-slate-800">{verdict.check ?? 'check'}</span>
                        {verdict.detail && <span className="text-slate-500"> — {verdict.detail}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {report && (
                <div className="rounded border border-slate-200 p-3 text-sm" data-testid="run-report">
                  <h3 className="text-xs font-semibold uppercase text-slate-500">Completed-run report</h3>
                  <p className="mt-1 text-slate-800">
                    Read {num(report.report.rows.read)}, committed {num(report.report.rows.committed)}, excepted{' '}
                    {num(report.report.rows.excepted)}, unaccounted {num(report.report.rows.unaccounted)}.
                  </p>
                </div>
              )}

              {evidenceRefused && (
                <p className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                  {evidenceRefused}
                </p>
              )}

              {evidence && (
                <div className="rounded border border-slate-200 p-3 text-sm" data-testid="run-evidence">
                  <h3 className="text-xs font-semibold uppercase text-slate-500">Rights attestation</h3>
                  <p className="mt-1 text-slate-800">{evidence.evidence.basis}</p>
                  {evidence.attestation_id && (
                    <p className="text-xs text-slate-500">Attestation {evidence.attestation_id}</p>
                  )}
                </div>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
