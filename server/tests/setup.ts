import { dataService } from '../src/services/DataService';
import { runMigrations } from '../src/db/migrationRunner';

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
