import { randomUUID } from 'crypto';
import { dataService } from '../../services/DataService';
import { currentTenantContext, tenantIdFor } from '../../platform/tenancy/tenantHierarchy';
import { SdkGatewayClient } from '../../services/projexcloud/SdkGatewayClient';
import { ORIGIN_CLASSES, OriginClass } from './inboxQuery';

/** How a queued capture was taken on the device. */
export type CaptureKind = 'contact' | 'business_card' | 'voice_note';

export const CAPTURE_KINDS: CaptureKind[] = ['contact', 'business_card', 'voice_note'];

/**
 * Most items one sync may carry.
 *
 * A device offline for a week can genuinely accumulate a lot, so the cap is
 * generous — but unbounded would let one request hold a connection open long
 * enough to look like an outage. The client pages the rest; that is why the
 * response is per-item.
 */
export const MAX_BATCH_ITEMS = 200;

export interface QueuedCapture {
  clientCaptureId: string;
  captureKind: CaptureKind;
  rawInput: string;
  originClass: OriginClass;
  /** When the DEVICE took it. Not when it arrived. */
  capturedAt: string | null;
  /** For a voice note taken at a property with no person named. */
  propertyReference: string | null;
}

export interface SyncItemOutcome {
  clientCaptureId: string;
  status: 'accepted' | 'duplicate' | 'failed';
  sourceRecordId: string | null;
  /** Present only on 'failed', and specific enough for the client to act. */
  error: string | null;
}

export interface SyncBatchResult {
  accepted: number;
  duplicates: number;
  failed: number;
  items: SyncItemOutcome[];
}

/**
 * Validate ONE queued item.
 *
 * Returns a reason rather than throwing, because a bad item must not fail the
 * batch. A single malformed capture — a voice note whose reference never parsed
 * — would otherwise block every other capture on that device indefinitely, and
 * the operator has no way to find it or take it out of the queue.
 */
function reasonInvalid(item: Partial<QueuedCapture>): string | null {
  if (typeof item.clientCaptureId !== 'string' || item.clientCaptureId.trim().length === 0) {
    return 'clientCaptureId is required — it is the idempotency key and must be minted on the device';
  }
  if (typeof item.rawInput !== 'string' || item.rawInput.trim().length === 0) {
    return 'rawInput is required — there is no evidence to store without it';
  }
  if (!item.captureKind || !CAPTURE_KINDS.includes(item.captureKind)) {
    return `captureKind must be one of: ${CAPTURE_KINDS.join(', ')}`;
  }
  if (!item.originClass || !ORIGIN_CLASSES.includes(item.originClass)) {
    // Recorded on the device at capture time, so a missing one is a defect in
    // this queued item rather than in the sync — and provenance is still never
    // guessed, offline or not.
    return 'originClass is required and must be one of the declared origin classes';
  }
  // NO NAME REQUIREMENT, deliberately. A field rep outside a property records
  // "leak above the kitchen, 42 Bridge Road" and there is no person yet.
  // Requiring a name would either lose the capture or invite a fabricated one.
  return null;
}

/** Which of these client ids this tenant has already synced. */
async function alreadySynced(
  clientIds: string[],
  tenantId: string | null
): Promise<Map<string, string>> {
  if (clientIds.length === 0) {
    return new Map();
  }

  const rows = await dataService.query<{ client_capture_id: string; source_record_id: string }>(
    `SELECT client_capture_id, source_record_id
       FROM offline_capture_sync
      WHERE client_capture_id = ANY($1::text[])
        AND COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)
          = COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`,
    [clientIds, tenantId]
  );

  return new Map(rows.map((row) => [row.client_capture_id, row.source_record_id]));
}

export class SyncBatchService {
  /**
   * Drain one batch from a device's offline queue.
   *
   * IDEMPOTENT ON THE CLIENT ID. A replayed item returns the source record it
   * produced the first time and creates nothing. That is what makes the
   * acceptance case hold: five captures, a force-quit mid-sync, a reconnect and
   * a second sync gives five records rather than seven — the retrying device
   * cannot know which of its items landed, so the server has to be the one that
   * knows.
   *
   * The INSERT carries ON CONFLICT DO NOTHING as well as the pre-read. The read
   * catches the ordinary replay; the constraint catches two syncs racing from
   * the same device, where both reads complete before either write. Without it
   * the window between them is exactly wide enough to duplicate under the
   * flaky connectivity this feature is for.
   */
  static async sync(items: Partial<QueuedCapture>[]): Promise<SyncBatchResult> {
    const tenantId = tenantIdFor(currentTenantContext(), 'lead') || null;

    const validIds = items
      .map((item) => item.clientCaptureId)
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
    const seen = await alreadySynced(validIds, tenantId);

    const outcomes: SyncItemOutcome[] = [];

    for (const item of items) {
      const invalid = reasonInvalid(item);
      if (invalid) {
        outcomes.push({
          clientCaptureId: typeof item.clientCaptureId === 'string' ? item.clientCaptureId : '',
          status: 'failed',
          sourceRecordId: null,
          error: invalid,
        });
        continue;
      }

      const queued = item as QueuedCapture;

      const existing = seen.get(queued.clientCaptureId);
      if (existing) {
        outcomes.push({
          clientCaptureId: queued.clientCaptureId,
          status: 'duplicate',
          // The ORIGINAL record id, so the client can reconcile its queue
          // against something real rather than just being told "duplicate".
          sourceRecordId: existing,
          error: null,
        });
        continue;
      }

      try {
        const sourceRecordId = await SyncBatchService.storeOne(queued, tenantId);
        outcomes.push({
          clientCaptureId: queued.clientCaptureId,
          status: 'accepted',
          sourceRecordId,
          error: null,
        });
        // Guards the rest of THIS batch against a device that queued the same
        // id twice — which a client with a buggy dedupe will do.
        seen.set(queued.clientCaptureId, sourceRecordId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[syncBatch] ${queued.clientCaptureId} failed:`, message);
        outcomes.push({
          clientCaptureId: queued.clientCaptureId,
          status: 'failed',
          sourceRecordId: null,
          // The client retries only what failed, so it needs to know which.
          error: 'This capture could not be stored. It stays queued and will be retried.',
        });
      }
    }

    return {
      accepted: outcomes.filter((o) => o.status === 'accepted').length,
      duplicates: outcomes.filter((o) => o.status === 'duplicate').length,
      failed: outcomes.filter((o) => o.status === 'failed').length,
      items: outcomes,
    };
  }

  /**
   * Record one capture, then remember its client id.
   *
   * ORDER IS LOAD-BEARING, and getting it wrong is silent data loss. The
   * ledger row is written LAST, only once the record actually exists upstream.
   *
   * The other way round — ledger first — was the original shape and it is
   * quietly catastrophic: an upstream failure leaves the id recorded as synced
   * while nothing was created. The item comes back `failed`, the device retries
   * it, the server now says `duplicate`, and the client marks it done. The
   * capture is gone, and every layer reports success. It was found by running
   * the real thing against a gateway that happened to be restarting, which no
   * mocked test would have shown.
   *
   * The reverse window is safe: a crash between the upstream create and the
   * ledger write means the retry re-sends, and the upstream call carries the
   * device's own id as its idempotency key — so it lands once there too and the
   * ledger simply catches up.
   */
  private static async storeOne(item: QueuedCapture, tenantId: string | null): Promise<string> {
    const sourceRecordId = `off_${randomUUID()}`;

    if (SdkGatewayClient.isConfigured()) {
      // Throws on failure, which is what we want: nothing is recorded as synced
      // unless this succeeded.
      await SdkGatewayClient.call({
        sdk: 'sdk-source-record',
        path: '/api/source-records',
        method: 'POST',
        // The DEVICE's id, so a retry that reaches upstream twice lands once.
        idempotencyKey: item.clientCaptureId,
        body: {
          tenant_id: tenantId,
          source_system: 'leadflow-offline',
          source_external_id: item.clientCaptureId,
          origin_class: item.originClass,
          raw_evidence: {
            raw_input: item.rawInput,
            capture_kind: item.captureKind,
            // Present for a voice note taken at a property with nobody named.
            // It is the only identifying thing such a capture has, so losing it
            // would make the record unusable rather than merely thinner.
            property_reference: item.propertyReference,
            captured_at: item.capturedAt,
            captured_offline: true,
          },
        },
      });
    }

    // ON CONFLICT DO NOTHING: if two syncs race, the loser gets zero rows and
    // returns the winner's id rather than storing a second copy. The constraint
    // is what enforces idempotency; the earlier read is only an optimisation.
    const inserted = await dataService.query<{ source_record_id: string }>(
      `INSERT INTO offline_capture_sync
         (client_capture_id, tenant_id, source_record_id, capture_kind, captured_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING
       RETURNING source_record_id`,
      [
        item.clientCaptureId,
        tenantId,
        sourceRecordId,
        item.captureKind,
        item.capturedAt ? new Date(item.capturedAt) : null,
      ]
    );

    if (inserted.length === 0) {
      const existing = await alreadySynced([item.clientCaptureId], tenantId);
      return existing.get(item.clientCaptureId) ?? sourceRecordId;
    }

    return sourceRecordId;
  }

}
