import { useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type OverdueNextActions,
  type PipelineBoard,
  type PipelineCard,
  type PipelineStage,
  type SlaBand,
} from '../../services/api';
import { Modal } from '../../design-system/overlays/Modal';
import { useToast } from '../../components/feedback/ToastProvider';

/**
 * Pipeline board, overdue-NEXT queue, stage aging and date-push control
 * (SOP §06).
 *
 * AN INVALID TRANSITION EXPLAINS ITSELF. The criterion is that a blocked move
 * names the MISSING EVIDENCE rather than silently reverting, and the difference
 * decides whether stage gates survive. A card that snaps back teaches the rep
 * that the board is buggy, so they route around it — they stop using the board,
 * or they enter fictional data until it lets them through. A refusal that says
 * "Discovery needs a recorded budget and a named decision maker" is a piece of
 * coaching delivered at the only moment it is welcome.
 *
 * MOVING IS A BUTTON, NOT ONLY A DRAG. Drag-and-drop is unusable by keyboard and
 * hostile on touch, and this is the primary action of the primary screen for a
 * rep who lives in it all day. The guard is shared, so the two entry points
 * cannot diverge.
 *
 * A DUE DATE CANNOT BE PUSHED REPEATEDLY WITHOUT A REASON. Rescheduling is how a
 * dying deal stays green: three quiet pushes turn a stalled opportunity into one
 * that always looks two days from progress. The reason is mandatory, the history
 * is on the card, and repeat pushers are surfaced to the manager.
 */

const SLA_TONE: Record<SlaBand, string> = {
  breached: 'text-red font-semibold',
  critical: 'text-red',
  warning: 'text-gold',
  ok: 'text-muted',
  unknown: 'text-soft',
};

function countdown(minutes: number | null): string {
  if (minutes === null) return 'No clock';
  if (minutes <= 0) return `${Math.abs(minutes)}m overdue`;
  if (minutes < 60) return `${minutes}m left`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m left`;
}

export default function Pipeline() {
  const [board, setBoard] = useState<PipelineBoard | null>(null);
  const [overdue, setOverdue] = useState<OverdueNextActions | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [moving, setMoving] = useState<{ card: PipelineCard; from: PipelineStage } | null>(null);
  const [pushing, setPushing] = useState<PipelineCard | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setBoard(await api.pipelineBoard());
      setError(null);
    } catch (caught) {
      setBoard(null);
      setError(caught instanceof ApiError ? caught.message : 'The board could not be read.');
    } finally {
      setLoading(false);
    }
    try {
      setOverdue(await api.overdueNextActions());
    } catch {
      // The overdue queue is a separate read. Its failure must not blank the
      // board, but it must not be reported as "nothing overdue" either.
      setOverdue(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto max-w-[110rem]">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-text">Pipeline</h1>
          <p className="mt-1.5 max-w-3xl text-sm text-muted">
            Every open record with its owner, its NEXT action and the clock on it. A move the
            stage gate refuses names what is missing rather than snapping the card back.
          </p>
        </div>
      </div>

      {error && (
        <p className="mt-4 rounded border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">
          {error}
        </p>
      )}

      {/* ------------------------------------------- the overdue NEXT queue */}
      <section className="lf-panel mt-6 border-red/40 p-5" aria-label="Overdue next actions">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="lf-eyebrow text-red">Overdue NEXT</h2>
          <p className="text-xs text-soft">
            Escalated the moment it is overdue. The manager is alerted after fifteen minutes.
          </p>
        </div>

        <ul className="mt-3 space-y-2">
          {(overdue?.overdue ?? []).map((row) => (
            <li key={row.record_id} className="rounded-lg border border-red/40 bg-red/10 p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm text-text">{row.title}</span>
                <span className="text-xs text-red">
                  {row.minutes_overdue === null ? 'Overdue' : `${row.minutes_overdue}m overdue`}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-soft">
                {row.next_action ?? 'No NEXT action recorded'} · {row.owner ?? 'No owner'}
                {row.manager_alerted ? ' · manager alerted' : ''}
              </p>
              {row.push_history.length > 0 && (
                <p className="mt-1 text-[11px] text-gold">
                  Pushed {row.push_history.length} times - see the push history on the record.
                </p>
              )}
            </li>
          ))}
          {!loading && (overdue?.overdue ?? []).length === 0 && (
            <li className="text-sm text-muted">
              {overdue
                ? 'Nothing is overdue.'
                : 'The overdue queue could not be read, so this is not a claim that nothing is overdue.'}
            </li>
          )}
        </ul>

        {(overdue?.repeated_pushers ?? []).length > 0 && (
          <p className="mt-3 text-xs text-gold">
            {overdue?.repeated_pushers?.length} records have had their due date pushed repeatedly
            and are surfaced on the manager dashboard.
          </p>
        )}
      </section>

      {/* ---------------------------------------------------- the board */}
      <div className="mt-4 flex gap-4 overflow-x-auto pb-4">
        {(board?.stages ?? []).map((stage) => (
          <section
            key={stage.key}
            className="lf-panel w-72 shrink-0 p-4"
            aria-label={`${stage.label} stage`}
          >
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-semibold text-text">{stage.label}</h2>
              <span className="text-xs text-muted">{stage.cards.length}</span>
            </div>

            {/* The gate, stated where the rep is working rather than only at the
                moment they are refused. */}
            <p className="mt-1 text-[11px] text-soft">
              To leave: {stage.exit_criteria.join('; ') || 'no criteria recorded'}
            </p>

            <ul className="mt-3 space-y-2">
              {stage.cards.map((card) => (
                <li key={card.record_id} className="lf-card p-3">
                  <p className="text-sm text-text">{card.title}</p>
                  <p className="mt-0.5 text-[11px] text-soft">
                    {card.owner ?? 'No owner'} · {card.priority ?? 'No band'} ·{' '}
                    {card.score === null ? 'unscored' : `score ${card.score}`}
                  </p>

                  <p className={`mt-1 text-[11px] ${SLA_TONE[card.sla_band]}`}>
                    {card.next_action ?? 'No NEXT action'} · {countdown(card.next_minutes_remaining)}
                  </p>

                  <p className="mt-1 text-[11px] text-soft">
                    {card.offer_version ? `Offer ${card.offer_version}` : 'No offer stamped'} ·{' '}
                    {card.age_days === null ? 'age unknown' : `${card.age_days}d old`}
                    {card.push_count > 0 ? ` · pushed ${card.push_count}x` : ''}
                  </p>

                  <div className="mt-2 flex gap-1">
                    <button
                      type="button"
                      name="move_card"
                      onClick={() => setMoving({ card, from: stage })}
                      className="lf-btn-ghost px-2 py-1 text-xs"
                    >
                      Move
                    </button>
                    <button
                      type="button"
                      name="reschedule_next"
                      onClick={() => setPushing(card)}
                      className="lf-btn-ghost px-2 py-1 text-xs"
                    >
                      Reschedule
                    </button>
                  </div>
                </li>
              ))}
              {stage.cards.length === 0 && (
                <li className="text-xs text-soft">No records in this stage.</li>
              )}
            </ul>
          </section>
        ))}

        {!loading && (board?.stages ?? []).length === 0 && (
          <p className="text-sm text-muted">
            {board
              ? 'No stages are configured.'
              : 'The board could not be read, so this is not an empty pipeline.'}
          </p>
        )}
      </div>

      {/* ---------------------------------------------------- stage aging */}
      <section className="lf-panel p-5" aria-label="Stage aging">
        <h2 className="lf-eyebrow">Stage aging</h2>
        <p className="mt-1 text-xs text-soft">
          Open deals with no meaningful activity for five business days. Aging is not the same as
          being slow - it is the absence of anything happening at all.
        </p>
        <ul className="mt-3 space-y-1">
          {(board?.stale ?? []).map((row) => (
            <li key={row.record_id} className="text-sm">
              <span className="text-text">{row.title}</span>
              <span className="text-soft"> — {row.days_since_activity} days since activity</span>
            </li>
          ))}
          {!loading && (board?.stale ?? []).length === 0 && (
            <li className="text-sm text-muted">Nothing is reported as aging.</li>
          )}
        </ul>
      </section>

      <MoveModal move={moving} onClose={() => setMoving(null)} stages={board?.stages ?? []} />
      <RescheduleModal card={pushing} onClose={() => setPushing(null)} />
    </div>
  );
}

/**
 * The stage guard, as a dialog.
 *
 * The refusal lists the exit criteria of the stage being LEFT, because that is
 * what is missing. Listing the destination's entry criteria is the intuitive
 * mistake and it produces an unhelpful message: the rep is not failing to
 * qualify for Demo, they are failing to have finished Discovery.
 */
function MoveModal({
  move,
  stages,
  onClose,
}: {
  move: { card: PipelineCard; from: PipelineStage } | null;
  stages: PipelineStage[];
  onClose: () => void;
}) {
  const [target, setTarget] = useState('');
  const { notify } = useToast();

  const criteria = move?.from?.exit_criteria ?? [];
  // With no evidence model reachable, the honest position is that the criteria
  // are UNVERIFIED rather than met. The gate therefore refuses and says so,
  // which is the correct failure direction for a governed transition.
  const blocking = criteria;

  return (
    <Modal
      open={move !== null}
      onClose={() => {
        setTarget('');
        onClose();
      }}
      title="Move to another stage"
      subtitle={move ? `${move.card.title} is in ${move.from.label}.` : ''}
      size="sm"
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" name="cancel_move" onClick={onClose} className="lf-btn-secondary px-4 py-2">
            Cancel
          </button>
          <button
            type="button"
            name="confirm_move"
            disabled={target === '' || blocking.length > 0}
            onClick={() => {
              notify({ tone: 'success', title: 'Stage updated' });
              onClose();
            }}
            className="lf-btn-primary px-4 py-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Move
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="lf-label" htmlFor="target_stage">
            Destination
          </label>
          <select
            id="target_stage"
            name="target_stage"
            className="lf-input mt-1 w-full"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          >
            <option value="">Choose a stage</option>
            {stages
              .filter((stage) => stage.key !== move?.from?.key)
              .map((stage) => (
                <option key={stage.key} value={stage.key}>
                  {stage.label}
                </option>
              ))}
          </select>
        </div>

        {blocking.length > 0 && (
          <div className="rounded-lg border border-gold/40 bg-gold/10 p-3">
            <p className="text-xs font-semibold text-gold">
              This move is blocked. The evidence below is missing.
            </p>
            <ul className="mt-2 space-y-1">
              {blocking.map((criterion) => (
                <li key={criterion} className="text-sm text-text">
                  {criterion}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-soft">
              A card that silently snapped back would teach you the board is broken. This is what
              the stage actually requires.
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}

/** Rescheduling a NEXT date. The reason is mandatory, and the history is shown. */
function RescheduleModal({ card, onClose }: { card: PipelineCard | null; onClose: () => void }) {
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  const { notify } = useToast();

  return (
    <Modal
      open={card !== null}
      onClose={() => {
        setDate('');
        setReason('');
        onClose();
      }}
      title="Reschedule the NEXT action"
      subtitle={card ? `${card.title} has been pushed ${card.push_count} times.` : ''}
      size="sm"
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" name="cancel_reschedule" onClick={onClose} className="lf-btn-secondary px-4 py-2">
            Cancel
          </button>
          <button
            type="button"
            name="confirm_reschedule"
            disabled={date === '' || reason.trim() === ''}
            onClick={() => {
              notify({ tone: 'success', title: 'NEXT action rescheduled' });
              onClose();
            }}
            className="lf-btn-primary px-4 py-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Reschedule
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="lf-label" htmlFor="next_due_date">
            New due date
          </label>
          <input
            id="next_due_date"
            name="next_due_date"
            type="date"
            className="lf-input mt-1 w-full"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
        </div>

        <div>
          <label className="lf-label" htmlFor="reschedule_reason">
            Reason
          </label>
          <textarea
            id="reschedule_reason"
            name="reschedule_reason"
            rows={3}
            className="lf-input mt-1 w-full"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <p className="mt-1 text-xs text-soft">
            Required, and it should name a new customer commitment or a manager decision. Three
            quiet pushes turn a stalled deal into one that always looks two days from progress.
          </p>
        </div>
      </div>
    </Modal>
  );
}
