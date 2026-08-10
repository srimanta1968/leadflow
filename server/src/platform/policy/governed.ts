import { randomUUID } from 'crypto';
import { Response } from 'express';
import { PolicyObligation } from '../../config/policies';
import { AuthenticatedRequest } from '../../middleware/auth';
import { AppError, ErrorCodes } from '../../utils/errors';
import { appendAuditEntry } from '../audit/auditLog';
import { AuditEventName } from '../audit/vocabulary';
import { PlatformRequest } from '../auth/sessionContext';
import { evaluate, PolicyDecision } from './policyEngine';

/** A request that has been through both auth middlewares. */
export type GovernedRequest = AuthenticatedRequest & PlatformRequest;

/**
 * How a handler deals with one obligation the PDP attached to its permit.
 *
 * `discharge` runs a real check and refuses when it fails. `defer` is an
 * admission that the check cannot be made yet — see the field docs on
 * `GovernedSpec.obligations`.
 */
export type ObligationHandling =
  | { kind: 'discharge'; check: (req: GovernedRequest) => Promise<boolean> | boolean; onFail: string }
  | { kind: 'defer'; because: string };

export interface GovernedSpec {
  /** Permission from `config/roles.ts`. Never a freehand string. */
  action: string;
  /** Audit event appended after the write succeeds. */
  event: AuditEventName;
  /** Consent purpose the action is taken under. */
  purpose: string;
  resourceType: string;
  /** The record acted upon, when the route names one. */
  resourceId?: (req: GovernedRequest) => string | undefined;
  /**
   * How each obligation type this action can carry is dealt with.
   *
   * EVERY obligation the PDP returns must have an entry. An obligation with no
   * entry FAILS CLOSED — the request is refused — because the alternative is a
   * permit that silently ignores the condition attached to it, which is
   * indistinguishable from having no condition at all. Adding an obligation to
   * `policies.ts` would then quietly weaken rather than tighten the system,
   * which is precisely backwards.
   */
  obligations?: Partial<Record<PolicyObligation['type'], ObligationHandling>>;
  /** Extra audit metadata. Never load-bearing. */
  metadata?: (req: GovernedRequest) => Record<string, unknown>;
}

/**
 * Local `users.role` values, mapped onto the SOP role keys the policy bundle
 * speaks.
 *
 * TWO VOCABULARIES EXIST, and they do not overlap. The local projection stores
 * `admin` / `manager` / `user`; `config/roles.ts` defines nine SOP actors, none
 * of them named that. Without this bridge every locally-authenticated caller
 * would match no rule and be denied — default-deny doing exactly what it should,
 * against a vocabulary mismatch rather than a real absence of authority.
 *
 * A BRIDGE, NOT A ROLE MODEL. It exists only while local authentication does,
 * and it is deliberately narrow: it grants what the local role already implied
 * in this app and nothing more. It disappears with the local `users` table —
 * see `AuthService.assertLocalCredentialsPermitted`. A platform session carries
 * real persona grants and never reaches this function.
 *
 * `admin` maps to THREE SOP roles because the local `admin` was unrestricted in
 * this app: it configured routing, reassigned leads AND worked them. Dropping
 * any of the three would take away authority the app already granted, which is a
 * migration rather than a bridge — and it showed up immediately as `admin`
 * being refused `POST /api/leads/:id/first-response`, since recording a response
 * is `lead.work_assigned`, which only a Rep holds. A Sales Manager is genuinely
 * not a Rep under SOP §28; the mistake was expecting one SOP role to stand in
 * for a local superuser.
 */
const LOCAL_ROLE_BRIDGE: Record<string, string[]> = {
  /*
   * `client_success` added here, and it is a judgement call worth reading.
   *
   * It holds handoff.accept, onboarding.manage and escalation.receive — the
   * entire post-sale half of the product — and NO local role bridged to it, so
   * every onboarding endpoint was unreachable by every user in the system. That
   * is a gap rather than a policy: an endpoint nobody can call is dead code
   * wearing a permission check.
   *
   * Folded into `admin` rather than given its own local role because users.role
   * is a single column and adding a value is a product decision, not a fix. Note
   * the contrast with `steward` below: that separation is deliberate and about
   * LEAST PRIVILEGE on capture resolution, which is a different question from an
   * area of the product having no caller at all.
   */
  admin: ['revenue_operations', 'sales_manager', 'sales_rep', 'client_success'],
  manager: ['sales_manager'],
  user: ['sales_rep'],
  // A steward is NOT folded into `admin`. The capture-resolution grants sit with
  // data_steward alone (config/policies.ts), and the comment above this map
  // records why that separation exists: expecting one SOP role to stand in for a
  // local superuser is the mistake that produced the 403s in the first place.
  // Kept as its own local role so a caller either legitimately holds stewardship
  // or does not — `users.role` is a single column, so this is a SEPARATE account,
  // never an elevation of the admin one.
  steward: ['data_steward'],
  /*
   * `privacy` added for the same reason `client_success` was, and resolved the
   * OPPOSITE way for a reason worth stating.
   *
   * privacy_officer holds consent.purpose_manage, dsar.fulfil and
   * erasure.execute, and NO local role bridged to it, so the entire consent and
   * data-rights surface was unreachable by every user — dead code wearing a
   * permission check, exactly the gap noted above.
   *
   * But it is NOT folded into `admin`. client_success could be, because
   * accepting a handoff is ordinary operational work an admin plausibly does.
   * Revoking a consent receipt and executing an erasure are not: they are the
   * acts a regulator asks about by name, and an audit that cannot distinguish
   * "the Privacy Officer revoked this" from "one of forty admins did" has lost
   * the only fact that mattered. So it follows `steward` — its own local role,
   * its own account, held or not held.
   */
  privacy: ['privacy_officer'],
};

/**
 * The caller's roles, failing closed to none.
 *
 * A platform session wins outright: its roles come from persona grants resolved
 * upstream at request time, which is the authority. The local session is
 * consulted only when there is no platform session at all.
 */
export function rolesFor(req: GovernedRequest): string[] {
  if (req.platformSession?.roles.length) {
    return req.platformSession.roles;
  }

  const local = req.session?.role;
  if (!local) {
    return [];
  }

  // An unmapped local role yields NOTHING rather than itself. Passing it
  // through would make an unrecognised value indistinguishable from a real SOP
  // role that simply holds no grants — and if someone later adds an SOP role
  // whose name collides with a local one, pass-through would silently grant it.
  return LOCAL_ROLE_BRIDGE[local] ?? [];
}

/** Who to record as the actor, preferring the platform persona. */
function actorFor(req: GovernedRequest): string {
  // The PERSONA, not the person and not the local user id: the same human acting
  // as Data Steward and as Sales Rep is two different authorities, and an audit
  // entry that names only the human cannot say which one acted.
  return (
    req.platformSession?.personaId ??
    req.platformSession?.personId ??
    req.session?.userId ??
    'unknown'
  );
}

/** The capacity they acted in. */
function personaRoleFor(req: GovernedRequest): string {
  return rolesFor(req)[0] ?? 'unknown';
}

/**
 * Settle the obligations on a permit.
 *
 * @returns The obligation types that were deferred rather than checked.
 * @throws AppError(403) when an obligation is undeclared or its check fails.
 */
async function settleObligations(
  decision: PolicyDecision,
  spec: GovernedSpec,
  req: GovernedRequest
): Promise<string[]> {
  const deferred: string[] = [];

  for (const obligation of decision.obligations) {
    const handling = spec.obligations?.[obligation.type];

    if (!handling) {
      // Fail closed. The rule said "permitted, IF" and this handler has not said
      // how it satisfies the "if", so it is not permitted.
      throw new AppError(
        403,
        ErrorCodes.FORBIDDEN,
        `This action carries an unmet condition: ${obligation.detail}`
      );
    }

    if (handling.kind === 'defer') {
      deferred.push(obligation.type);
      // Loud, because a deferral is a known hole and the log is where it stays
      // visible between the decision to defer and the work that closes it.
      console.warn(
        `[policy] ${spec.action}: obligation '${obligation.type}' NOT enforced — ${handling.because}`
      );
      continue;
    }

    if (!(await handling.check(req))) {
      throw new AppError(403, ErrorCodes.FORBIDDEN, handling.onFail);
    }
  }

  return deferred;
}

/**
 * Wrap a mutating handler in a policy decision and an audit entry.
 *
 * ORDER MATTERS AND IS NOT NEGOTIABLE:
 *
 *   1. PDP decides, BEFORE the handler runs. A check after the write is not a
 *      check — the row already exists.
 *   2. The handler runs only on an unconditional-or-settled permit.
 *   3. The audit entry is appended AFTER the write succeeds, quoting the
 *      decisionRef from step 1. Appending first would record actions that never
 *      happened, which corrupts the ledger in the direction nobody checks.
 *
 * A THROWN HANDLER APPENDS NOTHING. If the write failed there is no act to
 * record, and an entry for it would be a false statement in a tamper-evident
 * chain. The refusal itself is a different matter: a DENY is appended, because
 * an attempt that was refused is exactly what an auditor wants to find.
 *
 * The audit append never throws (see `appendAuditEntry`), so a ledger outage
 * cannot fail a write that has already committed.
 */
export function governed<T extends GovernedRequest>(
  spec: GovernedSpec,
  handler: (req: T, res: Response, decision: PolicyDecision) => Promise<void>
): (req: T, res: Response) => Promise<void> {
  return async (req: T, res: Response): Promise<void> => {
    const decision = evaluate(
      {
        action: spec.action,
        resourceType: spec.resourceType,
        resourceId: spec.resourceId?.(req),
      },
      rolesFor(req)
    );

    // One key for the whole act, so the audit append and any upstream call a
    // retry produces are recognisable as the same attempt rather than two.
    const idempotencyRef = `${spec.action}:${decision.decisionRef}`;

    if (decision.effect === 'deny') {
      await recordRefusal(spec, req, decision, idempotencyRef, 'denied');
      throw new AppError(403, ErrorCodes.FORBIDDEN, decision.reason);
    }

    if (decision.effect === 'requires_approval') {
      await recordRefusal(spec, req, decision, idempotencyRef, 'approval_required');
      // A DISTINCT code, not a plain FORBIDDEN. The difference is the whole
      // reason `requires_approval` exists as a third effect: this action is open
      // to the caller and needs a second party, so the client should offer the
      // escalation rather than telling them they may not do it. Collapsing the
      // two would train people to work around the product.
      throw new AppError(403, ErrorCodes.APPROVAL_REQUIRED, decision.reason);
    }

    const deferred = await settleObligations(decision, spec, req);

    await handler(req, res, decision);

    await appendAuditEntry({
      event: spec.event,
      actor: actorFor(req),
      personaRole: personaRoleFor(req),
      purpose: spec.purpose,
      decisionRef: decision.decisionRef,
      // No external evidence for an in-app action: the decision IS what it rests
      // on. Named explicitly rather than left blank, because a blank required
      // field reads as an omission rather than as "there is none".
      evidenceRef: `pdp:${decision.decisionRef}`,
      causationId: randomUUID(),
      idempotencyRef,
      subjectId: spec.resourceId?.(req),
      subjectType: spec.resourceType,
      metadata: {
        ...(spec.metadata?.(req) ?? {}),
        outcome: 'permitted',
        // Carried into the ledger so a deferred obligation is discoverable by
        // query later, not only by reading the source at the time.
        ...(deferred.length > 0 ? { deferred_obligations: deferred } : {}),
      },
    });
  };
}

/** Append the record of an action that was refused. */
async function recordRefusal(
  spec: GovernedSpec,
  req: GovernedRequest,
  decision: PolicyDecision,
  idempotencyRef: string,
  outcome: 'denied' | 'approval_required'
): Promise<void> {
  await appendAuditEntry({
    event: spec.event,
    actor: actorFor(req),
    personaRole: personaRoleFor(req),
    purpose: spec.purpose,
    decisionRef: decision.decisionRef,
    evidenceRef: `pdp:${decision.decisionRef}`,
    causationId: randomUUID(),
    idempotencyRef,
    subjectId: spec.resourceId?.(req),
    subjectType: spec.resourceType,
    metadata: { outcome, reason: decision.reason },
  });
}
