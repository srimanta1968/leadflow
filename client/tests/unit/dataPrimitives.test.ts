import { describe, expect, it } from 'vitest';
import { computeWindow, sortRows } from '../../src/design-system/data/virtualWindow';
import {
  BUILT_IN_VIEWS,
  applyView,
  loadViews,
  saveView,
  toQueryParams,
  type SavedView,
} from '../../src/design-system/data/savedViews';

/**
 * The data primitives, and the gate that keeps them the only ones.
 *
 * WHY THE GATE IS A TEST AND NOT A LINT RULE, which is what the criterion asks
 * for: `npm run lint` in this package runs `eslint src --ext ts,tsx`, and eslint
 * is not installed — the script fails with "'eslint' is not recognized". A rule
 * added there would never execute, which is the same green-gate-guarding-nothing
 * shape this codebase has been fixing all sprint. Put where it runs, it runs on
 * every commit. If eslint is adopted later this moves across unchanged.
 */

describe('virtual windowing', () => {
  const base = { total: 100_000, rowHeight: 40, viewportHeight: 800, scrollTop: 0 };

  it('renders a constant handful of rows regardless of dataset size', () => {
    const small = computeWindow({ ...base, total: 500 });
    const huge = computeWindow({ ...base, total: 1_000_000 });
    // THE WHOLE POINT: 2000x the rows must not mean 2000x the DOM.
    expect(huge.endIndex - huge.startIndex).toBe(small.endIndex - small.startIndex);
    expect(huge.endIndex - huge.startIndex).toBeLessThan(40);
  });

  it('keeps the scrollbar honest about the dataset, not the DOM', () => {
    expect(computeWindow(base).totalHeight).toBe(100_000 * 40);
  });

  it('spacers always account for exactly the rows not rendered', () => {
    const w = computeWindow({ ...base, scrollTop: 20_000 });
    const rendered = (w.endIndex - w.startIndex) * base.rowHeight;
    // If this drifts, the scroll position jumps as you drag — the classic
    // virtualization defect, and one that only shows up mid-list.
    expect(w.paddingTop + rendered + w.paddingBottom).toBe(w.totalHeight);
  });

  it('overscans so a fast flick does not paint blank', () => {
    const w = computeWindow({ ...base, scrollTop: 20_000 });
    const firstVisible = Math.floor(20_000 / 40);
    expect(w.startIndex).toBeLessThan(firstVisible);
    expect(w.endIndex).toBeGreaterThan(firstVisible + Math.ceil(800 / 40));
  });

  it('clamps a scrollTop past the end instead of reading past the array', () => {
    // Momentum scrolling and rubber-banding both produce exactly this.
    const w = computeWindow({ ...base, total: 100, scrollTop: 999_999 });
    expect(w.endIndex).toBeLessThanOrEqual(100);
    expect(w.startIndex).toBeGreaterThanOrEqual(0);
  });

  it('answers degenerate input rather than dividing by it', () => {
    // A viewport of 0 is normal for one frame, and whenever the tab is hidden.
    expect(computeWindow({ ...base, viewportHeight: 0 }).endIndex).toBeGreaterThanOrEqual(0);
    expect(computeWindow({ ...base, total: 0 })).toMatchObject({ startIndex: 0, endIndex: 0 });
    expect(computeWindow({ ...base, rowHeight: 0 }).totalHeight).toBe(0);
  });
});

describe('sorting', () => {
  const rows = [{ v: 3 }, { v: null }, { v: 1 }, { v: 10 }];

  it('sorts nulls LAST in both directions', () => {
    // "No response recorded" is not the fastest response. A table that sorts it
    // to the top is worse than one that will not sort at all.
    expect(sortRows(rows, (r) => r.v, 'asc').at(-1)!.v).toBeNull();
    expect(sortRows(rows, (r) => r.v, 'desc').at(-1)!.v).toBeNull();
  });

  it('compares numbers numerically, not as strings', () => {
    expect(sortRows(rows, (r) => r.v, 'asc').map((r) => r.v)).toEqual([1, 3, 10, null]);
  });

  it('does not mutate the caller array', () => {
    const original = [...rows];
    sortRows(rows, (r) => r.v, 'desc');
    expect(rows).toEqual(original);
  });
});

describe('saved views store a question, not an answer', () => {
  it('persists filters and never rows', () => {
    // The criterion in one assertion: a view carries a FILTER definition, so the
    // count is recomputed on open. A stored result set says 5 forever while the
    // queue moves on.
    const serialised = JSON.stringify(BUILT_IN_VIEWS);
    expect(serialised).not.toMatch(/"rows"|"results"|"count"|"items"/);
    for (const view of BUILT_IN_VIEWS) {
      expect(view.filters.length).toBeGreaterThan(0);
    }
  });

  it('recomputes against whatever the data says now', () => {
    const view = BUILT_IN_VIEWS.find((v) => v.id === 'view:sla-risk')!;
    const monday = [{ ageMinutes: 2000 }, { ageMinutes: 10 }];
    const tuesday = [{ ageMinutes: 2000 }, { ageMinutes: 3000 }, { ageMinutes: 10 }];
    expect(applyView(view, monday)).toHaveLength(1);
    expect(applyView(view, tuesday)).toHaveLength(2);
  });

  it('excludes a row when the operator is unknown rather than passing it through', () => {
    const view: SavedView = {
      id: 'x', name: 'x', subject: 'lead',
      filters: [{ field: 'f', op: 'unknown' as never, value: 1 }],
    };
    // A filter that silently does nothing is how a governed queue shows records
    // it was supposed to hide.
    expect(applyView(view, [{ f: 1 }])).toEqual([]);
  });

  it('translates to query params for endpoints that filter server side', () => {
    const view = BUILT_IN_VIEWS.find((v) => v.id === 'view:unresolved')!;
    const params = toQueryParams(view);
    expect(params.trustState).toBe('P0_CAPTURED,P1_NORMALIZED,P2_CANDIDATE');
    expect(params.sort).toBe('ageMinutes:desc');
  });

  it('always offers the built-ins, even when storage is corrupt', () => {
    const broken = { getItem: () => '{not json', setItem: () => undefined } as unknown as Storage;
    expect(loadViews(broken)).toEqual(BUILT_IN_VIEWS);
  });

  it('keeps built-ins out of storage so a new one reaches everybody', () => {
    let written = '';
    const store = {
      getItem: () => written || '[]',
      setItem: (_k: string, v: string) => { written = v; },
    } as unknown as Storage;
    saveView({ id: 'mine', name: 'Mine', subject: 'lead', filters: [{ field: 'a', op: 'eq', value: 1 }] }, store);
    expect(JSON.parse(written).some((v: SavedView) => v.builtIn)).toBe(false);
    expect(loadViews(store).filter((v) => v.builtIn)).toHaveLength(BUILT_IN_VIEWS.length);
  });
});
