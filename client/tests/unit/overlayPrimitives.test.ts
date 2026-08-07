import { describe, expect, it } from 'vitest';
import {
  IMPORT_STEPS,
  WIZARD_STATE_VERSION,
  canAdvance,
  clearWizard,
  emptyState,
  isStale,
  loadWizard,
  nextIndex,
  prevIndex,
  saveWizard,
} from '../../src/design-system/overlays/wizardState';
import {
  canonicalise,
  isSignable,
  signatureHash,
  type SignatureStroke,
} from '../../src/design-system/overlays/signature';

/** A localStorage stand-in, so persistence is tested rather than mocked away. */
function memoryStore(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  } as Storage;
}

describe('the import wizard survives a reload', () => {
  it('carries all ten steps in the mockup order', () => {
    expect([...IMPORT_STEPS]).toEqual([
      'Source', 'Connect', 'Preview', 'Origin', 'Map',
      'Transform', 'Resolve', 'Access', 'Consent', 'Commit',
    ]);
  });

  it('restores the step and the answers', () => {
    const store = memoryStore();
    const state = { ...emptyState('import'), stepIndex: 6, answers: { Map: { email: 'col_3' } } };
    saveWizard(state, store);

    const resumed = loadWizard('import', store);
    // The acceptance condition: an operator seven steps into a four-hundred-column
    // mapping does not start again because a tab reloaded.
    expect(resumed?.stepIndex).toBe(6);
    expect(resumed?.answers).toEqual({ Map: { email: 'col_3' } });
  });

  it('keeps two wizards apart', () => {
    const store = memoryStore();
    saveWizard({ ...emptyState('import'), stepIndex: 4 }, store);
    saveWizard({ ...emptyState('consent'), stepIndex: 1 }, store);
    expect(loadWizard('import', store)?.stepIndex).toBe(4);
    expect(loadWizard('consent', store)?.stepIndex).toBe(1);
  });

  it('DISCARDS a state from an older shape rather than migrating it', () => {
    const store = memoryStore();
    store.setItem('leadflow.wizard.import', JSON.stringify({
      wizardId: 'import', stepIndex: 7, answers: { Map: {} },
      savedAt: Date.now(), version: WIZARD_STATE_VERSION - 1,
    }));
    // Resuming step 7 into a form whose fields were renamed produces a wizard
    // that looks complete and submits nonsense — worse than starting over,
    // because nobody has a reason to distrust it.
    expect(loadWizard('import', store)).toBeNull();
  });

  it('survives a corrupt entry without taking the wizard down', () => {
    const store = memoryStore();
    store.setItem('leadflow.wizard.import', '{not json');
    expect(loadWizard('import', store)).toBeNull();
  });

  it('clears on completion', () => {
    const store = memoryStore();
    saveWizard(emptyState('import'), store);
    clearWizard('import', store);
    expect(loadWizard('import', store)).toBeNull();
  });

  it('flags stale progress instead of silently resuming week-old work', () => {
    const old = { ...emptyState('import'), savedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 };
    expect(isStale(old)).toBe(true);
    expect(isStale(emptyState('import'))).toBe(false);
  });
});

describe('step navigation', () => {
  const validators = { 2: (a: Record<string, unknown>) => (a.Preview ? [] : ['Preview a row first']) };

  it('blocks forward on an invalid step and names why', () => {
    const blocked = canAdvance(2, {}, validators);
    expect(blocked.ok).toBe(false);
    expect(blocked.errors).toEqual(['Preview a row first']);
    expect(canAdvance(2, { Preview: true }, validators).ok).toBe(true);
  });

  it('never blocks going BACK', () => {
    // Trapping somebody on a step they cannot satisfy, with no way to revisit the
    // earlier answer that caused it, is the classic wizard dead end.
    expect(prevIndex(2)).toBe(1);
    expect(prevIndex(0)).toBe(0);
  });

  it('cannot walk off either end', () => {
    expect(nextIndex(9, IMPORT_STEPS.length)).toBe(9);
    expect(nextIndex(0, IMPORT_STEPS.length)).toBe(1);
  });
});

describe('the signature evidence hash', () => {
  const strokes: SignatureStroke[] = [
    [{ x: 10, y: 20 }, { x: 11.04, y: 21.96 }, { x: 12, y: 23 }],
    [{ x: 30, y: 10 }, { x: 31, y: 12 }],
  ];

  it('is stable across calls', async () => {
    expect(await signatureHash(strokes)).toBe(await signatureHash(strokes));
  });

  it('is a 64-character hex digest', async () => {
    expect(await signatureHash(strokes)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when the mark changes', async () => {
    const different: SignatureStroke[] = [[{ x: 10, y: 20 }, { x: 99, y: 99 }]];
    expect(await signatureHash(different)).not.toBe(await signatureHash(strokes));
  });

  it('ignores sub-pixel jitter, so the same mark hashes the same everywhere', async () => {
    // Hashing a canvas PNG would vary with device pixel ratio, anti-aliasing and
    // GPU — two captures of one signature on a laptop and a tablet would differ
    // and the evidence would prove nothing.
    const jittered: SignatureStroke[] = [
      [{ x: 10.001, y: 20.004 }, { x: 11.04, y: 21.962 }, { x: 12.002, y: 23.001 }],
      [{ x: 30.004, y: 10.001 }, { x: 31.002, y: 12.003 }],
    ];
    expect(await signatureHash(jittered)).toBe(await signatureHash(strokes));
  });

  it('is recomputable by a reviewer from the stroke data alone', () => {
    // The digest is only auditable if its input is reproducible.
    expect(canonicalise(strokes)).toBe('10.0,20.0 11.0,22.0 12.0,23.0|30.0,10.0 31.0,12.0');
  });

  it('refuses a stray tap', () => {
    // One point would otherwise hash happily into the audit trail as a signed
    // consent.
    expect(isSignable([[{ x: 1, y: 1 }]])).toBe(false);
    expect(isSignable([])).toBe(false);
    expect(isSignable([Array.from({ length: 8 }, (_, i) => ({ x: i, y: i }))])).toBe(true);
  });
});
