import { randomUUID } from 'crypto';
import { SdkGatewayClient } from '../../platform/sdkGateway';
import { currentTenantContext, tenantIdFor } from '../tenancy/tenantHierarchy';
import { AuditEventName } from './vocabulary';

/**
 * The tenant an audit entry belongs to.
 *
 * APP-scoped, not customer-scoped, and that is a deliberate choice: a ledger
 * shared across a customer's apps would let one app's operator read another
 * app's activity. The chain follows the records it describes.
 */
function auditTenantId(): string {
  return tenantIdFor(currentTenantContext(), 'audit');
}

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
      path: '/api/audit/append',
      method: 'POST',
      // The act's own key, so a retried append lands once.
      idempotencyKey: entry.idempotencyRef,
      correlationId: entry.causationId,
      // sdk-audit's shape, not LeadFlow's. The previous body was flat and was
      // rejected 400 with "pool_index is required, payload is required" on every
      // append — and because this function never throws by design, every one of
      // those failures was a console line nobody read. The ledger was empty
      // while the app reported governed actions as recorded.
      body: {
        // The chain this entry belongs to, and what `verify` walks. Scoped to
        // the app tenant so one app's operator cannot read another's activity.
        pool_index: auditTenantId(),
        event_type: entry.event,
        tenant_id: auditTenantId(),
        // The seven stamps travel inside `payload`, which is the SDK's opaque
        // body. They stay REQUIRED on AuditEntry — the point was never which
        // envelope carries them, it is that no governed action can omit them.
        payload: {
          actor_id: entry.actor,
          persona_role: entry.personaRole,
          purpose: entry.purpose,
          decision_ref: entry.decisionRef,
          evidence_ref: entry.evidenceRef,
          causation_id: entry.causationId,
          idempotency_ref: entry.idempotencyRef,
          entry_ref: entryRef,
          metadata: entry.metadata ?? {},
        },
        // 'human' rather than 'service' or 'agent'. These entries record what a
        // PERSON did through LeadFlow; even a scheduled sweep is attributed to
        // the persona that configured it, so 'service' would lose the human who
        // is actually answerable. The vocabulary is sdk-audit's — human,
        // service, agent — and 'person' is rejected.
        actor_kind: 'human',
        subject_kind: entry.subjectType ?? undefined,
        subject_id: entry.subjectId ?? undefined,
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
  /**
   * How many entries the verifier actually walked.
   *
   * REPORTED BECAUSE "INTACT" ALONE IS AMBIGUOUS. An empty chain verifies
   * perfectly — there is nothing in it to be inconsistent — so `ok: true` with
   * `entries_checked: 0` means "nothing was ever accepted", which is the
   * WORST case dressed as the best. That is precisely how the unversioned
   * event-type names hid: sdk-audit rejected every append with a 400, the
   * append swallows failures by design, and the nightly verification kept
   * reporting a clean chain that was clean because it was empty.
   */
  entriesChecked: number;
  /** Set when the chain did not verify. */
  detail?: string;
  /** Sequence number the chain broke at, when it broke. */
  breakAtSeq?: number | null;
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
 *
 * THE RESPONSE FIELD IS `ok`, NOT `intact`. This read `intact` — a field
 * sdk-audit has never returned — so the check was `undefined === true`, false on
 * every run, and the nightly verification opened a CRITICAL "chain mismatch"
 * incident every single night against a chain that was fine. An alarm that
 * always fires is an alarm nobody reads, which would have made a genuine
 * mismatch invisible in exactly the pile of false ones this created. The real
 * shape is sdk-audit's VerifyProof: ok, entries_checked, break_at_seq,
 * break_reason.
 */
export async function verifyAuditChain(): Promise<ChainVerificationResult> {
  if (!SdkGatewayClient.isConfigured()) {
    return {
      attempted: false,
      intact: false,
      entriesChecked: 0,
      detail: 'No ProjexCloud gateway configured',
    };
  }

  const correlationId = randomUUID();

  try {
    const result = await SdkGatewayClient.call<{
      data?: {
        ok?: boolean;
        entries_checked?: number;
        break_at_seq?: number | null;
        break_reason?: string | null;
      };
    }>({
      sdk: 'sdk-audit',
      path: '/api/audit/verify',
      method: 'POST',
      correlationId,
      // `verify` walks one pool; it is the same pool the appends above write to.
      body: { pool_index: auditTenantId(), tenant_id: auditTenantId() },
    });

    const proof = result.data?.data;
    const entriesChecked = proof?.entries_checked ?? 0;
    // `=== true`, so a malformed response reads as NOT verified rather than
    // letting a missing field pass as a clean chain — the mistake this function
    // has been making in the other direction.
    const ok = proof?.ok === true;

    if (ok && entriesChecked > 0) {
      return { attempted: true, intact: true, entriesChecked };
    }

    if (ok && entriesChecked === 0) {
      // VERIFIED AND EMPTY. Not an incident — nothing is corrupt — but not a
      // pass either: a ledger with no entries means nothing was ever accepted,
      // and reporting that as intact is what let a whole rejected vocabulary go
      // unnoticed. Surfaced as not-intact with the reason named.
      return {
        attempted: true,
        intact: false,
        entriesChecked: 0,
        detail:
          'The audit chain verified, but it is EMPTY — no entries have ever been accepted. Check that the event types are registered and that appends are not being rejected.',
      };
    }

    const detail = proof?.break_reason
      ? `The audit chain broke at sequence ${proof.break_at_seq ?? 'unknown'}: ${proof.break_reason}`
      : 'The audit chain did not verify.';
    const incidentRef = await openChainIncident(detail, correlationId);
    return {
      attempted: true,
      intact: false,
      entriesChecked,
      detail,
      breakAtSeq: proof?.break_at_seq ?? null,
      incidentRef,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[audit] chain verification could not run:', message);
    // An unreachable verifier is NOT a verified chain. Reported as not-intact so
    // a silent outage cannot masquerade as a clean bill of health.
    return {
      attempted: true,
      intact: false,
      entriesChecked: 0,
      detail: `Verification unavailable: ${message}`,
    };
  }
}

/** Raise an incident for a chain that did not verify. */
async function openChainIncident(detail: string, correlationId: string): Promise<string | undefined> {
  try {
    const result = await SdkGatewayClient.call<{ data?: { incident_id?: string } }>({
      sdk: 'sdk-incident',
      path: '/api/incidents',
      method: 'POST',
      idempotencyKey: `audit-chain:${correlationId}`,
      correlationId,
      body: {
        tenant_id: auditTenantId(),
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
