import { randomUUID } from 'crypto';
import { Response } from 'express';
import { KIND_REQUIRES_PERMISSION } from '../../config/aiAgents';
import { PERMISSIONS } from '../../config/roles';
import { appendAuditEntry } from '../../platform/audit/auditLog';
import { AUDIT_EVENTS } from '../../platform/audit/vocabulary';
import { governed, GovernedRequest, rolesFor } from '../../platform/policy/governed';
import { decide, propose } from '../../platform/ai/reviewGate';
import { AppError, ErrorCodes } from '../../utils/errors';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A plain JSON object, and not an array or a null. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class AiReviewGateController {
  /**
   * POST /api/leadflow/ai/propose
   *
   * Records a consequential AI output for human review. 201, because what it
   * leaves behind is an addressable resource a reviewer later fetches and
   * decides by id (MUST-54).
   *
   * Governed by lead.work_assigned — the same authority the SDR module's
   * qualify carries, and for the same reason: asking a machine for a suggestion
   * is part of working. Deciding one is a different authority entirely, and it
   * depends on WHAT is being decided; see `decide` below.
   */
  static propose = governed(
    {
      action: PERMISSIONS.LEAD_WORK_ASSIGNED,
      event: AUDIT_EVENTS.AI_PROPOSAL_PROPOSED,
      purpose: 'lead_management',
      resourceType: 'ai_proposal',
      metadata: (req) => ({
        agent_key: (req.body as { agentKey?: string })?.agentKey ?? null,
        kind: (req.body as { kind?: string })?.kind ?? null,
        // The completion this rests on, so the ledger entry and the proposal can
        // be joined from the audit chain alone.
        completion_id: (req.body as { completionId?: string })?.completionId ?? null,
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
      const agentKey = typeof body.agentKey === 'string' ? body.agentKey : '';
      const kind = typeof body.kind === 'string' ? body.kind : '';
      const errors: string[] = [];

      if (agentKey.trim().length === 0) {
        errors.push('agentKey is required');
      }
      if (kind.trim().length === 0) {
        errors.push(`kind must be one of: ${Object.keys(KIND_REQUIRES_PERMISSION).join(', ')}`);
      }
      if (!isPlainObject(body.content)) {
        errors.push('content must be an object');
      }
      if (body.completionId !== undefined && typeof body.completionId !== 'string') {
        errors.push('completionId must be a string');
      }
      if (
        body.subjectId !== undefined &&
        (typeof body.subjectId !== 'string' || !UUID_PATTERN.test(body.subjectId))
      ) {
        errors.push('subjectId must be a UUID');
      }

      if (errors.length > 0) {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR, errors.join('; '));
      }

      const proposal = await propose({
        agentKey,
        kind,
        content: body.content as Record<string, unknown>,
        subjectType: typeof body.subjectType === 'string' ? body.subjectType : null,
        subjectId: typeof body.subjectId === 'string' ? body.subjectId : null,
        completionId: typeof body.completionId === 'string' ? body.completionId : null,
      });

      res.status(201).json({ success: true, data: { proposal } });
    }
  );

  /**
   * POST /api/leadflow/ai/proposals/:id/decide
   *
   * A qualified human accepts, edits-and-accepts, or rejects. An action on an
   * existing resource, so 200 (MUST-54).
   *
   * NOT WRAPPED IN `governed`, and this is the one place in the codebase that
   * deviates — so it is worth saying why. `governed` takes ONE static action per
   * route, and the authority needed here is not static: releasing a message is
   * message.send_approved, accepting a call summary is call.review, and a Sales
   * Manager holds the second and not the first. A single action on the route
   * would have to be the loosest of the four, which would let a machine's
   * suggestion become a route around the permission matrix — precisely the
   * loophole this gate exists to close.
   *
   * So the PDP call lives in `reviewGate.decide`, against the permission STAMPED
   * ON THE PROPOSAL, and the audit entry is appended here after the write
   * succeeds — the same order `governed` enforces: decide, then write, then
   * record. A thrown handler appends nothing, because there is no act to record.
   */
  static async decide(req: GovernedRequest, res: Response): Promise<void> {
    const id = req.params.id ?? '';
    if (!UUID_PATTERN.test(id)) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'id must be a UUID');
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const decision = body.decision;

    if (decision !== 'accept' && decision !== 'reject') {
      // NOT DEFAULTED TO ACCEPT. Defaulting would let an empty body approve an
      // output nobody read, which is the exact outcome the review step exists to
      // prevent.
      throw new AppError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        "decision must be 'accept' or 'reject'"
      );
    }

    if (body.editedContent !== undefined && !isPlainObject(body.editedContent)) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'editedContent must be an object');
    }

    const result = await decide({
      proposalId: id,
      decision,
      // From the SESSION, never from the body. Roles supplied by the caller
      // would make the whole check self-attested.
      roles: rolesFor(req),
      userId: req.session?.userId ?? null,
      editedContent: isPlainObject(body.editedContent) ? body.editedContent : null,
      note: typeof body.note === 'string' ? body.note : null,
    });

    await appendAuditEntry({
      event: AUDIT_EVENTS.AI_PROPOSAL_DECIDED,
      actor: req.platformSession?.personaId ?? req.session?.userId ?? 'unknown',
      personaRole: rolesFor(req)[0] ?? 'unknown',
      purpose: 'lead_management',
      decisionRef: result.decisionRef,
      evidenceRef: `ai_proposal:${result.proposal.id}`,
      causationId: result.proposal.completionId ?? randomUUID(),
      idempotencyRef: `ai-proposal-decide:${result.proposal.id}`,
      subjectId: result.proposal.id,
      subjectType: 'ai_proposal',
      metadata: {
        outcome: result.proposal.status,
        kind: result.proposal.kind,
        agent_key: result.proposal.agentKey,
        // WHICH AUTHORITY THIS DECISION RESTED ON. The single most useful field
        // on the entry: "a human accepted it" is only meaningful alongside what
        // that human had to be qualified to do.
        required_permission: result.requiredPermission,
        // Whether the human rewrote it. The best available signal on whether the
        // machine's output was any good.
        edited: result.wasEdited,
      },
    });

    res.status(200).json({ success: true, data: { proposal: result.proposal } });
  }
}
