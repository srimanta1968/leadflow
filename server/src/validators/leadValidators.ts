import { AppError } from '../utils/errors';
import { LeadCaptureInput, LeadOriginClass, LeadSourceChannel } from '../types';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

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

const ORIGIN_CLASSES: readonly LeadOriginClass[] = [
  'first_party_declared',
  'first_party_observed',
  'partner_shared',
  'public_record',
  'third_party_licensed',
  'inferred',
  'user_asserted',
  'unknown',
];

/**
 * Validate a POST /api/leads body.
 *
 * `name`, `email` and `source` are required — a capture missing any of them
 * cannot be routed or attributed, so it is rejected at the edge rather than
 * landing in the inbox as an unresolvable record.
 *
 * @throws AppError(400 VALIDATION_ERROR) when a field is missing or malformed.
 */
export function validateLeadCapture(body: Record<string, unknown>): LeadCaptureInput {
  const name = body.name;
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw AppError.badRequest("'name' is required", { field: 'name' });
  }
  if (name.trim().length > 255) {
    throw AppError.badRequest("'name' must be at most 255 characters", { field: 'name' });
  }

  const email = body.email;
  if (typeof email !== 'string' || email.trim().length === 0) {
    throw AppError.badRequest("'email' is required", { field: 'email' });
  }
  const normalisedEmail = email.trim().toLowerCase();
  // Bound the length BEFORE the pattern check and before the value can reach the
  // database. `leads.email` is VARCHAR(255); without this an over-long address
  // passes validation and the insert fails, turning a client mistake into a 500.
  if (normalisedEmail.length > 255) {
    throw AppError.badRequest("'email' must be at most 255 characters", { field: 'email' });
  }
  if (!EMAIL_PATTERN.test(normalisedEmail)) {
    throw AppError.badRequest("'email' must be a valid email address", { field: 'email' });
  }

  const source = body.source;
  if (typeof source !== 'string' || !SOURCE_CHANNELS.includes(source as LeadSourceChannel)) {
    throw AppError.badRequest(
      `'source' must be one of: ${SOURCE_CHANNELS.join(', ')}`,
      { field: 'source', allowed: SOURCE_CHANNELS }
    );
  }

  const originClassRaw = body.origin_class;
  let originClass: LeadOriginClass | undefined;
  if (originClassRaw !== undefined && originClassRaw !== null && originClassRaw !== '') {
    if (
      typeof originClassRaw !== 'string' ||
      !ORIGIN_CLASSES.includes(originClassRaw as LeadOriginClass)
    ) {
      throw AppError.badRequest(
        `'origin_class' must be one of: ${ORIGIN_CLASSES.join(', ')}`,
        { field: 'origin_class', allowed: ORIGIN_CLASSES }
      );
    }
    originClass = originClassRaw as LeadOriginClass;
  }

  const optional = (field: string, max: number): string | undefined => {
    const raw = body[field];
    if (raw === undefined || raw === null || raw === '') {
      return undefined;
    }
    if (typeof raw !== 'string') {
      throw AppError.badRequest(`'${field}' must be a string`, { field });
    }
    const value = raw.trim();
    if (value.length > max) {
      throw AppError.badRequest(`'${field}' must be at most ${max} characters`, { field });
    }
    return value.length > 0 ? value : undefined;
  };

  const utmRaw = body.utm;
  let utm: Record<string, string> | undefined;
  if (utmRaw !== undefined && utmRaw !== null) {
    if (typeof utmRaw !== 'object' || Array.isArray(utmRaw)) {
      throw AppError.badRequest("'utm' must be an object of string values", { field: 'utm' });
    }
    utm = {};
    for (const [key, value] of Object.entries(utmRaw as Record<string, unknown>)) {
      if (typeof value === 'string') {
        utm[key] = value;
      }
    }
  }

  return {
    name: name.trim(),
    email: normalisedEmail,
    source: source as LeadSourceChannel,
    phone: optional('phone', 40),
    company: optional('company', 255),
    message: optional('message', 4000),
    origin_class: originClass,
    consent_granted: body.consent_granted === true,
    utm,
  };
}
