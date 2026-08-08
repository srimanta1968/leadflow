import { Router, type Request, type Response } from 'express';
import { config } from '../../config/env';
import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/errorHandler';
import { AppError, ErrorCodes } from '../../utils/errors';
import { advancePipeline, ingest, rebuildPipeline, projectionFingerprint } from './consumer';
import { dispatchOutbox, listOutboxDlq, replayOutbox } from './outboxDispatcher';
import { verifyDelivery } from './signature';

/** Express augments the request with the raw bytes; see app.ts. */
interface WebhookRequest extends Request {
  rawBody?: string;
}

export const eventRoutes: Router = Router();

/**
 * POST /api/leadflow/events/projexcloud — the delivery receiver.
 *
 * NOT `authenticate`. The caller is ProjexCloud, not a person: it holds no
 * session and never will. Its credential is the HMAC over the body, which is
 * strictly stronger than a bearer token here because it also proves the payload
 * was not altered in transit.
 *
 * ANSWERS 200 FOR EVERY VERDICT EXCEPT A BAD SIGNATURE. Senders retry on any
 * non-2xx, so returning 4xx for a payload we have permanently refused makes them
 * redeliver it on a schedule we do not control, forever. A failed signature is
 * the one case that MUST be non-2xx: it is the only signal that tells the sender
 * their key is wrong, and swallowing it with 200 leaves a misconfigured
 * integration looking healthy while nothing lands.
 *
 * ACKNOWLEDGES ON RECORD, NOT ON PROJECT. The event is durable once the log row
 * exists; folding it into the projection happens after. Holding the connection
 * open until the projection is current would make the sender's timeout depend on
 * how much work our handlers do, and a slow handler would turn into a redelivery
 * storm.
 */
eventRoutes.post(
  '/projexcloud',
  asyncHandler(async (req: WebhookRequest, res: Response): Promise<void> => {
    // The RAW bytes. Re-serialising the parsed object reorders keys and changes
    // whitespace, so the digest would differ from the sender's for payloads that
    // are perfectly valid — and only for some senders, depending on their key
    // order, which is a miserable thing to diagnose.
    const rawBody = req.rawBody ?? JSON.stringify(req.body ?? {});
    const eventId = req.headers['x-projexcloud-event-id'] as string | undefined;

    const verification = verifyDelivery({
      rawBody,
      signatureHeader: req.headers['x-projexcloud-signature'] as string | undefined,
      eventId,
      algo: req.headers['x-projexcloud-algo'] as string | undefined,
      secret: config.projexCloud.webhookSecret,
    });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const payload = (body.payload ?? body.data ?? body) as Record<string, unknown>;

    // RECORDED EVEN WHEN REFUSED. "Never arrived" and "arrived and we rejected
    // it" are different incidents, and during an outage that difference is the
    // whole investigation. The row is written with signature_verified = false
    // and the consumer never projects it.
    if (eventId) {
      await ingest({
        eventId,
        eventType: String(body.event_type ?? body.type ?? 'unknown'),
        tenantId: (body.tenant_id as string) ?? null,
        occurredAt: (body.occurred_at as string) ?? null,
        subjectType: (body.subject_type as string) ?? null,
        subjectId: (body.subject_id as string) ?? (payload.id as string) ?? null,
        payload,
        signatureVerified: verification.ok,
      });
    }

    if (!verification.ok) {
      throw new AppError(401, ErrorCodes.UNAUTHENTICATED, verification.detail);
    }

    res.status(200).json({ success: true, data: { received: true, eventId } });

    // AFTER the response. A projection failure must not turn a delivery we have
    // already durably recorded into a redelivery.
    advancePipeline().catch((error: Error) => {
      console.error('[events] projection advance failed:', error.message);
    });
  }),
);

/* --------------------------------------------------------------- operations */

/**
 * The operator surface. Behind `authenticate` because it reports on the
 * platform rather than on any subject, and carries no personal data — the same
 * reasoning as the SDK health panel.
 */
eventRoutes.use(authenticate);

/** GET /api/leadflow/events/status — how far the consumer has got. */
eventRoutes.get(
  '/status',
  asyncHandler(async (_req: Request, res: Response): Promise<void> => {
    const result = await advancePipeline();
    res.status(200).json({
      success: true,
      data: {
        applied: result.applied,
        deadLettered: result.deadLettered,
        checkpoint: result.to,
        fingerprint: await projectionFingerprint(),
      },
    });
  }),
);

/** POST /api/leadflow/events/rebuild — recompute the projection from the log. */
eventRoutes.post(
  '/rebuild',
  asyncHandler(async (_req: Request, res: Response): Promise<void> => {
    const result = await rebuildPipeline();
    res.status(200).json({
      success: true,
      data: { applied: result.applied, deadLettered: result.deadLettered, checkpoint: result.to },
    });
  }),
);

/** GET /api/leadflow/events/outbox/dlq — outbound writes that gave up. */
eventRoutes.get(
  '/outbox/dlq',
  asyncHandler(async (_req: Request, res: Response): Promise<void> => {
    res.status(200).json({ success: true, data: { deliveries: await listOutboxDlq() } });
  }),
);

/** POST /api/leadflow/events/outbox/:id/replay — put one back in the queue. */
eventRoutes.post(
  '/outbox/:id/replay',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const replayed = await replayOutbox(String(req.params.id));
    if (!replayed) {
      // 404 rather than 409: from the caller's point of view there is no parked
      // delivery with that id, whether because it never existed or because it
      // has already been replayed. Both mean "nothing here to act on".
      throw new AppError(404, ErrorCodes.NOT_FOUND, 'No parked outbox delivery with that id');
    }
    const result = await dispatchOutbox();
    res.status(200).json({ success: true, data: { replayed: true, dispatch: result } });
  }),
);
