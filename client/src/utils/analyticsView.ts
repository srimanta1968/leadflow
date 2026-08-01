import { AnalyticsOverview, LeadSource } from '../services/api';
import { SOURCE_OPTIONS } from '../content/leadFields';

/**
 * How the analytics dashboard is filtered, sorted and ordered — and how that
 * choice survives a reload.
 *
 * Filtering is the SERVER's job: `from`, `to`, `source` and `owner_user_id` are
 * query parameters on `GET /api/analytics/overview`, because narrowing the
 * window has to change the aggregate itself, not just which rows are shown.
 * Sorting is the CLIENT's job: `by_source` is at most fourteen rows and `daily`
 * at most a year of them, so re-ordering what has already been fetched is
 * instant, where a round trip would make every column click wait on a fresh
 * aggregate query.
 *
 * The whole selection is a stated preference rather than a transient control
 * state: an operator who works one channel opens this screen on that channel
 * every morning, and re-picking four filters each time is the kind of friction
 * that ends with the dashboard going unused.
 *
 * Every function here is pure or storage-only so the ordering rules can be
 * asserted directly in `client/tests/unit/analyticsView.test.ts` — the rules
 * about where nulls land and how ties break are exactly the ones that rot
 * silently inside a component.
 */

/** One channel's row in the by-source breakdown. */
export type SourceRow = AnalyticsOverview['by_source'][number];

/** One day's row in the daily series. */
export type DailyRow = AnalyticsOverview['daily'][number];

/** Columns of the by-source table a viewer can sort on. */
export type SourceSortKey =
  | 'source'
  | 'captured'
  | 'responded'
  | 'breached'
  | 'average_response_seconds';

export type SortDirection = 'asc' | 'desc';

export interface SourceSort {
  key: SourceSortKey;
  direction: SortDirection;
}

/** Which end of the window the daily series starts from. */
export type DailyOrder = 'newest' | 'oldest';

/** The filter and ordering choices the dashboard remembers for a viewer. */
export interface AnalyticsPreferences {
  /** Inclusive start of the window, `YYYY-MM-DD`. */
  from: string;
  /** Exclusive end of the window, `YYYY-MM-DD`. */
  to: string;
  /** A capture channel, or `''` for every channel. */
  source: string;
  /** An owner's user id, or `''` for everyone. */
  owner_user_id: string;
  sourceSort: SourceSort;
  dailyOrder: DailyOrder;
}

const SOURCE_SORT_KEYS: readonly SourceSortKey[] = [
  'source',
  'captured',
  'responded',
  'breached',
  'average_response_seconds',
];

const SOURCE_VALUES: readonly string[] = SOURCE_OPTIONS.map((option) => option.value);

/**
 * Storage key, versioned.
 *
 * The `.v1` suffix is what lets the shape change later without a stored value
 * from an older build being read as the new one — a bumped key is simply absent
 * and falls back to the defaults, where a reused key would deserialise into a
 * half-valid object.
 */
export const PREFERENCES_STORAGE_KEY = 'leadflow.analytics.view.v1';

/** Reporting window the dashboard opens on when nothing is stored. */
export const DEFAULT_WINDOW_DAYS = 30;

const MS_PER_DAY = 86_400_000;

/** `YYYY-MM-DD` for a date input, in the viewer's own timezone. */
export function toDateInput(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

/**
 * The selection a viewer with no stored preference sees.
 *
 * `to` is tomorrow rather than today because the server treats the upper bound
 * as exclusive: ending the window at today's date would omit every lead that
 * arrived today, which is the opposite of what "last 30 days" means to the
 * person reading it.
 *
 * @param now Injectable clock, so the defaults are assertable.
 */
export function defaultPreferences(now: Date = new Date()): AnalyticsPreferences {
  return {
    from: toDateInput(new Date(now.getTime() - DEFAULT_WINDOW_DAYS * MS_PER_DAY)),
    to: toDateInput(new Date(now.getTime() + MS_PER_DAY)),
    source: '',
    owner_user_id: '',
    sourceSort: { key: 'captured', direction: 'desc' },
    dailyOrder: 'newest',
  };
}

/** A window of `days` ending tomorrow, leaving the other choices untouched. */
export function withWindow(
  preferences: AnalyticsPreferences,
  days: number,
  now: Date = new Date()
): AnalyticsPreferences {
  return {
    ...preferences,
    from: toDateInput(new Date(now.getTime() - days * MS_PER_DAY)),
    to: toDateInput(new Date(now.getTime() + MS_PER_DAY)),
  };
}

/**
 * The direction a column takes when its header is clicked.
 *
 * Clicking the ACTIVE column flips it. Clicking a different one starts from the
 * direction that column is normally read in: the channel name ascending, so it
 * reads alphabetically, and every count descending, so the biggest number — the
 * busiest channel, the worst breach count, the slowest response — is at the top
 * where somebody looking for a problem will find it.
 */
export function nextSourceSort(current: SourceSort, key: SourceSortKey): SourceSort {
  if (current.key === key) {
    return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
  }
  return { key, direction: key === 'source' ? 'asc' : 'desc' };
}

/**
 * Compare two numbers where either may be null, keeping nulls last.
 *
 * A null `average_response_seconds` means nothing in that channel has been
 * answered yet. That is not a fast time and not a slow one, so it must not sort
 * as either extreme: treating it as zero would put unanswered channels at the
 * top of "fastest first" and treating it as infinity would put them at the top
 * of "slowest first". Both readings are wrong, so nulls sink to the bottom in
 * BOTH directions and the ranking above them stays meaningful.
 *
 * @returns Negative when `a` sorts first, positive when `b` does, 0 when the
 *          caller must fall through to its tiebreaker.
 */
function compareNullable(a: number | null, b: number | null, direction: SortDirection): number {
  if (a === null && b === null) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  return direction === 'asc' ? a - b : b - a;
}

/**
 * Order the by-source breakdown.
 *
 * Returns a new array; the caller's rollup is left alone so a re-sort never
 * mutates the state React is rendering from.
 *
 * Ties break on captured descending and then on the label, so two channels with
 * the same breach count always come out in the same order. Without that, a
 * re-render after a push event could reshuffle equal rows and make a static
 * table appear to twitch on its own.
 *
 * @param rows      The rollup's `by_source` array.
 * @param sort      Column and direction.
 * @param labelFor  Resolves a channel to the text actually rendered, so sorting
 *                  by name matches what the viewer reads rather than the
 *                  underlying enum (`Live chat`, not `live_chat`).
 */
export function sortSourceRows(
  rows: readonly SourceRow[],
  sort: SourceSort,
  labelFor: (source: LeadSource | null) => string
): SourceRow[] {
  const sorted = [...rows];

  sorted.sort((left, right) => {
    let verdict = 0;

    if (sort.key === 'source') {
      verdict = labelFor(left.source).localeCompare(labelFor(right.source));
      if (sort.direction === 'desc') {
        verdict = -verdict;
      }
    } else {
      verdict = compareNullable(left[sort.key], right[sort.key], sort.direction);
    }

    if (verdict !== 0) {
      return verdict;
    }
    if (left.captured !== right.captured) {
      return right.captured - left.captured;
    }
    return labelFor(left.source).localeCompare(labelFor(right.source));
  });

  return sorted;
}

/**
 * Order the daily series.
 *
 * The server returns it oldest-first, which is the right shape for a trend line
 * and the wrong one for a list: somebody checking a dashboard wants to know what
 * happened today without scrolling past a year of history, so newest-first is
 * the default and the other order stays one click away.
 */
export function orderDailyRows(rows: readonly DailyRow[], order: DailyOrder): DailyRow[] {
  const ordered = [...rows];
  ordered.sort((left, right) =>
    order === 'newest' ? right.day.localeCompare(left.day) : left.day.localeCompare(right.day)
  );
  return ordered;
}

/** The `aria-sort` value for a column header, for screen readers. */
export function ariaSortFor(
  sort: SourceSort,
  key: SourceSortKey
): 'ascending' | 'descending' | 'none' {
  if (sort.key !== key) {
    return 'none';
  }
  return sort.direction === 'asc' ? 'ascending' : 'descending';
}

/** True for a `YYYY-MM-DD` string naming a real calendar date. */
function isDateInput(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  // `new Date('2026-02-31')` rolls over to 3 March rather than failing, so the
  // round trip is what actually rejects an impossible date.
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Rebuild a stored preference into a usable one, field by field.
 *
 * Every field is validated INDEPENDENTLY and falls back on its own. A stored
 * blob is not trusted input: it survives across deployments, it is trivially
 * editable in devtools, and a value that no longer exists — a channel removed
 * from the vocabulary, a sort key renamed — would otherwise reach the query
 * string or the sort comparator. Falling back per field rather than discarding
 * the whole object means one stale value costs that one choice, not the
 * viewer's entire saved view.
 *
 * @param raw      Whatever was parsed out of storage.
 * @param fallback The defaults to draw missing or invalid fields from.
 */
export function coercePreferences(raw: unknown, fallback: AnalyticsPreferences): AnalyticsPreferences {
  if (typeof raw !== 'object' || raw === null) {
    return fallback;
  }
  const candidate = raw as Record<string, unknown>;
  const storedSort = (candidate.sourceSort ?? {}) as Record<string, unknown>;

  const from = isDateInput(candidate.from) ? candidate.from : fallback.from;
  const to = isDateInput(candidate.to) ? candidate.to : fallback.to;

  return {
    // An inverted window is rejected as a PAIR: each bound is a valid date on
    // its own, so only comparing them catches a stored range the server would
    // answer with a 400 — which would greet the viewer with an error on a screen
    // they had merely reopened.
    from: from < to ? from : fallback.from,
    to: from < to ? to : fallback.to,
    source:
      typeof candidate.source === 'string' && SOURCE_VALUES.includes(candidate.source)
        ? candidate.source
        : fallback.source,
    owner_user_id:
      typeof candidate.owner_user_id === 'string' && UUID_PATTERN.test(candidate.owner_user_id)
        ? candidate.owner_user_id
        : fallback.owner_user_id,
    sourceSort: {
      key: SOURCE_SORT_KEYS.includes(storedSort.key as SourceSortKey)
        ? (storedSort.key as SourceSortKey)
        : fallback.sourceSort.key,
      direction:
        storedSort.direction === 'asc' || storedSort.direction === 'desc'
          ? storedSort.direction
          : fallback.sourceSort.direction,
    },
    dailyOrder:
      candidate.dailyOrder === 'newest' || candidate.dailyOrder === 'oldest'
        ? candidate.dailyOrder
        : fallback.dailyOrder,
  };
}

/**
 * Read the stored view, or the defaults when there is nothing usable.
 *
 * @param now Injectable clock for the default window.
 */
export function loadPreferences(now: Date = new Date()): AnalyticsPreferences {
  const fallback = defaultPreferences(now);
  try {
    const stored = window.localStorage.getItem(PREFERENCES_STORAGE_KEY);
    if (stored === null) {
      return fallback;
    }
    return coercePreferences(JSON.parse(stored), fallback);
  } catch {
    // Unparseable JSON, or storage refused outright in a private window. Either
    // way the dashboard opens on the defaults rather than failing to render.
    return fallback;
  }
}

/** Persist the view. Silently a no-op where storage is unavailable. */
export function savePreferences(preferences: AnalyticsPreferences): void {
  try {
    window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // A preference that does not survive a reload is a small loss; a dashboard
    // that throws while saving one is a large one.
  }
}

/** Forget the stored view, so the next visit opens on the defaults. */
export function clearPreferences(): void {
  try {
    window.localStorage.removeItem(PREFERENCES_STORAGE_KEY);
  } catch {
    // Nothing to do: if storage cannot be written it cannot be holding a value.
  }
}
