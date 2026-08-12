/**
 * What happens to a capability result once the provider has answered.
 *
 * TWO THINGS, AND THEY ARE DELIBERATELY SEPARATE. The credits settle, and the
 * answer is written back as PROVENANCE. Neither is allowed to imply the other:
 * a charged lookup is not a true value, and a free one is not a worthless value.
 *
 * NOTHING WRITTEN HERE IS OPERATIONAL. Every assertion goes in as a CANDIDATE
 * and stays one until a steward confirms it through the apply endpoint. That is
 * the whole safety property of buying data: a phone number that arrives from
 * outside the business is a claim about a person, and a claim that becomes the
 * number the business dials without anybody looking at it is how a wrong number
 * gets called four hundred times.
 *
 * The three functions at the top are PURE and are the ones the unit test covers
 * (MUST-67). They have no HTTP surface anybody can reach: no LeadFlow
 * environment has a funded credit account, so no capability request can be
 * reserved, executed or settled, so no api_definition testCase can ever observe
 * a settlement or an origin class. A unit test is the only runner that reaches
 * them, which is exactly the case MUST-67 reserves one for.
 */

import { AUDIT_EVENTS } from '../../platform/audit/vocabulary';
import { appendAuditEntry } from '../../platform/audit/auditLog';
import { config } from '../../config/env';
import { settleReservation, writeSourceAssertion } from './enrichmentGateway';
import { randomUUID } from 'crypto';

/** How a lookup ended, in sdk-data-credits' own vocabulary. */
export type SettlementOutcome = 'MATCHED' | 'NO_MATCH' | 'TECHNICAL_FAILURE' | 'CACHE_HIT';

/** Where a value came from, in sdk-source-record's origin vocabulary. */
export type OriginClass =
  | 'USER_PROVIDED'
  | 'FIRST_PARTY_DIRECT'
  | 'TENANT_FIRST_PARTY_CRM'
  | 'USER_AUTHORIZED_CONTACT_STORE'
  | 'PUBLIC_RECORD'
  | 'LICENSED_THIRD_PARTY'
  | 'PARTNER_PROVIDED'
  | 'UNKNOWN_QUARANTINED';

/**
 * What the tenant is charged for an outcome.
 *
 * ONLY A MATCH COSTS ANYTHING. A no-match is a fact about the world, a technical
 * failure is a fact about a vendor, and a cache hit is a fact about our own
 * store — three different events, all free, and kept apart rather than collapsed
 * into one no-charge branch because a report that cannot tell them apart cannot
 * tell a bad provider from a bad question.
 *
 * @param outcome How the lookup ended.
 * @param quotedCredits What the tenant was quoted when the credits were held.
 * @returns The credits to charge. Zero for everything but a match.
 */
export function chargeFor(outcome: SettlementOutcome, quotedCredits: number): number {
  if (outcome !== 'MATCHED') {
    return 0;
  }
  // A negative or unparseable quote charges nothing rather than something
  // arbitrary: a bad quote is our bug, and the tenant should not pay for it.
  return Number.isFinite(quotedCredits) && quotedCredits > 0 ? quotedCredits : 0;
}

/**
 * The origin class a capability's answers carry.
 *
 * NOT ONE CLASS FOR ALL OF THEM. A professional profile found on the open web is
 * PUBLIC_RECORD — the subject or their employer published it, and a later reader
 * can go and look. A phone number or an address appended from a data supplier is
 * LICENSED_THIRD_PARTY: nobody published it, we bought the right to use it, and
 * that is a materially weaker claim which several jurisdictions treat
 * differently. Flattening the two would make the weaker one look like the
 * stronger one on every screen that renders provenance.
 *
 * An unrecognised capability is UNKNOWN_QUARANTINED rather than a plausible
 * default, on the same principle the design system uses for an unmapped origin
 * chip: unknown provenance reading as trusted is the one failure worth guarding.
 */
export function originClassFor(capabilityKey: string): OriginClass {
  switch (capabilityKey) {
    case 'find_possible_profiles':
      return 'PUBLIC_RECORD';
    case 'validate_phone':
    case 'validate_email':
    case 'find_contact_points':
      return 'LICENSED_THIRD_PARTY';
    default:
      return 'UNKNOWN_QUARANTINED';
  }
}

/** One value a capability returned, ready to be written as provenance. */
export interface CandidateAssertion {
  attribute: string;
  value: string;
  originClass: OriginClass;
  /** 0..1. Null when the provider scored nothing — never 0, which means refuted. */
  confidence: number | null;
  /**
   * ALWAYS 'ASSERTION'. Typed as the literal rather than as AssertionStatus so
   * that writing a PRIMARY here is a compile error rather than a review comment.
   * Promotion happens in exactly one place, behind a steward's confirmation.
   */
  status: 'ASSERTION';
}

/** A confidence in 0..1, or null when there is not one. Never coerced to 0. */
function confidenceOf(raw: unknown): number | null {
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0 || value > 1) return null;
  return value;
}

/**
 * The values a result payload contains, as candidate assertions.
 *
 * READS A SHAPE RATHER THAN A SCHEMA, because the payload is whatever the broker
 * hands back and its shape is the vendor's, not ours. Only the three attributes
 * this product has a use for are lifted; anything else in the payload is left
 * behind rather than written as an assertion nobody can render.
 *
 * @param capabilityKey Which capability produced this.
 * @param result        The broker's result payload.
 * @returns One candidate per usable value. Empty when there is nothing to write.
 */
export function toCandidateAssertions(
  capabilityKey: string,
  result: unknown
): CandidateAssertion[] {
  const bag = (result ?? {}) as Record<string, unknown>;
  const originClass = originClassFor(capabilityKey);
  const confidence = confidenceOf(bag.confidence ?? bag.score);

  const candidates: CandidateAssertion[] = [];
  const push = (attribute: string, raw: unknown): void => {
    if (typeof raw !== 'string' || raw.trim() === '') return;
    candidates.push({ attribute, value: raw.trim(), originClass, confidence, status: 'ASSERTION' });
  };

  push('phone', bag.phone ?? bag.phone_number);
  push('email', bag.email ?? bag.email_address);
  push('profile_url', bag.profile_url ?? bag.profile);

  // A capability that returns several contact points returns them as a list, and
  // each is its own claim — collapsing them into the first would silently drop
  // every alternative the tenant paid for.
  const list = bag.contact_points;
  if (Array.isArray(list)) {
    for (const entry of list) {
      const item = (entry ?? {}) as Record<string, unknown>;
      const kind = typeof item.kind === 'string' ? item.kind : '';
      if (kind === 'phone' || kind === 'email') push(kind, item.value);
    }
  }

  return candidates;
}

/** What a completed capability did to the tenant's credits and their provenance. */
export interface WritebackResult {
  requestId: string;
  outcome: SettlementOutcome;
  creditsCharged: number;
  /** The candidates written. Empty on any outcome but a match. */
  assertionsWritten: number;
  /** False when sdk-source-record could not be reached. Never silently dropped. */
  provenanceRecorded: boolean;
  settled: boolean;
}

/**
 * Settle a completed capability and write its answers back as candidates.
 *
 * ORDER MATTERS. The settlement runs first, because it is the tenant's money and
 * it must land whether or not the provenance store is reachable; a result written
 * against credits that were never settled leaves the reservation held forever.
 * The audit entry is appended LAST and quotes both the policy decision and the
 * credits charged, so "what did this cost and what did it change" is one row
 * rather than a join nobody can perform.
 *
 * NOTHING HERE IS OPERATIONAL, and nothing here creates a consent basis. A
 * confirmed phone number still cannot be sent to: the channel decision engine
 * asks sdk-consent independently, and an appended value has no receipt behind
 * it, so the send is refused for want of a permission this function never mints.
 *
 * @param input.decisionRef The PDP decision this ran under, for the audit entry.
 */
export async function recordEnrichmentResult(input: {
  requestId: string;
  reservationId: string | null;
  capabilityKey: string;
  subjectRef: string;
  outcome: SettlementOutcome;
  quotedCredits: number;
  result: unknown;
  actor: string;
  personaRole: string;
  decisionRef: string;
}): Promise<WritebackResult> {
  const creditsCharged = chargeFor(input.outcome, input.quotedCredits);

  const settled = input.reservationId
    ? (await settleReservation(input.reservationId, input.outcome, input.result)).available
    : false;

  /*
   * ONLY A MATCH PRODUCES PROVENANCE. A cache hit already wrote its assertions
   * the first time the question was asked, and writing them again would stack
   * duplicate candidates on the same contact every time somebody re-ran the
   * lookup. A no-match and a technical failure have nothing to write at all —
   * and writing an empty assertion to record that we asked would put a claim
   * with no value into the provenance store.
   */
  const candidates =
    input.outcome === 'MATCHED' ? toCandidateAssertions(input.capabilityKey, input.result) : [];

  let provenanceRecorded = candidates.length === 0;
  let written = 0;
  for (const candidate of candidates) {
    const stored = await writeSourceAssertion({
      subjectRef: input.subjectRef,
      attribute: candidate.attribute,
      value: candidate.value,
      originClass: candidate.originClass,
      confidence: candidate.confidence,
      status: candidate.status,
      actorId: input.actor,
      metadata: {
        capability_key: input.capabilityKey,
        request_id: input.requestId,
        /* Stated in the record, not only in the code: nothing bought is usable
           until a steward says so, and a later reader of this row should not
           have to know our promotion rules to understand that. */
        requires_human_confirmation: true,
        creates_consent_basis: false,
      },
    });
    if (stored.available) {
      written += 1;
      provenanceRecorded = true;
    }
  }

  await appendAuditEntry({
    event: AUDIT_EVENTS.ENRICHMENT_SETTLED,
    actor: input.actor,
    personaRole: input.personaRole,
    purpose: 'lead_management',
    decisionRef: input.decisionRef,
    evidenceRef: `pdp:${input.decisionRef}`,
    causationId: randomUUID(),
    idempotencyRef: `enrich-settle:${input.requestId}`,
    subjectId: input.subjectRef,
    subjectType: 'enrichment_request',
    metadata: {
      request_id: input.requestId,
      capability_key: input.capabilityKey,
      outcome: input.outcome,
      /* The two figures an invoice dispute asks for, in the tamper-evident
         chain rather than only in the broker's ledger. */
      credits_quoted: input.quotedCredits,
      credits_charged: creditsCharged,
      assertions_written: written,
      tenant_id: config.projexCloud.tenantId,
      creates_consent_basis: false,
    },
  });

  return {
    requestId: input.requestId,
    outcome: input.outcome,
    creditsCharged,
    assertionsWritten: written,
    provenanceRecorded,
    settled,
  };
}
