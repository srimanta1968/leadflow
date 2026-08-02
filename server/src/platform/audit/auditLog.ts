import { randomUUID } from 'crypto';
import { config } from '../../config/env';
import { SdkGatewayClient } from '../../services/projexcloud/SdkGatewayClient';
import { AuditEventName } from './vocabulary';

/**
 * Everything a governed action must state about itself.
 *
 * REQUIRED, not optional, and that is the whole design. Each of these fields
 * answers a question an auditor will ask, and a field that may be omitted is a
 * field that will be omitted on exactly the entry that later matters:
 *
 *  - `actor` / `personaRole` — WHO, and in what capacity. The same human acting
 *    as Data Steward and as Sales Rep is two different authorities.
 *  - `purpose` — WHY, from the consent purpose registry. Without it a lawful
 *    basis cannot be shown after the fact.
 *  - `decisionRef` — WHAT PERMITTED IT, joining the write to the PDP verdict.
 *  - `evidenceRef` — WHAT IT RESTS ON, pointing at the stored proof.
 *  - `causationId` — WHAT CAUSED IT, so a chain of consequences is walkable in
 *    both directions rather than being a pile of timestamps.
 *  - `idempotencyRef` — so a retry is recognisable as the same act, and a
 *    replayed request does not read as the operator doing it twice.
 */
export interface AuditEntry {
  event: AuditEventName;
  /** Person or service that acted. */
  actor: string;
  /** The role they were acting through. */
  personaRole: string;
  /** Consent purpose key this action was taken under. */
  purpose: string;
  /** PDP decision reference that authorised it. */
  decisionRef: string;
  /** Pointer to the evidence the action rests on. */
  evidenceRef: string;
  /** The event that caused this one. */
  causationId: string;
  /** Stable key identifying this act, so a retry is not a second act. */
  idempotencyRef: string;
  /** What was acted upon. */
  subjectId?: string;
  subjectType?: string;
  /** Anything else worth keeping, none of it load-bearing. */
  metadata?: Record<string, unknown>;
}

export interface AuditAppendResult {
  /** False when no gateway is configured and the entry was only logged. */
  delivered: boolean;
  /** The entry's own id, for correlating a later reversal. */
  entryRef: string;
}

/**
 * Append one entry to the tamper-evident chain.
 *
 * NEVER THROWS. A governed action must not fail because the ledger was briefly
 * unreachable — the write has already happened, and refusing it afterwards
 * would leave the system in a state the caller was told did not occur. The
 * failure is logged loudly instead, and the nightly verification is what
 * catches a gap nobody noticed at the time.
 *
 * That is a real trade and worth naming: it means an outage can produce an
 * action with no entry. The alternative — fail the action because the audit
 * failed — trades a missing record for a broken product, and the missing record
 * is the recoverable one.
 */
export async function appendAuditEntry(entry: AuditEntry): Promise<AuditAppendResult> {
  const entryRef = `aud_${randomUUID()}`;

  if (!SdkGatewayClient.isConfigured()) {
    return { delivered: false, entryRef };
  }

  try {
    await SdkGatewayClient.call({
      sdk: 'sdk-audit',
      path: '/v1/audit/append',
      method: 'POST',
      // The act's own key, so a retried append lands once.
      idempotencyKey: entry.idempotencyRef,
      correlationId: entry.causationId,
      body: {
        tenant_id: config.projexCloud.tenantId,
        event_type: entry.event,
        actor_id: entry.actor,
        persona_role: entry.personaRole,
        purpose: entry.purpose,
        decision_ref: entry.decisionRef,
        evidence_ref: entry.evidenceRef,
        causation_id: entry.causationId,
        idempotency_ref: entry.idempotencyRef,
        entry_ref: entryRef,
        subject_id: entry.subjectId ?? null,
        subject_type: entry.subjectType ?? null,
        metadata: entry.metadata ?? {},
      },
    });

    return { delivered: true, entryRef };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Loud, and structured enough to reconstruct the entry by hand if it ever
    // comes to that.
    console.error(
      `[audit] FAILED TO APPEND ${entry.event} (actor=${entry.actor} ref=${entry.idempotencyRef}):`,
      message
    );
    return { delivered: false, entryRef };
  }
}

export interface ChainVerificationResult {
  attempted: boolean;
  intact: boolean;
  /** Set when the chain did not verify. */
  detail?: string;
  /** Reference of the incident opened, when one was. */
  incidentRef?: string;
}

/**
 * Verify the audit chain, and open an incident if it does not hold.
 *
 * Run nightly rather than per-write: verification walks the chain, so doing it
 * on every append would make the ledger quadratic in its own length. Nightly is
 * the compromise between that and only discovering tampering when somebody
 * happens to look.
 *
 * A FAILED VERIFICATION RAISES AN INCIDENT rather than only logging. A broken
 * hash chain is not a warning — either something rewrote history or the ledger
 * is corrupt, and both need a person. A log line would sit unread among the
 * successes.
 */
export async function verifyAuditChain(): Promise<ChainVerificationResult> {
  if (!SdkGatewayClient.isConfigured()) {
    return { attempted: false, intact: false, detail: 'No ProjexCloud gateway configured' };
  }

  const correlationId = randomUUID();

  try {
    const result = await SdkGatewayClient.call<{ data?: { intact?: boolean; detail?: string } }>({
      sdk: 'sdk-audit',
      path: '/v1/audit/verify',
      method: 'POST',
      correlationId,
      body: { tenant_id: config.projexCloud.tenantId },
    });

    const intact = result.data?.data?.intact === true;
    if (intact) {
      return { attempted: true, intact: true };
    }

    const detail = result.data?.data?.detail ?? 'The audit chain did not verify.';
    const incidentRef = await openChainIncident(detail, correlationId);
    return { attempted: true, intact: false, detail, incidentRef };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[audit] chain verification could not run:', message);
    // An unreachable verifier is NOT a verified chain. Reported as not-intact so
    // a silent outage cannot masquerade as a clean bill of health.
    return { attempted: true, intact: false, detail: `Verification unavailable: ${message}` };
  }
}

/** Raise an incident for a chain that did not verify. */
async function openChainIncident(detail: string, correlationId: string): Promise<string | undefined> {
  try {
    const result = await SdkGatewayClient.call<{ data?: { incident_id?: string } }>({
      sdk: 'sdk-incident',
      path: '/v1/incidents',
      method: 'POST',
      idempotencyKey: `audit-chain:${correlationId}`,
      correlationId,
      body: {
        tenant_id: config.projexCloud.tenantId,
        kind: 'audit_chain_mismatch',
        severity: 'critical',
        summary: 'LeadFlow audit chain failed verification',
        detail,
      },
    });
    return result.data?.data?.incident_id;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The chain is broken AND we could not raise the alarm — the worst case, and
    // the one that most needs to be shouted at whoever reads the logs.
    console.error('[audit] CHAIN MISMATCH AND INCIDENT COULD NOT BE OPENED:', message);
    return undefined;
  }
}
