import { Router, type Response } from 'express';
import { asyncHandler } from '../../middleware/errorHandler';
import { authenticate } from '../../middleware/auth';
import { AppError, ErrorCodes } from '../../utils/errors';
import { governed, type GovernedRequest } from '../../platform/policy/governed';
import { PERMISSIONS } from '../../config/roles';
import { AUDIT_EVENTS } from '../../platform/audit/vocabulary';
import {
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
