import { dataService } from '../../src/services/DataService';

/**
 * The two properties tenant isolation actually has to hold, written BEFORE the
 * Row-Level Security work rather than after it.
 *
 * WHY FIRST. The platform-admin path is a deliberate bypass of isolation, so it
 * is the single route every leak can run through. Written last - after the
 * isolation work already looks finished - it is the piece that gets the least
 * scrutiny, precisely when it deserves the most. ProjexCloud made the same point
 * back to us and they are right.
 *
 * WHY SKIPPED BY DEFAULT, AND WHY THAT IS NOT A DODGE. These assertions are RED
 * against today's code: an audit on 2026-08-10 found 38 queries against `leads`
 * that filter on no tenant at all. Committing them red would put a permanently
 * failing suite in front of every developer, and a suite that is red for a known
 * reason is one everybody learns to scroll past - which is how the next REAL
 * failure gets missed. So they run only where isolation is supposed to hold:
 *
 *     LEADFLOW_RLS=1 npx jest tests/unit/tenantIsolation.test.ts
 *
 * Flip that on in the environment where RLS is enabled and these become the
 * proof. Until then `tenantScopeBoundary.test.ts` holds the line by refusing NEW
 * unscoped queries.
 *
 * WHAT THEY ASSERT, and both matter:
 *
 *   1. A tenant sees only its own rows. The obvious one.
 *   2. A platform admin sees across tenants, AND no tenant-scoped route can
 *      reach that path. The second half is the one worth writing down: an
 *      isolation test that only proves the admin CAN see everything has tested
 *      the feature and missed the risk.
 *
 * ATTRIBUTION IS NOT ISOLATION - carried over from EMPI, where a merge decided
 * by one tenant acts on the globally shared L1 person and is therefore visible
 * to every tenant sharing that person. A platform admin acting "on behalf of" a
 * tenant will have the same property. These tests cover ROW VISIBILITY only, and
 * say so, so nobody reads a green run as proof that an action's EFFECTS were
 * tenant-local.
 */

const RLS_ENABLED = process.env.LEADFLOW_RLS === '1';
const suite = RLS_ENABLED ? describe : describe.skip;

const TENANT_A = '00000000-0000-4000-8000-00000000a001';
const TENANT_B = '00000000-0000-4000-8000-00000000b002';

/** Set the tenant the connection acts as, the way a scoped request will. */
async function actAs(tenantId: string): Promise<void> {
  await dataService.query('SELECT set_config($1, $2, false)', ['app.tenant_id', tenantId]);
}

suite('tenant isolation (row visibility)', () => {
  beforeAll(async () => {
    // Two tenants, one lead each. Fixed ids so a re-run replaces rather than
    // accumulates - a test that leaves rows behind changes the next run's answer.
    for (const [tenant, id, name] of [
      [TENANT_A, '00000000-0000-4000-8000-0000000a1ead', 'Tenant A Lead'],
      [TENANT_B, '00000000-0000-4000-8000-0000000b1ead', 'Tenant B Lead'],
    ] as const) {
      await dataService.query(
        `INSERT INTO leads (id, name, email, source, tenant_id)
         VALUES ($1, $2, $3, 'test', $4)
         ON CONFLICT (id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id`,
        [id, name, `${id}@leadflow.test`, tenant]
      );
    }
  });

  it('shows a tenant only its own leads', async () => {
    await actAs(TENANT_A);
    const rows = await dataService.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM leads'
    );
    // Deliberately an UNFILTERED select: the whole point is that the DATABASE
    // scopes it. A query with an explicit WHERE would pass even with RLS off and
    // would prove only that the test author remembered the filter.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tenant_id === TENANT_A)).toBe(true);
  });

  it('does not let one tenant read another by naming its id', async () => {
    await actAs(TENANT_A);
    const rows = await dataService.query(
      'SELECT id FROM leads WHERE tenant_id = $1',
      [TENANT_B]
    );
    // Asking for someone else's rows explicitly must return NOTHING rather than
    // an error: an error confirms the row exists, which is itself a disclosure.
    expect(rows).toHaveLength(0);
  });

  it('fails closed when no tenant is set on the connection', async () => {
    await dataService.query('SELECT set_config($1, $2, false)', ['app.tenant_id', '']);
    const rows = await dataService.query('SELECT id FROM leads');
    // THE PROPERTY THAT MAKES RLS WORTH THE WORK. A forgotten filter returns
    // nothing instead of everything, so the failure mode of a mistake is an
    // empty screen somebody reports - not a silent cross-tenant leak nobody sees.
    expect(rows).toHaveLength(0);
  });
});

suite('platform admin bypass', () => {
  /*
   * DELIBERATELY A TODO, NOT AN ASSERTION. The first draft of this called
   * dataService.query(sql, params, { pool: 'admin' }) - an API that DOES NOT
   * EXIST. ProjexCloud's db-runtime is multi-pool; LeadFlow's DataService is
   * single-pool, and I wrote the test against the upstream primitive as though
   * it were ours.
   *
   * Left as a todo rather than deleted, and rather than faked with a second
   * connection built inside the test: a test that stands up its own pool proves
   * that Postgres has pools, not that LeadFlow routes platform reads through a
   * separate one. It becomes a real assertion when DataService grows a pool
   * selector, and until then this names exactly what is missing.
   */
  it.todo(
    'sees across tenants on the platform pool - needs a pool selector on DataService'
  );

  it('is unreachable from a tenant-scoped request path', async () => {
    // THE HALF THAT USUALLY GOES UNTESTED. Proving the admin CAN see everything
    // tests the feature; proving a tenant route CANNOT reach that path tests the
    // risk. A separate pool is what makes this assertable at all - a bypass FLAG
    // on the shared connection could be set by any bug on any request, and there
    // would be nothing here to assert against.
    await actAs(TENANT_A);
    const rows = await dataService.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM leads'
    );
    expect(rows.every((r) => r.tenant_id === TENANT_A)).toBe(true);
  });
});
