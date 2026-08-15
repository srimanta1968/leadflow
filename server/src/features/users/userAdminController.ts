import { Response } from 'express';
import { dataService } from '../../services/DataService';
import { sendInvitationEmail } from '../../platform/email';
import { AuthService } from '../../services/AuthService';
import { AuthenticatedRequest } from '../../middleware/auth';
import { AppError, ErrorCodes } from '../../utils/errors';
import { AUDIT_EVENTS } from '../../platform/audit/vocabulary';
import { governed, GovernedRequest, sopRolesForLocalRole } from '../../platform/policy/governed';
import { SdkGatewayClient } from '../../platform/sdkGateway';
import { grantRoleTemplate, resolveRoleTemplateId } from './personaGrants';
import { PERMISSIONS } from '../../config/roles';
import { UserRow } from '../../types';
import { isAssignableLocalRole, localRoleCatalogue, permissionMatrix } from './roleCatalogue';
import { findUserById, findUserByEmail, listRegister, toRegisterUser } from './userRegister';

/**
 * The user register's HTTP surface.
 *
 * FOUR GOVERNED WRITES AND TWO REFERENCE READS. The writes go through
 * `governed()` — which decides, then acts, then appends — because every one of
 * them changes who may do what, and a change of authority with no entry in the
 * chain is the change an auditor cannot reconstruct. The reads are behind
 * `authenticate` only: what a role means is reference material, and hiding it
 * from an operator who has just been told a screen is Locked leaves them with a
 * refusal and no explanation.
 *
 * THE PURPOSE ON ALL FOUR IS `security_operations`, reusing the vocabulary
 * already in the codebase rather than minting a sixteenth value for the same
 * idea. Provisioning and access change are security operations; calling them
 * `user_administration` would put one act under two names in the ledger.
 */

/**
 * The shape `governed` hands a handler here.
 *
 * `personaMirror` is written by the handler and read by the spec's `metadata`
 * callback. That works — and is not a trick — because `governed()` evaluates
 * metadata AFTER the handler returns, precisely so an entry can describe what
 * actually happened rather than what was requested.
 */
type UserAdminRequest = GovernedRequest & {
  params: { id: string };
  personaMirror?: PersonaMirror;
};

/** Minimum length for an administrator-issued initial password. */
const MIN_PASSWORD_LENGTH = 12;

/**
 * A conservative address check.
 *
 * NOT an RFC 5322 parser. The register's job is to catch a typo before it
 * becomes an account nobody can sign into, and the authority on whether an
 * address exists is whether mail to it arrives — which this product cannot ask.
 * A permissive check that rejects the obviously-broken is the honest amount of
 * validation to do here.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Read a required non-empty string from a body, or 400. */
function requiredString(body: unknown, field: string): string {
  const value = (body as Record<string, unknown> | undefined)?.[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw AppError.badRequest(`${field} is required`);
  }
  return value.trim();
}

/** Read an optional string, normalising blank to null. */
function optionalString(body: unknown, field: string): string | null {
  const value = (body as Record<string, unknown> | undefined)?.[field];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw AppError.badRequest(`${field} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Load the subject of an action, or 404. */
async function requireUser(userId: string): Promise<UserRow> {
  const row = await findUserById(userId);
  if (!row) {
    throw AppError.notFound('No user with that id is on the register');
  }
  return row;
}

/** The acting user's local id, for the `invited_by` / `deactivated_by` stamp. */
function actorUserId(req: GovernedRequest): string | null {
  return req.session?.userId ?? null;
}

/**
 * Who to name as the sender in an invitation.
 *
 * The EMAIL, not the id: the recipient is being asked to trust a link, and
 * "srimanta@… invited you" is checkable in a way that a UUID is not. Null when
 * the session carries neither, and the template then says "an administrator"
 * rather than inventing a name.
 */
function actorName(req: GovernedRequest): string | null {
  return req.session?.email ?? null;
}

/** What happened when a local role change was pushed to the linked persona. */
export interface PersonaMirror {
  /** Null when nothing needed mirroring — no persona, or no gateway. */
  applied: boolean | null;
  /** The SOP role sent upstream, when one was. */
  role: string | null;
  detail: string;
}

/**
 * Push a local role change onto the ProjexCloud persona behind the account.
 *
 * WHY THIS EXISTS AT ALL. `rolesFor` prefers a platform session's persona grants
 * over the local `users.role` — deliberately, because persona grants are the
 * authority. So for a colleague who signs in through ProjexCloud, writing the
 * local column ALONE changes nothing they can do, while the register cheerfully
 * reports the new role. That is the worst possible shape: a permission model
 * that looks changed and enforces the old value, with no error anywhere.
 *
 * BEST EFFORT, BUT REPORTED. It never fails the local write — the row has
 * already been committed and refusing it afterwards would leave the caller told
 * a change did not happen when it did. What it must never do is stay silent: the
 * result travels in the response and in the audit metadata, so "the local role
 * changed and the persona did not" is a fact somebody can find rather than a
 * divergence discovered months later.
 *
 * ONE SOP ROLE IS SENT, AND THE REST ARE NAMED. A local value can bridge to
 * several SOP actors — `admin` is four — while the persona endpoint takes a
 * single role label. Sending the first and pretending that is the whole grant
 * would quietly narrow somebody's authority upstream, so the others are reported
 * as NOT mirrored instead of being dropped.
 */
async function mirrorRoleToPersona(
  personaId: string | null | undefined,
  localRole: string,
  assignedBy: string
): Promise<PersonaMirror> {
  if (!personaId) {
    return {
      applied: null,
      role: null,
      detail:
        'This account is local only — it projects no ProjexCloud persona, so users.role is the whole authority and there is nothing to mirror.',
    };
  }

  if (!SdkGatewayClient.isConfigured()) {
    return {
      applied: false,
      role: null,
      detail:
        'This account is linked to a ProjexCloud persona, but no gateway is configured, so the persona still holds its previous role. The local column and the persona now disagree.',
    };
  }

  const sopRoles = sopRolesForLocalRole(localRole);
  const primary = sopRoles[0] ?? null;

  if (!primary) {
    return {
      applied: false,
      role: null,
      detail: `The role bridge maps '${localRole}' to no SOP role, so there is nothing to send upstream.`,
    };
  }

  /*
   * THE TEMPLATE ID FIRST, and a failure here is reported rather than worked
   * around. `POST /api/role-assignments` takes a role_template_id, not a name,
   * and inventing a uuid for a foreign key is both forbidden and futile — the
   * platform rejects it on role_template_app_id_fkey.
   */
  const templateId = await resolveRoleTemplateId(primary);
  if (!templateId) {
    return {
      applied: false,
      role: primary,
      detail: `No ProjexCloud role template is published under the name '${primary}', so there is no role_template_id to grant. Provision the role catalogue (it runs at boot) and retry — the local column and the persona disagree until then.`,
    };
  }

  const applied = await grantRoleTemplate(personaId, templateId, assignedBy);
  const unmirrored = sopRoles.slice(1);

  return {
    applied,
    role: primary,
    detail: applied
      ? `The persona was granted the '${primary}' role template.${
          unmirrored.length > 0
            ? ` The local role also confers ${unmirrored.join(', ')}, which this single grant does not carry — those apply only while the caller uses a local session.`
            : ''
        }`
      : `The persona could NOT be granted '${primary}'. The local column and the persona disagree until this is retried.`,
  };
}

export class UserAdminController {
  /**
   * GET /api/users/register — the roster with its lifecycle states.
   *
   * SEPARATE FROM `GET /api/users`, which every screen that needs to name a
   * colleague already calls and which returns active users only. Widening that
   * response to carry invitation stamps would push administrative data into the
   * routing, coverage and ownership screens that consume it, and narrowing it
   * later would break them.
   */
  static async list(req: AuthenticatedRequest, res: Response): Promise<void> {
    const includeDeactivated = req.query.deactivated === 'true';
    const rows = await listRegister(includeDeactivated);
    const users = rows.map(toRegisterUser);

    res.status(200).json({
      success: true,
      data: {
        users,
        total: users.length,
        pending: users.filter((user) => user.state === 'pending').length,
        // Stated by the API rather than inferred by the screen: whether an
        // administrator can issue a password here is a deployment fact, and a
        // client guessing at it would offer a control the server refuses.
        local_credentials_permitted: AuthService.localCredentialsPermitted(),
      },
    });
  }

  /**
   * GET /api/users/roles — what each assignable role actually grants.
   *
   * The role picker's whole content. See roleCatalogue.ts for why none of it is
   * written down twice.
   */
  static async roles(_req: AuthenticatedRequest, res: Response): Promise<void> {
    const roles = localRoleCatalogue();
    res.status(200).json({ success: true, data: { roles, total: roles.length } });
  }

  /**
   * GET /api/users/permission-matrix — the SOP §28 grid, as the PDP decides it.
   *
   * READ-ONLY, and there is no companion write. Roles and policies are versioned
   * code in config/roles.ts and config/policies.ts; an endpoint that edited them
   * would make the policy set per-tenant configuration, which is precisely the
   * one thing in this system that must have a single source.
   */
  static async matrix(_req: AuthenticatedRequest, res: Response): Promise<void> {
    const rows = permissionMatrix();
    res.status(200).json({
      success: true,
      data: {
        rows,
        total: rows.length,
        source: 'server/src/config/roles.ts + server/src/config/policies.ts',
        editable: false,
      },
    });
  }

  /**
   * POST /api/users/invite — add a colleague to the register.
   *
   * 201, because this INSERTS an addressable row at a collection root.
   *
   * The account is created PENDING: `is_active` false, and a credential no
   * password can match (see AuthService.unusableCredential). An invitation that
   * created a working sign-in the moment it was issued would mean the act of
   * adding somebody to a list and the act of letting them in were the same act,
   * and only one of those is reversible by the person who did it.
   */
  static invite = governed(
    {
      action: PERMISSIONS.USER_INVITE,
      event: AUDIT_EVENTS.USER_INVITED,
      purpose: 'security_operations',
      resourceType: 'user',
      metadata: (req) => ({
        invited_email: (req.body as { email?: string })?.email ?? null,
        invited_role: (req.body as { role?: string })?.role ?? null,
      }),
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const email = requiredString(req.body, 'email');
      const role = requiredString(req.body, 'role');
      const firstName = optionalString(req.body, 'first_name');
      const lastName = optionalString(req.body, 'last_name');

      if (!EMAIL_PATTERN.test(email)) {
        throw AppError.badRequest('email must be a valid address');
      }
      if (!isAssignableLocalRole(role)) {
        // A named refusal rather than a generic validation error: an
        // unrecognised role SAVES fine and grants nothing, so the failure this
        // rejects is the silent one.
        throw AppError.badRequest(
          `role must be one of: ${localRoleCatalogue().map((entry) => entry.key).join(', ')}`
        );
      }

      const existing = await findUserByEmail(email);
      if (existing) {
        throw AppError.conflict(
          ErrorCodes.EMAIL_ALREADY_EXISTS,
          'Somebody with that email is already on the register'
        );
      }

      const passwordHash = await AuthService.unusableCredential();

      let created: UserRow | null;
      try {
        created = await dataService.queryOne<UserRow>(
          `INSERT INTO users
             (email, password_hash, first_name, last_name, role, is_active, invited_at, invited_by)
           VALUES ($1, $2, $3, $4, $5, FALSE, CURRENT_TIMESTAMP, $6)
           RETURNING *`,
          [email, passwordHash, firstName, lastName, role, actorUserId(req)]
        );
      } catch (error) {
        // The existence check above races two concurrent invitations for one
        // address; the unique index is what actually decides, so its violation
        // becomes the documented conflict rather than a 500.
        const constraint = (error as { constraint?: string }).constraint ?? '';
        if (constraint.includes('email')) {
          throw AppError.conflict(
            ErrorCodes.EMAIL_ALREADY_EXISTS,
            'Somebody with that email is already on the register'
          );
        }
        throw error;
      }

      if (!created) {
        throw new AppError(500, ErrorCodes.INTERNAL_ERROR, 'The invitation could not be recorded');
      }

      /*
       * THE INVITATION EMAIL IS THE ONLY WAY INTO THIS ACCOUNT. The row above is
       * created with an unusable credential and is_active FALSE, so an invitation
       * that never arrives leaves a person who cannot sign in and cannot ask for
       * a reset either — a dead end with no signal. That is why the outcome is
       * REPORTED on the response rather than assumed: an administrator who sees
       * "invited" and hears nothing back needs to know whether to chase it.
       *
       * It does not throw. The account is already on the register; failing the
       * request would leave the row created and tell the caller it was not.
       */
      const delivery = await sendInvitationEmail({
        userId: created.id,
        email: created.email,
        firstName: created.first_name ?? null,
        roleLabel: role,
        invitedBy: actorName(req),
        invitedByUserId: actorUserId(req),
      });

      res.status(201).json({
        success: true,
        data: {
          user: toRegisterUser(created),
          invitation: {
            sent: delivery.status === 'sent',
            status: delivery.status,
            detail:
              delivery.status === 'sent'
                ? `An invitation has been sent to ${created.email}. It expires in 7 days.`
                : delivery.status === 'skipped'
                  ? 'Email is not configured on this deployment, so no invitation was sent. This account cannot be signed in to until one is.'
                  : /* THE ADDRESS, NOT THE MAIL SYSTEM. An administrator who
                       mistypes a colleague's domain has created an account
                       nobody can ever enter, and the only useful thing to tell
                       them is which half is wrong. */
                    delivery.status === 'blocked'
                    ? `No invitation was sent: ${delivery.verification?.reason ?? 'that address did not pass the deliverability check'} Correct the address and invite again — this account cannot be signed in to until an invitation arrives.`
                    : 'The invitation could not be sent. This account cannot be signed in to until it is — send another once email is working.',
            address_check: delivery.verification ?? null,
          },
        },
      });
    }
  );

  /**
   * PATCH /api/users/:id/role — change what a colleague may do.
   *
   * 200: it changes an existing row rather than creating one.
   *
   * THE AUDIT METADATA CARRIES BOTH SIDES. `previous_role` is read before the
   * write and put in the entry, because "the role was changed to Manager" cannot
   * answer the question anybody actually asks — what could this person do
   * before, and did somebody quietly widen it.
   */
  static assignRole = governed(
    {
      action: PERMISSIONS.USER_ROLE_ASSIGN,
      event: AUDIT_EVENTS.USER_ROLE_CHANGED,
      purpose: 'security_operations',
      resourceType: 'user',
      resourceId: (req) => (req as UserAdminRequest).params.id,
      metadata: (req) => {
        const mirror = (req as UserAdminRequest).personaMirror;
        return {
          requested_role: (req.body as { role?: string })?.role ?? null,
          // WHETHER THE CHANGE REACHED THE AUTHORITY. A local role change on an
          // account backed by a ProjexCloud persona is not the whole act: the
          // persona's grants are what a platform session enforces. An entry that
          // recorded only the local write would say authority was granted when it
          // may not have been.
          persona_role_mirrored: mirror?.applied ?? null,
          persona_role: mirror?.role ?? null,
        };
      },
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const userId = (req as UserAdminRequest).params.id;
      const role = requiredString(req.body, 'role');

      if (!isAssignableLocalRole(role)) {
        throw AppError.badRequest(
          `role must be one of: ${localRoleCatalogue().map((entry) => entry.key).join(', ')}`
        );
      }

      const subject = await requireUser(userId);

      if (subject.role === role) {
        // Not an error. Re-asserting the role a person already holds is a
        // no-op, and answering 409 would make an idempotent retry look like a
        // conflict.
        res.status(200).json({
          success: true,
          data: {
            user: toRegisterUser(subject),
            previous_role: subject.role,
            changed: false,
            persona: {
              applied: null,
              role: null,
              detail: 'Nothing changed, so nothing was sent to the persona.',
            } satisfies PersonaMirror,
          },
        });
        return;
      }

      const updated = await dataService.queryOne<UserRow>(
        `UPDATE users
            SET role = $2, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
          RETURNING *`,
        [userId, role]
      );

      if (!updated) {
        throw AppError.notFound('No user with that id is on the register');
      }

      // AFTER the local write, never before. A persona updated against a local
      // write that then failed would leave ProjexCloud holding a role this
      // product never granted, and ProjexCloud is the store nobody here can fix.
      const persona = await mirrorRoleToPersona(
        updated.platform_persona_id,
        role,
        // The ACTING persona where there is one, so the grant is attributed to
        // the human who ordered it rather than to LeadFlow the service.
        req.platformSession?.personaId ?? actorUserId(req) ?? 'unknown'
      );
      (req as UserAdminRequest).personaMirror = persona;

      res.status(200).json({
        success: true,
        data: {
          user: toRegisterUser(updated),
          previous_role: subject.role,
          changed: true,
          persona,
        },
      });
    }
  );

  /**
   * POST /api/users/:id/activate — open the account for use.
   *
   * 200: an action on an existing resource, not a create.
   *
   * `initial_password` is OPTIONAL and, when present, is the only way a person
   * invited through this register can sign in at all — LeadFlow has no mail
   * transport, so there is no self-service link to send. When it is absent the
   * account is opened and the response says plainly that no credential was
   * issued, rather than implying the person can now get in.
   */
  static activate = governed(
    {
      action: PERMISSIONS.USER_DEACTIVATE,
      event: AUDIT_EVENTS.USER_ACTIVATED,
      purpose: 'security_operations',
      resourceType: 'user',
      resourceId: (req) => (req as UserAdminRequest).params.id,
      metadata: (req) => ({
        // WHETHER a credential was issued, never the credential. The ledger
        // records that access was granted; a password in an append-only chain
        // is a password that cannot be rotated out of it.
        credential_issued: typeof (req.body as { initial_password?: unknown })
          ?.initial_password === 'string',
      }),
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const userId = (req as UserAdminRequest).params.id;
      const initialPassword = optionalString(req.body, 'initial_password');

      if (initialPassword !== null && initialPassword.length < MIN_PASSWORD_LENGTH) {
        throw AppError.badRequest(
          `initial_password must be at least ${MIN_PASSWORD_LENGTH} characters`
        );
      }

      await requireUser(userId);

      // The credential FIRST, so an account is never opened with a password the
      // deployment then refuses to set — the 501 from `issueLocalCredential`
      // must leave the register exactly as it found it.
      if (initialPassword !== null) {
        await AuthService.issueLocalCredential(userId, initialPassword);
      }

      const updated = await dataService.queryOne<UserRow>(
        `UPDATE users
            SET is_active      = TRUE,
                activated_at   = COALESCE(activated_at, CURRENT_TIMESTAMP),
                deactivated_at = NULL,
                deactivated_by = NULL,
                updated_at     = CURRENT_TIMESTAMP
          WHERE id = $1
          RETURNING *`,
        [userId]
      );

      if (!updated) {
        throw AppError.notFound('No user with that id is on the register');
      }

      res.status(200).json({
        success: true,
        data: {
          user: toRegisterUser(updated),
          credential_issued: initialPassword !== null,
        },
      });
    }
  );

  /**
   * POST /api/users/:id/deactivate — close the account.
   *
   * 200, and NEVER a DELETE. Every audit entry, routing rule, lead assignment
   * and coverage window names a user id. Removing the row would turn a signed
   * history into dangling references and leave the one question an auditor asks
   * about a departed colleague — what did they do while they were here —
   * unanswerable. The row stays; only the ability to sign in goes.
   */
  static deactivate = governed(
    {
      action: PERMISSIONS.USER_DEACTIVATE,
      event: AUDIT_EVENTS.USER_DEACTIVATED,
      purpose: 'security_operations',
      resourceType: 'user',
      resourceId: (req) => (req as UserAdminRequest).params.id,
      metadata: (req) => ({ reason: (req.body as { reason?: string })?.reason ?? null }),
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const userId = (req as UserAdminRequest).params.id;
      const subject = await requireUser(userId);

      if (subject.id === actorUserId(req)) {
        // Refused rather than allowed-and-regretted. An administrator who closes
        // their own account may be the only holder of `user.deactivate`, and
        // the product would then have no way back in short of editing the
        // database — which is the thing this whole screen exists to remove.
        throw new AppError(
          409,
          ErrorCodes.CONFLICT,
          'You cannot deactivate your own account. Ask another administrator.'
        );
      }

      const updated = await dataService.queryOne<UserRow>(
        `UPDATE users
            SET is_active      = FALSE,
                deactivated_at = CURRENT_TIMESTAMP,
                deactivated_by = $2,
                updated_at     = CURRENT_TIMESTAMP
          WHERE id = $1
          RETURNING *`,
        [userId, actorUserId(req)]
      );

      if (!updated) {
        throw AppError.notFound('No user with that id is on the register');
      }

      res.status(200).json({
        success: true,
        data: {
          user: toRegisterUser(updated),
          // Named in the response so a client cannot present this as a delete.
          actions_remain_attributable: true,
          /*
           * A NAMED LIMITATION rather than a silent one.
           *
           * Closing the local row stops local password sign-in. It does NOT
           * revoke a ProjexCloud persona: sdk-persona publishes no deactivation
           * call this codebase already speaks, and guessing an endpoint path
           * would be worse than saying so — a revocation that quietly did
           * nothing is exactly the failure this whole screen exists to remove.
           * For a linked account, revoke the persona in ProjexCloud too.
           */
          persona_revoked: updated.platform_persona_id ? false : null,
          persona_note: updated.platform_persona_id
            ? 'This account projects a ProjexCloud persona. Local sign-in is closed, but the persona still holds its grants — revoke it in ProjexCloud as well.'
            : 'Local-only account; there is no persona to revoke.',
        },
      });
    }
  );
}
