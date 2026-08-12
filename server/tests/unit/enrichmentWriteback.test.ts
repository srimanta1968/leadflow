import {
  chargeFor,
  originClassFor,
  toCandidateAssertions,
} from '../../src/features/enrichment/resultWriteback';

/**
 * The three pure decisions behind enrichment write-back.
 *
 * WHY A UNIT TEST AND NOT AN api_definition testCase, which is what MUST-67
 * asks for by default. All three of these sit behind a settled capability
 * request, and NO ENVIRONMENT AVAILABLE HERE CAN PRODUCE ONE: sdk-data-credits
 * has no funded credit account in dev, qa or staging, so nothing can be
 * reserved, nothing can execute and nothing can settle. An api_definition
 * pointed at this logic would assert the 404 it gets on the way in and prove
 * none of it. That is the exact case MUST-67 reserves a unit test for — logic
 * with no reachable HTTP surface — and it is three tests, inside the cap.
 *
 * Each one guards a mistake that is cheap to make and expensive to ship:
 * charging for an answer nobody got, laundering bought data into first-party
 * provenance, and writing a purchased value in as though a human had confirmed
 * it.
 */

describe('what a capability outcome costs the tenant', () => {
  it('charges the quote on a match and nothing on the other three', () => {
    // AC3. The three free outcomes are asserted SEPARATELY rather than in a
    // loop, because they are three different facts — a fact about the world, a
    // fact about a vendor and a fact about our own cache — and a loop would let
    // one of them start charging without the test name changing.
    expect(chargeFor('MATCHED', 4)).toBe(4);
    expect(chargeFor('NO_MATCH', 4)).toBe(0);
    expect(chargeFor('TECHNICAL_FAILURE', 4)).toBe(0);
    expect(chargeFor('CACHE_HIT', 4)).toBe(0);
  });

  it('charges nothing when the quote itself is unusable', () => {
    // A bad quote is OUR bug. Charging something arbitrary for it bills the
    // tenant for our arithmetic, and a NaN reaching the ledger is worse still:
    // it propagates into every balance derived from it.
    expect(chargeFor('MATCHED', Number.NaN)).toBe(0);
    expect(chargeFor('MATCHED', -3)).toBe(0);
    expect(chargeFor('MATCHED', 0)).toBe(0);
  });
});

describe('where a bought value is recorded as coming from', () => {
  it('separates published record from licensed supply, and quarantines the unknown', () => {
    // AC4. PUBLIC_RECORD is a materially stronger claim than
    // LICENSED_THIRD_PARTY — the subject or their employer published it and a
    // later reader can go and look — and several jurisdictions treat the two
    // differently. Flattening them would make the weaker one render as the
    // stronger on every provenance surface in the product.
    expect(originClassFor('find_possible_profiles')).toBe('PUBLIC_RECORD');
    expect(originClassFor('validate_phone')).toBe('LICENSED_THIRD_PARTY');
    expect(originClassFor('validate_email')).toBe('LICENSED_THIRD_PARTY');
    expect(originClassFor('find_contact_points')).toBe('LICENSED_THIRD_PARTY');
    // An unmapped capability is NOT given a plausible default. Unknown
    // provenance reading as trusted is the one failure worth guarding against.
    expect(originClassFor('some_capability_added_later')).toBe('UNKNOWN_QUARANTINED');
  });
});

describe('what a result is written back as', () => {
  it('writes every value as a candidate, never as an operational one', () => {
    // AC1, and the whole safety property of buying data. A phone number that
    // arrives from outside the business is a CLAIM about a person; one that
    // becomes the number the business dials without anybody reading it is how a
    // wrong number gets called four hundred times.
    const candidates = toCandidateAssertions('find_contact_points', {
      phone: '+15551234567',
      email: 'contact@example.test',
      confidence: 0.82,
    });

    expect(candidates).toHaveLength(2);
    for (const candidate of candidates) {
      expect(candidate.status).toBe('ASSERTION');
      expect(candidate.originClass).toBe('LICENSED_THIRD_PARTY');
      expect(candidate.confidence).toBe(0.82);
    }
    expect(candidates.map((c) => c.attribute).sort()).toEqual(['email', 'phone']);
  });

  it('reports an unscored value as unscored rather than as worthless', () => {
    // confidence 0 says "we checked and it is worthless"; null says "nobody
    // scored it". Coercing the second into the first would let a survivorship
    // rule discard a perfectly good value on a score nobody produced.
    const [candidate] = toCandidateAssertions('validate_phone', { phone: '+15551234567' });
    expect(candidate.confidence).toBeNull();

    // Out-of-range scores are refused for the same reason rather than clamped:
    // a clamp invents a number, and 1.0 is the most consequential one to invent.
    const [outOfRange] = toCandidateAssertions('validate_phone', {
      phone: '+15551234567',
      confidence: 4,
    });
    expect(outOfRange.confidence).toBeNull();
  });

  it('keeps every returned contact point instead of the first one', () => {
    // A capability that returns three ways to reach somebody has been paid for
    // three times over; collapsing them to the first silently discards two.
    const candidates = toCandidateAssertions('find_contact_points', {
      contact_points: [
        { kind: 'phone', value: '+15550000001' },
        { kind: 'phone', value: '+15550000002' },
        { kind: 'email', value: 'second@example.test' },
        { kind: 'fax', value: '+15550000003' },
      ],
    });

    // The fax is dropped: this product has no surface that renders one, and an
    // assertion nobody can read is noise in the provenance store.
    expect(candidates.map((c) => c.value)).toEqual([
      '+15550000001',
      '+15550000002',
      'second@example.test',
    ]);
  });
});
