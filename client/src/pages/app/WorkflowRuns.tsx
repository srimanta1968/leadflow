import { useEffect, useState } from 'react';
import { api, ApiError, type ReleaseGateResult, type WorkflowRunList } from '../../services/api';
import { useToast } from '../../components/feedback/ToastProvider';

/**
 * Run explorer, customer journey builder and the release-gate test set
 * (PRD §13, SOP §21).
 *
 * THE RELEASE GATE RUNS ALL TWELVE AND BLOCKS ON ANY FAILURE. The twelve are not
 * a suite somebody assembled for coverage; each one is a way an automation has
 * actually hurt a customer. "Reply suppression" is the automation that kept
 * sending after the customer answered. "Opt-out" is the one that messaged
 * somebody who had left. "Rollback" is the one nobody could stop. A gate that
 * reported eleven passes and a skip would let exactly those through, so a
 * scenario with no result is rendered as UNKNOWN and blocks the same as a
 * failure.
 *
 * COMPENSATION HISTORY IS PART OF THE RUN, NOT A SEPARATE LOG. When a run fails
 * halfway, the interesting question is what it UNDID, and an explorer that shows
 * only forward steps leaves the operator unable to tell whether the customer was
 * charged, refunded, both or neither.
 *
 * THE JOURNEY STAGES CARRY EXPLICIT ENTRY AND EXIT CRITERIA. A stage list with
 * no criteria is a picture of a funnel; the criteria are what let two people
 * disagree about a record and resolve it.
 */

/** The twelve release-gate scenarios, per §21. */
const GATE_SCENARIOS = [
  { key: 'business_hours', label: 'Business hours' },
  { key: 'after_hours', label: 'After hours' },
  { key: 'duplicate_event', label: 'Duplicate event' },
  { key: 'reply_suppression', label: 'Reply suppression' },
  { key: 'opt_out', label: 'Opt-out' },
  { key: 'bad_phone', label: 'Bad phone' },
  { key: 'bounced_email', label: 'Bounced email' },
  { key: 'rep_unavailable', label: 'Rep unavailable' },
  { key: 'purchase_success', label: 'Purchase success' },
  { key: 'payment_failure', label: 'Payment failure' },
  { key: 'calendar_failure', label: 'Calendar failure' },
  { key: 'rollback', label: 'Rollback' },
];

/** The PRD's stage progression, with what enters and what leaves. */
const JOURNEY_STAGES = [
  { stage: 'Visitor', entry: 'First identified session', exit: 'Submits an identifying detail' },
  { stage: 'Lead', entry: 'Contact detail captured', exit: 'Meets the qualifying signal' },
  { stage: 'MQL', entry: 'Marketing qualification met', exit: 'Accepted by sales' },
  { stage: 'SQL', entry: 'Sales accepts the lead', exit: 'A real need is confirmed' },
  { stage: 'Opportunity', entry: 'Need and budget confirmed', exit: 'Demo scheduled' },
  { stage: 'Demo', entry: 'Demo booked', exit: 'Demo delivered and recapped' },
  { stage: 'Proposal', entry: 'Offer version stamped and sent', exit: 'Customer responds' },
  { stage: 'Negotiation', entry: 'Terms under discussion', exit: 'Terms agreed or lost' },
  { stage: 'Payment', entry: 'Terms agreed', exit: 'Payment verified' },
  { stage: 'Customer', entry: 'Payment verified', exit: 'Onboarding accepted by CS' },
  { stage: 'Expansion', entry: 'Adopted and healthy', exit: 'Expansion agreed or declined' },
  { stage: 'Renewal', entry: 'Term approaching end', exit: 'Renewed or churned' },
  { stage: 'Referral', entry: 'Customer advocates', exit: 'Referral captured as a new lead' },
];

export default function WorkflowRuns() {
  const [data, setData] = useState<WorkflowRunList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [gate, setGate] = useState<ReleaseGateResult | null>(null);
  const [gateRunning, setGateRunning] = useState(false);
  const { notify } = useToast();

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        setData(await api.workflowRuns(controller.signal));
        setError(null);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setData(null);
        setError(caught instanceof ApiError ? caught.message : 'Runs could not be read.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);

  const runGate = async () => {
    setGateRunning(true);
    try {
      const result = await api.releaseGate('candidate');
      setGate(result);
      notify(
        result.passed
          ? { tone: 'success', title: 'Release gate passed', detail: 'Evidence attached to the approval request.' }
          : { tone: 'error', title: 'Release gate failed - publish is blocked' },
      );
    } catch (caught) {
      notify({
        tone: 'error',
        title: 'The release gate could not be run',
        detail: caught instanceof ApiError ? caught.message : undefined,
      });
    } finally {
      setGateRunning(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-text">Runs &amp; Release Gate</h1>
          <p className="mt-1.5 max-w-3xl text-sm text-muted">
            Every run with its per-step state and what it undid, plus the twelve test leads that
            must pass before an automation may go live.
          </p>
        </div>
        <button
          type="button"
          name="run_release_gate"
          onClick={() => void runGate()}
          disabled={gateRunning}
          className="lf-btn-primary px-4 py-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {gateRunning ? 'Running the gate...' : 'Run release gate'}
        </button>
      </div>

      {error && (
        <p className="mt-4 rounded border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">
          {error}
        </p>
      )}

      {/* ------------------------------------------------- release gate */}
      <section className="lf-panel mt-6 p-5" aria-label="Release gate">
        <h2 className="lf-eyebrow">Release gate</h2>
        <p className="mt-1 text-xs text-soft">
          Each of these is a way an automation has actually hurt a customer. A scenario with no
          result blocks publish exactly as a failure does - eleven passes and a skip is how the
          twelfth gets through.
        </p>

        <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {GATE_SCENARIOS.map((scenario) => {
            const result = gate?.scenarios?.find((s) => s.key === scenario.key);
            const state =
              result === undefined
                ? 'Not run'
                : result.passed === null
                  ? 'Unknown'
                  : result.passed
                    ? 'Passed'
                    : 'Failed';
            return (
              <li key={scenario.key} className="lf-card p-3">
                <p className="text-sm text-text">{scenario.label}</p>
                <p
                  className={`mt-0.5 text-xs ${
                    state === 'Passed' ? 'text-green' : state === 'Failed' ? 'text-red' : 'text-soft'
                  }`}
                >
                  {state}
                </p>
              </li>
            );
          })}
        </ul>

        {gate && (
          <p
            className={`mt-3 rounded border px-3 py-2 text-sm ${
              gate.passed
                ? 'border-green/40 bg-green/10 text-green'
                : 'border-red/40 bg-red/10 text-red'
            }`}
          >
            {gate.passed
              ? `Gate passed. Evidence ${gate.evidence_ref ?? 'reference not returned'} is attached to the approval request.`
              : 'Gate failed. Publish is blocked until every scenario passes.'}
          </p>
        )}
      </section>

      {/* ------------------------------------------------- run explorer */}
      <section className="lf-panel mt-4 p-5" aria-label="Run explorer">
        <h2 className="lf-eyebrow">Run explorer</h2>

        <ul className="mt-3 space-y-2">
          {(data?.runs ?? []).map((run) => (
            <li key={run.run_id} className="lf-card p-3">
              <button
                type="button"
                onClick={() => setExpanded(expanded === run.run_id ? null : run.run_id)}
                className="w-full text-left"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm text-text">
                    {run.definition ?? 'Unknown definition'} v{run.version ?? '--'}
                  </span>
                  <span className="text-xs text-muted">{run.outcome ?? 'in flight'}</span>
                </div>
                <p className="mt-0.5 text-[11px] text-soft">
                  {run.subject ?? 'no subject'} · started {run.started_at ?? '--'} ·{' '}
                  {run.elapsed_ms === null ? 'elapsed unknown' : `${run.elapsed_ms}ms`}
                </p>
              </button>

              {expanded === run.run_id && (
                <div className="mt-3 border-t border-line pt-3">
                  <h3 className="lf-label">Steps</h3>
                  <ol className="mt-1 space-y-1">
                    {run.steps.map((step, index) => (
                      <li key={`${step.name}:${index}`} className="text-xs">
                        <span className="text-text">
                          {step.name} — {step.state}
                        </span>
                        <span className="text-soft">
                          {step.input_summary ? ` · in: ${step.input_summary}` : ''}
                          {step.output_summary ? ` · out: ${step.output_summary}` : ''}
                          {step.elapsed_ms !== null ? ` · ${step.elapsed_ms}ms` : ''}
                        </span>
                        {step.error && <span className="text-red"> · {step.error}</span>}
                      </li>
                    ))}
                  </ol>

                  <h3 className="lf-label mt-3">Compensation history</h3>
                  <ul className="mt-1 space-y-1">
                    {run.compensation_history.map((entry, index) => (
                      <li key={`${entry.step}:${index}`} className="text-xs text-muted">
                        {entry.step} compensated {entry.compensated_at} - {entry.reason}
                      </li>
                    ))}
                    {run.compensation_history.length === 0 && (
                      <li className="text-xs text-soft">Nothing was compensated on this run.</li>
                    )}
                  </ul>

                  <h3 className="lf-label mt-3">Signals received</h3>
                  <p className="mt-1 text-xs text-muted">
                    {run.signals_received.join(', ') || 'None'}
                  </p>

                  <button type="button" name="replay_run" className="lf-btn-secondary mt-3 px-3 py-1.5">
                    Replay
                  </button>
                </div>
              )}
            </li>
          ))}

          {!loading && (data?.runs ?? []).length === 0 && (
            <li className="text-sm text-muted">
              {data
                ? 'No runs match.'
                : 'The run store could not be read, so this is not a claim that nothing has run.'}
            </li>
          )}
        </ul>
      </section>

      {/* --------------------------------------------- the journey builder */}
      <section className="lf-panel mt-4 p-5" aria-label="Customer journey">
        <h2 className="lf-eyebrow">Customer journey</h2>
        <p className="mt-1 text-xs text-soft">
          Each stage carries what enters it and what leaves it. A stage list with no criteria is a
          picture of a funnel; the criteria are what let two people disagree about a record and
          resolve it.
        </p>

        <ol className="mt-3 space-y-2">
          {JOURNEY_STAGES.map((stage, index) => (
            <li key={stage.stage} className="lf-card p-3">
              <p className="text-sm text-text">
                {index + 1}. {stage.stage}
              </p>
              <p className="mt-0.5 text-[11px] text-soft">
                Enters when: {stage.entry} · Leaves when: {stage.exit}
              </p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
