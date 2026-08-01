/**
 * Copies the .sql migration files into the compiled output.
 *
 * `tsc` emits only JavaScript, so without this step `dist/db/migrations` would
 * be empty and a production boot would report the schema as up to date while
 * having applied nothing.
 */
const { copyFileSync, existsSync, mkdirSync, readdirSync } = require('fs');
const { join } = require('path');

const source = join(__dirname, '..', 'src', 'db', 'migrations');
const target = join(__dirname, '..', 'dist', 'db', 'migrations');

if (!existsSync(source)) {
  console.error(`[copy-migrations] source directory missing: ${source}`);
  process.exit(1);
}

mkdirSync(target, { recursive: true });

const files = readdirSync(source).filter((file) => file.endsWith('.sql'));
for (const file of files) {
  copyFileSync(join(source, file), join(target, file));
}

console.log(`[copy-migrations] copied ${files.length} migration(s) to dist/db/migrations`);
