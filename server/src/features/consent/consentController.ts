import { Router, type Response } from 'express';
import { asyncHandler } from '../../middleware/errorHandler';
import { authenticate } from '../../middleware/auth';
import { AppError, ErrorCodes } from '../../utils/errors';
import { governed, type GovernedRequest } from '../../platform/policy/governed';
import { PERMISSIONS } from '../../config/roles';
import { AUDIT_EVENTS } from '../../platform/audit/vocabulary';
import { config } from '../../config/env';
import {
  captureEvidence,
  encryptSignature,
  grantReceipt,
  listBounceEvents,
  listReceipts,
  listSuppressions,
  readSmsConsent,
  revokeReceipt,
  type ReceiptRow,
} from './consentGateway';

/**
 * The Consent & Preferences read surface (#view-consent).
 *
 * READS ARE GOVERNED, not merely authenticated. A consent receipt names a
 * person, a purpose, and what that person was told — reading the register is a
 * disclosure in its own right, so who looked belongs in the record.
 */
export const consentRoutes: Router = Router();

consentRoutes.use(authenticate);

const NOT_AN_OWNED_RECORD = {
  own_record_only: {
    kind: 'defer' as const,
    because: 'a consent receipt belongs to the subject and the tenant, not to an operator',
  },
};

/** The default expiring-soon window the mockup states. */
const DEFAULT_EXPIRING_DAYS = 30;

/** How many receipts one page of the register carries. */
const REGISTER_LIMIT = 500;

/** The channels the suppression panel reconciles. */
const SUPPRESSION_CHANNELS = ['sms', 'email', 'voice', 'postal'] as const;

type ReceiptStatus = 'active' | 'expiring' | 'revoked';

/**
 * A receipt's status for the register.
 *
 * REVOKED WINS over expiring, always. A revoked receipt that also happens to be
 * near its expiry is revoked — showing it as "expiring" would imply it is still
 * in force and merely running out, which is the opposite of what happened.
 */
function statusOf(row: ReceiptRow, now: number, windowDays: number): ReceiptStatus {
  if (row.revoked_at) return 'revoked';
  if (!row.expires_at) return 'active';
  const expiry = Date.parse(row.expires_at);
  if (Number.isNaN(expiry)) return 'active';
  const days = (expiry - now) / 86_400_000;
  return days <= windowDays ? 'expiring' : 'active';
}

/**
 * GET /api/leadflow/consent/overview — every panel on the screen, one call.
 */
consentRoutes.get(
  '/overview',
  asyncHandler(governed(
    {
      action: PERMISSIONS.CONSENT_PURPOSE_MANAGE,
      event: AUDIT_EVENTS.CONSENT_RECEIPT_ISSUED,
      purpose: 'compliance',
      resourceType: 'consent_register',
      metadata: () => ({ surface: 'consent_overview' }),
      obligations: NOT_AN_OWNED_RECORD,
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const raw = req.query?.expiring_within_days;
      let windowDays = DEFAULT_EXPIRING_DAYS;
      if (raw !== undefined && raw !== '') {
        /*
         * REJECTED, NOT DEFAULTED (AC1). Quietly substituting 30 for an
         * unparseable window would let somebody compare a figure they believe
         * covers a quarter against one that covers a month, and conclude
         * expiries had tripled.
         */
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 365) {
          throw new AppError(
            400,
            ErrorCodes.VALIDATION_ERROR,
            'expiring_within_days must be an integer between 1 and 365'
          );
        }
        windowDays = parsed;
      }

      const [receipts, sms, bounces, ...suppressionReads] = await Promise.all([
        listReceipts(REGISTER_LIMIT),
        readSmsConsent(),
        listBounceEvents(),
        ...SUPPRESSION_CHANNELS.map((channel) => listSuppressions(channel)),
      ]);

      const now = Date.now();
      const rows = receipts.value.map((row) => ({
        receipt_id: row.receipt_id ?? null,
        person_id: row.person_id ?? null,
        purpose_id: row.purpose_id ?? null,
        processor: row.processor ?? null,
        jurisdiction: row.jurisdiction ?? null,
        granted_at: row.granted_at ?? null,
        expires_at: row.expires_at ?? null,
        revoked_at: row.revoked_at ?? null,
        status: statusOf(row, now, windowDays),
      }));

      const counts = {
        active: rows.filter((r) => r.status === 'active').length,
        expiring: rows.filter((r) => r.status === 'expiring').length,
        revoked: rows.filter((r) => r.status === 'revoked').length,
      };

      /*
       * RECONCILED, NOT MERGED (AC2). Our count and the provider's are reported
       * SEPARATELY with a flag, because a suppression list that has drifted
       * from the provider is the exact condition under which somebody gets
       * messaged after opting out. One merged number would conceal precisely
       * the disagreement worth surfacing.
       */
      const suppressions = SUPPRESSION_CHANNELS.map((channel, index) => {
        const read = suppressionReads[index];
        return {
          channel,
          count: read.available ? read.value.length : null,
          provider_reachable: read.available,
          reconciled: read.available,
          note: read.available
            ? null
            : 'Could not reach the provider, so this count is unknown rather than zero.',
        };
      });

      res.status(200).json({
        success: true,
        data: {
          expiring_within_days: windowDays,
          kpis: {
            active_receipts: counts.active,
            expiring_soon: counts.expiring,
            revoked: counts.revoked,
            sms_permitted: sms.available ? sms.value : null,
            bounce_events: bounces.available ? bounces.value.length : null,
          },
          receipts: rows,
          /*
           * The register is ASSEMBLED from a DSAR export, not read from a
           * register endpoint that does not exist. Saying it was capped is the
           * difference between "these are the receipts" and "these are the
           * first 500 of an unknown number".
           */
          register: {
            source: '/api/consents/export',
            limit: REGISTER_LIMIT,
            truncated: receipts.value.length >= REGISTER_LIMIT,
            note: 'sdk-consent exposes no tenant-wide receipt list; this is assembled from the DSAR export and capped.',
          },
          suppressions,
          /* AC4 — the taxonomy cannot be listed, and the screen says so. */
          purposes: [],
          purpose_taxonomy_gap: {
            reason:
              'sdk-consent exposes only POST /api/consents/purposes, which registers a purpose. There is no GET, so the registered taxonomy cannot be read.',
            rejected_alternative:
              'Deriving the list from purposes seen on existing receipts would omit any registered purpose nobody has consented to yet - which is exactly when a taxonomy panel earns its place.',
          },
          upstream_available: {
            receipts: receipts.available,
            sms_consent: sms.available,
            bounce_events: bounces.available,
            suppressions: suppressionReads.every((r) => r.available),
          },
        },
      });
    }
  ))
);

const receiptIdOf = (req: GovernedRequest): string => String(req.params?.receipt_id ?? '');

/**
 * POST /api/leadflow/consent/receipts/:receipt_id/revoke — withdraw consent.
 *
 * A WRITE THAT NEVER DEGRADES. Every read on this feature answers honestly when
 * upstream is unreachable, but a revocation must not: reporting success when
 * nothing was revoked is the worst outcome available here, because the person
 * believes they have been removed and has no reason to check again. If
 * sdk-consent cannot be reached this answers 502 and the screen keeps the
 * receipt active.
 */
consentRoutes.post(
  '/receipts/:receipt_id/revoke',
  asyncHandler(governed(
    {
      action: PERMISSIONS.CONSENT_PURPOSE_MANAGE,
      event: AUDIT_EVENTS.CONSENT_RECEIPT_REVOKED,
      purpose: 'compliance',
      resourceType: 'consent_receipt',
      resourceId: receiptIdOf,
      metadata: (req) => ({ receipt_id: receiptIdOf(req) }),
      obligations: NOT_AN_OWNED_RECORD,
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';

      if (reason.length === 0) {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'reason is required to revoke consent');
      }

      const result = await revokeReceipt(receiptIdOf(req), reason);
      if (!result) {
        throw new AppError(
          502,
          ErrorCodes.UPSTREAM_UNAVAILABLE,
          'sdk-consent did not confirm the revocation, so it cannot be reported as revoked.'
        );
      }

      res.status(200).json({
        success: true,
        data: {
          receipt_id: receiptIdOf(req),
          revoked: true,
          reason,
          /*
           * AC3 — the cascade is upstream's: revoking emits
           * consent.receipt.revoked.v1, which sdk-data-rights fans out to the
           * erasure surfaces. Named rather than claimed, because LeadFlow does
           * not perform the cascade and should not imply it verified one.
           */
          cascade: {
            performed_by: 'sdk-consent',
            event: 'consent.receipt.revoked.v1',
            note: 'Suppression propagation is driven upstream by that event; this response confirms the revocation, not the fan-out.',
          },
          result,
        },
      });
    }
  ))
);

/** The one purpose that is never a channel. */
const PROMOTIONAL_PURPOSE = 'promotional_offers';

/** Capture methods the modal offers, mirroring the mockup. */
const CAPTURE_METHODS = [
  'in_person_signature',
  'secure_link',
  'web_form',
  'recorded_verbal',
  'imported_receipt',
] as const;

/**
 * POST /api/leadflow/consent/receipts — issue one signed, purpose-specific receipt.
 *
 * FOUR REFUSALS, and each exists because the alternative produces a permission
 * nobody granted.
 */
consentRoutes.post(
  '/receipts',
  asyncHandler(governed(
    {
      action: PERMISSIONS.CONSENT_PURPOSE_MANAGE,
      event: AUDIT_EVENTS.CONSENT_RECEIPT_ISSUED,
      purpose: 'compliance',
      resourceType: 'consent_receipt',
      metadata: (req) => ({
        purpose_id: String((req.body as Record<string, unknown>)?.purpose_id ?? ''),
        capture_method: String((req.body as Record<string, unknown>)?.capture_method ?? ''),
      }),
      obligations: NOT_AN_OWNED_RECORD,
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const b = (req.body ?? {}) as Record<string, unknown>;

      /*
       * AC1 — ONE PURPOSE, and an array is refused rather than reduced to its
       * first element. sdk-consent's validateGrantConsent takes a singular
       * purpose_id, so a multi-purpose receipt cannot exist upstream; quietly
       * taking [0] here would issue a receipt for one purpose while the
       * operator believed they had captured four.
       */
      if (Array.isArray(b.purpose_id) || typeof b.purpose_id !== 'string' || !b.purpose_id.trim()) {
        throw new AppError(
          400,
          ErrorCodes.VALIDATION_ERROR,
          'purpose_id must be a single purpose; a receipt covers exactly one'
        );
      }

      const channels = Array.isArray(b.channels) ? b.channels.map(String) : [];

      /*
       * AC4 — PROMOTIONAL OFFERS IS A PURPOSE, NOT A CHANNEL, and sending it as
       * one is refused LOUDLY. It is the permission people most often did not
       * intend to give: somebody agrees to job updates and finds themselves on
       * a marketing list. Dropping it silently would leave the operator
       * believing they had captured it, so the refusal names the reason.
       */
      if (channels.includes(PROMOTIONAL_PURPOSE)) {
        throw new AppError(
          400,
          ErrorCodes.VALIDATION_ERROR,
          'promotional_offers is a separate purpose, not a channel'
        );
      }

      /*
       * AC3 — THE NOTICE AS SHOWN, not as named. "Which version did they see"
       * is the first question when a consent is challenged, and a template id
       * cannot answer it because templates change: the one on file today may
       * not be the words that were on the screen that day.
       */
      const noticeHash = typeof b.notice_hash === 'string' ? b.notice_hash.trim() : '';
      const noticeText = typeof b.notice_text === 'string' ? b.notice_text.trim() : '';
      const noticeLang = typeof b.notice_language === 'string' ? b.notice_language.trim() : '';
      if (!noticeHash || !noticeText || !noticeLang) {
        throw new AppError(
          400,
          ErrorCodes.VALIDATION_ERROR,
          'notice_hash, notice_text and notice_language are required'
        );
      }

      const method = String(b.capture_method ?? '');
      if (!CAPTURE_METHODS.includes(method as (typeof CAPTURE_METHODS)[number])) {
        throw new AppError(
          400,
          ErrorCodes.VALIDATION_ERROR,
          `capture_method must be one of ${CAPTURE_METHODS.join(', ')}`
        );
      }

      /*
       * AC2 — THE SIGNATURE IS ENCRYPTED BEFORE ANYTHING KEEPS IT, and only the
       * reference is retained. The raw data URL is never persisted and never
       * logged; it is evidence for a specific dispute, not an attribute of a
       * person to be browsed, so it is excluded from every contact projection.
       */
      let signatureRef: string | null = null;
      if (typeof b.signature_data_url === 'string' && b.signature_data_url.length > 0) {
        signatureRef = await encryptSignature(b.signature_data_url);
        if (!signatureRef) {
          throw new AppError(
            502,
            ErrorCodes.UPSTREAM_UNAVAILABLE,
            'The signature could not be encrypted, so the receipt was not issued.'
          );
        }
      }

      const receipt = await grantReceipt({
        person_id: String(b.person_id ?? ''),
        purpose_id: b.purpose_id,
        processor: config.projexCloud.tenantId,
        app_id: config.projexCloud.appId || 'leadflow',
        jurisdiction: String(b.jurisdiction ?? ''),
        granted_by_actor: String(b.captured_by ?? req.session?.userId ?? ''),
        expires_at: typeof b.expires_at === 'string' ? b.expires_at : undefined,
      });

      if (!receipt) {
        throw new AppError(
          502,
          ErrorCodes.UPSTREAM_UNAVAILABLE,
          'sdk-consent did not confirm the receipt, so it cannot be reported as issued.'
        );
      }

      const evidenceId = await captureEvidence({
        kind: 'consent_signature',
        notice_hash: noticeHash,
        notice_language: noticeLang,
        capture_method: method,
        device: String(b.device ?? ''),
        representative: String(b.captured_by ?? ''),
        signature_ref: signatureRef,
      }).catch(() => null);

      res.status(201).json({
        success: true,
        data: {
          receipt,
          purpose_id: b.purpose_id,
          channels,
          /* The reference, never the image. */
          signature_ref: signatureRef,
          signature_searchable: false,
          notice: { hash: noticeHash, language: noticeLang, text: noticeText },
          capture_method: method,
          evidence_id: evidenceId,
          note: 'Final channel authorization is re-evaluated at use time. This receipt permits a purpose; it does not bypass suppression.',
        },
      });
    }
  ))
);
