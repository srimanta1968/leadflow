import { AppError, ErrorCodes } from '../../utils/errors';
import { ORIGIN_CLASSES, OriginClass } from './inboxQuery';

/** How the operator produced the fields. */
export type CaptureMode = 'manual' | 'assisted';

/** Who may see the resulting record. */
export type CaptureVisibility = 'private' | 'business_unit' | 'tenant';

/** The relationship the operator is asserting, when they assert one. */
export type RelationshipHint = 'owner' | 'delegate' | 'account_team' | 'none';

export const CAPTURE_MODES: CaptureMode[] = ['manual', 'assisted'];
export const CAPTURE_VISIBILITIES: CaptureVisibility[] = ['private', 'business_unit', 'tenant'];
export const RELATIONSHIP_HINTS: RelationshipHint[] = ['owner', 'delegate', 'account_team', 'none'];

/** Fields a parser proposed, which the operator has already reviewed. */
export interface ParsedProposal {
  full_name?: string;
  email?: string;
  phone?: string;
  company?: string;
  message?: string;
}

export interface QuickCaptureInput {
  mode: CaptureMode;
  /** Exactly what arrived, untouched. */
  rawInput: string;
  parsedProposal: ParsedProposal | null;
  originClass: OriginClass;
  visibility: CaptureVisibility;
  recordOwnerPersonaId: string | null;
  relationshipHint: RelationshipHint;
  note: string | null;
  searchAfterCapture: boolean;
  /** Blob committed through sdk-media, when the capture carried an image. */
  evidenceBlobRef: string | null;
}

/** Read an optional string, treating blank as absent. */
function optionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Validate a quick capture.
 *
 * ORIGIN CLASS IS 422, NOT 400, AND THAT IS DELIBERATE.
 *
 * Everything else here is a syntax complaint — a missing field, a value outside
 * its list — and 400 says "you sent me something malformed". A capture with no
 * origin class is not malformed. It is a perfectly well-formed request that
 * cannot be processed, because provenance is the one thing this system refuses
 * to infer.
 *
 * The reason is the trust ladder. Origin class is the difference between a
 * record a person handed us and one that came from somewhere nobody can name,
 * and every downstream promotion decision reads it. Defaulting it — to
 * USER_PROVIDED because that is the common case, or to UNKNOWN_QUARANTINED
 * because that seems safe — would write a provenance claim nobody made. The
 * first is a lie that promotes untrusted data; the second is a lie that looks
 * cautious while still fabricating a fact. An unknown origin has to come back to
 * the caller, which is what 422 says and 400 does not.
 *
 * An origin class OUTSIDE the vocabulary is the same refusal rather than a
 * VALIDATION_ERROR: a caller who guessed 'SCRAPED_FROM_LINKEDIN' has stated a
 * provenance this system cannot honour, and telling them it is a syntax problem
 * invites them to try another guess.
 *
 * @param body The raw request body.
 * @throws AppError(422 ORIGIN_CLASS_REQUIRED) when origin class is absent or unknown.
 * @throws AppError(400 VALIDATION_ERROR) for every other malformed field.
 */
export function validateQuickCapture(body: Record<string, unknown>): QuickCaptureInput {
  const errors: string[] = [];

  // Checked FIRST and thrown immediately, so a request missing both origin class
  // and rawInput answers 422 rather than burying the provenance refusal inside a
  // list of syntax complaints the caller will fix one at a time.
  const originClass = optionalString(body.originClass);
  if (!originClass || !ORIGIN_CLASSES.includes(originClass as OriginClass)) {
    throw new AppError(
      422,
      ErrorCodes.ORIGIN_CLASS_REQUIRED,
      `originClass is required and must be one of: ${ORIGIN_CLASSES.join(', ')}`
    );
  }

  const rawInput = typeof body.rawInput === 'string' ? body.rawInput : '';
  if (rawInput.trim().length === 0) {
    errors.push('rawInput is required');
  }

  const mode = (optionalString(body.mode) ?? 'manual') as CaptureMode;
  if (!CAPTURE_MODES.includes(mode)) {
    errors.push(`mode must be one of: ${CAPTURE_MODES.join(', ')}`);
  }

  const visibility = (optionalString(body.visibility) ?? 'business_unit') as CaptureVisibility;
  if (!CAPTURE_VISIBILITIES.includes(visibility)) {
    errors.push(`visibility must be one of: ${CAPTURE_VISIBILITIES.join(', ')}`);
  }

  const relationshipHint = (optionalString(body.relationshipHint) ?? 'none') as RelationshipHint;
  if (!RELATIONSHIP_HINTS.includes(relationshipHint)) {
    errors.push(`relationshipHint must be one of: ${RELATIONSHIP_HINTS.join(', ')}`);
  }

  if (body.searchAfterCapture !== undefined && typeof body.searchAfterCapture !== 'boolean') {
    errors.push('searchAfterCapture must be a boolean');
  }

  if (
    body.parsedProposal !== undefined &&
    body.parsedProposal !== null &&
    typeof body.parsedProposal !== 'object'
  ) {
    errors.push('parsedProposal must be an object');
  }

  if (errors.length > 0) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, errors.join('; '));
  }

  return {
    mode,
    // NOT trimmed. The stored evidence must be what actually arrived, including
    // the whitespace — a capture is only useful as proof if it was not tidied on
    // the way in.
    rawInput,
    parsedProposal: (body.parsedProposal as ParsedProposal | undefined) ?? null,
    originClass: originClass as OriginClass,
    visibility,
    recordOwnerPersonaId: optionalString(body.recordOwnerPersonaId),
    relationshipHint,
    note: optionalString(body.note),
    searchAfterCapture: body.searchAfterCapture === true,
    evidenceBlobRef: optionalString(body.evidenceBlobRef),
  };
}
