import { randomUUID } from 'crypto';
import { Response } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth';
import { AppError } from '../../utils/errors';
import { PlatformRequest } from '../auth/sessionContext';
import { evaluateBatch, isKnownAction, PolicyRequest } from './policyEngine';

/**
 * Most actions a screen can ask about at once.
 *
 * A page needing more than this is asking the wrong question — and an uncapped
 * batch is an unauthenticated-shaped amplification: one small request turning
 * into unbounded evaluation work.
 */
export const MAX_BATCH = 50;

interface RawAction {
  action?: unknown;
  resource_type?: unknown;
  resource_id?: unknown;
}

/**
 * Validate the requested action set.
 *
 * An unknown action is a 400, NOT a deny. They look similar and mean opposite
 * things: deny says "you may not", which a caller shows to a person, while an
 * unknown action means the caller asked about something that does not exist —
 * a bug to fix, not a permission to request. Returning deny would let a typo
 * masquerade as a policy decision forever.
 *
 * @throws AppError(400 VALIDATION_ERROR)
 */
export function validateActions(body: unknown): PolicyRequest[] {
  const actions = (body as { actions?: unknown })?.actions;

  if (!Array.isArray(actions) || actions.length === 0) {
    throw AppError.badRequest('actions must be a non-empty array');
  }
  if (actions.length > MAX_BATCH) {
    throw AppError.badRequest(`actions may contain at most ${MAX_BATCH} entries`);
  }

  return actions.map((entry: RawAction, index) => {
    const action = entry?.action;
    const resourceType = entry?.resource_type;

    if (typeof action !== 'string' || action.length === 0) {
      throw AppError.badRequest(`actions[${index}].action is required`);
    }
    if (!isKnownAction(action)) {
      throw AppError.badRequest(`actions[${index}].action '${action}' is not a known action`);
    }
    if (typeof resourceType !== 'string' || resourceType.length === 0) {
      throw AppError.badRequest(`actions[${index}].resource_type is required`);
    }

    return {
      action,
      resourceType,
      resourceId: typeof entry?.resource_id === 'string' ? entry.resource_id : undefined,
    };
  });
}

/**
 * The caller's roles.
 *
 * Read from the VERIFIED platform session when one is present. Falls back to the
 * local session's single role while ProjexCloud identity is not yet wired up —
 * and to no roles at all if neither exists, which denies everything. Failing
 * closed is the only safe default in a permission check.
 */
function rolesFor(req: AuthenticatedRequest & PlatformRequest): string[] {
  if (req.platformSession?.roles.length) {
    return req.platformSession.roles;
  }
  return req.session?.role ? [req.session.role] : [];
}

export class AuthzController {
  /** POST /api/leadflow/authz/evaluate — one verdict per requested action. */
  static async evaluate(
    req: AuthenticatedRequest & PlatformRequest,
    res: Response
  ): Promise<void> {
    const requests = validateActions(req.body);
    const decisions = evaluateBatch(requests, rolesFor(req));

    res.status(200).json({
      success: true,
      data: {
        // One evaluation call is one authorisation EVENT, so it gets its own
        // reference alongside the per-decision ones. It is what an auditor joins
        // on to ask "what did this screen check before it rendered", and it is
        // the only reference a caller can chain from without indexing into the
        // decisions array.
        batch_ref: `pdpb_${randomUUID()}`,
        decisions: decisions.map((decision) => ({
          action: decision.action,
          effect: decision.effect,
          reason: decision.reason,
          obligations: decision.obligations,
          decision_ref: decision.decisionRef,
        })),
      },
    });
  }
}
