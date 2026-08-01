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

  const pending = files.filter((file) => !alreadyApplied.has(file));
  if (pending.length === 0) {
    console.log(`[migrations] schema up to date (${files.length} applied)`);
    return;
  }

  for (const file of pending) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    await dataService.applyMigration(file, sql);
    console.log(`[migrations] applied ${file}`);
  }

  console.log(`[migrations] ${pending.length} migration(s) applied`);
}
