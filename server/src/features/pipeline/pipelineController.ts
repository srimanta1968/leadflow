import { Router, type Response } from 'express';
import { asyncHandler } from '../../middleware/errorHandler';
import { authenticate, type AuthenticatedRequest } from '../../middleware/auth';
import { AppError, ErrorCodes } from '../../utils/errors';
import { STAGES } from '../../config/verticalProfile';
import {
  NEXT_FIELDS, checkNext, checkStageGuard, evaluateGate, raiseIntegrityException,
  readSubject, stageCatalog, writeNext,
} from './saveGate';
import {
  CLOSE_REASON_KEYS, DISPOSITION_KEYS, LOST_REASON_CODES, NO_ANSWER_FOLLOW_UP_MINUTES,
  captureClosedLost, recordFeatureDependency, runDispositionAutomation,
} from './dispositionService';

/**
 * Pipeline stages, the save gate and disposition-driven automation.
 * SOP §01, §06, §07, §15, §28, §31, §32.
 */
export const pipelineRoutes: Router = Router();
export const recordRoutes: Router = Router();

pipelineRoutes.use(authenticate);
recordRoutes.use(authenticate);

/**
 * GET /api/leadflow/pipeline/stages — the ten stages and their guidance.
 *
 * CONFIGURATION, NOT CODE. The set comes from config/verticalProfile.ts and is
 * projected into leadflow_stage_config at boot, so changing a stage's evidence
 * or its allowed transitions is an edit to one declaration rather than a change
 * to a handler. The incumbent system hard-coded five stages with no entry or
 * exit criteria at all, which is the gap this shape closes.
 */
pipelineRoutes.get(
  '/stages',
  asyncHandler(async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    const stages = stageCatalog();
    res.status(200).json({
      success: true,
      data: {
        stages,
        stage_count: stages.length,
        /* AC4 — stated so a reader knows where to change it. */
        source: 'config/verticalProfile.ts, projected into leadflow_stage_config at boot',
        configuration_not_code: true,
        /* AC3 — the §31-32 responsibilities the record header renders. */
        guidance_note: 'Each stage carries CRM, rep and manager guidance for the record header, so the responsibility is in front of the operator rather than in a manual.',
      },
    });
  })
);

/**
 * GET /api/leadflow/pipeline/stage-guard — may this record enter that stage?
 *
 * REFUSES AN UNKNOWN STAGE rather than waving it through. The incumbent
 * `updateDealStage` allowed any stage to any stage, which is how a record
 * reached Closed Won having never been contacted.
 */
pipelineRoutes.get(
  '/stage-guard',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const query = (req.query ?? {}) as Record<string, string | undefined>;
    const subjectRef = (query.subject_ref ?? '').trim();
    const to = (query.to ?? '').trim();
    const from = (query.from ?? '').trim() || null;

    if (subjectRef === '') throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'subject_ref is required');
    if (to === '') throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'to is required');
    if (!STAGES.some((s) => s.key === to)) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `to must be one of ${STAGES.map((s) => s.key).join(', ')}`);
    }

    const verdict = await checkStageGuard(subjectRef, from, to);
    res.status(200).json({
      success: true,
      data: {
        ...verdict,
        /* AC4 of #118 — a roadmap promise is not an exit criterion, and the
           guard says so in the words the screen can render. */
        roadmap_rule: 'Only a dependency recorded as `available` satisfies an exit criterion. A roadmap promise never does.',
      },
    });
  })
);

/**
 * GET /api/leadflow/records/:ref/save-gate — may this record be saved?
 *
 * THE SAME GATE THE UI USES, and the one that actually decides. The composer
 * blocks submit until the NEXT is complete, which is a convenience; this is the
 * control, and a client bypassed with curl meets exactly the same refusal.
 */
recordRoutes.get(
  '/:ref/save-gate',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const subjectRef = String(req.params?.ref ?? '');
    const subject = await readSubject(subjectRef);
    if (!subject) throw new AppError(404, ErrorCodes.NOT_FOUND, 'No record with that reference');

    const verdict = evaluateGate(subject, null);
    res.status(200).json({
      success: true,
      data: {
        subject_ref: subjectRef,
        allowed: verdict.allowed,
        /* AC2 of #116 — every refusal names its field, so the UI renders it
           inline instead of showing one generic error at the top. */
        refusals: verdict.refusals,
        missing_fields: verdict.refusals.map((r) => r.field),
        terminal: verdict.terminal,
        /* AC3 of #116 — Closed Won is NOT terminal until onboarding lands. */
        terminal_rule: 'Closed Won remains non-terminal until onboarding is accepted and calendarized, because the handover is where deals are lost after the signature.',
        required_next_fields: NEXT_FIELDS,
      },
    });
  })
);

/**
 * POST /api/leadflow/records/:ref/next-action — save the NEXT, or be refused.
 *
 * A BLOCKED SAVE RAISES A MANAGER-VISIBLE EXCEPTION rather than failing
 * silently. Silence is how a gate becomes something reps route around: nobody
 * sees that one record has been refused eleven times, so nobody asks why.
 */
recordRoutes.post(
  '/:ref/next-action',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const subjectRef = String(req.params?.ref ?? '');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const actor = req.session?.userId ?? null;

    const refusals = checkNext(body);
    if (refusals.length > 0) {
      const exceptionId = await raiseIntegrityException({
        subjectRef, kind: 'blank_next',
        missing: refusals.map((r) => r.field),
        attemptedBy: actor,
        detail: 'A save was refused because the NEXT was incomplete.',
      });
      /*
       * 422 rather than 400: the request is well formed and the refusal is about
       * the CONTENT being incomplete. The body carries the structured refusals so
       * the UI can render each against its own field.
       */
      res.status(422).json({
        success: false,
        error: 'This record cannot be saved without a complete NEXT.',
        code: 'BLANK_NEXT',
        data: {
          subject_ref: subjectRef,
          refusals,
          missing_fields: refusals.map((r) => r.field),
          integrity_exception_id: exceptionId,
        },
      });
      return;
    }

    const subject = await readSubject(subjectRef);
    if (!subject) throw new AppError(404, ErrorCodes.NOT_FOUND, 'No record with that reference');

    const nextId = await writeNext({
      subjectRef,
      draft: {
        action_type: body.action_type, owner_user_id: body.owner_user_id, due_at: body.due_at,
        purpose: body.purpose, intended_outcome: body.intended_outcome,
      },
      createdBy: actor,
    });

    res.status(201).json({
      success: true,
      data: {
        next_id: nextId, subject_ref: subjectRef,
        action_type: body.action_type, owner_user_id: body.owner_user_id,
        due_at: body.due_at, purpose: body.purpose, intended_outcome: body.intended_outcome,
        note: 'Any previous open NEXT was completed rather than deleted — what the record was waiting on before is part of its history.',
      },
    });
  })
);

/**
 * POST /api/leadflow/records/:ref/disposition — log an outcome and run what it
 * implies.
 */
recordRoutes.post(
  '/:ref/disposition',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const subjectRef = String(req.params?.ref ?? '');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const codeKey = typeof body.code_key === 'string' ? body.code_key.trim() : '';

    if (!DISPOSITION_KEYS.includes(codeKey)) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `code_key must be one of ${DISPOSITION_KEYS.join(', ')}`);
    }

    const result = await runDispositionAutomation({
      subjectRef, codeKey,
      actorUserId: req.session?.userId ?? null,
      scheduledAt: typeof body.scheduled_at === 'string' ? body.scheduled_at : null,
    });

    res.status(result.alreadyRan ? 200 : 201).json({
      success: true,
      data: {
        subject_ref: subjectRef, code_key: codeKey,
        actions: result.actions,
        /* AC1 of #118 — the guarantee is a unique index, so a second identical
           disposition sends nothing rather than a second follow-up. */
        already_ran: result.alreadyRan,
        follow_up_minutes: NO_ANSWER_FOLLOW_UP_MINUTES,
        note: result.alreadyRan
          ? 'This automation already ran for this record. No duplicate send was made.'
          : 'Eligibility for the SMS is decided by the channel decision engine, not here.',
      },
    });
  })
);

/**
 * POST /api/leadflow/records/:ref/close-lost — the SOP §15 capture.
 *
 * THE PROSPECT'S OWN WORDING IS REQUIRED, not just a code. A taxonomy tells you
 * how often you lose on price; the sentence tells you what they actually said,
 * and only one of those changes how the offer gets written.
 */
recordRoutes.post(
  '/:ref/close-lost',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const subjectRef = String(req.params?.ref ?? '');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const reasonCode = typeof body.reason_code === 'string' ? body.reason_code.trim() : '';
    const prospectWording = typeof body.prospect_wording === 'string' ? body.prospect_wording.trim() : '';
    const offerVersion = typeof body.offer_version === 'string' ? body.offer_version.trim() : '';

    if (!(LOST_REASON_CODES as readonly string[]).includes(reasonCode)) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `reason_code must be one of ${LOST_REASON_CODES.join(', ')}`);
    }
    if (prospectWording === '') {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'prospect_wording is required — record what they actually said, not a paraphrase');
    }
    if (offerVersion === '') {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'offer_version is required — a loss cannot be attributed to terms that have since changed');
    }

    const result = await captureClosedLost({
      subjectRef, reasonCode, prospectWording, offerVersion,
      competingOption: typeof body.competing_option === 'string' ? body.competing_option : null,
      learningNote: typeof body.learning_note === 'string' ? body.learning_note : null,
      /* A future date ONLY when one truly exists. Inventing one to fill the
         field produces a nurture queue full of dates nobody agreed. */
      revisitAt: typeof body.revisit_at === 'string' && body.revisit_at.trim() !== '' ? body.revisit_at : null,
      closedBy: req.session?.userId ?? null,
    });

    res.status(result.alreadyCaptured ? 200 : 201).json({
      success: true,
      data: {
        subject_ref: subjectRef, capture_id: result.captureId,
        already_captured: result.alreadyCaptured,
        reason_code: reasonCode, offer_version: offerVersion,
        revisit_at: body.revisit_at ?? null,
        note: 'A revisit date is optional by design. A date nobody agreed is worse than none, because it fills the nurture queue with commitments the prospect never made.',
      },
    });
  })
);

/**
 * POST /api/leadflow/records/:ref/feature-dependency — record a capability the
 * deal depends on, and its REAL status.
 */
recordRoutes.post(
  '/:ref/feature-dependency',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const subjectRef = String(req.params?.ref ?? '');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const capability = typeof body.capability === 'string' ? body.capability.trim() : '';
    const status = typeof body.status === 'string' ? body.status.trim() : '';
    const STATUSES = ['available', 'in_development', 'roadmap', 'not_planned'];

    if (capability === '') throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'capability is required');
    if (!STATUSES.includes(status)) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `status must be one of ${STATUSES.join(', ')}`);
    }

    await recordFeatureDependency({
      subjectRef, capability,
      status: status as 'available' | 'in_development' | 'roadmap' | 'not_planned',
      promisedDate: typeof body.promised_date === 'string' ? body.promised_date : null,
      note: typeof body.note === 'string' ? body.note : null,
    });

    res.status(201).json({
      success: true,
      data: {
        subject_ref: subjectRef, capability, status,
        satisfies_exit_criteria: status === 'available',
        /* AC4 of #118, stated in the response rather than left in a comment. */
        note: 'Only `available` satisfies a stage exit criterion. A roadmap promise never does — recording one as satisfied is how a deal reaches Closed Won on a capability nobody has written.',
      },
    });
  })
);

/** The disposition and close-reason vocabularies, for the UI pickers. */
pipelineRoutes.get(
  '/vocabulary',
  asyncHandler(async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    res.status(200).json({
      success: true,
      data: {
        dispositions: DISPOSITION_KEYS,
        close_reasons: CLOSE_REASON_KEYS,
        lost_reason_codes: LOST_REASON_CODES,
        source: 'config/verticalProfile.ts',
      },
    });
  })
);
