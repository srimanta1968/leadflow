/**
 * Wizard progress, and why it is persisted rather than held in React state.
 *
 * THE IMPORT WIZARD IS TEN STEPS LONG. Source, Connect, Preview, Origin, Map,
 * Transform, Resolve, Access, Consent, Commit — an operator mapping four hundred
 * columns is not finishing that in one sitting, and a reload that drops them back
 * at step one loses an afternoon. Save-and-resume is the acceptance condition for
 * that reason, not as a convenience.
 *
 * WHAT IS PERSISTED IS THE ANSWERS, NEVER THE FILE. A CSV lives in browser memory
 * as a File handle that cannot survive a reload anyway, and copying its contents
 * into localStorage would put a customer list into a store no policy governs and
 * no erasure request reaches. On resume the wizard asks for the file again and
 * keeps everything else.
 */

export const IMPORT_STEPS = [
  'Source', 'Connect', 'Preview', 'Origin', 'Map',
  'Transform', 'Resolve', 'Access', 'Consent', 'Commit',
] as const;

export type ImportStep = (typeof IMPORT_STEPS)[number];

export interface WizardState {
  /** Which wizard this is, so two open flows cannot overwrite each other. */
  wizardId: string;
  /** 0-based index into the step list. */
  stepIndex: number;
  /** Answers so far, keyed by step name. */
  answers: Record<string, unknown>;
  /** When it was last written, for the resume prompt. */
  savedAt: number;
  /** Schema version, so a shape change does not resume into a broken form. */
  version: number;
}

/** Bumped when the persisted shape changes. A mismatch discards rather than migrates. */
export const WIZARD_STATE_VERSION = 1;

const KEY_PREFIX = 'leadflow.wizard.';

/** Anything older than this is offered as a resume but flagged as stale. */
export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export function emptyState(wizardId: string): WizardState {
  return { wizardId, stepIndex: 0, answers: {}, savedAt: Date.now(), version: WIZARD_STATE_VERSION };
}

export function saveWizard(state: WizardState, storage?: Storage): void {
  const store = storage ?? (typeof window === 'undefined' ? undefined : window.localStorage);
  try {
    store?.setItem(`${KEY_PREFIX}${state.wizardId}`, JSON.stringify({ ...state, savedAt: Date.now() }));
  } catch {
    // Quota or private mode. Losing resume is bad; taking the wizard down with it
    // is worse, so the failure is swallowed and the flow continues in memory.
  }
}

/**
 * Read saved progress, or null.
 *
 * A VERSION MISMATCH DISCARDS RATHER THAN MIGRATES. Resuming step 7 of a
 * ten-step flow into a form whose fields have been renamed produces a wizard
 * that looks complete and submits nonsense — worse than starting over, because
 * the operator has no reason to distrust it.
 */
export function loadWizard(wizardId: string, storage?: Storage): WizardState | null {
  const store = storage ?? (typeof window === 'undefined' ? undefined : window.localStorage);
  if (!store) return null;
  try {
    const raw = store.getItem(`${KEY_PREFIX}${wizardId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WizardState;
    if (parsed.version !== WIZARD_STATE_VERSION) return null;
    if (typeof parsed.stepIndex !== 'number' || !parsed.answers) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearWizard(wizardId: string, storage?: Storage): void {
  const store = storage ?? (typeof window === 'undefined' ? undefined : window.localStorage);
  try {
    store?.removeItem(`${KEY_PREFIX}${wizardId}`);
  } catch {
    /* nothing to do */
  }
}

export function isStale(state: WizardState, now: number = Date.now()): boolean {
  return now - state.savedAt > STALE_AFTER_MS;
}

/**
 * Whether the operator may leave this step.
 *
 * VALIDATION IS PER STEP AND FORWARD ONLY. Going BACK is always allowed even
 * from an invalid step — trapping somebody on a step they cannot satisfy, with
 * no way to revisit the earlier answer that caused it, is the classic wizard
 * dead end.
 */
export function canAdvance(
  stepIndex: number,
  answers: Record<string, unknown>,
  validators: Partial<Record<number, (a: Record<string, unknown>) => string[]>>,
): { ok: boolean; errors: string[] } {
  const validate = validators[stepIndex];
  if (!validate) return { ok: true, errors: [] };
  const errors = validate(answers);
  return { ok: errors.length === 0, errors };
}

export function nextIndex(current: number, total: number): number {
  return Math.min(current + 1, total - 1);
}

export function prevIndex(current: number): number {
  return Math.max(current - 1, 0);
}
