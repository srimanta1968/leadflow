import { AppError } from '../utils/errors';
import { validateUuidParam } from './routingValidators';
import {
  FirstResponseInput,
  LeadSourceChannel,
  ResponseChannel,
  SlaAlertKind,
  SlaAlertState,
} from '../types';

/**
 * The fourteen capture channels a lead can arrive through, matching
 * SOURCE_CHANNELS in leadValidators.ts and routingValidators.ts.
 *
 * Duplicated as a local constant rather than imported from a validator so this
 * module does not depend on an unrelated one; the three lists are checked
 * against `LeadSourceChannel` by the compiler, so they cannot silently diverge.
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

/**
 * Bounds on a first-response target, in minutes.
 *
 * A zero-minute target would breach on arrival, and a target beyond a week is
 * not an SLA anyone monitors. Mirrored by a CHECK constraint in migration 005 so
 * a direct INSERT cannot create a policy the application would refuse.
 */
const MIN_TARGET_MINUTES = 1;
const MAX_TARGET_MINUTES = 10080;
const MIN_EVALUATION_ORDER = 0;
const MAX_EVALUATION_ORDER = 100000;

/**
 * Channels a valid human first response can arrive through.
 *
 * Narrower than the fourteen capture channels on purpose: a lead can ARRIVE
 * from an ad platform or a CSV import, but a human cannot RESPOND through one.
 * Recording `google_ads` as a response channel would make the response-time
 * analysis meaningless.
 */
export const RESPONSE_CHANNELS: readonly ResponseChannel[] = [
  'email',
  'phone',
  'sms',
  'live_chat',
  'linkedin',
  'meeting',
];

/** Reporting window bounds for GET /api/sla/status, in minutes. */
const MIN_WINDOW_MINUTES = 1;
const MAX_WINDOW_MINUTES = 10080; // one week
export const DEFAULT_WINDOW_MINUTES = 1440; // 24 hours

/** Sweep size bounds for POST /api/sla/evaluate. */
const MIN_SWEEP_LIMIT = 1;
const MAX_SWEEP_LIMIT = 500;
export const DEFAULT_SWEEP_LIMIT = 100;

/**
 * Validate a POST /api/leads/:id/first-response body.
 *
 * `channel` is required rather than defaulted: "how did we reach them" is the
 * field an auditor reads when a prospect disputes that anyone responded, and a
 * guessed default would quietly invent that evidence.
 *
 * @throws AppError(400 VALIDATION_ERROR) when a field is missing or malformed.
 */
export function validateFirstResponse(body: Record<string, unknown>): FirstResponseInput {
  const channel = body.channel;
  if (typeof channel !== 'string' || !RESPONSE_CHANNELS.includes(channel as ResponseChannel)) {
    throw AppError.badRequest(`'channel' must be one of: ${RESPONSE_CHANNELS.join(', ')}`, {
      field: 'channel',
      allowed: RESPONSE_CHANNELS,
    });
  }

  let note: string | undefined;
  const rawNote = body.note;
  if (rawNote !== undefined && rawNote !== null && rawNote !== '') {
    if (typeof rawNote !== 'string') {
      throw AppError.badRequest("'note' must be a string", { field: 'note' });
    }
    if (rawNote.trim().length > 500) {
      throw AppError.badRequest("'note' must be at most 500 characters", { field: 'note' });
    }
    note = rawNote.trim();
  }

  let respondedBy: string | undefined;
  const rawResponder = body.responded_by_user_id;
  if (rawResponder !== undefined && rawResponder !== null && rawResponder !== '') {
    respondedBy = validateUuidParam('responded_by_user_id', rawResponder);
  }

  return {
    channel: channel as ResponseChannel,
    note,
    responded_by_user_id: respondedBy,
  };
}

export interface SlaStatusQuery {
  window_minutes: number;
  owner_user_id?: string;
}

/**
 * Validate the GET /api/sla/status query string.
 *
 * An out-of-range or non-numeric `window_minutes` is REJECTED rather than
 * silently clamped. A manager who asks for a window and is quietly given a
 * different one reads the resulting compliance number as if it answered the
 * question they asked.
 *
 * @throws AppError(400 VALIDATION_ERROR) when a parameter is malformed.
 */
export function validateSlaStatusQuery(query: Record<string, unknown>): SlaStatusQuery {
  let windowMinutes = DEFAULT_WINDOW_MINUTES;
  const rawWindow = query.window_minutes;
  if (rawWindow !== undefined && rawWindow !== null && rawWindow !== '') {
    const parsed = Number(rawWindow);
    if (
      !Number.isInteger(parsed) ||
      parsed < MIN_WINDOW_MINUTES ||
      parsed > MAX_WINDOW_MINUTES
    ) {
      throw AppError.badRequest(
        `'window_minutes' must be an integer between ${MIN_WINDOW_MINUTES} and ${MAX_WINDOW_MINUTES}`,
        { field: 'window_minutes' }
      );
    }
    windowMinutes = parsed;
  }

  let ownerUserId: string | undefined;
  const rawOwner = query.owner_user_id;
  if (rawOwner !== undefined && rawOwner !== null && rawOwner !== '') {
    ownerUserId = validateUuidParam('owner_user_id', rawOwner);
  }

  return { window_minutes: windowMinutes, owner_user_id: ownerUserId };
}

export interface SlaEvaluateInput {
  lead_id?: string;
  limit: number;
}

/**
 * Validate a POST /api/sla/evaluate body.
 *
 * Both fields are optional: the bare sweep is the scheduled path, and `lead_id`
 * narrows it to the single lead an operator or a webhook is asking about.
 *
 * @throws AppError(400 VALIDATION_ERROR) when a field is malformed.
 */
export function validateSlaEvaluate(body: Record<string, unknown>): SlaEvaluateInput {
  let leadId: string | undefined;
  const rawLeadId = body.lead_id;
  if (rawLeadId !== undefined && rawLeadId !== null && rawLeadId !== '') {
    leadId = validateUuidParam('lead_id', rawLeadId);
  }

  let limit = DEFAULT_SWEEP_LIMIT;
  const rawLimit = body.limit;
  if (rawLimit !== undefined && rawLimit !== null && rawLimit !== '') {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < MIN_SWEEP_LIMIT || parsed > MAX_SWEEP_LIMIT) {
      throw AppError.badRequest(
        `'limit' must be an integer between ${MIN_SWEEP_LIMIT} and ${MAX_SWEEP_LIMIT}`,
        { field: 'limit' }
      );
    }
    limit = parsed;
  }

  return { lead_id: leadId, limit };
}

/** Shared field checks between policy create and policy update. */
function readTargetMinutes(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < MIN_TARGET_MINUTES || parsed > MAX_TARGET_MINUTES) {
    throw AppError.badRequest(
      `'first_response_minutes' must be an integer between ${MIN_TARGET_MINUTES} and ${MAX_TARGET_MINUTES}`,
      { field: 'first_response_minutes' }
    );
  }
  return parsed;
}

function readEvaluationOrder(value: unknown): number {
  const parsed = Number(value);
  if (
    !Number.isInteger(parsed) ||
    parsed < MIN_EVALUATION_ORDER ||
    parsed > MAX_EVALUATION_ORDER
  ) {
    throw AppError.badRequest(
      `'evaluation_order' must be an integer between ${MIN_EVALUATION_ORDER} and ${MAX_EVALUATION_ORDER}`,
      { field: 'evaluation_order' }
    );
  }
  return parsed;
}

function readName(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw AppError.badRequest("'name' must be a non-empty string", { field: 'name' });
  }
  if (value.trim().length > 160) {
    throw AppError.badRequest("'name' must be at most 160 characters", { field: 'name' });
  }
  return value.trim();
}

function readBoolean(field: string, value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw AppError.badRequest(`'${field}' must be a boolean`, { field });
  }
  return value;
}

export interface SlaPolicyInput {
  name: string;
  source_channel?: LeadSourceChannel | null;
  first_response_minutes: number;
  business_hours_only?: boolean;
  evaluation_order?: number;
  is_active?: boolean;
}

/**
 * Validate a POST /api/sla/policies body.
 *
 * `source_channel` is optional and its absence is meaningful: a policy without
 * one is the catch-all that governs every lead type nothing else claims.
 *
 * @throws AppError(400 VALIDATION_ERROR) when a field is missing or malformed.
 */
export function validateSlaPolicy(body: Record<string, unknown>): SlaPolicyInput {
  const name = readName(body.name);
  const firstResponseMinutes = readTargetMinutes(body.first_response_minutes);

  let sourceChannel: LeadSourceChannel | null = null;
  const rawChannel = body.source_channel;
  if (rawChannel !== undefined && rawChannel !== null && rawChannel !== '') {
    if (
      typeof rawChannel !== 'string' ||
      !SOURCE_CHANNELS.includes(rawChannel as LeadSourceChannel)
    ) {
      throw AppError.badRequest(`'source_channel' must be one of: ${SOURCE_CHANNELS.join(', ')}`, {
        field: 'source_channel',
        allowed: SOURCE_CHANNELS,
      });
    }
    sourceChannel = rawChannel as LeadSourceChannel;
  }

  return {
    name,
    source_channel: sourceChannel,
    first_response_minutes: firstResponseMinutes,
    business_hours_only:
      body.business_hours_only === undefined
        ? false
        : readBoolean('business_hours_only', body.business_hours_only),
    evaluation_order:
      body.evaluation_order === undefined ? 100 : readEvaluationOrder(body.evaluation_order),
    is_active: body.is_active === undefined ? true : readBoolean('is_active', body.is_active),
  };
}

export interface SlaPolicyUpdate {
  name?: string;
  source_channel?: LeadSourceChannel | null;
  first_response_minutes?: number;
  business_hours_only?: boolean;
  evaluation_order?: number;
  is_active?: boolean;
}

/**
 * Validate a PATCH /api/sla/policies/:id body.
 *
 * A partial update, so absence and null are DIFFERENT: an absent key leaves the
 * column alone, while an explicit null on `source_channel` turns a
 * channel-specific policy into the catch-all. At least one field must be
 * present — an empty patch is a caller mistake worth reporting.
 *
 * @throws AppError(400 VALIDATION_ERROR) when nothing is supplied or a field is
 *         malformed.
 */
export function validateSlaPolicyUpdate(body: Record<string, unknown>): SlaPolicyUpdate {
  const update: SlaPolicyUpdate = {};

  if ('name' in body) update.name = readName(body.name);

  if ('source_channel' in body) {
    const raw = body.source_channel;
    if (raw === null || raw === '') {
      // Explicit clear: the policy becomes the catch-all.
      update.source_channel = null;
    } else if (typeof raw !== 'string' || !SOURCE_CHANNELS.includes(raw as LeadSourceChannel)) {
      throw AppError.badRequest(
        `'source_channel' must be null or one of: ${SOURCE_CHANNELS.join(', ')}`,
        { field: 'source_channel', allowed: SOURCE_CHANNELS }
      );
    } else {
      update.source_channel = raw as LeadSourceChannel;
    }
  }

  if ('first_response_minutes' in body) {
    update.first_response_minutes = readTargetMinutes(body.first_response_minutes);
  }
  if ('business_hours_only' in body) {
    update.business_hours_only = readBoolean('business_hours_only', body.business_hours_only);
  }
  if ('evaluation_order' in body) {
    update.evaluation_order = readEvaluationOrder(body.evaluation_order);
  }
  if ('is_active' in body) {
    update.is_active = readBoolean('is_active', body.is_active);
  }

  if (Object.keys(update).length === 0) {
    throw AppError.badRequest(
      'Provide at least one of: name, source_channel, first_response_minutes, business_hours_only, evaluation_order, is_active'
    );
  }

  return update;
}

/** Escalation tiers, matching the CHECK constraint in migration 006. */
const ALERT_KINDS: readonly SlaAlertKind[] = ['owner_warning', 'manager_breach'];
/** Delivery states, matching the CHECK constraint in migration 006. */
const ALERT_STATES: readonly SlaAlertState[] = ['pending', 'delivered', 'acknowledged', 'failed'];

/** Alert ledger paging bounds. */
const MAX_ALERT_PAGE = 200;
export const DEFAULT_ALERT_PAGE = 50;

/** Retry-sweep bounds for POST /api/sla/alerts/dispatch. */
const MIN_DISPATCH_LIMIT = 1;
const MAX_DISPATCH_LIMIT = 500;
export const DEFAULT_DISPATCH_LIMIT = 100;

export interface SlaAlertQuery {
  state?: SlaAlertState;
  kind?: SlaAlertKind;
  lead_id?: string;
  limit: number;
  offset: number;
}

/**
 * Validate the GET /api/sla/alerts query string.
 *
 * An unknown `state` or `kind` is REJECTED rather than ignored: silently
 * dropping an unrecognised filter would return the WHOLE ledger to a caller who
 * asked for one slice of it, and a manager reading that as "these are the
 * breaches" would be badly misled.
 *
 * @throws AppError(400 VALIDATION_ERROR) when a parameter is malformed.
 */
export function validateSlaAlertQuery(query: Record<string, unknown>): SlaAlertQuery {
  const result: SlaAlertQuery = { limit: DEFAULT_ALERT_PAGE, offset: 0 };

  const rawState = query.state;
  if (rawState !== undefined && rawState !== null && rawState !== '') {
    if (typeof rawState !== 'string' || !ALERT_STATES.includes(rawState as SlaAlertState)) {
      throw AppError.badRequest(`'state' must be one of: ${ALERT_STATES.join(', ')}`, {
        field: 'state',
        allowed: ALERT_STATES,
      });
    }
    result.state = rawState as SlaAlertState;
  }

  const rawKind = query.kind;
  if (rawKind !== undefined && rawKind !== null && rawKind !== '') {
    if (typeof rawKind !== 'string' || !ALERT_KINDS.includes(rawKind as SlaAlertKind)) {
      throw AppError.badRequest(`'kind' must be one of: ${ALERT_KINDS.join(', ')}`, {
        field: 'kind',
        allowed: ALERT_KINDS,
      });
    }
    result.kind = rawKind as SlaAlertKind;
  }

  const rawLeadId = query.lead_id;
  if (rawLeadId !== undefined && rawLeadId !== null && rawLeadId !== '') {
    result.lead_id = validateUuidParam('lead_id', rawLeadId);
  }

  const rawLimit = query.limit;
  if (rawLimit !== undefined && rawLimit !== null && rawLimit !== '') {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_ALERT_PAGE) {
      throw AppError.badRequest(`'limit' must be an integer between 1 and ${MAX_ALERT_PAGE}`, {
        field: 'limit',
      });
    }
    result.limit = parsed;
  }

  const rawOffset = query.offset;
  if (rawOffset !== undefined && rawOffset !== null && rawOffset !== '') {
    const parsed = Number(rawOffset);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw AppError.badRequest("'offset' must be a non-negative integer", { field: 'offset' });
    }
    result.offset = parsed;
  }

  return result;
}

/**
 * Validate a POST /api/sla/alerts/acknowledge body.
 *
 * Only `lead_id` is accepted. The RECIPIENT is deliberately NOT a body field —
 * it comes from the verified session, so one manager cannot silence an
 * escalation addressed to another.
 *
 * @throws AppError(400 VALIDATION_ERROR) when lead_id is missing or malformed.
 */
export function validateAlertAcknowledge(body: Record<string, unknown>): { lead_id: string } {
  return { lead_id: validateUuidParam('lead_id', body.lead_id) };
}

/**
 * Validate a POST /api/sla/alerts/dispatch body.
 * @throws AppError(400 VALIDATION_ERROR) when limit is malformed.
 */
export function validateAlertDispatch(body: Record<string, unknown>): { limit: number } {
  let limit = DEFAULT_DISPATCH_LIMIT;
  const rawLimit = body.limit;
  if (rawLimit !== undefined && rawLimit !== null && rawLimit !== '') {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < MIN_DISPATCH_LIMIT || parsed > MAX_DISPATCH_LIMIT) {
      throw AppError.badRequest(
        `'limit' must be an integer between ${MIN_DISPATCH_LIMIT} and ${MAX_DISPATCH_LIMIT}`,
        { field: 'limit' }
      );
    }
    limit = parsed;
  }
  return { limit };
}
