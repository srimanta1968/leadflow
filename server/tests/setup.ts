import { config } from '../src/config/env';
import { dataService } from '../src/services/DataService';
import { runMigrations } from '../src/db/migrationRunner';

/**
 * The jest suite runs with NO ProjexCloud gateway, deliberately.
 *
 * These are unit and integration tests of LeadFlow's OWN behaviour, and a large
 * part of that behaviour is what it does when the gateway is absent: SLA
 * verdicts fall back to the wall clock, routing falls back to rule-match then
 * round-robin, alerts are raised but stay pending. Those paths are asserted
 * throughout, so they have to be the paths that run.
 *
 * PINNED HERE rather than assumed from the environment. Until now the suite
 * simply inherited whatever `server/.env` held, so pointing a developer's .env
 * at a real gateway — which is exactly what you do to exercise the SDK paths —
 * silently flipped four tests from asserting the fallback to asserting against
 * a live upstream, and they failed for a reason that had nothing to do with the
 * code under test.
 *
 * A test that wants the configured behaviour sets it itself and restores it,
 * which also makes the dependency visible at the point it matters. The API
 * contract suite is where the real gateway gets exercised.
 */
config.projexCloud.gatewayUrl = '';
config.projexCloud.apiKey = '';

/**
 * Shared test lifecycle.
 *
 * Migrations run once before the suite so a fresh database self-provisions — the
 * same path production takes at boot, which means the suite also proves the
 * migration runner works rather than assuming it.
 *
 * The pool is closed afterwards so Jest exits cleanly instead of hanging on an
 * open handle.
 */
beforeAll(async (): Promise<void> => {
  try {
    await runMigrations();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Fail loudly and early: every test below asserts against real tables, so a
    // half-provisioned schema would produce a wall of confusing failures rather
    // than one clear cause.
    throw new Error(
      `Test database could not be provisioned. Is PostgreSQL reachable on the configured host? Cause: ${message}`
    );
  }
});

afterAll(async (): Promise<void> => {
  try {
    await dataService.close();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[tests] pool did not close cleanly:', message);
  }
});
