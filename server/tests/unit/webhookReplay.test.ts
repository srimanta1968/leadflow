import fs from 'fs';
import path from 'path';

/**
 * Acceptance criterion 4: "a replayed inbound webhook produces exactly one
 * downstream write, proven by test."
 *
 * The guarantee has two halves and they fail differently, so both are proved:
 *
 *   1. The DATABASE refuses the second archive row. That is a unique index, and
 *      no amount of application code can substitute for it — two deliveries
 *      landing on two workers at the same instant are separated by the index or
 *      not at all.
 *   2. The SERVICE branches on that refusal and returns before doing any
 *      downstream work. An index that dedupes the archive while the code carries
 *      on and calls the gateway anyway would still create the duplicate lead.
 *
 * The service half is driven through a fake `dataService` that MODELS the index
 * rather than running Postgres, and that limitation is stated rather than hidden:
 * what it proves is the branch, not the SQL. The SQL is proved by the first half,
 * which reads the migration and the query text directly. Between them there is no
 * gap where a replay gets through.
 */

/* ------------------------------------------------- half one: the constraint */

describe('the database refuses a replayed event', () => {
  const migration = fs.readFileSync(
    path.resolve(__dirname, '../../src/db/migrations/009_intake_events.sql'),
    'utf8',
  );
  const service = fs.readFileSync(
    path.resolve(__dirname, '../../src/features/intake/intakeService.ts'),
    'utf8',
  );

  it('has a UNIQUE index over the replay key', () => {
    expect(migration).toMatch(/CREATE UNIQUE INDEX[\s\S]*?ON intake_event/i);
    // All three parts, or the key does not identify a delivery.
    const index = /CREATE UNIQUE INDEX[\s\S]*?\);/i.exec(migration)![0];
    expect(index).toContain('platform');
    expect(index).toContain('source_event_id');
    // COALESCE, not a bare column: while tenancy is staged, NULL tenant rows
    // must share ONE bucket. Distinct NULLs would defeat the constraint exactly
    // when it matters, because NULL != NULL in a unique index.
    expect(index).toContain('COALESCE(tenant_id');
  });

  it('inserts with ON CONFLICT DO NOTHING and branches on what came back', () => {
    // RETURNING is what turns the conflict into a signal. Without it the insert
    // succeeds silently on a replay and the code cannot tell the difference.
    expect(service).toMatch(/INSERT INTO intake_event[\s\S]*?ON CONFLICT DO NOTHING[\s\S]*?RETURNING/i);
    expect(service).toContain('return rows.length > 0;');
  });

  it('archives BEFORE judging, so a refused signal still leaves a trace', () => {
    // "The webhook never arrived" and "it arrived and we discarded it" are
    // different incidents and must not look alike from the outside.
    const acceptBody = service.slice(service.indexOf('static async accept('));
    expect(acceptBody.indexOf('await archive(')).toBeLessThan(acceptBody.indexOf('if (invalid) {'));
  });
});

/* ---------------------------------------------------- half two: the branch */

/**
 * A fake table that enforces the same unique key the migration declares.
 *
 * Modelled, not executed — see the file docblock. It answers only the two shapes
 * `intakeService` actually issues.
 */
class FakeIntakeTable {
  readonly rows: { key: string; outcome: string; leadId: string | null }[] = [];
  readonly inserts: string[] = [];

  private static key(platform: string, sourceEventId: string, tenantId: string | null): string {
    return `${tenantId ?? '00000000-0000-0000-0000-000000000000'}|${platform}|${sourceEventId}`;
  }

  query(sql: string, params: unknown[] = []): unknown[] {
    if (/INSERT INTO intake_event/i.test(sql)) {
      const key = FakeIntakeTable.key(
        String(params[0]),
        String(params[1]),
        params[2] === null || params[2] === undefined ? null : String(params[2]),
      );
      this.inserts.push(key);
      if (this.rows.some((r) => r.key === key)) return [];   // ON CONFLICT DO NOTHING
      this.rows.push({ key, outcome: String(params[5]), leadId: null });
      return [{ platform: params[0] }];                       // RETURNING
    }

    if (/SELECT outcome, lead_id/i.test(sql)) {
      const key = FakeIntakeTable.key(
        String(params[0]),
        String(params[1]),
        params[2] === null || params[2] === undefined ? null : String(params[2]),
      );
      const found = this.rows.find((r) => r.key === key);
      return found ? [{ outcome: found.outcome, lead_id: found.leadId }] : [];
    }

    if (/UPDATE intake_event SET lead_id/i.test(sql)) {
      const row = this.rows.find((r) => r.key.endsWith(`|${params[1]}|${params[2]}`));
      if (row) {
        row.leadId = String(params[0]);
        row.outcome = 'accepted';
      }
      return [];
    }

    // Everything else the downstream write path issues — a lead insert, an
    // attribution update. Counted by the spy below rather than modelled.
    return [{ id: 'lead-generated' }];
  }
}

const table = new FakeIntakeTable();
const downstreamWrites: string[] = [];

/** Every write the downstream path can make, counted in one place. */
function countIfWrite(sql: string): void {
  if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql) && !/intake_event/i.test(sql)) {
    downstreamWrites.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
  }
}

jest.mock('../../src/services/DataService', () => ({
  dataService: {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      countIfWrite(sql);
      return table.query(sql, params);
    }),
    queryOne: jest.fn(async (sql: string, params: unknown[] = []) => {
      countIfWrite(sql);
      return (table.query(sql, params)[0] as unknown) ?? null;
    }),
    transaction: jest.fn(async (work: (c: unknown) => Promise<unknown>) =>
      work({ query: async (sql: string, params: unknown[] = []) => {
        countIfWrite(sql);
        return { rows: table.query(sql, params) };
      } })),
  },
}));

jest.mock('../../src/platform/sdkGateway', () => ({
  SdkGatewayClient: {
    isConfigured: () => true,
    call: jest.fn(async (options: { sdk: string; method: string; path: string }) => {
      if (options.method !== 'GET') downstreamWrites.push(`${options.sdk}${options.path}`);
      return { delivered: true, status: 200, data: { id: 'sr-1' } };
    }),
  },
}));

jest.mock('../../src/platform/tenancy/tenantHierarchy', () => ({
  currentTenantContext: () => null,
  tenantIdFor: () => null,
}));

// Imported AFTER the mocks, which is what makes them take effect.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { IntakeService } = require('../../src/features/intake/intakeService');

describe('a replayed webhook does no downstream work the second time', () => {
  beforeEach(() => {
    downstreamWrites.length = 0;
  });

  it('writes exactly once across five identical deliveries', async () => {
    const delivery = {
      platform: 'web_form',
      sourceEventId: 'evt_replay_1',
      signalKind: 'lead',
      identifiable: true,
      rawPayload: { email: 'dana@example.com', name: 'Dana Okafor' },
    };

    const first = await IntakeService.accept({ ...delivery });
    const writesAfterFirst = downstreamWrites.length;
    // NOT VACUOUS. If the first delivery wrote nothing, "the replays wrote no
    // more than the first" is trivially true and this test proves nothing at
    // all — the exact green-gate-guarding-nothing shape the rest of this suite
    // exists to catch.
    expect(writesAfterFirst).toBeGreaterThan(0);

    // Providers retry on any hiccup. Five is not a contrived number — it is a
    // normal afternoon for a webhook whose 200 got lost on the way back.
    const replays = [];
    for (let i = 0; i < 4; i += 1) {
      replays.push(await IntakeService.accept({ ...delivery }));
    }

    expect(first.replay).toBe(false);
    for (const r of replays) {
      expect(r.replay).toBe(true);
      // The sender gets a CONSISTENT answer, not a different one each time.
      expect(r.archived).toBe(true);
      expect(r.leadId).toBe(first.leadId);
    }

    // THE CRITERION. Not "fewer writes" — exactly the count the first delivery
    // made, and nothing after it.
    expect(downstreamWrites.length).toBe(writesAfterFirst);
    // Five attempted archives, one row.
    expect(table.inserts.filter((k) => k.endsWith('|evt_replay_1')).length).toBe(5);
    expect(table.rows.filter((r) => r.key.endsWith('|evt_replay_1')).length).toBe(1);
  });

  it('treats a DIFFERENT event id as a different event', () => {
    // Guards against the opposite bug — a dedupe so eager it swallows real
    // traffic, which is far harder to notice than a duplicate.
    const before = table.rows.length;
    return IntakeService.accept({
      platform: 'web_form',
      sourceEventId: 'evt_replay_2',
      signalKind: 'lead',
      identifiable: true,
      rawPayload: { email: 'sam@example.com' },
    }).then((result: { replay: boolean }) => {
      expect(result.replay).toBe(false);
      expect(table.rows.length).toBe(before + 1);
    });
  });
});
