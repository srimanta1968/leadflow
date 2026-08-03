import { Response } from 'express';
import { PERMISSIONS } from '../../config/roles';
import { AUDIT_EVENTS } from '../../platform/audit/vocabulary';
import { governed, GovernedRequest } from '../../platform/policy/governed';
import { AppError, ErrorCodes } from '../../utils/errors';
import { validateUuidParam } from '../../validators/routingValidators';
import { RESOLVE_STAGES, ResolveCaptureService, ResolveStage } from './resolveCaptureService';

/**
 * Validate a resolve request.
 *
 * @throws AppError(400 VALIDATION_ERROR) on a bad stage or malformed corrections.
 */
function validateResolve(body: Record<string, unknown>): {
  stage: ResolveStage;
  corrections: Record<string, string>;
} {
  const stage = typeof body.stage === 'string' ? body.stage : '';
  if (!RESOLVE_STAGES.includes(stage as ResolveStage)) {
    // No default. "normalize" is the commoner call, but guessing which half of
    // a governed promotion the steward meant is exactly the kind of helpfulness
    // that advances a record nobody asked to advance.
    throw new AppError(
      400,
      ErrorCodes.VALIDATION_ERROR,
      `stage must be one of: ${RESOLVE_STAGES.join(', ')}`
    );
  }

  const raw = body.corrections;
  if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'corrections must be an object');
  }

  const corrections: Record<string, string> = {};
  for (const [field, value] of Object.entries((raw as Record<string, unknown>) ?? {})) {
    if (typeof value !== 'string') {
      throw new AppError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        `corrections.${field} must be a string`
      );
    }
    // NOT trimmed to empty-null. A steward clearing a field is a real
    // correction — "the parser found a phone number and it is wrong" — and
    // dropping empty strings would silently discard that instruction.
    corrections[field] = value;
  }

  return { stage: stage as ResolveStage, corrections };
}

/**
 * HTTP surface for resolving a capture.
 *
 * A command against an existing record, so it answers 200 (MUST-54).
 *
 * Gated on `source_record.promote`, which only the Data Steward holds. That is
 * the SOP's own scoping: adjudicating a promotion is the steward's defining
 * act, so a Rep working their own leads is correctly refused here even though
 * they may capture freely.
 */
export class ResolveCaptureController {
  /** POST /api/leadflow/capture/:id/resolve */
  static resolve = governed(
    {
      action: PERMISSIONS.SOURCE_RECORD_PROMOTE,
      event: AUDIT_EVENTS.CAPTURE_PROMOTED,
      purpose: 'lead_management',
      resourceType: 'source_record',
      resourceId: (req) => req.params.id,
      metadata: (req) => ({
        stage: (req.body as { stage?: string })?.stage ?? null,
        // WHICH fields the human changed, in the ledger. "A record was
        // promoted" and "a record was promoted after the steward corrected the
        // email" are different facts, and only the second explains the decision.
        corrected_fields: Object.keys(
          ((req.body as { corrections?: Record<string, unknown> })?.corrections ?? {}) as object
        ),
      }),
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const captureId = validateUuidParam('id', req.params.id);
      const { stage, corrections } = validateResolve((req.body ?? {}) as Record<string, unknown>);

      const result = await ResolveCaptureService.resolve({ captureId, stage, corrections });
      res.status(200).json({ success: true, data: result });
    }
  );
}
