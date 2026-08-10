import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The tenant-scope boundary: a ratchet, not a clean bill of health.
 *
 * LeadFlow is becoming a true multi-tenant application on ONE database, so
 * isolation is row-level: every query against a tenant-scoped table must filter
 * on the caller's tenant. A forgotten filter does not error - it returns MORE
 * rows, so the screen looks right, the tests pass, and the leak is invisible
 * until somebody sees another tenant's leads.
 *
 * WHAT THIS TEST IS. An audit on 2026-08-10 found 38 queries against `leads`
 * and ZERO filtering on tenant, against a table that has carried a `tenant_id`
 * column since migration 007. The debt is real and closing it is a migration,
 * not a patch. So this test pins the CURRENT count and fails when it GROWS:
 * existing debt is recorded, new debt is refused.
 *
 * WHAT THIS TEST IS NOT. It does not prove isolation. It cannot - a string
 * search cannot tell a correct filter from a wrong one, and passing it means
 * only "no worse than the day it was written". The real proof is a two-tenant
 * fixture asserting each sees only its own rows, and it belongs with the
 * Row-Level Security work rather than here. This exists so that work starts
 * from a known number instead of a guess, and so nothing widens the gap while
 * it is being done.
 *
 * WHY A RATCHET RATHER THAN A FAILING SPEC. A test asserting the end state
 * would be red from the moment it is written, and a suite that is red for a
 * known reason teaches everyone to ignore it - which is how the next REAL
 * failure gets missed.
 */

/** Tables that carry a tenant_id and must therefore be filtered on it. */
const TENANT_SCOPED = [
  'leads',
  'routing_rules',
  'intake_event',
  'lead_source_event',
  'call_recording',
  'call_artifact',
  'ai_proposal',
  'ai_agent_run',
  'ai_coach_call',
] as const;

/**
 * The debt as measured on 2026-08-10. Each number is the count of statements
 * touching that table WITHOUT mentioning tenant anywhere in the same statement.
 *
 * LOWERING A NUMBER HERE IS THE POINT. When the RLS work scopes a query, drop
 * the baseline to match - the test then locks the improvement in. RAISING one
 * is a decision that should be argued for in a review, not typed in to make a
 * build pass.
 */
const BASELINE: Record<string, number> = {
  leads: 38,
  routing_rules: 12,
  intake_event: 10,
  lead_source_event: 6,
  call_recording: 6,
  call_artifact: 5,
  ai_proposal: 8,
  ai_agent_run: 6,
  ai_coach_call: 6,
};

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'migrations' || entry.name === 'node_modules') continue;
      sourceFiles(full, acc);
    } else if (entry.name.endsWith('.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Statements touching `table` that never mention a tenant.
 *
 * Crude on purpose: it reads the 400 characters following the table reference,
 * which covers the WHERE clause of essentially every statement in this codebase
 * without needing a SQL parser. A parser would be more precise and would also
 * be a second implementation of SQL to maintain - and precision is not what
 * this test is for. It is counting, and a count only has to be consistent.
 */
function unscopedCount(files: string[], table: string): number {
  const touch = new RegExp(`(FROM|UPDATE|INTO|JOIN)\\s+${table}\\b`, 'gi');
  let count = 0;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    let match: RegExpExecArray | null;
    while ((match = touch.exec(text)) !== null) {
      const window = text.slice(match.index, match.index + 400);
      if (!/tenant/i.test(window)) count += 1;
    }
  }
  return count;
}

describe('tenant scope boundary', () => {
  const files = sourceFiles(join(__dirname, '..', '..', 'src'));

  it('does not add new unscoped queries against tenant-scoped tables', () => {
    const grown: string[] = [];
    for (const table of TENANT_SCOPED) {
      const now = unscopedCount(files, table);
      const was = BASELINE[table] ?? 0;
      if (now > was) {
        grown.push(
          `${table}: ${now} unscoped queries, baseline ${was}. ` +
            `A new query against a tenant-scoped table must filter on the caller's tenant - ` +
            `an unfiltered one returns EVERY tenant's rows and nothing will report it.`
        );
      }
    }
    expect(grown).toEqual([]);
  });

  it('records the debt honestly rather than claiming isolation', () => {
    // Guards the guard: if somebody empties BASELINE to make the first test
    // trivially pass, this fails. The debt is only closed by scoping queries and
    // LOWERING the numbers, never by deleting them.
    expect(Object.keys(BASELINE).length).toBeGreaterThan(0);
    expect(BASELINE.leads).toBeGreaterThan(0);
  });
});
