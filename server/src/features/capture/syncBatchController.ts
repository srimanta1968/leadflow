import { Response } from 'express';
import { PERMISSIONS } from '../../config/roles';
import { AUDIT_EVENTS } from '../../platform/audit/vocabulary';
import { governed, GovernedRequest } from '../../platform/policy/governed';
import { AppError, ErrorCodes } from '../../utils/errors';
import { MAX_BATCH_ITEMS, QueuedCapture, SyncBatchService } from './syncBatchService';

/**
 * HTTP surface for draining a device's offline capture queue.
 *
 * Answers 200, not 201, and the choice is deliberate. A batch where three items
 * are new and two are replays has no single created/not-created answer; forcing
 * one would hide exactly the case this endpoint exists to handle. The per-item
 * outcomes carry the detail.
 */
export class SyncBatchController {
  /** POST /api/leadflow/capture/sync-batch */
  static sync = governed(
    {
      action: PERMISSIONS.LEAD_WORK_ASSIGNED,
      event: AUDIT_EVENTS.CAPTURE_CREATED,
      purpose: 'lead_management',
      resourceType: 'source_record_batch',
      metadata: (req) => ({
        // The batch SIZE, in the ledger. One entry per sync rather than per
        // item: the act being recorded is "this operator drained their queue",
        // and 200 entries for one press of Sync would drown the timeline the
        // audit screen renders.
        batch_size: Array.isArray((req.body as { items?: unknown[] })?.items)
          ? (req.body as { items: unknown[] }).items.length
          : 0,
        channel: 'offline_queue',
      }),
      obligations: {
        own_record_only: {
          kind: 'defer',
          because: 'a capture has no owner until it exists, so ownership cannot be checked',
        },
      },
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const items = (req.body as { items?: unknown })?.items;

      if (!Array.isArray(items) || items.length === 0) {
        // An empty batch is a client bug — a queue with nothing in it should not
        // be syncing at all — and answering it cheerfully hides that.
        throw new AppError(
          400,
          ErrorCodes.VALIDATION_ERROR,
          'items must be a non-empty array of queued captures'
        );
      }

      if (items.length > MAX_BATCH_ITEMS) {
        throw new AppError(
          400,
          ErrorCodes.VALIDATION_ERROR,
          `items may contain at most ${MAX_BATCH_ITEMS} entries — page the rest`
        );
      }

      const result = await SyncBatchService.sync(items as Partial<QueuedCapture>[]);
      res.status(200).json({ success: true, data: result });
    }
  );
}
