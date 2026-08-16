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
  /*
   * Carried so this side can CHECK the scoping rather than trust it. A receipt
   * names the tenant that collected it and the tenant it was collected for, and
   * either one being ours is what makes it ours to display.
   */
  source_tenant_id?: string | null;
  target_tenant_id?: string | null;
}

/** One registered purpose, as sdk-consent's taxonomy returns it. */
export interface PurposeRow {
  purpose_id?: string;
  app_id?: string;
  description?: string | null;
  legal_basis?: string | null;
  category?: string | null;
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

/** One page of the register, and the total it was drawn from. */
export interface ReceiptPage {
  rows: ReceiptRow[];
  /** Receipts this tenant holds in total. Null when upstream did not say. */
  total: number | null;
  /** Rows dropped here because they belonged to another tenant. Should be 0. */
  foreign_dropped: number;
}

/**
 * The receipt register for this tenant.
 *
 * READS THE REGISTER ENDPOINT, NOT THE DSAR EXPORT. This used to call
 * `/api/consents/export` with no person filter, because no tenant-wide list
 * existed — and that export applied no tenant predicate, so the screen rendered
 * OTHER TENANTS' consent receipts as this tenant's own. Verified in production:
 * every row on the register belonged to a different tenant, under a different
 * app. sdk-consent now exposes `/api/consents/receipts`, scoped by the tenant on
 * the credential and reporting the total behind the page, and the export is back
 * to being what its name says — one subject, on request.
 *
 * THE TENANT FILTER BELOW IS A SECOND LOCK ON A DOOR UPSTREAM NOW CLOSES. It is
 * not redundant: this deployment can be pointed at an older gateway, and the
 * failure it guards against is silent, indistinguishable from real data, and
 * legally significant. Anything dropped is COUNTED and reported, because a guard
 * that hides what it caught is a guard nobody can audit.
 */
export async function listReceipts(limit: number): Promise<Reached<ReceiptPage>> {
  const ours = config.projexCloud.tenantId;

  return degradingRead<ReceiptPage>(
    'sdk-consent',
    `/api/consents/receipts?limit=${encodeURIComponent(String(limit))}`,
    { rows: [], total: null, foreign_dropped: 0 },
    (body) => {
      const bag = (body ?? {}) as Record<string, unknown>;
      const all = asArray<ReceiptRow>(body, 'receipts', 'data').slice(0, limit);

      // Only filter when we know who we are. With no configured tenant there is
      // nothing to compare against, and dropping everything would report an
      // empty register — the one answer a consent screen must never invent.
      const rows = ours
        ? all.filter(
            (row) =>
              !row.source_tenant_id ||
              row.source_tenant_id === ours ||
              row.target_tenant_id === ours
          )
        : all;

      const total = typeof bag.total === 'number' ? bag.total : null;
      return { rows, total, foreign_dropped: all.length - rows.length };
    }
  );
}

/**
 * The registered purpose taxonomy.
 *
 * The screen carried a written gap saying "sdk-consent exposes only POST
 * /api/consents/purposes; there is no GET". There is one, and there was — it is
 * in the capability manifest and in the route table. The gap note was the wrong
 * kind of honesty: it stated a limitation confidently enough that nobody
 * rechecked it, and the register went on rendering raw purpose_ids.
 */
export async function listPurposes(): Promise<Reached<PurposeRow[]>> {
  return degradingRead<PurposeRow[]>(
    'sdk-consent',
    '/api/consents/purposes',
    [],
    (body) => asArray<PurposeRow>(body, 'purposes', 'data')
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
