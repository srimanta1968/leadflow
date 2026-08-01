import { AppError } from '../utils/errors';
import { LeadSourceChannel } from '../types';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The fourteen channels, matching SOURCE_CHANNELS in leadValidators.ts. */
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

export interface RoutingRuleInput {
  name: string;
  assigned_user_id: string;
  source_channel?: LeadSourceChannel;
  criteria?: string;
  evaluation_order?: number;
  is_active?: boolean;
}

/**
 * Validate a UUID path parameter.
 *
 * Checked before it reaches a query so a malformed id answers 400 rather than
 * causing Postgres to raise an invalid-input error that surfaces as a 500.
 *
 * @throws AppError(400 VALIDATION_ERROR) when the value is not a UUID.
 */
export function validateUuidParam(field: string, value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw AppError.badRequest(`'${field}' must be a UUID`, { field });
  }
  return value;
}

export interface RoutingRuleUpdate {
  name?: string;
  source_channel?: LeadSourceChannel | null;
  assigned_user_id?: string;
  criteria?: string | null;
  evaluation_order?: number;
  is_active?: boolean;
}

/**
 * Validate a PATCH /api/routing-rules/:id body.
 *
 * A partial update, so absence and null are DIFFERENT: an absent key leaves the
 * column alone, while an explicit null clears it (turning a channel-specific
 * rule into a catch-all). At least one field must be present — an empty patch is
 * a caller mistake worth reporting rather than a silent no-op.
 *
 * @throws AppError(400 VALIDATION_ERROR) when nothing is supplied or a field is malformed.
 */
export function validateRoutingRuleUpdate(body: Record<string, unknown>): RoutingRuleUpdate {
  const update: RoutingRuleUpdate = {};

  if ('name' in body) {
    const name = body.name;
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw AppError.badRequest("'name' must be a non-empty string", { field: 'name' });
    }
    if (name.trim().length > 160) {
      throw AppError.badRequest("'name' must be at most 160 characters", { field: 'name' });
    }
    update.name = name.trim();
  }

  if ('source_channel' in body) {
    const raw = body.source_channel;
    if (raw === null || raw === '') {
      // Explicit clear: the rule becomes a catch-all.
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

  if ('assigned_user_id' in body) {
    update.assigned_user_id = validateUuidParam('assigned_user_id', body.assigned_user_id);
  }

  if ('criteria' in body) {
    const raw = body.criteria;
    if (raw === null || raw === '') {
      update.criteria = null;
    } else if (typeof raw !== 'string') {
      throw AppError.badRequest("'criteria' must be a string or null", { field: 'criteria' });
    } else if (raw.trim().length > 255) {
      throw AppError.badRequest("'criteria' must be at most 255 characters", { field: 'criteria' });
    } else {
      update.criteria = raw.trim();
    }
  }

  if ('evaluation_order' in body) {
    const parsed = Number(body.evaluation_order);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100000) {
      throw AppError.badRequest("'evaluation_order' must be an integer between 0 and 100000", {
        field: 'evaluation_order',
      });
    }
    update.evaluation_order = parsed;
  }

  if ('is_active' in body) {
    if (typeof body.is_active !== 'boolean') {
      throw AppError.badRequest("'is_active' must be a boolean", { field: 'is_active' });
    }
    update.is_active = body.is_active;
  }

  if (Object.keys(update).length === 0) {
    throw AppError.badRequest(
      'Provide at least one of: name, source_channel, assigned_user_id, criteria, evaluation_order, is_active'
    );
  }

  return update;
}

export interface AssignmentInput {
  owner_user_id: string;
  reason: string;
}

/**
 * Validate a POST /api/leads/:id/assign body.
 *
 * `reason` is required, not optional: a reassignment nobody explained is not
 * auditable, and this is exactly the field a manager reads when asking why a
 * lead moved.
 *
 * @throws AppError(400 VALIDATION_ERROR) when a field is missing or malformed.
 */
export function validateAssignment(body: Record<string, unknown>): AssignmentInput {
  const ownerUserId = validateUuidParam('owner_user_id', body.owner_user_id);

  const reason = body.reason;
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw AppError.badRequest("'reason' is required so the reassignment is auditable", {
      field: 'reason',
    });
  }
  if (reason.trim().length > 500) {
    throw AppError.badRequest("'reason' must be at most 500 characters", { field: 'reason' });
  }

  return { owner_user_id: ownerUserId, reason: reason.trim() };
}

/**
 * Validate a POST /api/routing-rules body.
 * @throws AppError(400 VALIDATION_ERROR) when a field is missing or malformed.
 */
export function validateRoutingRule(body: Record<string, unknown>): RoutingRuleInput {
  const name = body.name;
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw AppError.badRequest("'name' is required", { field: 'name' });
  }
  if (name.trim().length > 160) {
    throw AppError.badRequest("'name' must be at most 160 characters", { field: 'name' });
  }

  const assignedUserId = validateUuidParam('assigned_user_id', body.assigned_user_id);

  let sourceChannel: LeadSourceChannel | undefined;
  const rawChannel = body.source_channel;
  if (rawChannel !== undefined && rawChannel !== null && rawChannel !== '') {
    if (
      typeof rawChannel !== 'string' ||
      !SOURCE_CHANNELS.includes(rawChannel as LeadSourceChannel)
    ) {
      throw AppError.badRequest(
        `'source_channel' must be one of: ${SOURCE_CHANNELS.join(', ')}`,
        { field: 'source_channel', allowed: SOURCE_CHANNELS }
      );
    }
    sourceChannel = rawChannel as LeadSourceChannel;
  }

  let criteria: string | undefined;
  const rawCriteria = body.criteria;
  if (rawCriteria !== undefined && rawCriteria !== null && rawCriteria !== '') {
    if (typeof rawCriteria !== 'string') {
      throw AppError.badRequest("'criteria' must be a string", { field: 'criteria' });
    }
    if (rawCriteria.trim().length > 255) {
      throw AppError.badRequest("'criteria' must be at most 255 characters", { field: 'criteria' });
    }
    criteria = rawCriteria.trim();
  }

  let evaluationOrder: number | undefined;
  const rawOrder = body.evaluation_order;
  if (rawOrder !== undefined && rawOrder !== null && rawOrder !== '') {
    const parsed = Number(rawOrder);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100000) {
      throw AppError.badRequest("'evaluation_order' must be an integer between 0 and 100000", {
        field: 'evaluation_order',
      });
    }
    evaluationOrder = parsed;
  }

  const rawActive = body.is_active;
  if (rawActive !== undefined && typeof rawActive !== 'boolean') {
    throw AppError.badRequest("'is_active' must be a boolean", { field: 'is_active' });
  }

  return {
    name: name.trim(),
    assigned_user_id: assignedUserId,
    source_channel: sourceChannel,
    criteria,
    evaluation_order: evaluationOrder,
    is_active: rawActive === undefined ? true : rawActive,
  };
}
