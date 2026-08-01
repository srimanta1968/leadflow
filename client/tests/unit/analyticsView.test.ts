import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AnalyticsPreferences,
  DEFAULT_WINDOW_DAYS,
  PREFERENCES_STORAGE_KEY,
  SourceRow,
  ariaSortFor,
  clearPreferences,
  coercePreferences,
  defaultPreferences,
  loadPreferences,
  nextSourceSort,
  orderDailyRows,
  savePreferences,
  sortSourceRows,
  toDateInput,
  withWindow,
} from '../../src/utils/analyticsView';

/**
 * The analytics view rules, asserted where they can be asserted precisely.
 *
 * Two of these are worth stating plainly because they are the ones a reader
 * would otherwise assume the opposite of:
 *
 *  - a null `average_response_seconds` means "nothing answered yet", so it sorts
 *    LAST in both directions rather than as the fastest or the slowest channel;
 *  - a stored preference is untrusted input, so each field is validated on its
 *    own and one stale value costs that one choice, not the whole saved view.
 */

/** Labels as the dashboard renders them, including the unattributed bucket. */
const LABELS: Record<string, string> = {
  web_form: 'Web form',
  live_chat: 'Live chat',
  referral: 'Referral',
  phone: 'Phone',
};

function labelFor(source: string | null): string {
  return source ? (LABELS[source] ?? source) : 'Unattributed';
}

/** A by-source row, with only the fields a given assertion cares about set. */
function row(partial: Partial<SourceRow> & Pick<SourceRow, 'source'>): SourceRow {
  return {
    captured: 0,
    responded: 0,
    breached: 0,
    average_response_seconds: null,
    ...partial,
  } as SourceRow;
}

describe('sortSourceRows', () => {
  const rows: SourceRow[] = [
    row({ source: 'web_form', captured: 12, responded: 9, breached: 2, average_response_seconds: 400 }),
    row({ source: 'live_chat', captured: 30, responded: 28, breached: 0, average_response_seconds: 90 }),
    row({ source: 'referral', captured: 4, responded: 0, breached: 1, average_response_seconds: null }),
    row({ source: null, captured: 7, responded: 3, breached: 5, average_response_seconds: 3600 }),
  ];

  it('leaves the caller\'s array untouched', () => {
    const original = [...rows];
    sortSourceRows(rows, { key: 'captured', direction: 'desc' }, labelFor);
    expect(rows).toEqual(original);
  });

  it('orders a count column biggest first when descending', () => {
    const sorted = sortSourceRows(rows, { key: 'captured', direction: 'desc' }, labelFor);
    expect(sorted.map((entry) => entry.captured)).toEqual([30, 12, 7, 4]);
  });

  it('orders a count column smallest first when ascending', () => {
    const sorted = sortSourceRows(rows, { key: 'breached', direction: 'asc' }, labelFor);
    expect(sorted.map((entry) => entry.breached)).toEqual([0, 1, 2, 5]);
  });

  it('sorts the channel column by the rendered label, not the enum value', () => {
    // 'live_chat' < 'web_form' as raw values, but 'Live chat' < 'Unattributed'
    // < 'Web form' as text — the order the viewer actually reads.
    const sorted = sortSourceRows(rows, { key: 'source', direction: 'asc' }, labelFor);
    expect(sorted.map((entry) => labelFor(entry.source))).toEqual([
      'Live chat',
      'Referral',
      'Unattributed',
      'Web form',
    ]);
  });

  it('keeps an unmeasured response time last in BOTH directions', () => {
    const slowestFirst = sortSourceRows(
      rows,
      { key: 'average_response_seconds', direction: 'desc' },
      labelFor
    );
    const fastestFirst = sortSourceRows(
      rows,
      { key: 'average_response_seconds', direction: 'asc' },
      labelFor
    );

    expect(slowestFirst.map((entry) => entry.average_response_seconds)).toEqual([
      3600,
      400,
      90,
      null,
    ]);
    expect(fastestFirst.map((entry) => entry.average_response_seconds)).toEqual([
      90,
      400,
      3600,
      null,
    ]);
  });

  it('breaks ties deterministically, so equal rows do not reshuffle on a re-render', () => {
    const tied: SourceRow[] = [
      row({ source: 'phone', captured: 5, breached: 3 }),
      row({ source: 'web_form', captured: 9, breached: 3 }),
      row({ source: 'live_chat', captured: 9, breached: 3 }),
    ];

    const first = sortSourceRows(tied, { key: 'breached', direction: 'desc' }, labelFor);
    const second = sortSourceRows([...tied].reverse(), { key: 'breached', direction: 'desc' }, labelFor);

    // Same breach count everywhere, so captured decides, then the label.
    expect(first.map((entry) => labelFor(entry.source))).toEqual(['Live chat', 'Web form', 'Phone']);
    expect(second.map((entry) => labelFor(entry.source))).toEqual(first.map((e) => labelFor(e.source)));
  });
});

describe('orderDailyRows', () => {
  const daily = [
    { day: '2026-07-01', captured: 3, responded: 2, breached: 0 },
    { day: '2026-07-03', captured: 8, responded: 5, breached: 1 },
    { day: '2026-07-02', captured: 1, responded: 1, breached: 0 },
  ];

  it('puts today at the top by default', () => {
    expect(orderDailyRows(daily, 'newest').map((point) => point.day)).toEqual([
      '2026-07-03',
      '2026-07-02',
      '2026-07-01',
    ]);
  });

  it('reads as a trend line when reversed', () => {
    expect(orderDailyRows(daily, 'oldest').map((point) => point.day)).toEqual([
      '2026-07-01',
      '2026-07-02',
      '2026-07-03',
    ]);
  });
});

describe('nextSourceSort', () => {
  it('flips the direction when the active column is clicked again', () => {
    expect(nextSourceSort({ key: 'captured', direction: 'desc' }, 'captured')).toEqual({
      key: 'captured',
      direction: 'asc',
    });
  });

  it('opens a count column biggest first', () => {
    expect(nextSourceSort({ key: 'source', direction: 'asc' }, 'breached')).toEqual({
      key: 'breached',
      direction: 'desc',
    });
  });

  it('opens the channel column alphabetically', () => {
    expect(nextSourceSort({ key: 'captured', direction: 'desc' }, 'source')).toEqual({
      key: 'source',
      direction: 'asc',
    });
  });
});

describe('ariaSortFor', () => {
  it('describes only the active column', () => {
    const sort = { key: 'captured', direction: 'desc' } as const;
    expect(ariaSortFor(sort, 'captured')).toBe('descending');
    expect(ariaSortFor(sort, 'breached')).toBe('none');
    expect(ariaSortFor({ key: 'source', direction: 'asc' }, 'source')).toBe('ascending');
  });
});

describe('defaultPreferences and withWindow', () => {
  const now = new Date('2026-07-31T12:00:00Z');

  it('opens on the last 30 days, ending tomorrow because the bound is exclusive', () => {
    const preferences = defaultPreferences(now);
    expect(preferences.from).toBe(toDateInput(new Date(now.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000)));
    expect(preferences.to).toBe(toDateInput(new Date(now.getTime() + 86_400_000)));
    expect(preferences.from < preferences.to).toBe(true);
  });

  it('opens with no channel or owner narrowed', () => {
    const preferences = defaultPreferences(now);
    expect(preferences.source).toBe('');
    expect(preferences.owner_user_id).toBe('');
  });

  it('moves the window without disturbing the other choices', () => {
    const preferences: AnalyticsPreferences = {
      ...defaultPreferences(now),
      source: 'live_chat',
      sourceSort: { key: 'breached', direction: 'asc' },
      dailyOrder: 'oldest',
    };

    const moved = withWindow(preferences, 7, now);

    expect(moved.from).toBe(toDateInput(new Date(now.getTime() - 7 * 86_400_000)));
    expect(moved.source).toBe('live_chat');
    expect(moved.sourceSort).toEqual({ key: 'breached', direction: 'asc' });
    expect(moved.dailyOrder).toBe('oldest');
  });
});

describe('coercePreferences', () => {
  const fallback = defaultPreferences(new Date('2026-07-31T12:00:00Z'));

  it('falls back entirely when the stored value is not an object', () => {
    expect(coercePreferences('nonsense', fallback)).toEqual(fallback);
    expect(coercePreferences(null, fallback)).toEqual(fallback);
  });

  it('keeps a stored view that is still valid', () => {
    const stored: AnalyticsPreferences = {
      from: '2026-01-01',
      to: '2026-02-01',
      source: 'live_chat',
      owner_user_id: '3f1c2b8e-9d44-4a1f-8b0e-77c1a2d3e4f5',
      sourceSort: { key: 'average_response_seconds', direction: 'asc' },
      dailyOrder: 'oldest',
    };
    expect(coercePreferences(stored, fallback)).toEqual(stored);
  });

  it('drops a channel that is no longer in the vocabulary, keeping the rest', () => {
    const coerced = coercePreferences(
      { ...fallback, source: 'carrier_pigeon', dailyOrder: 'oldest' },
      fallback
    );
    expect(coerced.source).toBe('');
    // One stale field costs that field only.
    expect(coerced.dailyOrder).toBe('oldest');
  });

  it('drops an owner id that is not a UUID', () => {
    expect(coercePreferences({ ...fallback, owner_user_id: 'not-a-uuid' }, fallback).owner_user_id).toBe(
      ''
    );
  });

  it('drops a sort key that no longer names a column', () => {
    const coerced = coercePreferences(
      { ...fallback, sourceSort: { key: 'conversion', direction: 'asc' } },
      fallback
    );
    expect(coerced.sourceSort.key).toBe(fallback.sourceSort.key);
    expect(coerced.sourceSort.direction).toBe('asc');
  });

  it('rejects an impossible date', () => {
    expect(coercePreferences({ ...fallback, from: '2026-02-31' }, fallback).from).toBe(fallback.from);
    expect(coercePreferences({ ...fallback, to: 'yesterday' }, fallback).to).toBe(fallback.to);
  });

  it('rejects an inverted window as a pair, so reopening the screen is not a 400', () => {
    const coerced = coercePreferences({ ...fallback, from: '2026-06-01', to: '2026-05-01' }, fallback);
    expect(coerced.from).toBe(fallback.from);
    expect(coerced.to).toBe(fallback.to);
  });
});

describe('preference storage', () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    // vitest runs these in a node environment, so `window` is supplied here
    // rather than assumed. Only the three methods the module uses are stubbed.
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      },
    };
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('round-trips a saved view', () => {
    const preferences: AnalyticsPreferences = {
      ...defaultPreferences(),
      source: 'referral',
      sourceSort: { key: 'breached', direction: 'asc' },
      dailyOrder: 'oldest',
    };

    savePreferences(preferences);
    expect(loadPreferences()).toEqual(preferences);
  });

  it('opens on the defaults when nothing is stored', () => {
    const now = new Date('2026-07-31T12:00:00Z');
    expect(loadPreferences(now)).toEqual(defaultPreferences(now));
  });

  it('opens on the defaults when the stored value is corrupt', () => {
    store.set(PREFERENCES_STORAGE_KEY, '{not json');
    const now = new Date('2026-07-31T12:00:00Z');
    expect(loadPreferences(now)).toEqual(defaultPreferences(now));
  });

  it('forgets the view so the next visit does not resurrect it', () => {
    savePreferences({ ...defaultPreferences(), source: 'phone' });
    clearPreferences();
    expect(store.has(PREFERENCES_STORAGE_KEY)).toBe(false);
    expect(loadPreferences().source).toBe('');
  });

  it('survives storage being unavailable', () => {
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: () => {
          throw new Error('SecurityError');
        },
        setItem: () => {
          throw new Error('QuotaExceededError');
        },
        removeItem: () => {
          throw new Error('SecurityError');
        },
      },
    };

    const now = new Date('2026-07-31T12:00:00Z');
    expect(() => savePreferences(defaultPreferences(now))).not.toThrow();
    expect(() => clearPreferences()).not.toThrow();
    expect(loadPreferences(now)).toEqual(defaultPreferences(now));
  });
});
