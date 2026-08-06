import { AppError } from '../../utils/errors';

/** The trust ladder, in order. */
export const TRUST_STATES = [
  'P0_CAPTURED',
  'P1_NORMALIZED',
  'P2_CANDIDATE',
  'P3_LINKED',
  'P4_DIRECT',
] as const;
export type TrustState = (typeof TRUST_STATES)[number];

/** Where a capture came from. */
export const ORIGIN_CLASSES = [
  'USER_PROVIDED',
  'FIRST_PARTY_DIRECT',
  'TENANT_FIRST_PARTY_CRM',
  'USER_AUTHORIZED_CONTACT_STORE',
  'PUBLIC_RECORD',
  'LICENSED_THIRD_PARTY',
  'PARTNER_PROVIDED',
  'UNKNOWN_QUARANTINED',
] as const;
export type OriginClass = (typeof ORIGIN_CLASSES)[number];

/** Most rows one page may return. */
export const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 25;

/**
 * How many recent captures the counting window holds.
 *
 * The six tiles are counted over this window rather than over the tenant's
 * whole history, because the inbox is a triage queue: a record captured last
 * quarter is not outstanding work, and a tile that keeps climbing forever
 * stops being a number anybody acts on. Larger than any page so a drill-in
 * never shrinks the tiles.
 */
export const COUNT_WINDOW = 500;

/**
 * When a capture is old enough to be at risk — the mockup's "Older than 24
 * hours". Used only as the fallback when sdk-sla cannot be reached.
 */
export const SLA_RISK_MINUTES = 24 * 60;

/**
 * The capture surfaces the breakdown panel lists, in the mockup's order.
 *
 * Keyed off `source_system` — the value each LeadFlow capture path stamps on
 * the source record it posts upstream — with `capture_kind` splitting the
 * offline sync, which carries several kinds under one system name.
 *
 * EMAIL SIGNATURE HAS NO CAPTURE PATH YET. It is listed because the panel is
 * an inventory of the surfaces the product claims to support, and a row that
 * reads 0 says "nothing arrived this way" where a missing row says nothing at
 * all — the second is how a broken ingestion path stays invisible.
 */
export const CAPTURE_SOURCES = [
  { key: 'quick_add', label: 'Quick Add' },
  { key: 'browser_extension', label: 'Browser extension' },
  { key: 'mobile_contacts', label: 'Mobile contacts' },
  { key: 'email_signature', label: 'Email signature' },
  { key: 'business_card', label: 'Business card' },
] as const;

export type CaptureSourceKey = (typeof CAPTURE_SOURCES)[number]['key'] | 'other';

/**
 * Which surface a source record arrived through.
 *
 * Anything unrecognised is `other` rather than being forced into the nearest
 * bucket: an import or a partner feed is not a quick add, and quietly counting
 * it as one would overstate a channel nobody used.
 */
export function captureSourceFor(
  sourceSystem: string | undefined,
  captureKind: string | undefined
): CaptureSourceKey {
  switch (sourceSystem) {
    case 'leadflow':
      return 'quick_add';
    case 'leadflow-extension':
      return 'browser_extension';
    case 'leadflow-offline':
      // One system name, several kinds — the device says which.
      return captureKind === 'business_card' ? 'business_card' : 'mobile_contacts';
    case 'leadflow-email-signature':
      return 'email_signature';
    default:
      return 'other';
  }
}

/**
 * Where the next page starts.
 *
 * A COMPOSITE of the row's timestamp AND its id, not the timestamp alone.
 * Captures arrive in bursts and two can share a millisecond; a cursor on time
 * alone would either skip the second one or return it twice, depending on which
 * side of the comparison it landed. The id breaks the tie deterministically.
 */
export interface InboxCursor {
  createdAt: string;
  sourceRecordId: string;
}

export interface InboxQuery {
  limit: number;
  trustState: TrustState | null;
  originClass: OriginClass | null;
  cursor: InboxCursor | null;
}

/** Encode a cursor for the wire. */
export function encodeCursor(cursor: InboxCursor): string {
  return Buffer.from(`${cursor.createdAt}|${cursor.sourceRecordId}`, 'utf8').toString('base64url');
}

/**
 * Decode a cursor, refusing anything malformed.
 *
 * A bad cursor is a 400, NOT a silent restart from page one. Silently
 * restarting looks like it worked and quietly re-serves rows the operator has
 * already triaged, which in a queue means duplicated work rather than a visible
 * error.
 */
export function decodeCursor(raw: string): InboxCursor {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    throw AppError.badRequest('cursor is not a valid cursor');
  }

  // FIRST separator, not the last. The timestamp is a fixed-format ISO string
  // and can never contain a pipe, whereas an upstream id might — splitting from
  // the right would then hand the tail of the id to Date.parse and reject a
  // perfectly good cursor.
  const separator = decoded.indexOf('|');
  if (separator <= 0 || separator === decoded.length - 1) {
    throw AppError.badRequest('cursor is not a valid cursor');
  }

  const createdAt = decoded.slice(0, separator);
  const sourceRecordId = decoded.slice(separator + 1);

  if (Number.isNaN(Date.parse(createdAt))) {
    throw AppError.badRequest('cursor is not a valid cursor');
  }

  return { createdAt, sourceRecordId };
}

/**
 * Is this row strictly past the cursor, in the queue's own newest-first order?
 *
 * COMPARES THE PAIR, not the timestamp alone. Two captures sharing a
 * millisecond would otherwise both be "not past" the first one's cursor and the
 * second would be served twice, or both be "past" it and the first would be
 * skipped — which in a triage queue means either duplicated work or a capture
 * nobody ever sees. The id decides the tie, using the same ordering the page
 * itself is sorted by.
 */
export function isAfterCursor(row: InboxCursor, cursor: InboxCursor): boolean {
  const rowTime = Date.parse(row.createdAt) || 0;
  const cursorTime = Date.parse(cursor.createdAt) || 0;
  if (rowTime !== cursorTime) {
    return rowTime < cursorTime;
  }
  return row.sourceRecordId.localeCompare(cursor.sourceRecordId) < 0;
}

/**
 * Validate the query string.
 *
 * Unknown enum values are rejected rather than ignored. Dropping an
 * unrecognised filter would answer a DIFFERENT question than the one asked —
 * the operator filters to LICENSED_THIRD_PARTY, mistypes it, and is shown every
 * capture while believing they are looking at one origin class.
 *
 * @throws AppError(400 VALIDATION_ERROR)
 */
export function parseInboxQuery(raw: Record<string, unknown>): InboxQuery {
  const limitRaw = raw.limit;
  let limit = DEFAULT_LIMIT;
  if (limitRaw !== undefined && limitRaw !== '') {
    limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw AppError.badRequest(`limit must be an integer between 1 and ${MAX_LIMIT}`);
    }
  }

  const trustStateRaw = raw.trust_state;
  let trustState: TrustState | null = null;
  if (typeof trustStateRaw === 'string' && trustStateRaw !== '') {
    if (!TRUST_STATES.includes(trustStateRaw as TrustState)) {
      throw AppError.badRequest(`trust_state must be one of ${TRUST_STATES.join(', ')}`);
    }
    trustState = trustStateRaw as TrustState;
  }

  const originRaw = raw.origin_class;
  let originClass: OriginClass | null = null;
  if (typeof originRaw === 'string' && originRaw !== '') {
    if (!ORIGIN_CLASSES.includes(originRaw as OriginClass)) {
      throw AppError.badRequest(`origin_class must be one of ${ORIGIN_CLASSES.join(', ')}`);
    }
    originClass = originRaw as OriginClass;
  }

  const cursorRaw = raw.cursor;
  const cursor =
    typeof cursorRaw === 'string' && cursorRaw !== '' ? decodeCursor(cursorRaw) : null;

  return { limit, trustState, originClass, cursor };
}

/**
 * The actions a trust state permits, before the caller's authority is applied.
 *
 * A record that has not been normalized cannot be promoted, and a linked one
 * cannot be re-normalized. This is the state machine's own answer, independent
 * of who is asking.
 */
export function actionsForTrustState(state: TrustState): string[] {
  switch (state) {
    case 'P0_CAPTURED':
      return ['source_record.normalize', 'suppression.apply'];
    case 'P1_NORMALIZED':
      return ['source_record.promote', 'suppression.apply'];
    case 'P2_CANDIDATE':
      return ['source_record.promote', 'identity.link.verify', 'suppression.apply'];
    case 'P3_LINKED':
      return ['source_record.promote', 'suppression.apply'];
    case 'P4_DIRECT':
      // Fully trusted: nothing left to promote, and suppression still applies
      // because a person may always ask to stop being contacted.
      return ['suppression.apply'];
    default:
      return [];
  }
}

/**
 * What this caller may actually do to this row.
 *
 * THE INTERSECTION of what the state allows and what policy permits. Offering
 * an action the state forbids produces a confusing failure; offering one the
 * caller lacks authority for produces a refusal on click, which teaches people
 * that the buttons lie. Both halves are needed, and neither alone is enough.
 *
 * @param state          The row's trust state.
 * @param permitted      Actions the PDP permitted for this caller.
 */
export function availableActions(state: TrustState, permitted: Set<string>): string[] {
  return actionsForTrustState(state).filter((action) => permitted.has(action));
}
