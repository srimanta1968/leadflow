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
import {
  effectiveState,
  recordSignal,
  type StopSignal,
  type SuppressionChannel,
  type SuppressionSource,
} from './suppressionLedger';
import { runCascade } from './revocationCascade';
import { reconcile } from './suppressionReconciliation';

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

/*
 * ---------------------------------------------------------------------------
 * Suppression: the operational half of consent.
 *
 * A receipt says what somebody agreed to. A suppression says we must not
 * contact them regardless — because they replied STOP, unsubscribed, marked a
 * message as spam, bounced permanently, registered on a do-not-call list, or
 * because the number turned out to reach somebody else entirely. The two are
 * deliberately separate surfaces: a hard bounce suppresses email while consent
 * remains perfectly valid, and a revoked receipt still leaves the evidence of
 * what was once agreed.
 */

const STOP_SIGNALS: StopSignal[] = [
  'sms_stop', 'sms_help', 'email_unsubscribe', 'spam_complaint', 'hard_bounce',
  'dnc_registration', 'wrong_number', 'staff_revocation', 'release',
];

const STOP_SOURCES: SuppressionSource[] = ['provider', 'staff', 'subject', 'reconciliation'];

/**
 * POST /api/leadflow/consent/stop-signals — record a stop and cascade it.
 *
 * ONE ENDPOINT FOR EVERY KIND OF STOP. An inbound SMS STOP, an unsubscribe
 * redemption, a spam complaint and a staff-initiated revocation differ in where
 * they came from and in which channels they close, and in nothing else: each
 * must be written down, must take effect immediately, and must cancel the work
 * already queued. Splitting them into eight endpoints would mean eight places
 * for the cascade to be forgotten, and the one that forgets is the one that
 * sends the message.
 *
 * 201 because a signal is a new record, returned with what the cascade actually
 * managed to stop rather than a bare acknowledgement.
 */
consentRoutes.post(
  '/stop-signals',
  asyncHandler(governed(
    {
      action: PERMISSIONS.CONSENT_PURPOSE_MANAGE,
      event: AUDIT_EVENTS.SUPPRESSION_APPLIED,
      purpose: 'compliance',
      resourceType: 'suppression_signal',
      metadata: (req) => ({
        signal: String((req.body as Record<string, unknown>)?.signal ?? ''),
        source: String((req.body as Record<string, unknown>)?.source ?? ''),
      }),
      obligations: NOT_AN_OWNED_RECORD,
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const b = (req.body ?? {}) as Record<string, unknown>;

      const subjectRef = typeof b.subject_ref === 'string' ? b.subject_ref.trim() : '';
      if (!subjectRef) {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'subject_ref is required');
      }
      const signal = b.signal as StopSignal;
      if (!STOP_SIGNALS.includes(signal)) {
        throw new AppError(
          400,
          ErrorCodes.VALIDATION_ERROR,
          `signal must be one of: ${STOP_SIGNALS.join(', ')}`,
        );
      }
      const source = b.source as SuppressionSource;
      if (!STOP_SOURCES.includes(source)) {
        throw new AppError(
          400,
          ErrorCodes.VALIDATION_ERROR,
          `source must be one of: ${STOP_SOURCES.join(', ')}`,
        );
      }

      /*
       * A RELEASE MUST SAY WHY, and so must a staff revocation. "Who
       * un-suppressed this person, and on what basis" is the question asked
       * after somebody who opted out receives a message, and an unexplained
       * release makes it unanswerable.
       */
      const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
      if (!reason && (signal === 'release' || signal === 'staff_revocation')) {
        throw new AppError(
          400,
          ErrorCodes.VALIDATION_ERROR,
          'a release or a staff revocation must carry a reason',
        );
      }

      if (b.occurred_at !== undefined && b.occurred_at !== null) {
        if (typeof b.occurred_at !== 'string' || Number.isNaN(Date.parse(b.occurred_at))) {
          throw new AppError(
            400,
            ErrorCodes.VALIDATION_ERROR,
            'occurred_at must be an ISO-8601 timestamp',
          );
        }
      }

      const tenantId = typeof b.tenant_id === 'string' ? b.tenant_id : null;
      const { signalId, channels } = await recordSignal({
        tenantId,
        subjectRef,
        signal,
        source,
        channel: typeof b.channel === 'string' ? (b.channel as SuppressionChannel) : undefined,
        reason: reason || undefined,
        receiptRef: typeof b.receipt_ref === 'string' ? b.receipt_ref : undefined,
        occurredAt: typeof b.occurred_at === 'string' ? b.occurred_at : undefined,
        recordedBy: req.session?.userId ?? null,
      });

      /*
       * HELP suppresses nothing, and says so rather than pretending. The
       * carrier requires an auto-reply to HELP; treating it as an opt-out would
       * silence somebody for asking a question.
       */
      if (!signalId) {
        res.status(201).json({
          success: true,
          data: {
            signal_id: null,
            signal,
            channels: [],
            suppressed: false,
            cascade: null,
            note: 'HELP is a request for information, not an opt-out. Nothing was suppressed.',
          },
        });
        return;
      }

      /*
       * THE CASCADE RUNS ONLY FOR A STOP. Releasing somebody must not cancel
       * their queued work — there is nothing to stop, and running the cascade
       * on a release would tear down the sequences the release was meant to
       * make possible again.
       */
      const cascade = signal === 'release'
        ? null
        : await runCascade({
          signalId,
          subjectRef,
          tenantId,
          channels,
          reason: reason || `${signal} recorded from ${source}`,
          receiptRef: typeof b.receipt_ref === 'string' ? b.receipt_ref : undefined,
        });

      res.status(201).json({
        success: true,
        data: {
          signal_id: signalId,
          signal,
          channels,
          suppressed: signal !== 'release',
          cascade,
          /* The evidence is kept. The guarantee, stated on the wire. */
          evidence_preserved: true,
          note: 'The receipt is revoked, never deleted: the record of what was agreed is what proves the earlier messages were lawful.',
        },
      });
    },
  )),
);

/**
 * GET /api/leadflow/consent/suppressions — the effective state per channel.
 *
 * Derived from the ledger rather than stored, so the answer follows the same
 * rule the composer applies: most-restrictive wins, and a suppression beats a
 * release recorded in the same instant.
 */
consentRoutes.get(
  '/suppressions',
  asyncHandler(governed(
    {
      action: PERMISSIONS.CONSENT_PURPOSE_MANAGE,
      event: AUDIT_EVENTS.CONSENT_RECEIPT_ISSUED,
      purpose: 'compliance',
      resourceType: 'suppression_signal',
      obligations: NOT_AN_OWNED_RECORD,
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const subjectRef =
        typeof req.query.subject_ref === 'string' ? req.query.subject_ref.trim() : '';
      if (!subjectRef) {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'subject_ref is required');
      }
      const channels = await effectiveState(
        subjectRef,
        typeof req.query.tenant_id === 'string' ? req.query.tenant_id : null,
      );
      res.status(200).json({
        success: true,
        data: {
          subject_ref: subjectRef,
          channels,
          any_suppressed: channels.some((c) => c.suppressed),
        },
      });
    },
  )),
);

/**
 * POST /api/leadflow/consent/suppressions/reconcile — the daily comparison.
 *
 * An action rather than a resource, hence 200. Exposed as an endpoint rather
 * than left to a timer alone so it can be run on demand when a divergence is
 * suspected, and so its behaviour is testable at all.
 */
consentRoutes.post(
  '/suppressions/reconcile',
  asyncHandler(governed(
    {
      action: PERMISSIONS.CONSENT_PURPOSE_MANAGE,
      event: AUDIT_EVENTS.SUPPRESSION_APPLIED,
      purpose: 'compliance',
      resourceType: 'suppression_signal',
      obligations: NOT_AN_OWNED_RECORD,
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const result = await reconcile(typeof b.tenant_id === 'string' ? b.tenant_id : null);
      res.status(200).json({ success: true, data: result });
    },
  )),
);
