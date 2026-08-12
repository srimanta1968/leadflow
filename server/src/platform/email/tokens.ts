import { createHash, randomBytes } from 'crypto';
import { dataService } from '../../services/DataService';

/**
 * Single-use, expiring tokens for verification and invitation.
 *
 * THE PLAINTEXT LEAVES THIS MODULE ONCE, in the return value of `issue()`, and
 * is never stored. What the table holds is a SHA-256 of it, so a database read
 * cannot be turned into a working link. The same reasoning as an API key: a
 * verification URL is a bearer credential for exactly one account, and a backup
 * or a support query must not hand somebody the ability to claim it.
 *
 * REDEMPTION IS ATOMIC. `consume()` marks the row in the same statement that
 * checks it is live, so two clicks on the same link — a mail client prefetching
 * it, a person double-clicking — cannot both succeed. Checking and then
 * updating would leave exactly that window open.
 */

export type TokenKind = 'verify' | 'invite';

/** Verification is short: the person is at their keyboard, having just signed up. */
const VERIFY_TTL_HOURS = 24;
/** An invitation waits for somebody to get to their inbox, and often their week. */
const INVITE_TTL_HOURS = 24 * 7;

const hash = (token: string): string => createHash('sha256').update(token).digest('hex');

export interface IssuedToken {
  /** The only copy. Goes into the email and is never persisted. */
  token: string;
  expiresAt: Date;
}

/**
 * Mint a token, superseding any live one of the same kind for that user.
 *
 * SUPERSEDING RATHER THAN ACCUMULATING: somebody who clicks "resend" three
 * times should end up with one working link, not three. The older rows are
 * consumed rather than deleted so the ledger still shows they were issued.
 */
export async function issue(
  userId: string,
  email: string,
  kind: TokenKind,
  createdBy?: string | null,
): Promise<IssuedToken> {
  await dataService.query(
    `UPDATE leadflow_email_token
        SET consumed_at = now()
      WHERE user_id = $1 AND kind = $2 AND consumed_at IS NULL`,
    [userId, kind],
  );

  // 32 bytes of CSPRNG, base64url so it survives a URL without escaping.
  const token = randomBytes(32).toString('base64url');
  const ttl = kind === 'invite' ? INVITE_TTL_HOURS : VERIFY_TTL_HOURS;
  const expiresAt = new Date(Date.now() + ttl * 3600_000);

  await dataService.query(
    `INSERT INTO leadflow_email_token (token_hash, user_id, kind, email, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [hash(token), userId, kind, email, expiresAt, createdBy ?? null],
  );

  return { token, expiresAt };
}

export interface ConsumedToken {
  userId: string;
  email: string;
  kind: TokenKind;
}

/**
 * Redeem a token, or explain why not.
 *
 * ONE STATEMENT. The WHERE clause carries every condition — right hash, not
 * already consumed, not expired — and the UPDATE only matches a row that
 * satisfies all of them, so the check and the claim cannot be separated by
 * another request.
 *
 * @returns The token's subject, or null when it is wrong, spent or expired.
 *          Deliberately ONE null for all three: telling an anonymous caller
 *          which of the three it was lets them probe for live tokens.
 */
export async function consume(token: string, kind: TokenKind): Promise<ConsumedToken | null> {
  const row = await dataService.queryOne<{ user_id: string; email: string }>(
    `UPDATE leadflow_email_token
        SET consumed_at = now()
      WHERE token_hash = $1
        AND kind = $2
        AND consumed_at IS NULL
        AND expires_at > now()
      RETURNING user_id, email`,
    [hash(token), kind],
  );
  return row ? { userId: row.user_id, email: row.email, kind } : null;
}
