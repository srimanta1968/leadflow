import { randomUUID } from 'crypto';
import { config } from '../../config/env';
import { SdkGatewayClient } from '../../services/projexcloud/SdkGatewayClient';
import { AUDIT_EVENTS } from '../audit/vocabulary';
import { appendAuditEntry } from '../audit/auditLog';

/** Who is revealing a value, and under what authority. */
export interface RevealContext {
  actor: string;
  personaRole: string;
  /** Consent purpose the reveal is taken under. */
  purpose: string;
  /** PDP decision that permitted it. */
  decisionRef: string;
  /** The subject whose data is being revealed. */
  subjectId: string;
  /** What caused the reveal — the request or action that needed it. */
  causationId: string;
}

export interface RevealResult {
  /** Null when the value could not be decrypted. */
  value: string | null;
  /** Reference of the audit entry that recorded the reveal. */
  auditRef: string;
}

/**
 * Encrypt a personal value through sdk-vault.
 *
 * Encryption is NOT audited. Storing a value the subject gave us is ordinary
 * processing; auditing every write would bury the entries that matter under
 * noise. Reading it back is the sensitive act, because that is when a human
 * sees it.
 */
export async function encryptPii(plaintext: string, subjectId: string): Promise<string | null> {
  if (!SdkGatewayClient.isConfigured()) {
    return null;
  }

  try {
    const result = await SdkGatewayClient.call<{ data?: { ciphertext?: string } }>({
      sdk: 'sdk-vault',
      path: '/api/vault/encrypt',
      method: 'POST',
      idempotencyKey: `encrypt:${subjectId}:${plaintext.length}`,
      body: { tenant_id: config.projexCloud.tenantId, subject_id: subjectId, plaintext },
    });
    return result.data?.data?.ciphertext ?? null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[piiVault] encrypt failed:', message);
    return null;
  }
}

/**
 * Decrypt a personal value, recording WHO looked and WHY.
 *
 * THE AUDIT ENTRY IS WRITTEN FIRST, BEFORE the plaintext is returned. That
 * ordering is the whole guarantee: if the append is attempted after the reveal,
 * a crash between the two leaves a value on someone's screen with no record
 * that they saw it, and the one case where that matters is exactly the case
 * somebody is investigating. Writing first can produce an entry for a reveal
 * that then failed — an over-recorded look, which is the harmless direction.
 *
 * Every field of the entry is already required by AuditEntry, so a reveal
 * cannot be recorded without naming the actor, the purpose and the decision
 * that permitted it.
 */
export async function revealPii(
  ciphertext: string,
  context: RevealContext
): Promise<RevealResult> {
  const idempotencyRef = `reveal:${context.subjectId}:${randomUUID()}`;

  const audit = await appendAuditEntry({
    event: AUDIT_EVENTS.PII_REVEALED,
    actor: context.actor,
    personaRole: context.personaRole,
    purpose: context.purpose,
    decisionRef: context.decisionRef,
    // The ciphertext itself is the evidence pointer. The PLAINTEXT never
    // appears in an audit entry — an audit trail that quotes the value it is
    // protecting is a second copy of the thing.
    evidenceRef: `vault:${ciphertext.slice(0, 12)}`,
    causationId: context.causationId,
    idempotencyRef,
    subjectId: context.subjectId,
    subjectType: 'person',
  });

  if (!SdkGatewayClient.isConfigured()) {
    return { value: null, auditRef: audit.entryRef };
  }

  try {
    const result = await SdkGatewayClient.call<{ data?: { plaintext?: string } }>({
      sdk: 'sdk-vault',
      path: '/api/vault/decrypt',
      method: 'POST',
      correlationId: context.causationId,
      body: { tenant_id: config.projexCloud.tenantId, ciphertext },
    });
    return { value: result.data?.data?.plaintext ?? null, auditRef: audit.entryRef };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Not logged with the ciphertext or any part of the value.
    console.error(`[piiVault] decrypt failed for subject ${context.subjectId}:`, message);
    return { value: null, auditRef: audit.entryRef };
  }
}

/**
 * Rotate a vault key without downtime.
 *
 * sdk-vault re-wraps under the new key while keeping the previous one able to
 * DECRYPT, so values encrypted a moment before rotation still read. That is the
 * same shape as the JWKS rotation in platform/auth: the incoming key takes over
 * new work while the outgoing one keeps serving what is already in flight, and
 * a rotation that cannot do that is an outage with extra steps.
 */
export async function rotateVaultKey(keyId: string): Promise<boolean> {
  if (!SdkGatewayClient.isConfigured()) {
    return false;
  }

  try {
    await SdkGatewayClient.call({
      sdk: 'sdk-vault',
      path: `/api/vault/keys/${encodeURIComponent(keyId)}/rotate`,
      method: 'POST',
      idempotencyKey: `vault-rotate:${keyId}:${new Date().toISOString().slice(0, 10)}`,
      body: { tenant_id: config.projexCloud.tenantId },
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[piiVault] key rotation failed for ${keyId}:`, message);
    return false;
  }
}
