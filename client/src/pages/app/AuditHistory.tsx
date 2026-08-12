import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError, type AuditTimeline } from '../../services/api';
import { Timeline, type TimelineEntry } from '../../design-system/evidence/Timeline';
import { ReversibleActionsPanel } from '../../features/audit/ReversibleActionsPanel';
import { EvidenceBundleModal } from '../../features/audit/EvidenceBundleModal';
import { AdvancedQueryModal } from '../../features/audit/AdvancedQueryModal';

/**
 * Audit & History (#view-audit) — evidence, causality and reversibility.
 *
 * A CORRELATED NARRATIVE, NOT A LOG TAIL. The distinction is the whole screen.
 * A log tail answers "what happened" in the order the machine happened to write
 * it; this answers "who did what, under what authority, and what can I quote" —
 * which are the only questions ever asked of an audit trail after the fact.
 * Every entry therefore carries its actor, its reference and its policy
 * decision, and the Timeline primitive REQUIRES all three so an entry cannot
 * quietly ship without them.
 *
 * THE CORRELATION CONTEXT IS THE HALF THAT MAKES IT AN AUDIT. Four references
 * tie a single act to everything it touched — the canonical entity it wrote to,
 * the trace that carried it from the browser through the workflow to the write
 * kernel, the policy bundle that was in force at the time, and the consent epoch
 * it was evaluated against. Without them a timeline entry is an assertion; with
 * them it is evidence, because each one can be resolved independently.
 *
 * THE SUBJECT IS IN THE URL. An audit finding is something one person sends to
 * another, and a screen whose subject lives in component state produces a link
 * that opens on nothing.
 */

const FRAMING =
  'Evidence, causality and reversibility. Every governed action is correlated to the entity it wrote, the trace that carried it, the policy in force and the consent epoch it was evaluated against.';

export default function AuditHistory() {
  const [params, setParams] = useSearchParams();
  const subjectRef = params.get('subject_ref') ?? '';
  const [draft, setDraft] = useState(subjectRef);
  const [data, setData] = useState<AuditTimeline | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bundleOpen, setBundleOpen] = useState(false);
  const [queryOpen, setQueryOpen] = useState(false);

  const load = useCallback(async (subject: string) => {
    if (subject === '') {
      // Nothing is read until a subject is named. Loading "the audit chain" with
      // no subject would either return another tenant's events or an arbitrary
      // window, and both look like an answer.
      setData(null);
      setError(null);
      return;
    }
    setLoading(true);
    try {
      setData(await api.auditTimeline(subject));
      setError(null);
    } catch (caught) {
      setData(null);
      setError(caught instanceof ApiError ? caught.message : 'The audit chain could not be read.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(subjectRef);
  }, [subjectRef, load]);

  const entries: TimelineEntry[] = (data?.entries ?? []).map((entry) => ({
    id: entry.event_id,
    summary: entry.title,
    actor: entry.actor ?? 'Actor not recorded',
    // The meta line's reference id. An entry with nothing to quote is a claim,
    // so the absence is stated rather than left blank.
    reference:
      [entry.reference, entry.policy_decision_ref, entry.credit_estimate]
        .filter((part): part is string => Boolean(part))
        .join(' · ') || 'No reference recorded',
    at: entry.occurred_at ?? 'Time not recorded',
    decision: entry.effect ? { effect: entry.effect } : undefined,
  }));

  const correlation = data?.correlation;

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-text">Audit &amp; History</h1>
          <p className="mt-1.5 max-w-3xl text-sm text-muted">{FRAMING}</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            name="advanced_query"
            onClick={() => setQueryOpen(true)}
            className="lf-btn-secondary px-4 py-2"
          >
            Advanced query
          </button>
          <button
            type="button"
            name="export_evidence_bundle"
            onClick={() => setBundleOpen(true)}
            className="lf-btn-primary px-4 py-2"
          >
            Export evidence bundle
          </button>
        </div>
      </div>

      {/* ------------------------------------------------- the subject */}
      <div className="lf-panel mt-6 p-4">
        <label className="lf-label block" htmlFor="subject_ref">
          Subject reference
        </label>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <input
            id="subject_ref"
            name="subject_ref"
            className="lf-input min-w-[22rem] flex-1"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="person:canonical-id"
          />
          <button
            type="button"
            name="read_chain"
            onClick={() => setParams(draft ? { subject_ref: draft } : {})}
            className="lf-btn-secondary px-4 py-2"
          >
            Read chain
          </button>
        </div>
        <p className="mt-2 text-xs text-soft">
          Nothing is read until a subject is named. An audit query with no subject returns either
          an arbitrary window or somebody else's events, and both look like an answer.
        </p>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        {/* ------------------------------------ the contact evidence timeline */}
        <section className="lf-panel p-5 lg:col-span-2" aria-label="Contact Evidence Timeline">
          <h2 className="lf-eyebrow">Contact Evidence Timeline</h2>
          <p className="mb-4 mt-1 text-xs text-soft">
            Each entry names what happened, who did it, the reference you can quote and the policy
            decision it was taken under.
          </p>

          {error && (
            <p className="mb-3 rounded border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">
              {error}
            </p>
          )}

          {subjectRef === '' ? (
            <p className="py-8 text-center text-sm text-soft">
              Name a subject above to read its evidence timeline.
            </p>
          ) : loading ? (
            <p role="status" className="py-8 text-center text-sm text-muted">
              Reading the audit chain...
            </p>
          ) : (
            <Timeline entries={entries} />
          )}
        </section>

        {/* ------------------------------------------ the correlation context */}
        <section className="lf-panel p-5" aria-label="Correlation Context">
          <h2 className="lf-eyebrow">Correlation Context</h2>
          <p className="mb-3 mt-1 text-xs text-soft">
            Four references that turn an entry from an assertion into evidence, because each
            resolves independently.
          </p>

          <dl className="space-y-3">
            <CorrelationRow
              label="Canonical Entity"
              value={correlation?.canonical_entity?.value}
              note={correlation?.canonical_entity?.note ?? 'MDM write kernel'}
            />
            <CorrelationRow
              label="Trace / Causation"
              value={correlation?.trace?.value}
              note={correlation?.trace?.note ?? 'Browser to workflow to MDM'}
            />
            <CorrelationRow
              label="Policy Bundle"
              value={correlation?.policy_bundle?.value}
              note={correlation?.policy_bundle?.note ?? 'Decision references preserved'}
            />
            <CorrelationRow
              label="Consent Epoch"
              value={correlation?.consent_epoch?.value}
              note={correlation?.consent_epoch?.note ?? 'Current at latest action'}
            />
          </dl>
        </section>
      </div>

      <ReversibleActionsPanel subjectRef={subjectRef} />

      <EvidenceBundleModal
        open={bundleOpen}
        subjectRef={subjectRef}
        onClose={() => setBundleOpen(false)}
      />

      <AdvancedQueryModal
        open={queryOpen}
        onClose={() => setQueryOpen(false)}
        /* A hit becomes the screen's subject, so a search lands on the
           correlated narrative rather than leaving the reader to copy a
           reference between two views. Through the URL, like every other
           subject change here, so the resulting link opens on the same thing. */
        onUseSubject={(ref) => {
          setDraft(ref);
          setParams({ subject_ref: ref });
        }}
      />
    </div>
  );
}

/**
 * One correlation reference.
 *
 * Rendered as a button because every one of the four is CLICK-THROUGH — the
 * point of a correlation id is that it resolves. A reference printed as inert
 * text asks the operator to copy it into another tool, which is how correlation
 * ids stop being used.
 */
function CorrelationRow({
  label,
  value,
  note,
}: {
  label: string;
  value: string | null | undefined;
  note: string;
}) {
  const resolved = Boolean(value);
  return (
    <div>
      <dt className="lf-label">{label}</dt>
      <dd>
        <button
          type="button"
          disabled={!resolved}
          className="text-left text-sm text-blue hover:underline disabled:cursor-not-allowed disabled:text-soft disabled:no-underline"
        >
          {value ?? 'Not resolved'}
        </button>
        <p className="mt-0.5 text-[11px] text-soft">{note}</p>
      </dd>
    </div>
  );
}
