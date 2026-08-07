import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  canAdvance,
  clearWizard,
  emptyState,
  isStale,
  loadWizard,
  nextIndex,
  prevIndex,
  saveWizard,
  type WizardState,
} from './wizardState';

/**
 * The stepper, over the persistence layer in wizardState.
 *
 * RESUME IS OFFERED, NEVER ASSUMED. Silently dropping somebody back at step
 * seven of ten is disorienting when they expected a fresh start, and it hides
 * that stale answers are in play. The prompt says how old the progress is and
 * lets them discard it — which is also the only way to escape a saved state that
 * has become wrong.
 */

export interface WizardStepDef {
  label: string;
  render: (ctx: {
    answers: Record<string, unknown>;
    set: (key: string, value: unknown) => void;
  }) => ReactNode;
  /** Returns the reasons this step cannot be left. Empty means it can. */
  validate?: (answers: Record<string, unknown>) => string[];
}

export interface WizardProps {
  wizardId: string;
  steps: WizardStepDef[];
  onComplete: (answers: Record<string, unknown>) => void;
  onCancel?: () => void;
  /** The footer hint line under the buttons. */
  hint?: string;
}

export function Wizard({ wizardId, steps, onComplete, onCancel, hint }: WizardProps) {
  const [state, setState] = useState<WizardState>(() => emptyState(wizardId));
  const [resumable, setResumable] = useState<WizardState | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    const saved = loadWizard(wizardId);
    // Only worth offering if they actually got somewhere.
    if (saved && saved.stepIndex > 0) setResumable(saved);
  }, [wizardId]);

  const persist = useCallback((next: WizardState) => {
    setState(next);
    saveWizard(next);
  }, []);

  const set = useCallback(
    (key: string, value: unknown) => {
      setState((s) => {
        const next = { ...s, answers: { ...s.answers, [key]: value } };
        saveWizard(next);
        return next;
      });
      // Clearing on edit rather than on navigate: leaving a stale error under a
      // field the operator has just corrected reads as "still wrong".
      setErrors([]);
    },
    [],
  );

  const validators = Object.fromEntries(
    steps.map((step, i) => [i, step.validate]).filter(([, v]) => v),
  ) as Partial<Record<number, (a: Record<string, unknown>) => string[]>>;

  const step = steps[state.stepIndex];
  const isLast = state.stepIndex === steps.length - 1;

  function forward(): void {
    const check = canAdvance(state.stepIndex, state.answers, validators);
    if (!check.ok) {
      setErrors(check.errors);
      return;
    }
    setErrors([]);
    if (isLast) {
      clearWizard(wizardId);
      onComplete(state.answers);
      return;
    }
    persist({ ...state, stepIndex: nextIndex(state.stepIndex, steps.length) });
  }

  if (resumable) {
    const stale = isStale(resumable);
    return (
      <div className="lf-panel p-5">
        <h3 className="text-base font-bold text-text">Resume where you left off?</h3>
        <p className="mt-1 text-sm text-muted">
          You were on step {resumable.stepIndex + 1} of {steps.length}
          {' — '}
          {steps[resumable.stepIndex]?.label}. Saved{' '}
          {new Date(resumable.savedAt).toLocaleString()}.
          {stale && (
            <span className="text-gold">
              {' '}That is over a week old, so the source data may have moved on.
            </span>
          )}
        </p>
        <p className="mt-2 text-xs text-soft">
          The file itself is never saved, only your answers — you will be asked for it again.
        </p>
        <div className="mt-4 flex gap-3">
          <button
            type="button"
            className="lf-btn-primary px-4 py-2"
            onClick={() => { setState(resumable); setResumable(null); }}
          >
            Resume
          </button>
          <button
            type="button"
            className="lf-btn-secondary px-4 py-2"
            onClick={() => { clearWizard(wizardId); setState(emptyState(wizardId)); setResumable(null); }}
          >
            Start over
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-col">
      <ol className="flex flex-wrap gap-1 border-b border-line pb-3" aria-label="Progress">
        {steps.map((s, i) => {
          const done = i < state.stepIndex;
          const current = i === state.stepIndex;
          return (
            <li key={s.label}>
              {/* Completed steps are clickable, later ones are not: jumping
                  forward past a validation gate is how a wizard is bypassed. */}
              <button
                type="button"
                disabled={!done}
                onClick={() => persist({ ...state, stepIndex: i })}
                aria-current={current ? 'step' : undefined}
                className={`rounded-lg px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                  current ? 'bg-panel2 text-text'
                  : done ? 'text-green hover:bg-panel'
                  : 'cursor-not-allowed text-soft'
                }`}
              >
                {i + 1}. {s.label}
              </button>
            </li>
          );
        })}
      </ol>

      <div className="min-h-0 flex-1 overflow-y-auto py-4">
        {step?.render({ answers: state.answers, set })}
      </div>

      {errors.length > 0 && (
        <ul role="alert" className="mb-3 space-y-1">
          {errors.map((e) => <li key={e} className="text-xs text-red">{e}</li>)}
        </ul>
      )}

      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-line pt-3">
        <p className="text-[11px] text-soft">{hint}</p>
        <div className="flex gap-3">
          {onCancel && (
            <button type="button" onClick={onCancel} className="lf-btn-ghost px-4 py-2">Cancel</button>
          )}
          {/* Back is never disabled by validation — trapping somebody on a step
              they cannot satisfy, with no way to revisit the answer that caused
              it, is the classic wizard dead end. */}
          <button
            type="button"
            onClick={() => persist({ ...state, stepIndex: prevIndex(state.stepIndex) })}
            disabled={state.stepIndex === 0}
            className="lf-btn-secondary px-4 py-2 disabled:opacity-40"
          >
            Back
          </button>
          <button type="button" onClick={forward} className="lf-btn-primary px-4 py-2">
            {isLast ? 'Commit' : 'Continue'}
          </button>
        </div>
      </div>
    </div>
  );
}
