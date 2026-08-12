import { Router, type Response } from 'express';
import { asyncHandler } from '../../middleware/errorHandler';
import { authenticate, type AuthenticatedRequest } from '../../middleware/auth';
import { AppError, ErrorCodes } from '../../utils/errors';
import {
  DEFAULT_BUDGET,
  MAX_DEPTH_CAP,
  MAX_VISIT_CAP,
  ROLES,
  ROLE_MEANING,
  TRUST_STATES,
  isRole,
  isTrustState,
  requiresEvidence,
  type Role,
  type TrustState,
} from './roleVocabulary';
import {
  checkReachable,
  closeRole,
  grantRole,
  listRoles,
  type ContextualRoleRow,
} from './relationshipGateway';

/**
 * Contextual roles — #c-relationships.
 *
 * ROLES ARE BITEMPORAL CONTRACTS, and ownership, occupancy, management and
 * decision authority remain DISTINCT. One property can carry an OWNS the public
 * record only suggests, a field-confirmed OCCUPIES and a DECISION_MAKER, all at
 * once, each with its own trust state and its own life.
 *
 * NOTHING HERE DELETES. A role that stops being true is DATED, not removed,
 * because "who was the decision maker last March" is exactly the question asked
 * when something has gone wrong.
 */
export const relationshipRoutes: Router = Router();

relationshipRoutes.use(authenticate);

/** How many roles one page carries. */
const PAGE_LIMIT = 200;

const roleListMessage = `role must be one of ${ROLES.join(', ')}`;

/** One role as the screen renders it. */
interface RoleView {
  relationship_id: string | null;
  subject_ref: string | null;
  object_ref: string | null;
  role: string | null;
  role_meaning: string | null;
  trust_state: string | null;
  /** Whether evidence was required for this state, and whether any is attached. */
  evidence_required: boolean;
  evidence_refs: string[];
  valid_from: string | null;
  valid_to: string | null;
  closed_reason: string | null;
  /**
   * In force at this instant.
   *
   * SEPARATE FROM trust_state, deliberately. "Is this in force now" and "how
   * sure are we it is real" have different remedies: an expired authority needs
   * renewing, an unevidenced one needs a document. One combined status answers
   * "inactive" to both and tells the operator nothing about which.
   */
  is_live: boolean;
}

function toView(row: ContextualRoleRow): RoleView {
  const trust = typeof row.trust_state === 'string' ? row.trust_state : null;
  const role = typeof row.role_label === 'string' ? row.role_label : null;
  return {
    relationship_id: row.relationship_id ?? null,
    subject_ref: row.persona_a ?? null,
    object_ref: row.persona_b ?? null,
    role,
    role_meaning: role && isRole(role) ? ROLE_MEANING[role] : null,
    trust_state: trust,
    evidence_required: trust !== null && isTrustState(trust) && requiresEvidence(trust),
    evidence_refs: Array.isArray(row.evidence_refs) ? row.evidence_refs : [],
    valid_from: row.valid_from ?? null,
    valid_to: row.valid_to ?? null,
    closed_reason: row.closed_reason ?? null,
    is_live: !row.valid_to,
  };
}

/** An integer query param inside a stated range, or a refusal naming it. */
function boundedInt(raw: unknown, name: string, min: number, max: number, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  /*
   * REFUSED, NOT CLAMPED. A caller who asked for depth 99 and silently got 4
   * would read a deny as "not reachable within 99 hops", which is a far stronger
   * claim than the one actually checked.
   */
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new AppError(
      400,
      ErrorCodes.VALIDATION_ERROR,
      `${name} must be an integer between ${min} and ${max}`
    );
  }
  return parsed;
}

/**
 * GET /api/leadflow/relationships — every role a subject holds.
 *
 * GROUPED BY OBJECT IN THE COMPOSER so every consumer groups the same way. The
 * mockup renders one card per property carrying several role chips; deriving the
 * grouping in each client is how two screens come to disagree about which roles
 * belong together.
 */
relationshipRoutes.get(
  '/',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const query = (req.query ?? {}) as Record<string, string | undefined>;
    const subjectRef = (query.subject_ref ?? '').trim();

    if (subjectRef === '') {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'subject_ref is required');
    }

    const roleFilter = query.role?.trim();
    if (roleFilter && !isRole(roleFilter)) {
      /*
       * A screen headed "Owners" listing occupants is the exact confusion this
       * vocabulary exists to prevent — the two carry completely different
       * authority — so an unknown filter is refused rather than dropped.
       */
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, roleListMessage);
    }

    const trustFilter = query.trust_state?.trim();
    if (trustFilter && !isTrustState(trustFilter)) {
      throw new AppError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        `trust_state must be one of ${TRUST_STATES.join(', ')}`
      );
    }

    const target = query.check_reachable_to?.trim();
    const depthCap = boundedInt(query.depth_cap, 'depth_cap', 1, MAX_DEPTH_CAP, DEFAULT_BUDGET.depth_cap);
    const visitCap = boundedInt(query.visit_cap, 'visit_cap', 1, MAX_VISIT_CAP, DEFAULT_BUDGET.visit_cap);

    const [roles, reach] = await Promise.all([
      listRoles({
        subjectRef,
        objectRef: query.object_ref?.trim() || undefined,
        role: roleFilter as Role | undefined,
        trustState: trustFilter as TrustState | undefined,
        includeClosed: query.include_closed === 'true',
        asOf: query.as_of?.trim() || undefined,
        limit: PAGE_LIMIT,
      }),
      target
        ? checkReachable({ subjectRef, targetRef: target, depthCap, visitCap })
        : Promise.resolve(null),
    ]);

    const views = roles.value.map(toView);

    /* One card per object, from the SAME rows as the flat list, so a card and
       the list cannot disagree about what attaches to what. */
    const byObject = new Map<string, RoleView[]>();
    for (const view of views) {
      const key = view.object_ref ?? 'unknown';
      const bag = byObject.get(key) ?? [];
      bag.push(view);
      byObject.set(key, bag);
    }

    res.status(200).json({
      success: true,
      data: {
        subject_ref: subjectRef,
        /* AC1 — several roles per pair, each with its own trust and validity. */
        roles: views,
        roles_by_object: [...byObject.entries()].map(([objectRef, entries]) => ({
          object_ref: objectRef,
          roles: entries,
          live_count: entries.filter((entry) => entry.is_live).length,
          closed_count: entries.filter((entry) => !entry.is_live).length,
        })),
        role_count: views.length,
        /* AC2 — closed roles are one query param away and never gone. */
        include_closed: query.include_closed === 'true',
        as_of: query.as_of ?? null,
        /* AC4 — the walk is bounded, and what it spent is reported beside the
           verdict so a deny reads as "not reachable" rather than "we gave up". */
        reachability: target
          ? {
              target_ref: target,
              decision: reach?.value?.decision ?? null,
              reason: reach?.value?.reason ?? null,
              budget: { depth_cap: depthCap, visit_cap: visitCap },
              budget_used: reach?.value?.budget_used ?? null,
              traversal_depth: reach?.value?.traversal_depth ?? null,
              available: reach?.available ?? false,
            }
          : null,
        vocabulary: ROLES.map((role) => ({ role, meaning: ROLE_MEANING[role] })),
        upstream_available: { rebac: roles.available },
      },
    });
  })
);

/**
 * POST /api/leadflow/relationships — establish one role.
 *
 * THE EVIDENCE RULE IS ENFORCED HERE AND UPSTREAM. This handler refuses with a
 * message naming the two states; sdk-rebac refuses again in its service and with
 * a CHECK constraint, so an unevidenced CONFIRMED row is unrepresentable however
 * it was written. Belt and braces is the right posture when the failure mode is
 * a false claim of verification.
 */
relationshipRoutes.post(
  '/',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const subjectRef = typeof body.subject_ref === 'string' ? body.subject_ref.trim() : '';
    const objectRef = typeof body.object_ref === 'string' ? body.object_ref.trim() : '';
    const role = typeof body.role === 'string' ? body.role.trim() : '';
    const trustState = typeof body.trust_state === 'string' ? body.trust_state.trim() : 'CANDIDATE';
    const evidenceRefs = Array.isArray(body.evidence_refs)
      ? body.evidence_refs.map((ref) => String(ref).trim()).filter(Boolean)
      : [];

    if (subjectRef === '' || objectRef === '') {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'subject_ref and object_ref are required');
    }
    if (subjectRef === objectRef) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'subject_ref and object_ref must differ');
    }
    if (!isRole(role)) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, roleListMessage);
    }
    if (!isTrustState(trustState)) {
      throw new AppError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        `trust_state must be one of ${TRUST_STATES.join(', ')}`
      );
    }

    /*
     * AC3. CONFIRMED and DOCUMENTED mean somebody CHECKED, so they must say what
     * they checked. A CONFIRMED role with nothing behind it reads as verified to
     * every downstream reader while resting on nothing — worse than an honest
     * CANDIDATE, because nobody will ever question it again.
     */
    if (requiresEvidence(trustState) && evidenceRefs.length === 0) {
      throw new AppError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        `trust_state ${trustState} requires at least one evidence_ref`
      );
    }

    const granted = await grantRole({
      subjectRef,
      objectRef,
      role,
      trustState,
      evidenceRefs,
      validFrom: typeof body.valid_from === 'string' ? body.valid_from : undefined,
      scope: (body.scope as Record<string, unknown>) ?? undefined,
    });

    if (!granted.ok) {
      if (granted.conflict) {
        /* Two live OCCUPIES for one pair is not richer data, it is a record
           nobody can act on. End the existing one or re-attest it. */
        throw new AppError(
          409,
          ErrorCodes.CONFLICT,
          'A live role of this kind already exists for this pair'
        );
      }
      throw new AppError(
        502,
        ErrorCodes.UPSTREAM_UNAVAILABLE,
        'The relationship graph did not confirm the role, so nothing was established'
      );
    }

    res.status(201).json({
      success: true,
      data: {
        ...toView(granted.role),
        /* Stated rather than implied: establishing OCCUPIES leaves any existing
           OWNS on the same pair exactly where it was. */
        note: 'Roles coexist. Establishing this one does not disturb any other role on the same pair.',
      },
    });
  })
);

/**
 * POST /api/leadflow/relationships/:relationship_id/end — close a role.
 *
 * SETS valid_to, NEVER DELETES (AC2). A POST rather than a DELETE because the
 * verb would advertise the wrong semantics even with a correct handler behind
 * it: nothing is removed, and the role stays readable in provenance forever.
 */
relationshipRoutes.post(
  '/:relationship_id/end',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const relationshipId = String(req.params?.relationship_id ?? '');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    const validTo = typeof body.valid_to === 'string' ? body.valid_to.trim() : '';

    /*
     * Ending a decision authority is a claim about the world changing, and "why"
     * is the only part of it a later reader can assess. An unexplained close is
     * indistinguishable from a mistake — and this is exactly the row somebody
     * will be reading when they are trying to work out whether it was one.
     */
    if (reason === '') {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'reason is required to end a relationship');
    }

    /*
     * A role that has not stopped being true yet is still live. Dating its end
     * forward would make every reachability check between now and then answer on
     * a role the record says has ended.
     */
    if (validTo !== '') {
      const at = Date.parse(validTo);
      if (Number.isNaN(at)) {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'valid_to must be a valid timestamp');
      }
      if (at > Date.now()) {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'valid_to cannot be in the future');
      }
    }

    const closed = await closeRole({
      relationshipId,
      reason,
      validTo: validTo === '' ? undefined : validTo,
    });

    /*
     * 404 RATHER THAN 200. A caller reading 200 as "closed" would leave an
     * operator believing a live authority had been ended when nothing happened.
     */
    if (!closed.value) {
      throw new AppError(
        404,
        ErrorCodes.NOT_FOUND,
        'No relationship with that id could be closed'
      );
    }

    res.status(200).json({
      success: true,
      data: {
        ...toView(closed.value),
        /* AC2, stated in the response so no reader has to infer it. */
        deleted: false,
        still_visible_in_provenance: true,
        note: 'Ending a role says it STOPPED being true, not that it never was. A role asserted in error needs its evidence corrected rather than an end date, because an end date leaves the historical period intact and readable.',
      },
    });
  })
);
