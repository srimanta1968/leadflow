import { randomUUID } from 'crypto';
import { SyncBatchService } from '../../src/features/capture/syncBatchService';
import { dataService } from '../../src/services/DataService';
import { config } from '../../src/config/env';
import { SdkGatewayClient } from '../../src/services/projexcloud/SdkGatewayClient';

/**
 * Draining an offline capture queue.
 *
 * Integration rather than unit, and deliberately: idempotency here is enforced
 * by a UNIQUE INDEX, and a mocked data layer would assert that the mock behaves
 * as written rather than that the constraint holds. The whole feature is "a
 * retry must not duplicate", so the constraint IS the feature.
 */

/** One well-formed queued capture. */
function queued(overrides: Record<string, unknown> = {}) {
  return {
    clientCaptureId: `test-${randomUUID()}`,
    captureKind: 'contact' as const,
    rawInput: 'Priya Raman, priya@example.test',
    originClass: 'USER_PROVIDED' as const,
    capturedAt: new Date().toISOString(),
    propertyReference: null,
    ...overrides,
  };
}

const created: string[] = [];

/**
 * Clear this suite's rows at the START, not the end.
 *
 * The global afterAll in tests/setup.ts closes the connection pool, and it is
 * registered before any hook in this file — so an afterAll here runs after the
 * pool is gone and dies with "Cannot use a pool after calling end on the pool".
 * The suite passed every assertion and still reported as failed.
 *
 * Cleaning up-front avoids the ordering question entirely and is idempotent:
 * each run removes the previous run's rows, and the ids are prefixed so nothing
 * else is touched.
 */
beforeAll(async () => {
  await dataService.query("DELETE FROM offline_capture_sync WHERE client_capture_id LIKE 'test-%'", []);
});

describe('the acceptance case: five offline, force-quit, re-sync', () => {
  it('produces exactly five records across two syncs, not seven', async () => {
    const batch = [queued(), queued(), queued(), queued(), queued()];
    batch.forEach((item) => created.push(item.clientCaptureId));

    const first = await SyncBatchService.sync(batch);
    expect(first.accepted).toBe(5);
    expect(first.duplicates).toBe(0);

    // The force-quit: the device does not know which of its five landed, so it
    // re-sends all of them. This is the whole reason the client mints the id.
    const second = await SyncBatchService.sync(batch);

    expect(second.accepted).toBe(0);
    expect(second.duplicates).toBe(5);

    const distinct = new Set(
      [...first.items, ...second.items].map((item) => item.sourceRecordId)
    );
    // FIVE, not ten. The replay returned the SAME record ids.
    expect(distinct.size).toBe(5);
  });

  it('returns the ORIGINAL record id on a replay, not just a flag', async () => {
    const item = queued();
    created.push(item.clientCaptureId);

    const first = await SyncBatchService.sync([item]);
    const second = await SyncBatchService.sync([item]);

    // A client reconciling its queue needs something real to point at, not
    // merely to be told "duplicate".
    expect(second.items[0].sourceRecordId).toBe(first.items[0].sourceRecordId);
    expect(second.items[0].status).toBe('duplicate');
  });

  it('survives a PARTIAL sync — only the unsent items are created', async () => {
    const a = queued();
    const b = queued();
    const c = queued();
    [a, b, c].forEach((item) => created.push(item.clientCaptureId));

    // The app died after two of three landed.
    await SyncBatchService.sync([a, b]);
    // On reconnect the device re-sends everything it has not marked durable —
    // which, because it died mid-sync, is all three.
    const resumed = await SyncBatchService.sync([a, b, c]);

    expect(resumed.duplicates).toBe(2);
    expect(resumed.accepted).toBe(1);
  });

  it('deduplicates WITHIN one batch, for a client whose own dedupe is broken', async () => {
    const item = queued();
    created.push(item.clientCaptureId);

    const result = await SyncBatchService.sync([item, item]);

    expect(result.accepted).toBe(1);
    expect(result.duplicates).toBe(1);
  });
});

describe('a bad item never blocks the batch', () => {
  it('fails one item and still lands the rest', async () => {
    const good = queued();
    created.push(good.clientCaptureId);

    const result = await SyncBatchService.sync([
      good,
      // No client id — cannot be made idempotent, so it cannot be accepted.
      queued({ clientCaptureId: '' }),
    ]);

    // Rejecting the whole batch would let one malformed capture block every
    // other capture on that device indefinitely, with no way to find it.
    expect(result.accepted).toBe(1);
    expect(result.failed).toBe(1);
  });

  it('names WHY an item failed, so the client can act', async () => {
    const result = await SyncBatchService.sync([queued({ clientCaptureId: '' })]);

    expect(result.items[0].error).toContain('clientCaptureId');
  });

  it('refuses an item with no origin class, even offline', async () => {
    const result = await SyncBatchService.sync([queued({ originClass: undefined })]);

    // Provenance is never guessed — not on the server, and not because the
    // capture happened on a device with no signal.
    expect(result.failed).toBe(1);
    expect(result.items[0].error).toContain('originClass');
  });

  it('refuses an item with no raw input', async () => {
    const result = await SyncBatchService.sync([queued({ rawInput: '   ' })]);

    expect(result.failed).toBe(1);
  });

  it('refuses an unknown capture kind rather than guessing', async () => {
    const result = await SyncBatchService.sync([queued({ captureKind: 'telepathy' })]);

    expect(result.failed).toBe(1);
    expect(result.items[0].error).toContain('captureKind');
  });
});

describe('a voice note with no name', () => {
  it('is a VALID capture carrying the property reference', async () => {
    const note = queued({
      captureKind: 'voice_note',
      rawInput: 'Leak above the kitchen, wants a quote',
      propertyReference: '42 Bridge Road',
    });
    created.push(note.clientCaptureId);

    const result = await SyncBatchService.sync([note]);

    // A field rep outside a property has no person yet. Requiring a name would
    // either lose the capture or invite a fabricated one.
    expect(result.accepted).toBe(1);
    expect(result.items[0].sourceRecordId).toBeTruthy();
  });

  it('persists the capture kind so the record is recognisable later', async () => {
    const note = queued({ captureKind: 'voice_note', propertyReference: '17 Mill Lane' });
    created.push(note.clientCaptureId);

    await SyncBatchService.sync([note]);

    const rows = await dataService.query<{ capture_kind: string }>(
      'SELECT capture_kind FROM offline_capture_sync WHERE client_capture_id = $1',
      [note.clientCaptureId]
    );
    expect(rows[0].capture_kind).toBe('voice_note');
  });

  it('records when the DEVICE took it, not when it arrived', async () => {
    const takenAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const note = queued({ capturedAt: takenAt.toISOString() });
    created.push(note.clientCaptureId);

    await SyncBatchService.sync([note]);

    const rows = await dataService.query<{ captured_at: Date; synced_at: Date }>(
      'SELECT captured_at, synced_at FROM offline_capture_sync WHERE client_capture_id = $1',
      [note.clientCaptureId]
    );

    // A capture taken Friday and synced Monday is FRIDAY's evidence, and the
    // difference is what an SLA or a consent window is measured against.
    expect(rows[0].captured_at.getTime()).toBeCloseTo(takenAt.getTime(), -3);
    expect(rows[0].synced_at.getTime()).toBeGreaterThan(rows[0].captured_at.getTime());
  });
});

describe('an upstream failure must not mark a capture synced', () => {
  afterEach(() => {
    config.projexCloud.gatewayUrl = '';
    config.projexCloud.apiKey = '';
    jest.restoreAllMocks();
  });

  it('writes NO ledger row when the upstream create fails', async () => {
    // THE BUG THIS GUARDS. The ledger row was originally written BEFORE the
    // upstream call, so a failure left the id recorded as synced while nothing
    // existed upstream: the item came back `failed`, the device retried, the
    // server answered `duplicate`, the client marked it done — and the capture
    // was gone with every layer reporting success.
    //
    // Found by running against a gateway that happened to be restarting. No
    // mocked test would have shown it, because tests/setup.ts pins the gateway
    // unconfigured and the upstream branch never ran.
    config.projexCloud.gatewayUrl = 'https://gateway.test';
    config.projexCloud.apiKey = 'token';
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(SdkGatewayClient, 'call').mockRejectedValue(new Error('gateway down'));

    const item = queued();
    const result = await SyncBatchService.sync([item]);

    expect(result.failed).toBe(1);

    const rows = await dataService.query(
      'SELECT 1 FROM offline_capture_sync WHERE client_capture_id = $1',
      [item.clientCaptureId]
    );
    // Nothing recorded, so the retry genuinely re-creates it.
    expect(rows).toHaveLength(0);
  });

  it('a retry after an upstream failure still creates the record', async () => {
    config.projexCloud.gatewayUrl = 'https://gateway.test';
    config.projexCloud.apiKey = 'token';
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const call = jest.spyOn(SdkGatewayClient, 'call').mockRejectedValueOnce(new Error('down'));

    const item = queued();
    created.push(item.clientCaptureId);

    const first = await SyncBatchService.sync([item]);
    expect(first.failed).toBe(1);

    // Gateway recovers. The device retries the item it never saw confirmed.
    call.mockResolvedValue({ delivered: true, status: 201, data: null } as never);
    const second = await SyncBatchService.sync([item]);

    // ACCEPTED, not duplicate. This is the difference between a recoverable
    // outage and silent data loss.
    expect(second.accepted).toBe(1);
    expect(second.duplicates).toBe(0);
  });
});
