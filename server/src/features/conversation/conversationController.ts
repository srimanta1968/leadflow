import { Response } from 'express';
import { allJurisdictionCodes } from '../../config/recordingJurisdictions';
import { PERMISSIONS } from '../../config/roles';
import { AUDIT_EVENTS } from '../../platform/audit/vocabulary';
import { governed, GovernedRequest } from '../../platform/policy/governed';
import { AppError, ErrorCodes } from '../../utils/errors';
import { appendCustody, custodyChain, verifyChain } from './custodyLedger';
import { artifactsFor, recordingForCall } from './intelligencePipeline';
import { checkRecordingEligibility } from './recordingEligibility';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ConversationController {
  /**
   * GET /api/leadflow/calls/recording-eligibility
   *
   * MAY THIS CALL BE RECORDED, AND IF NOT WHY — asked BEFORE the call.
   *
   * A SECOND ENDPOINT BEYOND THE ONE THE BRIEF LISTS, and that is a deliberate
   * departure worth defending rather than hiding. The brief names only
   * GET /calls/:id/intelligence as the new local API, but the acceptance
   * criterion is that recording is blocked "with the reason shown" BEFORE the
   * call — and before the call there is no call id to ask about. Every other
   * surface here is keyed on a recording that exists by definition too late. So
   * this takes a consent reference and a jurisdiction, and answers the only
   * question a rep can act on while they still have a choice.
   *
   * A read, so 200 (MUST-54) — including when the answer is "blocked". The
   * block is the ANSWER, not an error: returning 403 would make a
   * correctly-functioning check look like a permission failure and give the
   * client nothing to display.
   *
   * Governed by call.review, the same authority the coaching surface carries.
   */
  static eligibility = governed(
    {
      action: PERMISSIONS.CALL_REVIEW,
      event: AUDIT_EVENTS.RECORDING_ELIGIBILITY_CHECKED,
      purpose: 'quality_assurance',
      resourceType: 'call_recording',
      metadata: (req) => ({
        jurisdiction: (req.query as { jurisdiction?: string })?.jurisdiction ?? null,
        // That a basis was offered, never the reference itself — the ledger is a
        // wider audience than the consent service.
        basis_offered: typeof (req.query as { consentBasisRef?: string })?.consentBasisRef === 'string',
      }),
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const consentBasisRef =
        typeof req.query.consentBasisRef === 'string' ? req.query.consentBasisRef : null;
      const jurisdiction =
        typeof req.query.jurisdiction === 'string' ? req.query.jurisdiction : null;
      const allPartyConsentCaptured = req.query.allPartyConsentCaptured === 'true';

      const verdict = await checkRecordingEligibility({
        consentBasisRef,
        jurisdiction,
        allPartyConsentCaptured,
      });

      res.status(200).json({
        success: true,
        data: {
          ...verdict,
          // Offered so a client can build the picker from the same registry the
          // check reads, rather than from a list that drifts.
          knownJurisdictions: allJurisdictionCodes(),
        },
      });
    }
  );

  /**
   * GET /api/leadflow/calls/:id/intelligence
   *
   * Everything derived from one recording, with its chain of custody.
   *
   * READING IS ITSELF A CUSTODY EVENT and is appended before the response is
   * sent. "Who listened to this call" is the question asked first when somebody
   * complains, and a chain that records only the machine's stages cannot answer
   * it. That is also why this is wrapped in `governed` despite being a read.
   *
   * A read, so 200. 404 when no recording exists for the call — distinct from
   * a blocked recording, which never produced a row at all, and the message
   * says so rather than leaving a rep to guess which of the two happened.
   */
  static intelligence = governed(
    {
      action: PERMISSIONS.CALL_REVIEW,
      event: AUDIT_EVENTS.RECORDING_ACCESSED,
      purpose: 'quality_assurance',
      resourceType: 'call_recording',
      resourceId: (req) => req.params.id,
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const id = req.params.id ?? '';
      if (!UUID_PATTERN.test(id)) {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'id must be a UUID');
      }

      const recording = await recordingForCall(id);
      if (!recording) {
        throw new AppError(
          404,
          ErrorCodes.NOT_FOUND,
          'No recording exists for this call. It may never have been recorded — a call blocked by the consent or jurisdiction check produces no recording at all.'
        );
      }

      const actor = req.platformSession?.personaId ?? req.session?.userId ?? 'unknown';

      // Appended BEFORE the payload is assembled, so a read that fails halfway
      // is still recorded as an access. The alternative records only successful
      // reads, which is the wrong half to keep.
      await appendCustody({
        recordingId: recording.id,
        stage: 'accessed',
        actor,
        actorKind: 'human',
        detail: 'Call intelligence read.',
        content: { recordingId: recording.id },
      });

      const [artifacts, chain, verdict] = await Promise.all([
        artifactsFor(recording.id),
        custodyChain(recording.id),
        verifyChain(recording.id),
      ]);

      res.status(200).json({
        success: true,
        data: {
          recording,
          artifacts,
          custody: { chain, verification: verdict },
          // Stated rather than left to be inferred from every artifact carrying
          // offsets: a client showing "jump to this moment" needs to know it can
          // rely on it.
          everyArtifactTraceable: artifacts.every(
            (artifact) => Number.isInteger(artifact.sourceStartMs) && Number.isInteger(artifact.sourceEndMs)
          ),
        },
      });
    }
  );
}
