import { Response } from 'express';
import { PERMISSIONS } from '../../config/roles';
import { AUDIT_EVENTS } from '../../platform/audit/vocabulary';
import { governed, GovernedRequest } from '../../platform/policy/governed';
import { AppError, ErrorCodes } from '../../utils/errors';
import {
  assertNoForbiddenFields,
  evaluateDomainPolicy,
  ExtensionCaptureInput,
  ExtensionCaptureService,
  QUICK_ACTIONS,
  QuickAction,
} from './extensionCaptureService';

/**
 * Validate a browser capture.
 *
 * ORDER MATTERS. Forbidden fields are checked FIRST, before anything else,
 * because their presence means the client read something it must never touch —
 * and that is a more serious finding than a missing field. Reporting "domain is
 * required" on a payload that also carried a session cookie would bury the
 * thing that actually matters under a routine complaint.
 */
function validateExtensionCapture(body: Record<string, unknown>): ExtensionCaptureInput {
  assertNoForbiddenFields(body);

  const selectedText = typeof body.selectedText === 'string' ? body.selectedText : '';
  const domain = typeof body.domain === 'string' ? body.domain.trim() : '';
  const errors: string[] = [];

  if (selectedText.trim().length === 0) {
    errors.push('selectedText is required');
  }
  if (domain.length === 0) {
    errors.push('domain is required');
  }

  const quickAction = typeof body.quickAction === 'string' ? body.quickAction : null;
  if (quickAction !== null && !QUICK_ACTIONS.includes(quickAction as QuickAction)) {
    errors.push(`quickAction must be one of: ${QUICK_ACTIONS.join(', ')}`);
  }

  if (errors.length > 0) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, errors.join('; '));
  }

  // Checked AFTER the shape, so a malformed payload gets the syntax answer and
  // a well-formed unconfirmed one gets the consent answer. They are different
  // problems and a client fixes them differently.
  if (body.confirmed !== true) {
    throw new AppError(
      422,
      ErrorCodes.CONFIRMATION_REQUIRED,
      'A browser capture must be confirmed in the transmission preview before it is sent'
    );
  }

  return {
    // NOT trimmed: the selection is evidence, and the operator's whitespace is
    // part of what they saw.
    selectedText,
    domain,
    sourceUrl: typeof body.sourceUrl === 'string' ? body.sourceUrl : null,
    confirmed: true,
    retainSourceUrl: body.retainSourceUrl === true,
    quickAction: (quickAction as QuickAction | null) ?? null,
  };
}

export class ExtensionCaptureController {
  /**
   * GET /api/leadflow/capture/extension/domain-policy
   *
   * A read, so it answers 200 — including when the answer is "no". A restricted
   * domain is not an error the operator caused; refusing with 403 would teach
   * them the extension is broken rather than that this site is off limits.
   *
   * NOT wrapped in `governed`: asking whether you may capture is not itself a
   * governed act, and gating the question behind the permission would mean an
   * operator who cannot capture also cannot be told why.
   */
  static async domainPolicy(req: GovernedRequest, res: Response): Promise<void> {
    const domain = typeof req.query.domain === 'string' ? req.query.domain.trim() : '';
    if (domain.length === 0) {
      // Not defaulted. A policy answer about an unnamed domain is meaningless,
      // and answering "allowed" to it would be the most dangerous default here.
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'domain is required');
    }

    const decision = await evaluateDomainPolicy(domain);
    res.status(200).json({ success: true, data: decision });
  }

  /**
   * POST /api/leadflow/capture/extension
   *
   * A create at a collection root, so it answers 201 (MUST-54).
   */
  static capture = governed(
    {
      action: PERMISSIONS.LEAD_WORK_ASSIGNED,
      event: AUDIT_EVENTS.CAPTURE_CREATED,
      purpose: 'lead_management',
      resourceType: 'source_record',
      metadata: (req) => ({
        // The domain and the retention choice, in the ledger. "A capture
        // happened" and "a capture happened from mail.example.com with the URL
        // retained" are different facts, and only the second can be reviewed
        // against the tenant's own policy afterwards.
        domain: (req.body as { domain?: string })?.domain ?? null,
        source_url_retained: (req.body as { retainSourceUrl?: boolean })?.retainSourceUrl === true,
        channel: 'browser_extension',
      }),
      obligations: {
        own_record_only: {
          kind: 'defer',
          because: 'a capture has no owner until it exists, so ownership cannot be checked',
        },
      },
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const input = validateExtensionCapture((req.body ?? {}) as Record<string, unknown>);
      const result = await ExtensionCaptureService.capture(input);
      res.status(201).json({ success: true, data: result });
    }
  );
}
