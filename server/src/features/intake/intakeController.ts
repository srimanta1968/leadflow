import { Response } from 'express';
import { PERMISSIONS } from '../../config/roles';
import { AUDIT_EVENTS } from '../../platform/audit/vocabulary';
import { governed, GovernedRequest } from '../../platform/policy/governed';
import { AppError, ErrorCodes } from '../../utils/errors';
import { SOURCE_ADAPTERS, launchEvidenceFor } from '../../config/sourceAdapters';
import { IntakeService, IntakeSignal } from './intakeService';
import { verifySignature } from './signatureVerifier';
import { classifySignal, knownSignalKinds } from './signalPolicy';

/** A request that may carry the raw body the signature was computed over. */
type WebhookRequest = GovernedRequest & { rawBody?: string };

export class IntakeController {
  /**
   * POST /api/leadflow/intake/events — the normalized signal envelope.
   *
   * A create at a collection root, so 201 (MUST-54). Authenticated: this is the
   * first-party path used by our own connectors and by partners holding an API
   * key, as distinct from the webhook receiver below, which is authenticated by
   * signature instead.
   */
  static events = governed(
    {
      action: PERMISSIONS.LEAD_WORK_ASSIGNED,
      event: AUDIT_EVENTS.CAPTURE_CREATED,
      purpose: 'lead_management',
      resourceType: 'intake_event',
      metadata: (req) => ({
        platform: (req.body as { platform?: string })?.platform ?? null,
        source_event_id: (req.body as { sourceEventId?: string })?.sourceEventId ?? null,
        channel: 'intake_events',
      }),
      obligations: {
        own_record_only: {
          kind: 'defer',
          because: 'an intake signal has no owner until it becomes a lead',
        },
      },
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const result = await IntakeService.accept(
        (req.body ?? {}) as Partial<IntakeSignal>,
        // Not signature-authenticated: this path is behind the bearer guard, so
        // the caller is already established. Recorded as such rather than
        // claiming a verification that never happened.
        'verified'
      );

      // 201 for a genuinely new signal; 200 for a replay or a deferral, because
      // nothing was created. A replay answering 201 would tell an honest sender
      // they had just made a second lead.
      res.status(result.outcome === 'accepted' && !result.replay ? 201 : 200).json({
        success: true,
        data: result,
      });
    }
  );

  /**
   * POST /api/leadflow/intake/webhooks/:platform — the per-provider receiver.
   *
   * Answers 200 whatever the verdict, EXCEPT for a failed signature. Providers
   * retry on any non-2xx, so returning 4xx for a payload we have permanently
   * refused makes them redeliver it on a schedule we do not control, forever.
   * A bad signature is the one case that MUST be non-2xx: it is the only signal
   * that tells a sender their secret is wrong, and swallowing it with 200 would
   * leave a misconfigured integration looking healthy while nothing lands.
   *
   * NOT `governed`: there is no session here. The caller is a machine
   * authenticated by HMAC, and gating this on a persona's permissions would
   * require a persona that no webhook has.
   */
  static async webhook(req: WebhookRequest, res: Response): Promise<void> {
    const platform = String(req.params.platform ?? '');
    if (platform.length === 0) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'platform is required in the path');
    }

    // The RAW bytes, not a re-serialisation. Re-encoding parsed JSON reorders
    // keys and changes whitespace, so the digest would differ from the sender's
    // for payloads that are perfectly valid — an intermittent failure that
    // depends on their key order.
    const rawBody = req.rawBody ?? JSON.stringify(req.body ?? {});
    const provided =
      (req.headers['x-signature'] as string | undefined) ??
      (req.headers['x-hub-signature-256'] as string | undefined);

    const verification = verifySignature(platform, rawBody, provided);

    if (!verification.ok) {
      // ARCHIVED EVEN THOUGH IT IS REFUSED. A rejected webhook that leaves no
      // trace is indistinguishable from one that never arrived, and during an
      // incident that difference is the whole investigation.
      await IntakeService.accept(
        {
          platform,
          sourceEventId: String(
            (req.body as { sourceEventId?: string })?.sourceEventId ?? `unsigned:${Date.now()}`
          ),
          rawPayload: (req.body ?? {}) as Record<string, unknown>,
        },
        verification.state
      );

      throw new AppError(401, ErrorCodes.UNAUTHENTICATED, verification.detail);
    }

    const result = await IntakeService.accept(
      {
        ...((req.body ?? {}) as Partial<IntakeSignal>),
        platform,
      },
      verification.state
    );

    res.status(200).json({ success: true, data: result });
  }

  /**
   * POST /api/leadflow/intake/classify — the SOP §03 decision for one signal.
   *
   * A read-shaped question about a signal rather than a create, so 200: nothing
   * is stored, and answering 201 would suggest the classification itself made a
   * record.
   *
   * Returns the decision WITH its reasoning. A classification with no stated
   * basis is unauditable — six months on, nobody can say why a comment became a
   * lead and an impression did not without re-reading the code as it was that
   * day.
   */
  static classify = governed(
    {
      action: PERMISSIONS.LEAD_WORK_ASSIGNED,
      event: AUDIT_EVENTS.CAPTURE_NORMALIZED,
      purpose: 'lead_management',
      resourceType: 'intake_signal',
      metadata: (req) => ({
        signal_kind: (req.body as { signalKind?: string })?.signalKind ?? null,
        identifiable: (req.body as { identifiable?: boolean })?.identifiable === true,
      }),
      obligations: {
        own_record_only: {
          kind: 'defer',
          because: 'a classification decides whether a record exists at all, so there is no owner yet',
        },
      },
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const body = (req.body ?? {}) as {
        signalKind?: string;
        identifiable?: boolean;
        existingLeadId?: string | null;
      };

      if (typeof body.signalKind !== 'string' || body.signalKind.trim().length === 0) {
        throw new AppError(
          400,
          ErrorCodes.VALIDATION_ERROR,
          `signalKind is required and should be one of: ${knownSignalKinds().slice(0, 8).join(', ')}...`
        );
      }

      const classification = classifySignal(body.signalKind, {
        // Defaults to FALSE. An unstated identifiable flag must not be read as
        // "yes" — that would turn an anonymous comment into a lead on the
        // strength of a missing field.
        identifiable: body.identifiable === true,
        existingLeadId: body.existingLeadId ?? null,
      });

      res.status(200).json({ success: true, data: classification });
    }
  );

  /**
   * GET /api/leadflow/intake/adapters — every configured source.
   *
   * A read, so 200. Returns the declaration the runtime uses rather than a
   * separate description of it: an operator asking "what does the Meta adapter
   * need" gets the same answer the validator enforces, so the two cannot
   * disagree.
   */
  static async adapters(_req: GovernedRequest, res: Response): Promise<void> {
    res.status(200).json({
      success: true,
      data: {
        adapters: SOURCE_ADAPTERS.map((adapter) => ({
          key: adapter.key,
          label: adapter.label,
          requiredFields: adapter.requiredFields,
          permissionFields: adapter.permissionFields,
          attributionFields: adapter.attributionFields,
          failureQueue: adapter.failureQueue,
          manualFallback: adapter.manualFallback,
        })),
        total: SOURCE_ADAPTERS.length,
      },
    });
  }

  /**
   * GET /api/leadflow/intake/adapters/:key/launch-evidence
   *
   * The SOP §29 launch-evidence packet for one integration. 404 for an unknown
   * adapter rather than an empty packet — an empty packet reads as "nothing to
   * evidence" when the truth is "no such integration", and somebody would sign
   * it off.
   *
   * The packet attests that the integration is SPECIFIED completely. It is not
   * a production test result, and every item says what satisfies it so a green
   * packet cannot be mistaken for a successful end-to-end run.
   */
  static async launchEvidence(req: GovernedRequest, res: Response): Promise<void> {
    const packet = launchEvidenceFor(String(req.params.key ?? ''));
    if (!packet) {
      throw new AppError(404, ErrorCodes.NOT_FOUND, `No source adapter '${req.params.key}'`);
    }
    res.status(200).json({ success: true, data: packet });
  }

  /**
   * POST /api/leadflow/intake/backfill — drain the outage queue.
   *
   * A command, so 200. Gated on `data.configure`: replaying a backlog of events
   * is an operational act with real consequences, and a rep working their own
   * leads has no business triggering it.
   */
  static backfill = governed(
    {
      action: PERMISSIONS.DATA_CONFIGURE,
      event: AUDIT_EVENTS.IMPORT_RUN_COMMITTED,
      purpose: 'service_operation',
      resourceType: 'intake_outage_queue',
      metadata: (req) => ({
        blocked_on: (req.body as { blockedOn?: string })?.blockedOn ?? 'all',
      }),
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const blockedOn = (req.body as { blockedOn?: string })?.blockedOn;
      const result = await IntakeService.backfill(blockedOn);
      res.status(200).json({ success: true, data: result });
    }
  );
}
