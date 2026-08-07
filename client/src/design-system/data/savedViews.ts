/**
 * Saved views.
 *
 * A SAVED VIEW IS A QUESTION, NOT AN ANSWER. It stores the FILTER that produced
 * a set of rows and never the rows themselves, so "SLA risk — 5" re-counts every
 * time it is opened. Storing the result set is the tempting shortcut and it is
 * the one that makes an operational shortcut lie: a card that said 5 last Tuesday
 * still says 5 today, and the queue it points at has moved on.
 *
 * That is also why nothing here caches a count. The count belongs to whoever
 * renders the view, taken from the same read the screen uses.
 */

/** One clause. Deliberately narrow — a saved view is a filter, not a query language. */
export interface FilterClause {
  field: string;
  op: 'eq' | 'neq' | 'in' | 'gte' | 'lte';
  value: string | number | string[];
}

export interface SavedView {
  id: string;
  name: string;
  /** The entity the view lists, e.g. 'capture' or 'lead'. */
  subject: string;
  filters: FilterClause[];
  /** Column to sort by, and which way. */
  sort?: { field: string; direction: 'asc' | 'desc' };
  /** Shipped with the product rather than authored by the operator. */
  builtIn?: boolean;
}

const STORAGE_KEY = 'leadflow.savedViews';

/** Views that ship with the product, matching the mockup's shortcut cards. */
export const BUILT_IN_VIEWS: SavedView[] = [
  {
    id: 'view:unresolved',
    name: 'Unresolved captures',
    subject: 'capture',
    filters: [{ field: 'trustState', op: 'in', value: ['P0_CAPTURED', 'P1_NORMALIZED', 'P2_CANDIDATE'] }],
    sort: { field: 'ageMinutes', direction: 'desc' },
    builtIn: true,
  },
  {
    id: 'view:sla-risk',
    name: 'SLA risk',
    subject: 'capture',
    filters: [{ field: 'ageMinutes', op: 'gte', value: 24 * 60 }],
    sort: { field: 'ageMinutes', direction: 'desc' },
    builtIn: true,
  },
  {
    id: 'view:browser-captures',
    name: 'Browser captures',
    subject: 'capture',
    filters: [{ field: 'captureSource', op: 'eq', value: 'browser_extension' }],
    builtIn: true,
  },
  {
    id: 'view:unowned-leads',
    name: 'Leads with no owner',
    subject: 'lead',
    filters: [{ field: 'owner_user_id', op: 'eq', value: '' }],
    sort: { field: 'created_at', direction: 'asc' },
    builtIn: true,
  },
];

/**
 * Apply a view's filters to rows already in hand.
 *
 * CLIENT-SIDE ONLY, and that is a deliberate limit rather than an oversight: it
 * narrows the page you have, it does not reach past it. A view that claims to
 * filter the whole dataset while only seeing 50 loaded rows would show a
 * confident heading over an incomplete answer. Server-side filtering belongs in
 * the endpoint, and `toQueryParams` is how a view asks for it.
 */
export function applyView<T extends Record<string, unknown>>(view: SavedView, rows: T[]): T[] {
  return rows.filter((row) =>
    view.filters.every((clause) => {
      const actual = row[clause.field];
      switch (clause.op) {
        case 'eq':
          return actual === clause.value;
        case 'neq':
          return actual !== clause.value;
        case 'in':
          return Array.isArray(clause.value) && clause.value.includes(String(actual));
        case 'gte':
          return typeof actual === 'number' && actual >= Number(clause.value);
        case 'lte':
          return typeof actual === 'number' && actual <= Number(clause.value);
        default:
          // An operator nobody implemented excludes the row rather than passing
          // it: a filter that silently does nothing is how a governed queue
          // shows records it was supposed to hide.
          return false;
      }
    }),
  );
}

/** The view as query parameters, for the endpoints that can filter server side. */
export function toQueryParams(view: SavedView): Record<string, string> {
  const params: Record<string, string> = {};
  for (const clause of view.filters) {
    params[clause.field] = Array.isArray(clause.value)
      ? clause.value.join(',')
      : String(clause.value);
  }
  if (view.sort) params.sort = `${view.sort.field}:${view.sort.direction}`;
  return params;
}

/**
 * Read the operator's own views, with the built-ins always present.
 *
 * Built-ins are not persisted, so shipping a new one reaches everybody and
 * editing one cannot be stranded in a stale localStorage copy.
 */
export function loadViews(storage?: Storage): SavedView[] {
  const store = storage ?? (typeof window === 'undefined' ? undefined : window.localStorage);
  if (!store) return [...BUILT_IN_VIEWS];
  try {
    const raw = JSON.parse(store.getItem(STORAGE_KEY) ?? '[]') as SavedView[];
    const custom = Array.isArray(raw) ? raw.filter((v) => v && v.id && !v.builtIn) : [];
    return [...BUILT_IN_VIEWS, ...custom];
  } catch {
    // A corrupt entry loses the operator's own views, not the product's.
    return [...BUILT_IN_VIEWS];
  }
}

export function saveView(view: SavedView, storage?: Storage): SavedView[] {
  const store = storage ?? (typeof window === 'undefined' ? undefined : window.localStorage);
  const custom = loadViews(store).filter((v) => !v.builtIn && v.id !== view.id);
  const next = [...custom, { ...view, builtIn: false }];
  try {
    store?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Quota or private mode. The view is lost, the screen is not.
  }
  return [...BUILT_IN_VIEWS, ...next];
}
