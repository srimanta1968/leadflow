import { useState } from 'react';
import { api, ApiError, IdentityReviewCase } from '../../services/api';
import { useToast } from '../../components/feedback/ToastProvider';
import { failureFor } from '../../content/messages';
import { chipClass, riskChipClass } from '../../design-system/tokens';

/**
 * Identity Candidate Review — #identityModal.
 *
 * THE SCREEN'S JOB IS TO CONTRADICT THE API'S VOCABULARY. Verify Link is wired
 * to an upstream call named `approve` that invokes `mergeRecords`, and a steward
 * reading that word would reasonably conclude the second record is absorbed. It
 * is not: `mergeRecords` inserts a row into `empi.merge_event` and flips the
 * candidate's status, touching neither person row. Both ids survive inside the
 * event, which is exactly what lets `unmerge` reverse it. So the retention
 * guarantee is STATED on the button and beside the outcome, because a guarantee
 * nobody writes down is one the next reader has to take on trust.
 *
 * A REASON IS COLLECTED BEFORE EITHER RECORDED DECISION, not after. The steward
 * is overruling a model that explicitly declined to decide; "why" is the only
 * part of that a later reader — or the person wrongly linked — can assess.
 */

/** One row of the evidence comparison. */
interface EvidenceRow {
  feature: string;
  incoming: string;
  existing: string;
  assessment: string;
  weight: string;
}

/**
 * The evidence table, derived from the candidate's provenance.
 *
 * NOT INVENTED WHEN ABSENT. The mockup shows five populated rows; those are
 * sample data, and rendering them for a case whose provenance we could not read
 * would be showing a steward evidence that does not exist for the decision they
 * are about to take. An empty provenance yields an empty table and a sentence
 * saying so.
 */
function evidenceFrom(provenance: Record<string, unknown> | null): EvidenceRow[] {
  if (!provenance || typeof provenance !== 'object') return [];
  const features = provenance.features;
  if (!Array.isArray(features)) return [];
  return features.map((entry) => {
    const row = (entry ?? {}) as Record<string, unknown>;
    return {
      feature: String(row.feature ?? row.name ?? 'unnamed'),
      incoming: String(row.incoming ?? '-'),
      existing: String(row.existing ?? '-'),
      assessment: String(row.assessment ?? 'unassessed'),
      weight: String(row.weight ?? '-'),
    };
  });
}

export function IdentityCandidateModal({
  candidate,
  onClose,
  onDecided,
}: {
  candidate: IdentityReviewCase;
  onClose: () => void;
  onDecided: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const { notify } = useToast();

  const evidence = evidenceFrom(candidate.provenance);
  const linkId = candidate.link_id ?? '';

  async function decide(decision: 'verify_link' | 'keep_separate' | 'defer') {
    if (!linkId) return;
    setBusy(true);
    try {
      const result = await api.identityDecision(linkId, decision, reason);
      setOutcome(
        result.recorded
          ? `Recorded. Both source records retained. Reversible via ${result.reversibility_ref ?? 'the rejection record'}.`
          : 'Deferred. The case stays open and stays in the queue.'
      );
      onDecided();
    } catch (error) {
      notify(failureFor(error instanceof ApiError ? error.code : 'INTERNAL_ERROR'));
    } finally {
      setBusy(false);
    }
  }

  /* Both recorded decisions need a reason; deferring asserts nothing. */
  const canRecord = reason.trim().length > 0 && !busy;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-panel max-h-full w-full max-w-4xl overflow-y-auto rounded-lg p-6">
        <header className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold">Identity Candidate Review</h2>
            <p className="text-soft">
              Compare evidence, decide the link, and retain both source records.
            </p>
          </div>
          <span className={`rounded-full border px-2 py-0.5 ${riskChipClass(candidate.risk_band)}`}>
            {candidate.risk_band} risk
          </span>
        </header>

        <section className="mb-4 grid gap-4 md:grid-cols-2">
          <div className="border-line rounded border p-3">
            <div className="text-soft text-xs uppercase">Incoming source record</div>
            <div className="font-mono text-xs">{candidate.person_id_a ?? '-'}</div>
            <span className={`mt-1 inline-block rounded-full border px-2 text-xs ${chipClass('publicRecord')}`}>
              P2 Candidate
            </span>
          </div>
          <div className="border-line rounded border p-3">
            <div className="text-soft text-xs uppercase">Existing canonical contact</div>
            <div className="font-mono text-xs">{candidate.person_id_b ?? '-'}</div>
            <span className={`mt-1 inline-block rounded-full border px-2 text-xs ${chipClass('success')}`}>
              P4 Direct
            </span>
          </div>
        </section>

        <section className="mb-4">
          <h3 className="mb-2 font-semibold">Evidence Comparison</h3>
          <table className="w-full text-left text-sm">
            <thead className="text-soft">
              <tr>
                <th>Feature</th>
                <th>Incoming</th>
                <th>Existing</th>
                <th>Assessment</th>
                <th>Weight</th>
              </tr>
            </thead>
            <tbody>
              {evidence.map((row) => (
                <tr key={row.feature}>
                  <td>{row.feature}</td>
                  <td>{row.incoming}</td>
                  <td>{row.existing}</td>
                  <td>{row.assessment}</td>
                  <td>{row.weight}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {evidence.length === 0 && (
            <p className="text-soft py-3">
              No per-feature evidence was recorded for this candidate, so none is shown.
              Deciding without it means deciding on the score alone.
            </p>
          )}
        </section>

        <section className="border-line mb-4 rounded border p-3">
          <h3 className="mb-1 font-semibold">Resolver verdict</h3>
          <p>
            Score {candidate.model_score.toFixed(2)} — below the automatic threshold, so
            the resolver refused to link this on its own and referred it here. That is why
            it is not auto-linkable: the model is confident enough to suspect a match and
            not confident enough to assert one.
          </p>
        </section>

        <section className="mb-4">
          <label className="mb-1 block text-sm" htmlFor="decision-reason">
            Reason (required to record a decision)
          </label>
          <textarea
            id="decision-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className="border-line w-full rounded border p-2"
            rows={2}
          />
        </section>

        {outcome && <p className="mb-3">{outcome}</p>}

        <footer className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => decide('defer')} className="border-line rounded border px-3 py-1">
            Defer
          </button>
          <button type="button" disabled={!canRecord} onClick={() => decide('keep_separate')} className="border-line rounded border px-3 py-1">
            Keep Separate
          </button>
          <button type="button" disabled={!canRecord} onClick={() => decide('verify_link')} className="border-line rounded border px-3 py-1">
            Verify Link
          </button>
          <button type="button" onClick={onClose} className="text-soft ml-auto px-3 py-1">
            Close
          </button>
        </footer>

        <p className="text-soft mt-3 text-sm">
          Verifying a link never collapses the two records. It records an assertion that
          they are the same person; both source records are retained and the assertion can
          be retracted.
        </p>
      </div>
    </div>
  );
}
