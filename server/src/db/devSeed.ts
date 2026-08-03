import bcrypt from 'bcryptjs';
import { config } from '../config/env';
import { dataService } from '../services/DataService';

export interface DevSeedResult {
  attempted: boolean;
  created: boolean;
  /** Why it did not run, when it did not. */
  skipped?: string;
}

/**
 * Ensure a privileged account exists in a non-production environment.
 *
 * WHY THIS IS NEEDED. Registration creates users at the `users.role` default,
 * `user`, which maps to a Sales Rep — a role that correctly holds none of
 * `routing.configure`, `lead.reassign` or `sla.configure`. The API contract
 * suite authenticates as ONE account and reuses that token everywhere, so
 * without elevation it can only ever test the refusal path of every governed
 * endpoint. That is a real gap in the suite, not a reason to weaken the policy:
 * the fix is to give QA a caller who legitimately holds the roles, not to grant
 * the roles to everybody.
 *
 * POINT THIS AT THE ACCOUNT THE RUNNER ACTUALLY USES — `testCredentials.default`
 * in `tests/config/test-config.json`. Seeding a SEPARATE admin achieves nothing,
 * because the runner never logs in as it: the primary request for every
 * definition is built from that one configured credential rather than from the
 * definition's own test cases, so an extra privileged account simply sits unused
 * while every governed endpoint keeps answering 403. The Dev MCP registers that
 * account itself if it is missing, which is why this ELEVATES an existing row
 * rather than assuming it can create one.
 *
 * NEVER IN PRODUCTION. An account with credentials drawn from a committed
 * config file is a back door wherever it exists, so this refuses to run when
 * NODE_ENV is `production` — checked here rather than left to whoever writes the
 * deployment, because the safe default has to be the one you get by doing
 * nothing.
 *
 * It is also inert unless both variables are set, so a developer who has not
 * opted in gets no surprise account.
 *
 * IDEMPOTENT. Runs on every boot and does nothing when the account is already
 * present and already privileged. The password is only ever written on
 * creation — a re-run does not reset a password someone has deliberately
 * changed.
 */
export async function seedDevAdmin(): Promise<DevSeedResult> {
  if (config.nodeEnv === 'production') {
    return { attempted: false, created: false, skipped: 'NODE_ENV is production' };
  }

  const email = config.devSeed.adminEmail;
  const password = config.devSeed.adminPassword;

  if (!email || !password) {
    return {
      attempted: false,
      created: false,
      skipped: 'DEV_ADMIN_EMAIL / DEV_ADMIN_PASSWORD are not set',
    };
  }

  const existing = await dataService.queryOne<{ id: string; role: string }>(
    'SELECT id, role FROM users WHERE email = $1',
    [email]
  );

  if (existing) {
    if (existing.role !== 'admin') {
      // The row is there but not privileged — most likely someone registered
      // through the normal flow with this address. Raise the role rather than
      // rewriting the account, so their password keeps working.
      await dataService.query(
        "UPDATE users SET role = 'admin', updated_at = CURRENT_TIMESTAMP WHERE id = $1",
        [existing.id]
      );
    }
    return { attempted: true, created: false };
  }

  const hash = await bcrypt.hash(password, config.bcryptRounds);
  await dataService.query(
    `INSERT INTO users (email, username, password_hash, first_name, last_name, role, email_verified)
     VALUES ($1, $2, $3, $4, $5, 'admin', TRUE)
     ON CONFLICT (email) DO NOTHING`,
    [email, 'dev-admin', hash, 'Dev', 'Admin']
  );

  return { attempted: true, created: true };
}
