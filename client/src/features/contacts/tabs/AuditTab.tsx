import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, type AuditTimeline } from '../../../services/api';
import { useContactRecord } from '../ContactRecordContext';
import { Timeline, type TimelineEntry } from '../../../design-system/evidence/Timeline';

/**
 * Contact 360 Audit Timeline (#c-activity).
 *
 * A GOVERNED-ACTION TIMELINE, NOT A LOG TAIL. Every entry names the actor, the
 * reference an operator can quote to support, and the policy decision it was
 * taken under — the Timeline primitive requires all three, which is why the
 * mapping below refuses to invent them: an entry whose actor is unknown renders
 * as unknown rather than as "system", because "system" is a claim about who
 * acted and a wrong one is worse than an absent one.
 */

export default function AuditTab() {
  const { contactId, summary } = useContactRecord();
  const [data, setData] = useState<AuditTimeline | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // The audit chain is keyed by SUBJECT, not by the local contact row, so the
  // canonical id is the correct key when it is known. Falling back to the local
  // id is honest: it reads whatever chain that id names, and if the two differ
  // the timeline is empty rather than showing another subject's history.
  const subjectRef = summary?.canonical_id ?? contactId;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void (async () => {
      try {
        setData(await api.auditTimeline(subjectRef, controller.signal));
        setError(null);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setData(null);
        setError(caught instanceof ApiError ? caught.message : 'The timeline could not be read.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [subjectRef]);

  const entries = useMemo<TimelineEntry[]>(
    () =>
      (data?.entries ?? []).map((entry) => ({
        id: entry.event_id,
        summary: entry.title,
        actor: entry.actor ?? 'Actor not recorded',
        reference: entry.reference ?? entry.policy_decision_ref ?? 'No reference recorded',
        at: entry.occurred_at ?? 'Time not recorded',
        decision: entry.effect ? { effect: entry.effect } : undefined,
      })),
    [data],
  );

  return (
    <section aria-label="Audit Timeline">
      <div className="lf-panel p-5">
        <h2 className="text-lg font-semibold text-text">Audit Timeline</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Every governed action taken on this record, with the actor who took it and the decision
          it was taken under.
        </p>
      </div>

      <div className="lf-panel mt-4 p-5">
        {error && (
          <p className="mb-3 rounded border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">
            {error}
          </p>
        )}
        {loading ? (
          <p role="status" className="py-8 text-center text-sm text-muted">
            Reading the audit chain...
          </p>
        ) : (
          <Timeline entries={entries} />
        )}
      </div>
    </section>
  );
}
