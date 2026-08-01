import { AppError } from '../utils/errors';
import { validateUuidParam } from './routingValidators';
import { LeadSourceChannel } from '../types';

/**
 * The fourteen capture channels a lead can arrive through.
 *
 * Declared locally rather than imported from another validator, matching the
 * precedent in `slaValidators.ts`: each validator owns its own list so it does
 * not depend on an unrelated module, and the `LeadSourceChannel` annotation
 * makes the compiler reject any list that drifts from the union.
 */
const SOURCE_CHANNELS: readonly LeadSourceChannel[] = [
  'web_form',
  'landing_page',
  'facebook',
  'instagram',
  'linkedin',
  'tiktok',
  'google_ads',
  'live_chat',
  'phone',
  'email',
  'referral',
  'webhook',
  'api',
  'csv_import',
];

/** Reporting window used when the caller bounds neither end. */
const DEFAULT_WINDOW_DAYS = 30;

/**
 * Longest window the endpoint will aggregate over.
 *
 * A year plus a day, so a caller can ask for "the last twelve months" across a
 * leap year without being rejected by an off-by-one. Beyond that the per-day
 * series stops being something a dashboard can render and the query stops being
 * something a single request should do.
 */
const MAX_WINDOW_DAYS = 366;

const MS_PER_DAY = 86_400_000;

export interface AnalyticsOverviewQuery {
  /** Inclusive start of the reporting window, by lead arrival. */
  from: Date;
  /** Exclusive end of the reporting window, by lead arrival. */
  to: Date;
  /** Narrow to one capture channel. */
  source?: LeadSourceChannel;
  /** Narrow to one representative's queue. */
  owner_user_id?: string;
}

/**
 * Parse one end of the reporting window.
 *
 * Accepts a date (`2026-07-30`) or a full ISO 8601 instant, because a dashboard
 * date picker sends the former and a saved view round-trips the latter.
 *
 * `new Date(...)` is deliberately checked with `Number.isNaN` rather than
 * trusted: it answers `Invalid Date` for unparseable input instead of throwing,
 * so an unchecked value would flow into the SQL as a null bound and silently
 * widen the window to everything — a wrong answer that looks like a right one.
 */
function parseBound(field: string, raw: unknown): Date {
  const parsed = new Date(String(raw));
  if (Number.isNaN(parsed.getTime())) {
    throw AppError.badRequest(`'${field}' must be an ISO 8601 date or datetime`, { field });
  }
  return parsed;
}

/**
 * Validate the analytics overview query string.
 *
 * Every filter is optional and they combine. Omitting both bounds reports the
 * last 30 days, which is what the dashboard opens on.
 *
 * @param query Raw `req.query`.
 * @throws AppError(400 VALIDATION_ERROR) on an unparseable bound, an inverted or
 *         over-long range, an unknown source channel, or a malformed owner id.
 */
export function validateAnalyticsOverviewQuery(
  query: Record<string, unknown>
): AnalyticsOverviewQuery {
  const now = new Date();

  const hasFrom = query.from !== undefined && query.from !== null && query.from !== '';
  const hasTo = query.to !== undefined && query.to !== null && query.to !== '';

  const to = hasTo ? parseBound('to', query.to) : now;
  const from = hasFrom
    ? parseBound('from', query.from)
    : new Date(to.getTime() - DEFAULT_WINDOW_DAYS * MS_PER_DAY);

  // Strictly after, not "not before": a zero-width window can only ever report
  // an empty result, so accepting it would answer a question the caller did not
  // mean to ask rather than telling them the range is wrong.
  if (to.getTime() <= from.getTime()) {
    throw AppError.badRequest("'to' must be after 'from'", { field: 'to' });
  }

  if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * MS_PER_DAY) {
    throw AppError.badRequest(`The reporting window cannot exceed ${MAX_WINDOW_DAYS} days`, {
      field: 'from',
    });
  }

  let source: LeadSourceChannel | undefined;
  if (query.source !== undefined && query.source !== null && query.source !== '') {
    const candidate = String(query.source);
    if (!SOURCE_CHANNELS.includes(candidate as LeadSourceChannel)) {
      throw AppError.badRequest(`'source' must be one of: ${SOURCE_CHANNELS.join(', ')}`, {
        field: 'source',
      });
    }
    source = candidate as LeadSourceChannel;
  }

  let ownerUserId: string | undefined;
  if (
    query.owner_user_id !== undefined &&
    query.owner_user_id !== null &&
    query.owner_user_id !== ''
  ) {
    ownerUserId = validateUuidParam('owner_user_id', query.owner_user_id);
  }

  return { from, to, source, owner_user_id: ownerUserId };
}

export { SOURCE_CHANNELS, DEFAULT_WINDOW_DAYS, MAX_WINDOW_DAYS };
