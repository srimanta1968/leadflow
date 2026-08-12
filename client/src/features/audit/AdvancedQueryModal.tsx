import { useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type AuditQueryResult,
  type EvidenceFilters,
  type SavedAuditQuery,
  type SavedQueryVisibility,
} from '../../services/api';
import { Modal } from '../../design-system/overlays/Modal';

/**
 * Advanced query — evidence across the twelve correlation dimensions.
 *
 * THE SUBJECT FIELD ON THE SCREEN BEHIND THIS ANSWERS ONE QUESTION: "what
 * happened to this record". An audit rarely starts there. It starts with "what
 * did this person do", "what ran under this trace", "what did we deny for this
 * purpose last quarter" — none of which name a subject, and all of which are a
 * filter over the same chain.
 *
 * THE CHAIN VERDICT IS SHOWN WITH THE RESULTS, NOT INSTEAD OF THEM. The server
 * returns `chain.state` on every response precisely because a broken chain and
 * an unreachable verifier are opposite instructions — stop trusting these rows,
 * versus try again later — and rows displayed without that verdict invite the
 * reader to assume the first is the second.
 *
 * VISIBILITY IS CHOSEN, NEVER DEFAULTED, when saving. Private is the safe
 * direction for disclosure and the wrong one for intent: somebody who meant to
 * share with their team would believe they had, and nobody would ever see it.
 * The server refuses an absent visibility for that reason; this offers no
 * pre-selection so the refusal never has to fire.
 */

/** label, key, and the placeholder that says what the value looks like. */
const FIELDS: { key: keyof EvidenceFilters; label: string; placeholder: string }[] = [
  { key: 'actor', label: 'Actor', placeholder: 'persona or user id' },
  { key: 'persona_role', label: 'Persona role', placeholder: 'sales_rep, data_steward…' },
  { key: 'purpose', label: 'Purpose', placeholder: 'inspection_estimate…' },
  { key: 'policy_version', label: 'Policy version', placeholder: 'bundle version in force' },
  { key: 'consent_epoch', label: 'Consent epoch', placeholder: 'epoch it was evaluated against' },
  { key: 'entity_ref', label: 'Entity reference', placeholder: 'contact:… / lead:…' },
  { key: 'case_id', label: 'Case id', placeholder: 'review or incident case' },
  { key: 'import_run_id', label: 'Import run id', placeholder: 'the run that wrote it' },
  { key: 'trace_id', label: 'Trace id', placeholder: 'correlates one act across services' },
];

/* Rejected by the server rather than ignored: dropping an unrecognised outcome
   would return EVERY governed action to somebody who asked for the refusals. */
const OUTCOMES = ['permitted', 'denied', 'approval_required'] as const;

const VISIBILITIES: { value: SavedQueryVisibility; label: string; hint: string }[] = [
  { value: 'private', label: 'Private', hint: 'only you' },
  { value: 'role', label: 'Role', hint: 'everyone holding your role' },
  { value: 'tenant', label: 'Tenant', hint: 'everyone in this tenant' },
];

const CHAIN_TONE: Record<string, string> = {
  verified: 'text-ok',
  broken: 'text-danger',
  unknown: 'text-warn',
};

const CHAIN_MEANING: Record<string, string> = {
  verified: 'The chain segment covering these rows verifies. They can be quoted.',
  broken: 'The chain is BROKEN over this range. Do not quote these rows until it is explained.',
  unknown: 'The verifier could not be reached, so the chain is unproven — not disproven. Try again.',
};

export function AdvancedQueryModal({
  open,
  onClose,
  onUseSubject,
}: {
  open: boolean;
  onClose: () => void;
  /** Hand an entity reference back to the screen, so a hit becomes a timeline. */
  onUseSubject?: (subjectRef: string) => void;
}) {
  const [filters, setFilters] = useState<EvidenceFilters>({});
  const [result, setResult] = useState<AuditQueryResult | null>(null);
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const [saved, setSaved] = useState<SavedAuditQuery[]>([]);
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<SavedQueryVisibility | ''>('');
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  const set = (key: keyof EvidenceFilters, value: string) =>
    setFilters((current) => {
      const next = { ...current };
      if (value.trim() === '') delete next[key];
      else next[key] = value.trim();
      return next;
    });

  const loadSaved = useCallback(async () => {
    try {
      const answer = await api.savedAuditQueries();
      setSaved(answer.queries ?? []);
    } catch {
      // A saved-query list that cannot be read must not block running a query —
      // the list is a convenience, the query is the point.
      setSaved([]);
    }
  }, []);

  useEffect(() => {
    if (open) void loadSaved();
  }, [open, loadSaved]);

  const active = Object.keys(filters).length;

  const run = async () => {
    setRunning(true);
    setFailure(null);
    setSavedNote(null);
    try {
      setResult(await api.auditQuery({ filters }));
    } catch (caught) {
      setResult(null);
      setFailure(caught instanceof ApiError ? caught.message : 'The query could not be run.');
    } finally {
      setRunning(false);
    }
  };

  const save = async () => {
    if (name.trim() === '' || visibility === '') return;
    setSaving(true);
    setFailure(null);
    try {
      await api.saveAuditQuery({ name: name.trim(), visibility, filters });
      setSavedNote(`Saved as "${name.trim()}".`);
      setName('');
      setVisibility('');
      await loadSaved();
    } catch (caught) {
      setFailure(caught instanceof ApiError ? caught.message : 'The query could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Advanced query"
      subtitle="Evidence filtered across actor, purpose, policy, consent epoch and trace — not one subject at a time."
      size="lg"
      footer={
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-soft">
            {active === 0 ? 'No filters — this would return the whole window.' : `${active} filter${active === 1 ? '' : 's'} applied.`}
          </span>
          <div className="flex gap-2">
            <button type="button" name="close_advanced_query" onClick={onClose} className="lf-btn-secondary px-4 py-2">
              Close
            </button>
            <button
              type="button"
              name="run_advanced_query"
              disabled={running || active === 0}
              onClick={() => void run()}
              className="lf-btn-primary px-4 py-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {running ? 'Running...' : 'Run query'}
            </button>
          </div>
        </div>
      }
    >
      <div className="space-y-5">
        {saved.length > 0 && (
          <div>
            <span className="lf-label block">Saved queries</span>
            <div className="mt-2 flex flex-wrap gap-2">
              {saved.map((q) => (
                <button
                  key={q.query_id}
                  type="button"
                  name={`load_saved_query_${q.query_id}`}
                  onClick={() => {
                    setFilters(q.filters ?? {});
                    setResult(null);
                    setSavedNote(null);
                  }}
                  className="lf-btn-secondary px-3 py-1.5 text-xs"
                  title={`${q.visibility} · saved ${q.created_at}`}
                >
                  {q.name}
                  <span className="ml-1.5 text-soft">({q.visibility})</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          {FIELDS.map((field) => (
            <div key={field.key}>
              <label className="lf-label block" htmlFor={`aq_${field.key}`}>
                {field.label}
              </label>
              <input
                id={`aq_${field.key}`}
                name={field.key}
                className="lf-input mt-1 w-full"
                placeholder={field.placeholder}
                value={filters[field.key] ?? ''}
                onChange={(e) => set(field.key, e.target.value)}
              />
            </div>
          ))}

          <div>
            <label className="lf-label block" htmlFor="aq_decision_outcome">
              Decision outcome
            </label>
            <select
              id="aq_decision_outcome"
              name="decision_outcome"
              className="lf-input mt-1 w-full"
              value={filters.decision_outcome ?? ''}
              onChange={(e) => set('decision_outcome', e.target.value)}
            >
              <option value="">Any outcome</option>
              {OUTCOMES.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="lf-label block" htmlFor="aq_from">
                From
              </label>
              <input
                id="aq_from"
                name="from"
                type="datetime-local"
                className="lf-input mt-1 w-full"
                value={filters.from ?? ''}
                onChange={(e) => set('from', e.target.value)}
              />
            </div>
            <div>
              <label className="lf-label block" htmlFor="aq_to">
                To
              </label>
              <input
                id="aq_to"
                name="to"
                type="datetime-local"
                className="lf-input mt-1 w-full"
                value={filters.to ?? ''}
                onChange={(e) => set('to', e.target.value)}
              />
            </div>
          </div>
        </div>

        {failure && (
          <p role="alert" className="text-sm text-danger">
            {failure}
          </p>
        )}

        {result && (
          <div className="space-y-3 border-t border-line pt-4">
            <div>
              <p className={`text-sm font-semibold ${CHAIN_TONE[result.chain.state] ?? 'text-text'}`}>
                Chain {result.chain.state}
                {result.chain.entries_checked !== null && ` · ${result.chain.entries_checked} entries checked`}
              </p>
              <p className="mt-0.5 text-xs text-muted">
                {CHAIN_MEANING[result.chain.state] ?? ''}
                {result.chain.break_reason ? ` ${result.chain.break_reason}` : ''}
              </p>
            </div>

            <p className="text-sm text-text">
              {result.result_count} result{result.result_count === 1 ? '' : 's'}
              {typeof result.total === 'number' && result.total !== result.result_count
                ? ` of ${result.total}`
                : ''}
              {result.upstream_available.search ? '' : ' — search was unreachable, so this may be incomplete.'}
            </p>

            {result.trace && (
              <p className="text-xs text-muted">
                Trace {result.trace.trace_id}: {result.trace.span_count} span
                {result.trace.span_count === 1 ? '' : 's'}
                {result.trace.available ? '' : ' (trace store unreachable)'}
              </p>
            )}

            <div className="max-h-64 overflow-y-auto rounded border border-line">
              {result.results.length === 0 ? (
                <p className="p-3 text-sm text-muted">Nothing matched. The filters held, the window was empty.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {result.results.map((row, i) => {
                    const ref = String(row.entity_ref ?? row.subject_ref ?? '');
                    return (
                      <li key={String(row.event_id ?? i)} className="flex items-start justify-between gap-3 p-2.5">
                        <div className="min-w-0">
                          <p className="truncate text-sm text-text">
                            {String(row.title ?? row.event_type ?? 'Event')}
                          </p>
                          <p className="truncate text-xs text-soft">
                            {[row.actor, row.occurred_at, ref].filter(Boolean).join(' · ') || 'No detail recorded'}
                          </p>
                        </div>
                        {ref !== '' && onUseSubject && (
                          <button
                            type="button"
                            name="open_in_timeline"
                            onClick={() => {
                              onUseSubject(ref);
                              onClose();
                            }}
                            className="lf-btn-secondary shrink-0 px-2.5 py-1 text-xs"
                          >
                            Timeline
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        )}

        <div className="space-y-2 border-t border-line pt-4">
          <span className="lf-label block">Save this query</span>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-48 flex-1">
              <input
                id="aq_name"
                name="saved_query_name"
                className="lf-input w-full"
                placeholder="Name it for whoever runs it next"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <select
              id="aq_visibility"
              name="saved_query_visibility"
              className="lf-input"
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as SavedQueryVisibility | '')}
            >
              <option value="">Who may run it…</option>
              {VISIBILITIES.map((v) => (
                <option key={v.value} value={v.value}>
                  {v.label} — {v.hint}
                </option>
              ))}
            </select>
            <button
              type="button"
              name="save_advanced_query"
              disabled={saving || name.trim() === '' || visibility === '' || active === 0}
              onClick={() => void save()}
              className="lf-btn-secondary px-4 py-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
          {savedNote && <p className="text-xs text-ok">{savedNote}</p>}
        </div>
      </div>
    </Modal>
  );
}
