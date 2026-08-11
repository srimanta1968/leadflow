import { degradingRead, unreachable, type Reached } from '../../platform/sdkGateway/degradingRead';
import { SdkGatewayClient } from '../../platform/sdkGateway';
import { config } from '../../config/env';

/**
 * Typed reads of sdk-data-credits' tenant-facing surface.
 *
 * EVERY SHAPE BELOW WAS TAKEN FROM THE HANDLER, not from a manifest. The four
 * routes used here are declared in `packages/sdk-data-credits/src/server/routes.ts`
 * and their projections are built field-by-field in `brokerService.ts` and
 * `reservationService.ts`; those files are the contract.
 *
 * NOTHING IN THIS FILE CAN CARRY A VENDOR. That is not a convention here, it is
 * a property of what upstream returns: sdk-data-credits builds its tenant views
 * by NAMING fields rather than spreading rows, so `provider_binding` and
 * `provider_attempt` are not reachable through any route below. The interfaces
 * are written out in full for the same reason — an `unknown` passthrough or an
 * index signature would let a field added upstream flow to the browser without
 * anybody choosing it, which is exactly how an opacity guarantee decays.
 */

/** One catalog entry, as `CapabilityView` returns it: outcome and price only. */
export interface CapabilityRow {
  key?: string;
  outcome_label?: string;
  description?: string | null;
  credit_price?: number;
  category?: string | null;
}

/**
 * One row of the request register.
 *
 * The three optional fields at the bottom are NOT in the list projection today.
 * They are read defensively because the POST accepts `requested_by_persona_id`
 * and `metadata`, so the columns the mockup asks for light up the moment
 * upstream projects them — and until then they read as absent rather than as
 * empty, which is the distinction `field_gaps` carries to the screen.
 */
export interface CapabilityRequestRow {
  request_id?: string;
  capability_key?: string;
  status?: string;
  outcome?: string | null;
  served_from_cache?: boolean;
  credits_reserved?: number;
  credits_charged?: number;
  created_at?: string;
  /** Present only once upstream widens the list projection. See field_gaps. */
  requested_by_persona_id?: string | null;
  subject_label?: string | null;
  metadata?: { purpose?: string | null; contact_label?: string | null } | null;
}

/** The credit account, as `BalanceView` returns it. */
export interface BalanceRow {
  balance?: number;
  reserved?: number;
  available?: number;
}

/**
 * One credit-ledger entry.
 *
 * READ FOR ONE FIELD: `reason`. A refusal writes a RELEASE entry carrying the
 * reason the approver gave, and `rejectRequest` REFUSES a reason-less refusal,
 * so that string is guaranteed to exist for every denied request. It is the only
 * tenant-readable source for the Explain action, and quoting it beats composing
 * a sentence in the UI that would read as authoritative while agreeing with
 * nothing.
 */
export interface LedgerEntryRow {
  entry_no?: number;
  entry_type?: string;
  request_id?: string | null;
  reason?: string | null;
  created_at?: string;
}

const SDK = 'sdk-data-credits';

/** Pulls a named array out of the upstream `data` envelope. */
const asArray = <T>(body: unknown, key: string): T[] => {
  const bag = (body ?? {}) as Record<string, unknown>;
  const raw = bag[key];
  return Array.isArray(raw) ? (raw as T[]) : [];
};

/** The capability catalog the tenant is entitled to. */
export async function listCapabilities(): Promise<Reached<CapabilityRow[]>> {
  return degradingRead<CapabilityRow[]>(SDK, '/api/capabilities', [], (body) =>
    asArray<CapabilityRow>(body, 'capabilities')
  );
}

/**
 * The request register, newest first.
 *
 * THE STATUS FILTER IS NOT PASSED UPSTREAM even though the route accepts one,
 * and that is deliberate. Upstream filters on its own six-state vocabulary; this
 * screen filters on the four words it is allowed to say, and two of them span
 * several upstream states (Processing covers APPROVED and EXECUTING; Blocked
 * covers REJECTED and FAILED). Translating the filter into a single upstream
 * status would silently drop half of each segment. The whole window is read and
 * narrowed here, where the mapping is stated once.
 *
 * @param limit Upstream clamps to 500 itself.
 */
export async function listCapabilityRequests(limit: number): Promise<Reached<CapabilityRequestRow[]>> {
  return degradingRead<CapabilityRequestRow[]>(
    SDK,
    `/api/capability-requests?limit=${encodeURIComponent(String(limit))}`,
    [],
    (body) => asArray<CapabilityRequestRow>(body, 'requests')
  );
}

/**
 * The credit account.
 *
 * A tenant with no provisioned account gets a 404 from upstream, which
 * `degradingRead` correctly reports as ANSWERED and empty rather than as an
 * outage — "you have no credit account" is the service working. The caller
 * distinguishes the two by `available`, which stays null in both cases while
 * `upstream_available.balance` says which happened.
 */
export async function readBalance(): Promise<Reached<BalanceRow | null>> {
  return degradingRead<BalanceRow | null>(SDK, '/api/credits/balance', null, (body) => {
    const bag = (body ?? {}) as BalanceRow;
    return typeof bag === 'object' && bag !== null ? bag : null;
  });
}

/**
 * Recent ledger entries, for the refusal reasons alone.
 *
 * @param limit How far back to look for RELEASE entries. Upstream clamps to 1000.
 */
export async function listLedgerEntries(limit: number): Promise<Reached<LedgerEntryRow[]>> {
  return degradingRead<LedgerEntryRow[]>(
    SDK,
    `/api/credits/ledger?limit=${encodeURIComponent(String(limit))}`,
    [],
    (body) => asArray<LedgerEntryRow>(body, 'entries')
  );
}

/**
 * A write-side gateway call that reports unreachability instead of throwing.
 *
 * SdkGatewayClient.call RAISES when it cannot obtain a credential or the circuit
 * is open. For a READ that is what `degradingRead` absorbs; for these WRITES it
 * would surface as a 502 from the enrichment modal - which is exactly the
 * opposite of the contract those endpoints state. The eligibility callout
 * promises to degrade to `review` rather than fail, and Reserve & Run must be
 * able to say "the credits could not be held" rather than returning a generic
 * upstream error the operator cannot act on.
 */
async function callOrUnreached<T>(
  options: Parameters<typeof SdkGatewayClient.call>[0],
): Promise<{ delivered: boolean; data: T | null }> {
  try {
    const res = await SdkGatewayClient.call<T>(options);
    return { delivered: res.delivered, data: res.data };
  } catch {
    return { delivered: false, data: null };
  }
}

/**
 * Ask sdk-policy whether this request is eligible, for the LIVE verdict callout.
 *
 * READ-ONLY AND CHEAP, because the modal re-asks it every time the operator
 * ticks a capability or changes the business reason. Reserving credits to find
 * out whether you are allowed to reserve them would charge the tenant for
 * changing their mind.
 */
export async function evaluateEligibility(input: {
  capabilityKeys: string[];
  purposeKey: string;
  roleRef: string;
  subjectRef: string;
}): Promise<Reached<{ effect?: string; reason?: string } | null>> {
  const result = await callOrUnreached<{ data?: { effect?: string; reason?: string } }>({
    sdk: 'sdk-policy',
    path: '/api/policies/evaluate',
    method: 'POST',
    body: {
      tenant_id: config.projexCloud.tenantId,
      subject_id: input.subjectRef,
      action: 'enrichment.capability.request',
      resource: { type: 'contact', id: input.subjectRef },
      context: {
        capability_keys: input.capabilityKeys,
        purpose_key: input.purposeKey,
        role_ref: input.roleRef,
      },
    },
  });
  if (!result.delivered) return unreachable(null);
  return { value: result.data?.data ?? null, available: true };
}

/**
 * Hold the credits for a run, through the brokered lane.
 *
 * THE FINGERPRINT, NEVER THE RAW SUBJECT. sdk-data-credits takes a
 * subject_fingerprint precisely so that a table of everything every tenant ever
 * looked up cannot accumulate upstream, and sending the raw value would defeat
 * that from our side.
 */
export async function reserveCapabilityRequest(input: {
  capabilityKey: string;
  subjectFingerprint: string;
  roleRef: string;
  requestedByPersonaId?: string;
  metadata?: Record<string, unknown>;
}): Promise<Reached<{ request_id?: string; estimated_credits?: number } | null>> {
  const result = await callOrUnreached<{
    data?: { request_id?: string; estimated_credits?: number };
  }>({
    sdk: 'sdk-data-credits',
    path: '/api/capability-requests',
    method: 'POST',
    idempotencyKey: `enrich:${input.subjectFingerprint}:${input.capabilityKey}`,
    body: {
      tenant_id: config.projexCloud.tenantId,
      capability_key: input.capabilityKey,
      subject_fingerprint: input.subjectFingerprint,
      role_ref: input.roleRef,
      requested_by_persona_id: input.requestedByPersonaId,
      metadata: input.metadata,
    },
  });
  if (!result.delivered) return unreachable(null);
  return { value: result.data?.data ?? null, available: true };
}

/** Run a held request. 409 upstream when an approval is still outstanding. */
export async function executeCapabilityRequest(
  requestId: string,
  subject: unknown,
): Promise<Reached<Record<string, unknown> | null>> {
  const result = await callOrUnreached<{ data?: Record<string, unknown> }>({
    sdk: 'sdk-data-credits',
    path: `/api/capability-requests/${encodeURIComponent(requestId)}/execute`,
    method: 'POST',
    idempotencyKey: `enrich-exec:${requestId}`,
    body: { tenant_id: config.projexCloud.tenantId, subject },
  });
  if (!result.delivered) return unreachable(null);
  return { value: result.data?.data ?? null, available: true };
}

/** Raise the approval a request-only tier requires before anything runs. */
export async function requestApproval(input: {
  requestId: string;
  roleRef: string;
  reason: string;
  estimatedCredits: number;
}): Promise<Reached<{ approval_id?: string } | null>> {
  const result = await callOrUnreached<{ data?: { approval_id?: string } }>({
    sdk: 'sdk-approval',
    path: '/api/approvals/requests',
    method: 'POST',
    idempotencyKey: `enrich-approval:${input.requestId}`,
    body: {
      tenant_id: config.projexCloud.tenantId,
      subject_ref: input.requestId,
      kind: 'data_credit_spend',
      reason: input.reason,
      metadata: { role_ref: input.roleRef, estimated_credits: input.estimatedCredits },
    },
  });
  if (!result.delivered) return unreachable(null);
  return { value: result.data?.data ?? null, available: true };
}
