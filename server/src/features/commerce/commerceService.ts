import { dataService } from '../../services/DataService';
import { config } from '../../config/env';
import { SdkGatewayClient } from '../../platform/sdkGateway';

/**
 * Offers, checkout, verified payments and the onboarding handoff.
 * SOP §12, §13, §19, §22, §32, §44, §45, §50.
 */

/** The five labels a rep is permitted to say about a capability. SOP §12. */
export const FEATURE_STATUSES = ['LIVE', 'BETA', 'ROADMAP', 'USAGE_THIRD_PARTY', 'NOT_INCLUDED'] as const;
export type FeatureStatus = (typeof FEATURE_STATUSES)[number];

/** The commercial fields an Offer Data Sheet must carry. SOP §12. */
export const REQUIRED_OFFER_FIELDS = [
  'price_cents', 'quantity_basis', 'payment_options', 'license_limits',
  'implementation_expectations', 'refund_terms', 'cancellation_terms',
  'included_features', 'variable_charges', 'third_party_charges',
] as const;

/** The parties whose sign-off a publish requires. SOP §22. */
export const APPROVAL_PARTIES = ['leadership', 'legal', 'finance'] as const;

/** Refunds at or above this need a second party. */
export const REFUND_APPROVAL_THRESHOLD_CENTS = 50_000;

/** The onboarding kickoff must be booked inside this window of verified payment. */
export const KICKOFF_WINDOW_HOURS = 24;

/**
 * Card-like patterns, blocked from every free-text surface. SOP §13.
 *
 * AN ABSOLUTE RULE, not a warning. Card data in a CRM note or an email is a
 * compliance breach that no amount of later redaction undoes — the note is
 * already replicated, indexed and backed up by the time anybody notices. So the
 * compose surfaces REFUSE rather than flag.
 *
 * Matches 13-19 digits with optional spaces or dashes, which covers every major
 * scheme, and a CVV-with-context pattern. Deliberately broad: a false positive
 * costs somebody a rephrase, a false negative costs a breach notification.
 */
const CARD_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'card number', re: /\b(?:\d[ -]*?){13,19}\b/ },
  { name: 'CVV', re: /\b(?:cvv|cvc|security\s*code)\b\s*[:#]?\s*\d{3,4}\b/i },
  { name: 'expiry', re: /\b(?:0[1-9]|1[0-2])\s*[/-]\s*(?:\d{2}|\d{4})\b/ },
];

export interface CardScan { blocked: boolean; matched: string[] }

/**
 * Whether a free-text field contains card-like data.
 *
 * THE LUHN CHECK IS DELIBERATELY NOT APPLIED. A number that fails Luhn is still
 * somebody typing a card number badly, and the point is to stop the habit rather
 * than to catch valid cards specifically.
 */
export function scanForCardData(text: string): CardScan {
  const matched: string[] = [];
  for (const p of CARD_PATTERNS) {
    if (p.re.test(text)) matched.push(p.name);
  }
  // A long digit run that is plainly a phone number or an id is still refused:
  // the operator rephrases, which costs seconds, and the alternative costs a
  // breach notification.
  return { blocked: matched.length > 0, matched };
}

/* ------------------------------------------------------------------ offers */

export interface OfferVersionRow {
  offer_version_id: string; offer_key: string; version: number;
  price_cents: string; currency: string; quantity_basis: string;
  payment_options: unknown; license_limits: string; implementation_expectations: string;
  refund_terms: string; cancellation_terms: string; included_features: unknown;
  variable_charges: unknown; third_party_charges: unknown;
  approved_scarcity_language: string | null;
  approved_at: string | null; approvals: { party: string; at: string }[]; activated_at: string | null;
}

/**
 * The version a rep may quote.
 *
 * ONLY THE ACTIVE ONE IS RETURNED. Improvisation is made structurally impossible
 * rather than discouraged: a rep who cannot see last quarter's pricing cannot
 * quote it by accident, and one who cannot see an unapproved draft cannot quote
 * terms nobody reviewed.
 */
export async function currentOffer(offerKey: string): Promise<OfferVersionRow | null> {
  const rows = await dataService.query<OfferVersionRow>(
    `SELECT offer_version_id, offer_key, version, price_cents::text, currency, quantity_basis,
            payment_options, license_limits, implementation_expectations, refund_terms,
            cancellation_terms, included_features, variable_charges, third_party_charges,
            approved_scarcity_language, approved_at, approvals, activated_at
       FROM leadflow_offer_version
      WHERE tenant_id = $1 AND offer_key = $2
        AND activated_at IS NOT NULL AND superseded_at IS NULL
      LIMIT 1`,
    [config.projexCloud.tenantId, offerKey]
  );
  return rows[0] ?? null;
}

/** Whether every party SOP §22 requires has signed off. */
export function approvalComplete(approvals: { party: string }[]): { complete: boolean; missing: string[] } {
  const have = new Set((approvals ?? []).map((a) => a.party));
  const missing = APPROVAL_PARTIES.filter((p) => !have.has(p));
  return { complete: missing.length === 0, missing };
}

export async function featureMatrix(offerKey: string): Promise<{
  capability: string; status: string; owner_user_id: string; updated_at: string; note: string | null;
}[]> {
  return dataService.query(
    `SELECT capability, status, owner_user_id, updated_at, note
       FROM leadflow_feature_status
      WHERE tenant_id = $1 AND offer_key = $2 ORDER BY capability`,
    [config.projexCloud.tenantId, offerKey]
  );
}

/* ---------------------------------------------------------------- checkout */

export async function createCheckout(input: {
  subjectRef: string; dealRef: string | null; offerKey: string; offerVersion: number;
  checkoutUrl: string | null; decisionDueAt: string | null;
}): Promise<string> {
  /* DUPLICATE OFFERS ARE SUPPRESSED. A second live checkout for the same contact
     lets them pay twice, or pay against terms the rep has already replaced. */
  await dataService.query(
    `UPDATE leadflow_checkout_session SET status = 'cancelled'
      WHERE tenant_id = $1 AND subject_ref = $2 AND status IN ('sent','started')`,
    [config.projexCloud.tenantId, input.subjectRef]
  );
  const rows = await dataService.query<{ checkout_id: string }>(
    `INSERT INTO leadflow_checkout_session
       (tenant_id, subject_ref, deal_ref, offer_key, offer_version, checkout_url, decision_due_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz) RETURNING checkout_id`,
    [
      config.projexCloud.tenantId, input.subjectRef, input.dealRef,
      input.offerKey, input.offerVersion, input.checkoutUrl, input.decisionDueAt,
    ]
  );
  return rows[0].checkout_id;
}

/* ---------------------------------------------------------------- payments */

export interface VerifyResult {
  verificationId: string | null;
  verification: 'gateway_confirmed' | 'intent_only' | 'failed';
  duplicate: boolean;
  mayCloseWon: boolean;
  reconciledFromGateway: boolean;
  financeTaskRef: string | null;
}

/**
 * Record a payment verification, exactly once per charge.
 *
 * THE UNIQUE CONSTRAINT IS THE IDEMPOTENCY. Replaying a webhook five times must
 * produce one customer, one licence, one welcome and one onboarding — and the
 * only way to guarantee that across five concurrent deliveries is to let the
 * database refuse the second insert. A handler that checks first has a window.
 *
 * AN INTENT IS NOT A VERIFICATION. SOP §22 names "payment success assumed from
 * checkout intent" as the gap, so the two are different values and only
 * `gateway_confirmed` permits Closed Won.
 */
export async function verifyPayment(input: {
  subjectRef: string; chargeRef: string; checkoutId: string | null;
  verification: 'gateway_confirmed' | 'intent_only' | 'failed';
  amountCents: number | null; currency: string | null;
  payload: unknown; reconciledFromGateway: boolean;
}): Promise<VerifyResult> {
  const rows = await dataService.query<{ verification_id: string }>(
    `INSERT INTO leadflow_payment_verification
       (tenant_id, subject_ref, checkout_id, charge_ref, verification, amount_cents,
        currency, gateway_payload, reconciled_from_gateway)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
     ON CONFLICT (tenant_id, charge_ref) DO NOTHING
     RETURNING verification_id`,
    [
      config.projexCloud.tenantId, input.subjectRef, input.checkoutId, input.chargeRef,
      input.verification, input.amountCents, input.currency,
      JSON.stringify(input.payload ?? {}), input.reconciledFromGateway,
    ]
  );

  const duplicate = rows.length === 0;
  if (input.verification === 'gateway_confirmed' && !duplicate) {
    await dataService.query(
      `UPDATE leadflow_checkout_session SET status = 'paid', paid_at = now()
        WHERE checkout_id = $1`,
      [input.checkoutId]
    );
  }

  return {
    verificationId: rows[0]?.verification_id ?? null,
    verification: input.verification,
    duplicate,
    /* AC1 of #135 — only a gateway confirmation opens Closed Won. */
    mayCloseWon: input.verification === 'gateway_confirmed',
    reconciledFromGateway: input.reconciledFromGateway,
    financeTaskRef: null,
  };
}

/**
 * Query the gateway directly when the webhook never arrived.
 *
 * sdk-payment exposes no GET for a charge, so what CAN be done is a distribute
 * probe that fails for an unknown charge. Reported honestly as unconfirmed
 * rather than assumed: assuming success here is the exact failure SOP §22 names.
 */
export async function reconcileFromGateway(chargeRef: string): Promise<{ confirmed: boolean; detail: string }> {
  if (!SdkGatewayClient.isConfigured()) {
    return { confirmed: false, detail: 'The payment service is unreachable, so the charge could not be verified. Closed Won stays blocked.' };
  }
  try {
    const result = await SdkGatewayClient.call<{ data?: { status?: string } }>({
      sdk: 'sdk-payment', path: `/api/payments/${encodeURIComponent(chargeRef)}/distribute`,
      method: 'POST', idempotencyKey: `reconcile:${chargeRef}`,
      body: { tenant_id: config.projexCloud.tenantId, dry_run: true },
    });
    if (!result.delivered) return { confirmed: false, detail: 'The payment service did not answer.' };
    const status = String(result.data?.data?.status ?? '').toLowerCase();
    return status === 'succeeded' || status === 'paid'
      ? { confirmed: true, detail: `The gateway reports the charge as ${status}.` }
      : { confirmed: false, detail: `The gateway did not confirm the charge (reported ${status || 'nothing'}).` };
  } catch (error) {
    return { confirmed: false, detail: `The gateway probe failed: ${error instanceof Error ? error.message : 'unknown'}` };
  }
}

/* -------------------------------------------------------------- onboarding */

export interface PendingHandoff {
  handoff_id: string; subject_ref: string; paid_at: string;
  accepted_at: string | null; kickoff_at: string | null;
  alerted_at: string | null; exception_reason: string | null;
  exception_owner_user_id: string | null; exception_review_at: string | null;
  hours_since_payment: number;
}

/**
 * Paid licences whose onboarding has not landed.
 *
 * THE CLOCK RUNS FROM VERIFIED PAYMENT, not from the handoff being created —
 * otherwise a handoff nobody creates never starts a clock, which is precisely
 * the "Closed Won incomplete" failure SOP §50 names.
 */
export async function pendingHandoffs(): Promise<PendingHandoff[]> {
  const rows = await dataService.query<PendingHandoff & { hours: string }>(
    `SELECT handoff_id, subject_ref, paid_at, accepted_at, kickoff_at, alerted_at,
            exception_reason, exception_owner_user_id, exception_review_at,
            EXTRACT(EPOCH FROM (now() - paid_at))/3600 AS hours
       FROM leadflow_onboarding_handoff
      WHERE tenant_id = $1 AND (accepted_at IS NULL OR kickoff_at IS NULL)
      ORDER BY paid_at ASC LIMIT 500`,
    [config.projexCloud.tenantId]
  );
  return rows.map((r) => ({ ...r, hours_since_payment: Math.floor(Number(r.hours ?? 0)) }));
}

/** Raise the 24-hour alert, once per handoff. */
export async function alertOverdueHandoff(handoffId: string, subjectRef: string): Promise<boolean> {
  const rows = await dataService.query<{ handoff_id: string }>(
    `UPDATE leadflow_onboarding_handoff SET alerted_at = now()
      WHERE handoff_id = $1 AND alerted_at IS NULL RETURNING handoff_id`,
    [handoffId]
  );
  if (rows.length === 0) return false;
  if (SdkGatewayClient.isConfigured()) {
    try {
      await SdkGatewayClient.call({
        sdk: 'sdk-notification', path: '/api/notifications/send', method: 'POST',
        idempotencyKey: `handoff-overdue:${handoffId}`,
        body: {
          tenant_id: config.projexCloud.tenantId, subject_ref: subjectRef,
          channels: ['in_app', 'email'], template: 'onboarding_handoff_overdue',
          audience: ['client_success', 'sales_manager'],
          body: `A paid licence has had no accepted handoff or booked kickoff for ${KICKOFF_WINDOW_HOURS} hours.`,
        },
      });
    } catch { /* the alerted_at stamp is the durable part */ }
  }
  return true;
}
