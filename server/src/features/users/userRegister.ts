import { dataService } from '../../services/DataService';
import { UserRow } from '../../types';

/**
 * The register's own projection of a user.
 *
 * SEPARATE FROM `PublicUser`, which is the shape an authentication response
 * returns. The register answers a different question — not "who am I" but "who
 * is on this team, in what state, invited by whom" — and folding the lifecycle
 * stamps into the auth projection would put an administrative concern into every
 * sign-in response for no reader.
 */
export interface RegisterUser {
  id: string;
  email: string;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  role: string;
  /** Derived, never stored — see migration 034. */
  state: RegisterState;
  is_active: boolean;
  email_verified: boolean;
  invited_at: string | null;
  invited_by: string | null;
  activated_at: string | null;
  deactivated_at: string | null;
  deactivated_by: string | null;
  last_login: string | null;
  created_at: string;
  /**
   * The ProjexCloud persona this account projects, or null.
   *
   * SURFACED RATHER THAN HIDDEN, because it changes what a role assignment
   * MEANS. For a local-only account the `users.role` column is the whole
   * authority. For a linked one the persona's grants win at request time, so the
   * register mirrors the change upstream and says whether that landed.
   */
  platform_persona_id: string | null;
}

/**
 * The three states an account can be in.
 *
 * `pending` is NOT "inactive". An account that was invited and never opened, and
 * an account that was closed after somebody left, are the same boolean and
 * completely different facts: the first is work outstanding, the second is
 * history. A register that spelled them the same way would show a departed
 * colleague in the same list as a starter waiting for access.
 */
export type RegisterState = 'pending' | 'active' | 'deactivated';

/** Derive the state from the stamps, in the one place that does it. */
export function stateOf(row: UserRow): RegisterState {
  if (row.deactivated_at) {
    return 'deactivated';
  }
  return row.is_active ? 'active' : 'pending';
}

const iso = (value: Date | null | undefined): string | null =>
  value ? new Date(value).toISOString() : null;

/** Project a row for the register. Never carries `password_hash`. */
export function toRegisterUser(row: UserRow): RegisterUser {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    first_name: row.first_name,
    last_name: row.last_name,
    role: row.role,
    state: stateOf(row),
    is_active: row.is_active,
    email_verified: row.email_verified,
    invited_at: iso(row.invited_at),
    invited_by: row.invited_by ?? null,
    activated_at: iso(row.activated_at),
    deactivated_at: iso(row.deactivated_at),
    deactivated_by: row.deactivated_by ?? null,
    last_login: iso(row.last_login),
    created_at: new Date(row.created_at).toISOString(),
    platform_persona_id: row.platform_persona_id ?? null,
  };
}

/** Load one user by id, or null. */
export async function findUserById(userId: string): Promise<UserRow | null> {
  return dataService.queryOne<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
}

/** Load one user by email, or null. Email is unique and case-sensitive in 001. */
export async function findUserByEmail(email: string): Promise<UserRow | null> {
  return dataService.queryOne<UserRow>('SELECT * FROM users WHERE email = $1', [email]);
}

/**
 * The whole register, pending invitations first.
 *
 * ORDERED BY STATE, not by creation date. The list exists to be worked: a
 * pending invitation is an outstanding task and a deactivated account is
 * archive, so burying the first among the second — which `ORDER BY created_at`
 * does the moment the team is a year old — hides the only rows anybody needs to
 * act on.
 */
export async function listRegister(includeDeactivated: boolean): Promise<UserRow[]> {
  const sql = `
    SELECT * FROM users
     ${includeDeactivated ? '' : 'WHERE deactivated_at IS NULL'}
     ORDER BY
       CASE
         WHEN deactivated_at IS NOT NULL THEN 3
         WHEN is_active THEN 2
         ELSE 1
       END,
       created_at ASC
  `;
  return dataService.query<UserRow>(sql);
}
