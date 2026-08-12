import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { dataService } from '../services/DataService';

/**
 * Locate the ordered `NNN_name.sql` migration files.
 *
 * Under ts-node the files sit beside this module in `src/db/migrations`. After
 * `tsc` they are copied into `dist/db/migrations` by the build script; the
 * source path is kept as a fallback so a `dist` build that skipped the copy
 * still boots rather than silently applying nothing.
 */
function resolveMigrationsDir(): string {
  const compiled = join(__dirname, 'migrations');
  if (existsSync(compiled)) {
    return compiled;
  }
  return join(__dirname, '..', '..', 'src', 'db', 'migrations');
}

const MIGRATIONS_DIR = resolveMigrationsDir();

/**
 * Applies pending schema migrations at server startup.
 *
 * Nobody creates tables by hand: a fresh environment self-provisions on first
 * boot, and an existing one applies only what it has not seen. Files are
 * applied in filename order, each inside its own transaction, and recorded in
 * `_leadflow_migrations` so a re-run is a no-op.
 *
 * Every migration is written to be idempotent and additive (CREATE ... IF NOT
 * EXISTS, ALTER TABLE ... ADD COLUMN IF NOT EXISTS) — an applied migration is
 * never edited, a correction ships as a new file.
 *
 * This is the ONLY place DDL runs. Service and data-access code must never
 * execute schema statements.
 */
export async function runMigrations(): Promise<void> {
  await dataService.query(
    `CREATE TABLE IF NOT EXISTS _leadflow_migrations (
       name       VARCHAR(255) PRIMARY KEY,
       applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`
  );

  const applied = await dataService.query<{ name: string }>(
    'SELECT name FROM _leadflow_migrations'
  );
  const alreadyApplied = new Set(applied.map((row) => row.name));

  let files: string[];
  try {
    files = readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith('.sql'))
      .sort();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[migrations] cannot read ${MIGRATIONS_DIR}: ${message}`);
    throw error;
  }

  /*
   * EVERY FILE IS APPLIED ON EVERY BOOT, not just the unrecorded ones.
   *
   * The ledger records what was RUN; it cannot know what the schema actually
   * CONTAINS, and those two drift apart in ordinary use — a database restored
   * from an older dump, a branch switched after some migrations were applied, a
   * transaction rolled back by an unrelated failure. When they drift, the old
   * behaviour skipped the file that would have repaired the schema and the
   * server died in a SEED instead, several steps later, with an error naming a
   * column rather than the migration that provides it. That is exactly the
   * failure this replaced: `startup failed: column "superseded_at" does not
   * exist`, thrown from seedVerticalProfile while 031_segments_and_kpi.sql sat
   * recorded-but-absent.
   *
   * This is only safe because every statement in every migration is idempotent
   * by construction — CREATE ... IF NOT EXISTS, ALTER TABLE ... ADD COLUMN IF
   * NOT EXISTS, with no exceptions across the whole directory. Re-applying is a
   * no-op against a correct schema and a repair against a drifted one, so the
   * database provisions AND heals itself with no manual step.
   *
   * THE RULE THIS DEPENDS ON: a migration is never edited once shipped, and a
   * correction ships as a new file. A non-idempotent statement added here would
   * now fail on the second boot rather than silently on the first, which is the
   * right direction for that mistake to fail in.
   */
  const unseen = files.filter((file) => !alreadyApplied.has(file));

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    await dataService.applyMigration(file, sql);
  }

  console.log(
    `[migrations] ${files.length} migration(s) applied`
    + (unseen.length > 0 ? `, ${unseen.length} new: ${unseen.join(', ')}` : ' (all previously recorded)'),
  );
}
