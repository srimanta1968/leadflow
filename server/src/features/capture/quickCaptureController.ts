import { Response } from 'express';
import { PERMISSIONS } from '../../config/roles';
import { AUDIT_EVENTS } from '../../platform/audit/vocabulary';
import { governed, GovernedRequest } from '../../platform/policy/governed';
import { QuickCaptureService } from './quickCaptureService';
import { validateQuickCapture } from './quickCaptureValidator';

/**
 * HTTP surface for one-call lead capture.
 *
 * A create at a collection root, so it answers 201 (MUST-54).
 *
 * Wrapped in `governed`, which is what emits `capture.created` naming the acting
 * persona and quoting the PDP decision that allowed it. Doing it here rather
 * than inside the service is deliberate: the audit entry must record WHO acted,
 * and only the request layer knows that. A service-level append would have to be
 * handed an actor, and an actor that can be passed in is an actor that can be
 * passed in wrongly.
 */
export class QuickCaptureController {
  /** POST /api/leadflow/capture/quick — capture a lead and assert it upstream. */
  static quick = governed(
    {
      action: PERMISSIONS.LEAD_WORK_ASSIGNED,
      event: AUDIT_EVENTS.CAPTURE_CREATED,
      purpose: 'lead_management',
      resourceType: 'source_record',
      // The origin class is stamped into the ledger with the act, because "a
      // record was captured" and "a record was captured claiming to be
      // first-party" are different facts, and only the second can be audited
      // against the trust ladder afterwards.
      metadata: (req) => ({
        origin_class: (req.body as { originClass?: string })?.originClass ?? null,
        mode: (req.body as { mode?: string })?.mode ?? 'manual',
        search_after_capture: (req.body as { searchAfterCapture?: boolean })?.searchAfterCapture === true,
      }),
      obligations: {
        own_record_only: {
          kind: 'defer',
          // The rule scopes a Rep to leads they own. A capture has no owner yet
          // — it is the act that creates the record — so there is nothing to
          // compare the caller against. Deferred rather than silently ignored.
          because: 'a capture has no owner until it exists, so ownership cannot be checked',
        },
      },
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const input = validateQuickCapture((req.body ?? {}) as Record<string, unknown>);
      const result = await QuickCaptureService.capture(input);
      res.status(201).json({ success: true, data: result });
    }
  );
}
