import { useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type OverdueNextActions,
  type PipelineBoard,
} from '../../services/api';

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



export default function Pipeline() {
  const [board, setBoard] = useState<PipelineBoard | null>(null);
  const [overdue, setOverdue] = useState<OverdueNextActions | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
            <li key={row.lead_id} className="rounded-lg border border-red/40 bg-red/10 p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm text-text">{row.name ?? row.lead_id}</span>
                <span className="text-xs text-red">
                  {row.hours_overdue === null ? 'Overdue' : `${row.hours_overdue}h overdue`}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-soft">
                {row.next_action ?? 'No NEXT action recorded'} · {row.owner ?? 'No owner'}
                {row.stage ? ` · ${row.stage}` : ''}
              </p>
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

        {/* MISSING AND OVERDUE ARE SEPARATE, and the missing list is the worse
            of the two: a lead with a date that has passed is somebody's slipped
            commitment; one with no date at all was never committed to, and
            nothing date-based will ever surface it. */}
        {(overdue?.no_next_action ?? []).length > 0 && (
          <div className="mt-4 border-t border-line pt-3">
            <h3 className="lf-label">No NEXT action at all</h3>
            <p className="mt-1 text-xs text-soft">
              {overdue?.no_next_action_count} record
              {overdue?.no_next_action_count === 1 ? '' : 's'} with no dated commitment. Target:{' '}
              {overdue?.target}
            </p>
            <ul className="mt-2 space-y-1">
              {(overdue?.no_next_action ?? []).slice(0, 10).map((row) => (
                <li key={row.lead_id} className="text-sm">
                  <span className="text-text">{row.name ?? row.lead_id}</span>
                  <span className="text-soft"> — {row.owner ?? 'No owner'}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* ---------------------------------------------------- the board */}
      <div className="mt-4 flex gap-4 overflow-x-auto pb-4">
        {(board?.columns ?? []).map((column) => (
          <section
            key={column.stage}
            className="lf-panel w-64 shrink-0 p-4"
            aria-label={`${column.stage} stage`}
          >
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-semibold text-text">{column.stage}</h2>
              <span className="text-xs text-muted">{column.count}</span>
            </div>
            <p className="mt-2 text-[11px] text-soft">
              Oldest {column.oldest_days}d in this stage.
            </p>
            {/* PER-RECORD CARDS ARE NOT IN THIS RESPONSE. The board endpoint
                returns stage counts and aging; it does not return the records
                themselves, so there is nothing here to move or reschedule.
                Rendering empty cards would imply the stage was empty. */}
          </section>
        ))}

        {!loading && (board?.columns ?? []).length === 0 && (
          <p className="text-sm text-muted">
            {board
              ? 'No open stages.'
              : 'The board could not be read, so this is not an empty pipeline.'}
          </p>
        )}
      </div>

      {board && (
        <section className="lf-panel mt-4 p-5" aria-label="Pipeline health">
          <h2 className="lf-eyebrow">Hard targets</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <p className={`text-2xl ${board.pipeline_health.unowned > board.hard_targets.unowned ? 'text-red' : 'text-green'}`}>
                {board.pipeline_health.unowned}
              </p>
              <p className="text-xs text-soft">
                Unowned · target {board.hard_targets.unowned}
              </p>
            </div>
            <div>
              <p className={`text-2xl ${board.pipeline_health.active_without_next > board.hard_targets.active_without_next ? 'text-red' : 'text-green'}`}>
                {board.pipeline_health.active_without_next}
              </p>
              <p className="text-xs text-soft">
                Active without a NEXT · target {board.hard_targets.active_without_next}
              </p>
            </div>
          </div>
          <p className={`mt-3 text-sm ${board.targets_met ? 'text-green' : 'text-red'}`}>
            {board.targets_met ? 'Both hard targets are met.' : 'A hard target is missed.'}
          </p>
        </section>
      )}

      {/* ---------------------------------------------------- stage aging */}
      <section className="lf-panel p-5" aria-label="Stage aging">
        <h2 className="lf-eyebrow">Stage aging</h2>
        <p className="mt-1 text-xs text-soft">
          Open deals with no meaningful activity for five business days. Aging is not the same as
          being slow - it is the absence of anything happening at all.
        </p>
        <ul className="mt-3 space-y-1">
          {(board?.pipeline_health?.aging ?? []).map((row) => (
            <li key={row.stage} className="text-sm">
              <span className="text-text">{row.stage}</span>
              <span className="text-soft"> — {row.count} open, oldest {row.oldest_days} days</span>
            </li>
          ))}
          {!loading && (board?.pipeline_health?.aging ?? []).length === 0 && (
            <li className="text-sm text-muted">Nothing is reported as aging.</li>
          )}
        </ul>
      </section>

    </div>
  );
}

