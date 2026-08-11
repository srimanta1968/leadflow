import { useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type SequenceList,
  type SequenceSummary,
} from '../../services/api';
import { Modal } from '../../design-system/overlays/Modal';
import { chipClass } from '../../design-system/tokens';
import { useToast } from '../../components/feedback/ToastProvider';

/**
 * Sequences — no-answer automation, reply-pause and the opt-out kill (SOP,
 * "IMMEDIATE RESPONSE AND NO-ANSWER AUTOMATION").
 *
 * AN INBOUND REPLY PAUSES THE SEQUENCE. The SOP states this twice, in two
 * different sections, which is a fair signal of how expensive getting it wrong
 * is: "Any reply pauses the generic sequence and creates an urgent owner task.
 * Do not continue automated persuasion while a human conversation is active."
 * The failure it prevents is the one customers actually complain about — a rep
 * answers a question by hand while the automation keeps sending step 4, and the
 * customer concludes nobody is reading their messages.
 *
 * THE PAUSED SET IS ON THE SCREEN, NOT IN A LOG. That is the difference between
 * a rule and a claim. An operator looking at a sequence needs to see WHICH
 * contacts stopped receiving it and why; a pause that is only discoverable by
 * querying an event stream is a pause nobody audits.
 *
 * OPT-OUT CANCELS, IT DOES NOT SUSPEND. STOP, unsubscribe, complaint, invalid
 * number and do-not-contact cancel queued steps immediately and apply
 * suppression — "no persuasion after opt-out". A suspended step is one
 * configuration change away from being sent to somebody who asked not to hear
 * from us, so the count of CANCELLED steps is reported per contact.
 *
 * GLOBAL PAUSE IS A BIG RED BUTTON ON PURPOSE. The runbook's duplicate-send /
 * automation-loop failure mode is a live incident, and an operator halfway
 * through one should not be hunting for the control that stops it.
 */

/** The playbook's ten triggers, so the screen names them even when it cannot read a sequence. */
const TRIGGERS = [
  { key: 'immediate_inbound', label: 'Immediate inbound' },
  { key: 'after_hours', label: 'After hours' },
  { key: 'no_answer', label: 'No answer' },
  { key: 'callback_confirmed', label: 'Callback confirmed' },
  { key: 'demo_booked', label: 'Demo booked' },
  { key: 'two_hour_reminder', label: 'Two-hour reminder' },
  { key: 'no_show', label: 'No-show' },
  { key: 'decision_checkout', label: 'Decision or checkout' },
  { key: 'closed_won', label: 'Closed won' },
  { key: 'breakup', label: 'Breakup' },
];

const VERDICT_ROLE = { allow: 'success', review: 'warning', deny: 'blocked' } as const;

export default function Sequences() {
  const [data, setData] = useState<SequenceList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pausing, setPausing] = useState<SequenceSummary | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.sequences());
      setError(null);
    } catch (caught) {
      setData(null);
      setError(caught instanceof ApiError ? caught.message : 'Sequences could not be read.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto max-w-6xl">
      <div>
        <h1 className="text-2xl font-bold text-text">Sequences</h1>
        <p className="mt-1.5 max-w-3xl text-sm text-muted">
          Automated follow-up that stops the moment a human conversation starts. A reply pauses
          the sequence and raises an urgent task for the owner; an opt-out cancels it outright.
        </p>
      </div>

      {error && (
        <p className="mt-4 rounded border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">
          {error}
        </p>
      )}

      {/* ------------------------------------------------- the ten triggers */}
      <section className="lf-panel mt-6 p-5" aria-label="Entry triggers">
        <h2 className="lf-eyebrow">Entry triggers</h2>
        <p className="mt-1 text-xs text-soft">
          A sequence enters on exactly one. Overlapping entry conditions are how a contact ends up
          in two sequences and receives two messages about the same thing.
        </p>
        <ul className="mt-3 flex flex-wrap gap-2">
          {TRIGGERS.map((trigger) => (
            <li key={trigger.key} className="lf-pill border-line2 text-muted">
              {trigger.label}
            </li>
          ))}
        </ul>
      </section>

      {/* --------------------------------------------------- the sequences */}
      {loading && (
        <p role="status" className="mt-6 text-sm text-muted">
          Reading sequences...
        </p>
      )}

      {(data?.sequences ?? []).map((sequence) => (
        <section key={sequence.sequence_id} className="lf-panel mt-4 p-5" aria-label={sequence.name}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-text">{sequence.name}</h2>
              <p className="mt-0.5 text-xs text-soft">
                {sequence.trigger ?? 'no trigger'} · {sequence.status ?? 'unknown status'} ·{' '}
                {sequence.active_enrollments === null
                  ? 'enrollments unknown'
                  : `${sequence.active_enrollments} active`}
              </p>
            </div>
            <button
              type="button"
              name="pause_sequence"
              onClick={() => setPausing(sequence)}
              className="lf-btn-secondary px-3 py-1.5"
            >
              Pause globally
            </button>
          </div>

          {sequence.paused && (
            <p className="mt-3 rounded border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">
              Paused {sequence.paused.at ?? ''} by {sequence.paused.by ?? 'unknown'} -{' '}
              {sequence.paused.reason}
            </p>
          )}

          {/* --------------------------------------------------- the steps */}
          <ol className="mt-3 space-y-2">
            {sequence.steps.map((step) => (
              <li key={step.step_id} className="lf-card p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm text-text">
                    {step.order}. {step.channel} after {step.delay}
                  </span>
                  {step.gate ? (
                    <span className={`lf-pill ${chipClass(VERDICT_ROLE[step.gate.verdict])}`}>
                      {step.gate.verdict}
                    </span>
                  ) : (
                    <span className="lf-pill border-line2 text-soft">no gate verdict</span>
                  )}
                </div>
                <p className="mt-0.5 text-[11px] text-soft">
                  {step.purpose}
                  {step.template_ref ? ` · ${step.template_ref}` : ' · no approved template'}
                </p>
                {/* The gate verdict, verbatim. A step may not be enabled without one. */}
                <p className="mt-1 text-[11px] text-soft">
                  {step.gate
                    ? step.gate.reason
                    : 'No eligibility or hours verdict was returned, so this step stays disabled.'}
                </p>
              </li>
            ))}
            {sequence.steps.length === 0 && (
              <li className="text-sm text-muted">This sequence has no steps.</li>
            )}
          </ol>

          {/* ------------------------------------------- reply-paused set */}
          <div className="mt-4 border-t border-line pt-4">
            <h3 className="lf-label">Paused by an inbound reply</h3>
            <p className="mt-1 text-xs text-soft">
              A human conversation is active on these records, so automated persuasion has
              stopped and the owner holds an urgent task.
            </p>
            <ul className="mt-2 space-y-1">
              {sequence.reply_paused.map((entry) => (
                <li key={entry.contact} className="text-sm">
                  <span className="text-text">{entry.contact}</span>
                  <span className="text-soft">
                    {' '}
                    — replied {entry.replied_at ?? 'time not recorded'} ·{' '}
                    {entry.task_ref ?? 'no task reference'}
                  </span>
                </li>
              ))}
              {sequence.reply_paused.length === 0 && (
                <li className="text-sm text-muted">No enrollment is currently reply-paused.</li>
              )}
            </ul>

            <h3 className="lf-label mt-4">Cancelled by opt-out or suppression</h3>
            <p className="mt-1 text-xs text-soft">
              Cancelled, not suspended. A suspended step is one configuration change away from
              reaching somebody who asked not to hear from us.
            </p>
            <ul className="mt-2 space-y-1">
              {sequence.suppressed.map((entry) => (
                <li key={entry.contact} className="text-sm">
                  <span className="text-text">{entry.contact}</span>
                  <span className="text-soft">
                    {' '}
                    — {entry.reason} · {entry.cancelled_steps} queued steps cancelled
                  </span>
                </li>
              ))}
              {sequence.suppressed.length === 0 && (
                <li className="text-sm text-muted">No enrollment has been suppressed.</li>
              )}
            </ul>
          </div>
        </section>
      ))}

      {!loading && (data?.sequences ?? []).length === 0 && (
        <p className="mt-6 text-sm text-muted">
          {data
            ? 'No sequences are configured.'
            : 'The sequence store could not be read, so this is not a claim that none are running.'}
        </p>
      )}

      <PauseModal
        sequence={pausing}
        onClose={() => setPausing(null)}
        onPaused={() => {
          setPausing(null);
          void load();
        }}
      />
    </div>
  );
}

/**
 * The global pause.
 *
 * Requires a reason because a halted sequence is an incident artefact: whoever
 * finds it stopped tomorrow needs to know whether it was a loop, a bad template
 * or a deliberate hold, and those have opposite next steps.
 */
function PauseModal({
  sequence,
  onClose,
  onPaused,
}: {
  sequence: SequenceSummary | null;
  onClose: () => void;
  onPaused: () => void;
}) {
  const [reason, setReason] = useState('');
  const [pausing, setPausing] = useState(false);
  const { notify } = useToast();

  const pause = async () => {
    if (!sequence) return;
    setPausing(true);
    try {
      const result = await api.pauseSequence(sequence.sequence_id, reason.trim());
      notify({
        tone: 'success',
        title: 'Sequence paused',
        detail: `${result.queued_steps_cancelled} queued steps were stopped.`,
      });
      setReason('');
      onPaused();
    } catch (caught) {
      notify({
        tone: 'error',
        title: 'The sequence was not paused',
        detail: caught instanceof ApiError ? caught.message : undefined,
      });
    } finally {
      setPausing(false);
    }
  };

  return (
    <Modal
      open={sequence !== null}
      onClose={onClose}
      title="Pause this sequence globally"
      subtitle="Stops every queued step across every enrollment."
      size="sm"
      dismissable={false}
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" name="cancel_pause" onClick={onClose} className="lf-btn-secondary px-4 py-2">
            Cancel
          </button>
          <button
            type="button"
            name="confirm_pause"
            disabled={reason.trim() === '' || pausing}
            onClick={() => void pause()}
            className="lf-btn-primary px-4 py-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pausing ? 'Pausing...' : 'Pause sequence'}
          </button>
        </div>
      }
    >
      <div>
        <label className="lf-label" htmlFor="pause_reason">
          Reason
        </label>
        <textarea
          id="pause_reason"
          name="pause_reason"
          rows={3}
          className="lf-input mt-1 w-full"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        <p className="mt-1 text-xs text-soft">
          Required. Whoever finds this stopped tomorrow needs to know whether it was a duplicate-send
          loop, a bad template or a deliberate hold - those have opposite next steps.
        </p>
      </div>
    </Modal>
  );
}
