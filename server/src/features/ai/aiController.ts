import { Response } from 'express';
import { PERMISSIONS } from '../../config/roles';
import { AUDIT_EVENTS } from '../../platform/audit/vocabulary';
import { governed, GovernedRequest } from '../../platform/policy/governed';
import { AppError, ErrorCodes } from '../../utils/errors';
import { acceptProposal, qualifyLead, SdrChannel } from './sdrQualifyService';
import { registerCall, scoreCall } from './coachScorecardService';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANNELS: SdrChannel[] = ['email', 'sms'];

export class AiSdrController {
  /**
   * POST /api/leadflow/ai/sdr/qualify
   *
   * Creates an addressable proposal the rep later fetches and accepts by id, so
   * 201 rather than the 200 an action endpoint would take (MUST-54). The path
   * reads like a verb, but what it leaves behind is a resource.
   *
   * Governed by lead.work_assigned — asking for a draft is part of working the
   * lead. Releasing one is not, and carries a different permission.
   */
  static qualify = governed(
    {
      action: PERMISSIONS.LEAD_WORK_ASSIGNED,
      event: AUDIT_EVENTS.AI_DRAFT_PROPOSED,
      purpose: 'lead_management',
      resourceType: 'ai_sdr_proposal',
      metadata: (req) => ({
        lead_id: (req.body as { leadId?: string })?.leadId ?? null,
        channel: (req.body as { channel?: string })?.channel ?? null,
        // Recorded on the proposal event so "which sources produced this draft"
        // is answerable from the ledger alone, without joining to a table that
        // may since have been redacted by an erasure.
        research_sources: (req.body as { researchSources?: string[] })?.researchSources ?? null,
      }),
      obligations: {
        own_record_only: {
          kind: 'defer',
          because: 'the proposal does not exist yet, so its ownership cannot be checked',
        },
      },
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const leadId = typeof body.leadId === 'string' ? body.leadId : '';
      const channel = typeof body.channel === 'string' ? body.channel : '';
      const errors: string[] = [];

      if (!UUID_PATTERN.test(leadId)) {
        errors.push('leadId must be a UUID');
      }
      if (!CHANNELS.includes(channel as SdrChannel)) {
        errors.push(`channel must be one of: ${CHANNELS.join(', ')}`);
      }

      let researchSources: string[] | undefined;
      if (body.researchSources !== undefined) {
        if (
          !Array.isArray(body.researchSources) ||
          body.researchSources.some((entry) => typeof entry !== 'string')
        ) {
          errors.push('researchSources must be an array of strings');
        } else {
          researchSources = body.researchSources as string[];
        }
      }

      if (errors.length > 0) {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR, errors.join('; '));
      }

      const proposal = await qualifyLead({
        leadId,
        channel: channel as SdrChannel,
        researchSources,
        actor: req.platformSession?.personaId ?? req.session?.userId ?? null,
      });

      res.status(201).json({ success: true, data: { proposal } });
    }
  );

  /**
   * POST /api/leadflow/ai/sdr/proposals/:id/accept
   *
   * An action on an existing resource, so 200 (MUST-54).
   *
   * Governed by message.send_approved, NOT the lead.work_assigned that
   * qualifying carries. Deciding a message may go to a prospect is a different
   * authority from asking for a draft, and a rep may hold the first without the
   * second.
   */
  static accept = governed(
    {
      action: PERMISSIONS.MESSAGE_SEND_APPROVED,
      event: AUDIT_EVENTS.AI_DRAFT_ACCEPTED,
      purpose: 'lead_management',
      resourceType: 'ai_sdr_proposal',
      metadata: (req) => ({
        proposal_id: req.params.id ?? null,
        // Whether a human changed the copy. The single most useful fact when
        // asking later whether the drafts were any good.
        edited: typeof (req.body as { editedBody?: unknown })?.editedBody === 'string',
      }),
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const id = req.params.id ?? '';
      if (!UUID_PATTERN.test(id)) {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'id must be a UUID');
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const editedBody = typeof body.editedBody === 'string' ? body.editedBody : null;
      const acceptedAsWritten = body.acceptedAsWritten === true;

      if (!acceptedAsWritten && editedBody === null) {
        // Not defaulted to accept-as-written. Defaulting would let an empty
        // body release a message nobody read, which is the exact outcome the
        // human-review step exists to prevent.
        throw new AppError(
          400,
          ErrorCodes.VALIDATION_ERROR,
          'Supply acceptedAsWritten: true or an editedBody'
        );
      }

      const result = await acceptProposal({
        proposalId: id,
        userId: req.session?.userId ?? null,
        acceptedAsWritten,
        editedBody,
      });

      res.status(200).json({ success: true, data: { proposal: result } });
    }
  );
}

export class AiCoachController {
  /**
   * POST /api/leadflow/ai/coach/calls
   *
   * A create at a collection root, so 201 (MUST-54).
   */
  static register = governed(
    {
      action: PERMISSIONS.CALL_REVIEW,
      event: AUDIT_EVENTS.AI_CALL_REGISTERED,
      purpose: 'quality_assurance',
      resourceType: 'ai_coach_call',
      metadata: (req) => ({
        external_call_id: (req.body as { externalCallId?: string })?.externalCallId ?? null,
        // That a basis was present, never the basis itself — the reference is a
        // pointer into the consent service and the ledger is a wider audience.
        recording_basis_present:
          typeof (req.body as { recordingConsentBasisRef?: unknown })?.recordingConsentBasisRef ===
          'string',
      }),
      obligations: {
        own_record_only: {
          kind: 'defer',
          because: 'the call record does not exist yet, so its ownership cannot be checked',
        },
      },
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const externalCallId = typeof body.externalCallId === 'string' ? body.externalCallId : '';
      const occurredAt = typeof body.occurredAt === 'string' ? body.occurredAt : '';
      const errors: string[] = [];

      if (externalCallId.trim().length === 0) {
        errors.push('externalCallId is required');
      }
      if (occurredAt.trim().length === 0 || Number.isNaN(Date.parse(occurredAt))) {
        errors.push('occurredAt must be an ISO timestamp');
      }

      if (errors.length > 0) {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR, errors.join('; '));
      }

      const call = await registerCall({
        externalCallId,
        repEmail: typeof body.repEmail === 'string' ? body.repEmail : null,
        leadId: typeof body.leadId === 'string' && UUID_PATTERN.test(body.leadId)
          ? body.leadId
          : null,
        occurredAt,
        recordingConsentBasisRef:
          typeof body.recordingConsentBasisRef === 'string' ? body.recordingConsentBasisRef : null,
        recordingConsentCapturedAt:
          typeof body.recordingConsentCapturedAt === 'string'
            ? body.recordingConsentCapturedAt
            : null,
      });

      res.status(201).json({ success: true, data: { call } });
    }
  );

  /**
   * GET /api/leadflow/ai/coach/scorecard/:callId
   *
   * NOT wrapped in `governed`, because governed appends to the ledger AFTER the
   * handler succeeds — and a refusal is the entry that matters most here. The
   * consent gate is inside scoreCall, ahead of any content access, and the
   * refusal path records its own event.
   */
  static async scorecard(req: GovernedRequest, res: Response): Promise<void> {
    const callId = req.params.callId ?? '';
    if (!UUID_PATTERN.test(callId)) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'callId must be a UUID');
    }

    const scorecard = await scoreCall(
      callId,
      req.platformSession?.personaId ?? req.session?.userId ?? null
    );
    res.status(200).json({ success: true, data: { scorecard } });
  }
}
