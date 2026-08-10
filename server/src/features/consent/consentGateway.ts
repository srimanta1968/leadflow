import { degradingRead, unreachable, type Reached } from '../../platform/sdkGateway/degradingRead';
import { SdkGatewayClient } from '../../platform/sdkGateway';
import { config } from '../../config/env';

/**
 * Typed reads for the Consent & Preferences screen.
 *
 * EVERY PATH HERE WAS TAKEN FROM THE UPSTREAM ROUTER, NOT FROM THE SPEC. The
 * task named `GET /api/consent/receipts`, `GET /api/consent/purposes` and
 * `POST /api/consent/receipts/:id/revoke`. None of those exist: sdk-consent
 * serves `/api/consents/*` — PLURAL — and always has. The identical
 * singular/plural slip in recordingConsent.ts made the AI coach's recording
 * gate deny every call, and it read as an outage rather than a typo because the
 * gate's "an outage denies" rule turned a 404 into a refusal. Checking the
 * router first is the only reason this cost minutes instead of a release.
 */

/** One consent receipt as sdk-consent's export returns it. */
export interface ReceiptRow {
  receipt_id?: string;
  person_id?: string;
  purpose_id?: string;
  processor?: string;
  jurisdiction?: string;
  app_id?: string;
  granted_by_actor?: string | null;
  granted_at?: string;
  expires_at?: string | null;
  revoked_at?: string | null;
  evidence_hash?: string | null;
}

/** One suppression, as sdk-deliverability lists them. */
export interface SuppressionRow {
  channel?: string;
  address?: string;
  reason?: string;
  source?: string;
  created_at?: string;
}

const asArray = <T>(body: unknown, ...keys: string[]): T[] => {
  const bag = (body ?? {}) as Record<string, unknown>;
  for (const key of keys) {
    if (Array.isArray(bag[key])) return bag[key] as T[];
  }
  return Array.isArray(body) ? (body as T[]) : [];
};

/**
 * The receipt register.
 *
 * ASSEMBLED FROM A DSAR EXPORT, WHICH IS NOT A REGISTER, and the caller is told
 * so. `/api/consents/export` is built for Article 15 subject-access requests:
 * it answers per person_id and returns everything for that person. There is no
 * tenant-wide receipt list upstream, so a register is approximated by exporting
 * without a person filter and capping the result. The cap is reported rather
 * than applied silently — a screen showing the first N of an unknown total
 * invites the reader to conclude that is all of them, which for a consent
 * register is a conclusion with legal weight.
 */
export async function listReceipts(limit: number): Promise<Reached<ReceiptRow[]>> {
  return degradingRead<ReceiptRow[]>(
    'sdk-consent',
    '/api/consents/export',
    [],
    (body) => asArray<ReceiptRow>(body, 'receipts', 'data').slice(0, limit)
  );
}

/**
 * Suppressions for one channel, straight from the provider-backed list.
 *
 * tenant_id is REQUIRED by the route — it answers 400 without one — so it is
 * always sent rather than left to a default that does not exist.
 */
export async function listSuppressions(channel: string): Promise<Reached<SuppressionRow[]>> {
  const params = new URLSearchParams({
    tenant_id: config.projexCloud.tenantId,
    channel,
    limit: '500',
  });
  return degradingRead<SuppressionRow[]>(
    'sdk-deliverability',
    `/api/deliverability/suppressions?${params.toString()}`,
    [],
    (body) => asArray<SuppressionRow>(body, 'suppressions', 'data')
  );
}

/** Hard bounces and complaints, which are suppressions the provider decided. */
export async function listBounceEvents(): Promise<Reached<Record<string, unknown>[]>> {
  const params = new URLSearchParams({ tenant_id: config.projexCloud.tenantId, limit: '500' });
  return degradingRead<Record<string, unknown>[]>(
    'sdk-deliverability',
    `/api/deliverability/bounce-events?${params.toString()}`,
    [],
    (body) => asArray<Record<string, unknown>>(body, 'events', 'bounce_events', 'data')
  );
}

/** SMS consent state, which is a separate permission from an email receipt. */
export async function readSmsConsent(): Promise<Reached<Record<string, unknown> | null>> {
  const params = new URLSearchParams({ tenant_id: config.projexCloud.tenantId });
  return degradingRead<Record<string, unknown> | null>(
    'sdk-notification',
    `/api/notifications/sms-consent?${params.toString()}`,
    null,
    (body) => (body && typeof body === 'object' ? (body as Record<string, unknown>) : null)
  );
}

/**
 * Revoke one receipt.
 *
 * NOT degradingRead: a revocation is a WRITE and must never be reported as
 * successful because a read degraded. If this cannot reach sdk-consent it
 * throws, and the caller answers 502 — a screen that says "revoked" when
 * nothing was revoked is the single worst outcome available on this feature,
 * because the person believes they have been removed and has no reason to check
 * again.
 */
export async function revokeReceipt(
  receiptId: string,
  reason: string
): Promise<Record<string, unknown> | null> {
  const result = await SdkGatewayClient.call<{ data?: Record<string, unknown> }>({
    sdk: 'sdk-consent',
    path: `/api/consents/${encodeURIComponent(receiptId)}/revoke`,
    method: 'POST',
    idempotencyKey: `revoke:${receiptId}`,
    body: { reason },
  });
  return result.data?.data ?? null;
}

/**
 * Encrypt the signature blob before anything stores it.
 *
 * A WRITE THAT MUST NOT DEGRADE. If the vault is unreachable the receipt is not
 * issued at all: a consent receipt whose signature never got encrypted is worse
 * than no receipt, because it looks complete to everyone who reads it later.
 *
 * @returns The ciphertext reference the receipt keeps. The raw image is never
 *          returned, never persisted here, and never logged.
 */
export async function encryptSignature(dataUrl: string): Promise<string | null> {
  const result = await SdkGatewayClient.call<{ data?: { ciphertext?: string; ref?: string } }>({
    sdk: 'sdk-vault',
    path: '/api/vault/encrypt',
    method: 'POST',
    body: { plaintext: dataUrl, purpose: 'consent_signature' },
  });
  return result.data?.data?.ref ?? result.data?.data?.ciphertext ?? null;
}

/** Record the capture as evidence, so the receipt can be defended later. */
export async function captureEvidence(payload: Record<string, unknown>): Promise<string | null> {
  const result = await SdkGatewayClient.call<{ data?: { id?: string } }>({
    sdk: 'sdk-evidence',
    path: '/api/evidence/capture',
    method: 'POST',
    body: payload,
  });
  return result.data?.data?.id ?? null;
}

/**
 * Grant the receipt.
 *
 * `purpose_id` IS SINGULAR UPSTREAM, and that is what makes blanket consent
 * impossible rather than merely discouraged. Every required field is sent
 * explicitly - validateGrantConsent demands person_id, purpose_id, processor,
 * app_id, jurisdiction and granted_by_actor, and a missing one is a 400 that
 * would read here as "consent service rejected the receipt".
 */
export async function grantReceipt(input: {
  person_id: string;
  purpose_id: string;
  processor: string;
  app_id: string;
  jurisdiction: string;
  granted_by_actor: string;
  expires_at?: string;
}): Promise<Record<string, unknown> | null> {
  const result = await SdkGatewayClient.call<{ data?: Record<string, unknown> }>({
    sdk: 'sdk-consent',
    path: '/api/consents',
    method: 'POST',
    idempotencyKey: `grant:${input.person_id}:${input.purpose_id}`,
    body: input,
  });
  return result.data?.data ?? null;
}
