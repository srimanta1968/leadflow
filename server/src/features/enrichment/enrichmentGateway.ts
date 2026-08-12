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

/* ------------------------------------------------- result write-back (#91) */

/**
 * Settle a held reservation against how the lookup actually ended.
 *
 * THE OUTCOME IS PASSED THROUGH VERBATIM rather than being reduced to a boolean.
 * Upstream charges on MATCHED and nothing else, but it also RECORDS which of the
 * three free outcomes occurred, and that distinction is the difference between a
 * bad provider, a bad question and our own cache working. A caller that sent
 * `charged: false` would settle the credits correctly and destroy the report.
 */
export async function settleReservation(
  reservationId: string,
  outcome: 'MATCHED' | 'NO_MATCH' | 'TECHNICAL_FAILURE' | 'CACHE_HIT',
  result: unknown,
): Promise<Reached<Record<string, unknown> | null>> {
  const call = await callOrUnreached<{ data?: Record<string, unknown> }>({
    sdk: 'sdk-data-credits',
    path: `/api/credits/reservations/${encodeURIComponent(reservationId)}/settle`,
    method: 'POST',
    // Keyed on the reservation, so a retry after a timeout settles once. Settling
    // twice would charge twice for one answer.
    idempotencyKey: `enrich-settle:${reservationId}`,
    body: { tenant_id: config.projexCloud.tenantId, outcome, result: result ?? null },
  });
  if (!call.delivered) return unreachable(null);
  return { value: call.data?.data ?? null, available: true };
}

/**
 * Write one enrichment answer back as provenance.
 *
 * `status` is the caller's, and every caller in this feature passes 'ASSERTION'.
 * It is not defaulted here: a default would make the safe value invisible at the
 * call site, and the one thing a reader of that call site must be able to see is
 * that nothing bought is being written as operational.
 */
export async function writeSourceAssertion(input: {
  subjectRef: string;
  attribute: string;
  value: string;
  originClass: string;
  confidence: number | null;
  status: 'ASSERTION' | 'PRIMARY';
  actorId: string;
  metadata?: Record<string, unknown>;
}): Promise<Reached<{ assertion_id?: string } | null>> {
  const call = await callOrUnreached<{ data?: { assertion?: { assertion_id?: string } } }>({
    sdk: 'sdk-source-record',
    path: '/api/source-assertions',
    method: 'POST',
    idempotencyKey: `enrich-assert:${input.subjectRef}:${input.attribute}:${input.value}`,
    body: {
      tenant_id: config.projexCloud.tenantId,
      subject_ref: input.subjectRef,
      attribute: input.attribute,
      value: input.value,
      origin_class: input.originClass,
      // Omitted rather than sent as 0 when the provider scored nothing: 0 means
      // "we checked and it is worthless", which is a different claim from
      // "nobody scored it" and the one nothing here is entitled to make.
      ...(input.confidence === null ? {} : { confidence: input.confidence }),
      status: input.status,
      is_pii: input.attribute === 'phone' || input.attribute === 'email',
      retrieved_at: new Date().toISOString(),
      actor_id: input.actorId,
      purpose: 'lead_management',
      metadata: input.metadata,
    },
  });
  if (!call.delivered) return unreachable(null);
  return { value: call.data?.data?.assertion ?? null, available: true };
}

/**
 * Promote a confirmed candidate by superseding it with a PRIMARY assertion.
 *
 * THE PRIOR ROW IS RETAINED, NEVER DELETED — that is what `supersede` does and
 * why it is used instead of an update. What the system believed before a steward
 * confirmed it is exactly the thing an audit asks about afterwards.
 *
 * ORIGIN CLASS AND CONFIDENCE ARE CARRIED THROUGH UNCHANGED. Confirming that a
 * number is the right number says nothing about where it came from, and
 * rewriting LICENSED_THIRD_PARTY to something warmer on confirmation would
 * launder bought data into first-party evidence with one click.
 */
export async function promoteAssertion(input: {
  assertionId: string;
  subjectRef: string;
  attribute: string;
  value: string;
  originClass: string;
  confidence: number | null;
  reason: string;
  actorId: string;
}): Promise<Reached<Record<string, unknown> | null>> {
  const call = await callOrUnreached<{ data?: Record<string, unknown> }>({
    sdk: 'sdk-source-record',
    path: `/api/source-assertions/${encodeURIComponent(input.assertionId)}/supersede`,
    method: 'POST',
    idempotencyKey: `enrich-promote:${input.assertionId}`,
    body: {
      tenant_id: config.projexCloud.tenantId,
      subject_ref: input.subjectRef,
      attribute: input.attribute,
      value: input.value,
      origin_class: input.originClass,
      ...(input.confidence === null ? {} : { confidence: input.confidence }),
      status: 'PRIMARY',
      reason: input.reason,
      actor_id: input.actorId,
      purpose: 'lead_management',
      metadata: {
        confirmed_by_steward: true,
        /* The claim this endpoint is most often assumed to make, denied in the
           record itself so nothing downstream has to infer it. */
        creates_consent_basis: false,
      },
    },
  });
  if (!call.delivered) return unreachable(null);
  return { value: call.data?.data ?? null, available: true };
}

/** One stored assertion, as sdk-source-record's list returns it. */
export interface SourceAssertionRow {
  assertion_id?: string;
  subject_ref?: string;
  attribute?: string;
  value?: string;
  origin_class?: string;
  confidence?: number | null;
  status?: string;
  metadata?: Record<string, unknown> | null;
}

/**
 * The candidate assertions one enrichment request produced.
 *
 * Filtered on the request id in metadata rather than on the subject, because a
 * contact enriched twice has candidates from both runs and confirming one must
 * not offer the other's values.
 */
export async function listCandidateAssertions(
  subjectRef: string,
  requestId: string,
): Promise<Reached<SourceAssertionRow[]>> {
  const params = new URLSearchParams({
    tenant_id: config.projexCloud.tenantId,
    subject_ref: subjectRef,
    status: 'ASSERTION',
    exclude_superseded: 'true',
  });
  const read = await degradingRead<SourceAssertionRow[]>(
    'sdk-source-record',
    `/api/source-assertions?${params.toString()}`,
    [],
    (body) => {
      const bag = (body ?? {}) as Record<string, unknown>;
      const rows = bag.assertions;
      return Array.isArray(rows) ? (rows as SourceAssertionRow[]) : [];
    },
  );
  return {
    value: read.value.filter((row) => row.metadata?.request_id === requestId),
    available: read.available,
  };
}
