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
/**
 * Provision one privileged dev account at a given role.
 *
 * Extracted so stewardship can be seeded the same way as admin. It must be a
 * SEPARATE account rather than more grants on the admin one: users.role is a
 * single column, and config/policies.ts assigns the capture-resolution grants to
 * data_steward alone. Folding them into admin would recreate exactly the mistake
 * the LOCAL_ROLE_BRIDGE comment warns about — treating one SOP role as a local
 * superuser.
 */
async function seedDevUser(
  email: string,
  password: string,
  role: string,
  username: string,
  firstName: string,
  lastName: string,
  missingVarsMessage: string
): Promise<DevSeedResult> {
  if (config.nodeEnv === 'production') {
    return { attempted: false, created: false, skipped: 'NODE_ENV is production' };
  }

  if (!email || !password) {
    return { attempted: false, created: false, skipped: missingVarsMessage };
  }

  const existing = await dataService.queryOne<{ id: string; role: string }>(
    'SELECT id, role FROM users WHERE email = $1',
    [email]
  );

  if (existing) {
    if (existing.role !== role) {
      // The row is there but not privileged — most likely someone registered
      // through the normal flow with this address. Raise the role rather than
      // rewriting the account, so their password keeps working.
      await dataService.query(
        'UPDATE users SET role = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
        [existing.id, role]
      );
    }
    return { attempted: true, created: false };
  }

  const hash = await bcrypt.hash(password, config.bcryptRounds);
  await dataService.query(
    `INSERT INTO users (email, username, password_hash, first_name, last_name, role, email_verified)
     VALUES ($1, $2, $3, $4, $5, $6, TRUE)
     ON CONFLICT (email) DO NOTHING`,
    [email, username, hash, firstName, lastName, role]
  );

  return { attempted: true, created: true };
}

/**
 * Seed the QA steward. Mirrors seedDevAdmin; see seedDevUser for why the two
 * cannot be the same account.
 */
export async function seedDevSteward(): Promise<DevSeedResult> {
  return seedDevUser(
    config.devSeed.stewardEmail,
    config.devSeed.stewardPassword,
    'steward',
    'dev-steward',
    'Dev',
    'Steward',
    'DEV_STEWARD_EMAIL / DEV_STEWARD_PASSWORD are not set'
  );
}

/**
 * Seed the QA privacy officer. Mirrors seedDevSteward for the same reason: the
 * consent and data-rights grants sit with privacy_officer alone, so a caller
 * either holds them or does not - never by being an admin.
 */
export async function seedDevPrivacyOfficer(): Promise<DevSeedResult> {
  return seedDevUser(
    config.devSeed.privacyEmail,
    config.devSeed.privacyPassword,
    'privacy',
    'dev-privacy',
    'Dev',
    'Privacy',
    'DEV_PRIVACY_EMAIL / DEV_PRIVACY_PASSWORD are not set'
  );
}

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
