import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config/env';
import { dataService } from './DataService';
import { AppError, ErrorCodes } from '../utils/errors';
import { AuthResult, LoginInput, PublicUser, RegisterInput, UserRow } from '../types';

/**
 * LeadFlow's authentication adapter.
 *
 * ProjexCloud is the identity authority for LeadFlow; the local `users` table
 * is a session-bound projection, not a source of truth. This service mints and
 * checks LeadFlow session tokens against that projection so the application and
 * its API contract tests have a working token producer. When the identity spine
 * lands, `register`/`login` delegate to ProjexCloud and keep writing the same
 * projection — callers and the token shape are unchanged.
 *
 * That handover is enforced, not merely intended: configuring an identity issuer
 * turns local password auth OFF (see `assertLocalCredentialsPermitted`), so the
 * two stores cannot both be answering at once. Reads of the projection —
 * `getById` — stay available either way, because a projection is exactly what it
 * is meant to be once the credentials are gone.
 */
export class AuthService {
  /**
   * Refuse to act as a credential store once ProjexCloud identity is live.
   *
   * ProjexCloud's rule (mcp-server/data/AGENTS.md): "Do NOT build your own
   * users/roles/sessions tables — a parallel table breaks tenant isolation and
   * the audit chain." LeadFlow has one, and it exists for a defensible reason:
   * something has to mint a token before the identity spine is reachable, and
   * every api_definition in the project chains from an auth producer.
   *
   * The danger is not the table existing — it is the table STAYING AUTHORITATIVE
   * after the real authority arrives. Two credential stores that both answer
   * "yes" is how a revoked user keeps working: revocation happens in ProjexCloud
   * and the local hash never hears about it. So the moment an issuer is
   * configured, local password auth stops, and this becomes a projection that is
   * only ever written from verified platform claims.
   *
   * The guard is the enforceable half of that migration. Dropping the table is
   * the last step and needs personas provisioned for every existing user; this
   * needs nothing, and it is what keeps the two stores from diverging in the
   * meantime.
   *
   * @throws AppError(501 NOT_IMPLEMENTED) when an identity issuer is configured.
   */
  private static assertLocalCredentialsPermitted(): void {
    if (!config.projexCloud.identity.issuerUrl) {
      return;
    }
    throw new AppError(
      501,
      ErrorCodes.NOT_IMPLEMENTED,
      'Local password authentication is disabled: ProjexCloud is the identity authority for this deployment'
    );
  }

  /** Strip the password hash and normalise timestamps for API responses. */
  private static toPublicUser(row: UserRow): PublicUser {
    return {
      id: row.id,
      email: row.email,
      username: row.username,
      first_name: row.first_name,
      last_name: row.last_name,
      phone: row.phone,
      role: row.role,
      is_active: row.is_active,
      email_verified: row.email_verified,
      last_login: row.last_login ? row.last_login.toISOString() : null,
      created_at: row.created_at.toISOString(),
    };
  }

  /**
   * Map a PostgreSQL unique-violation into the project's conflict codes.
   *
   * @param error The error thrown by the INSERT.
   * @returns The AppError to throw — the original error when it is not a
   *          unique violation, so unrelated failures are not mislabelled.
   */
  private static translateUniqueViolation(error: unknown): unknown {
    const code = (error as { code?: string } | null)?.code;
    if (code !== '23505') {
      return error;
    }
    const constraint = (error as { constraint?: string }).constraint ?? '';
    if (constraint.includes('username')) {
      return AppError.conflict(
        ErrorCodes.USERNAME_ALREADY_EXISTS,
        'That username is already taken'
      );
    }
    return AppError.conflict(
      ErrorCodes.EMAIL_ALREADY_EXISTS,
      'An account with that email already exists'
    );
  }

  /** Sign a session token carrying the claims every guard reads. */
  private static issueToken(row: UserRow): string {
    return jwt.sign(
      { userId: row.id, email: row.email, role: row.role },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn } as jwt.SignOptions
    );
  }

  /**
   * Create a user and return a session token for them.
   *
   * @param input Validated registration fields.
   * @returns The signed token and the public projection of the new user.
   * @throws AppError(409 EMAIL_ALREADY_EXISTS | USERNAME_ALREADY_EXISTS)
   */
  static async register(input: RegisterInput): Promise<AuthResult> {
    AuthService.assertLocalCredentialsPermitted();

    const existingEmail = await dataService.queryOne<UserRow>(
      'SELECT * FROM users WHERE email = $1',
      [input.email]
    );
    if (existingEmail) {
      throw AppError.conflict(
        ErrorCodes.EMAIL_ALREADY_EXISTS,
        'An account with that email already exists'
      );
    }

    if (input.username) {
      const existingUsername = await dataService.queryOne<UserRow>(
        'SELECT * FROM users WHERE username = $1',
        [input.username]
      );
      if (existingUsername) {
        throw AppError.conflict(
          ErrorCodes.USERNAME_ALREADY_EXISTS,
          'That username is already taken'
        );
      }
    }

    const passwordHash = await bcrypt.hash(input.password, config.bcryptRounds);

    let created: UserRow | null;
    try {
      created = await dataService.queryOne<UserRow>(
        `INSERT INTO users (email, username, password_hash, first_name, last_name, phone)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          input.email,
          input.username ?? null,
          passwordHash,
          input.first_name ?? null,
          input.last_name ?? null,
          input.phone ?? null,
        ]
      );
    } catch (error) {
      // The checks above race: two concurrent registrations for the same email
      // can both see no existing row and both reach this INSERT. The unique
      // index is what actually decides, so translate its violation into the
      // documented conflict code rather than letting it surface as a 500.
      throw AuthService.translateUniqueViolation(error);
    }

    if (!created) {
      throw new AppError(500, ErrorCodes.INTERNAL_ERROR, 'User could not be created');
    }

    return {
      token: AuthService.issueToken(created),
      expires_in: config.jwt.expiresIn,
      user: AuthService.toPublicUser(created),
    };
  }

  /**
   * Exchange credentials for a session token and stamp `last_login`.
   *
   * @param input Validated login fields.
   * @returns The signed token and the public projection of the user.
   * @throws AppError(401 INVALID_CREDENTIALS) for unknown email or bad password.
   * @throws AppError(403 ACCOUNT_INACTIVE) when the account is disabled.
   */
  static async login(input: LoginInput): Promise<AuthResult> {
    AuthService.assertLocalCredentialsPermitted();

    const user = await dataService.queryOne<UserRow>('SELECT * FROM users WHERE email = $1', [
      input.email,
    ]);

    // Compare unconditionally so a missing account and a wrong password take
    // the same time — otherwise response timing enumerates registered emails.
    const hash = user ? user.password_hash : '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin';
    const passwordMatches = await bcrypt.compare(input.password, hash);

    if (!user || !passwordMatches) {
      throw AppError.invalidCredentials();
    }

    if (!user.is_active) {
      throw new AppError(
        403,
        ErrorCodes.ACCOUNT_INACTIVE,
        'This account has been deactivated'
      );
    }

    const updated = await dataService.queryOne<UserRow>(
      'UPDATE users SET last_login = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *',
      [user.id]
    );
    const current = updated ?? user;

    return {
      token: AuthService.issueToken(current),
      expires_in: config.jwt.expiresIn,
      user: AuthService.toPublicUser(current),
    };
  }

  /**
   * Load the public projection of a user by id.
   *
   * @param userId The user's UUID, normally taken from verified session claims.
   * @throws AppError(404 NOT_FOUND) when no such user exists.
   */
  static async getById(userId: string): Promise<PublicUser> {
    const user = await dataService.queryOne<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
    if (!user) {
      throw AppError.notFound('User not found');
    }
    return AuthService.toPublicUser(user);
  }
}
