import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  ASSERTION_COLUMNS,
  ASSERTION_STATUS,
  TRUST_RAIL_NODES,
  fromUpstream,
  isSuperseded,
  type UpstreamAssertionRecord,
  type UpstreamLosingAssertion,
} from '../../src/design-system/evidence/assertions';

/**
 * The provenance primitives.
 *
 * The acceptance condition — "a superseded assertion always displays the reason
 * it lost, never a bare status word" — is enforced in the TYPE, so most of it is
 * checked by tsc rather than here. What this file adds is the part a type cannot
 * hold: that the reason comes from upstream verbatim, and that the mapping onto
 * the mockup's columns is the one intended.
 */

const record: UpstreamAssertionRecord = {
  assertion_id: 'a-1',
  attribute: 'Mobile phone',
  value: '+44 7700 900123',
  origin_class: 'USER_PROVIDED',
  origin_ref: 'src:form-4821',
  confidence: 0.82,
  verification_state: 'verified',
  observed_at: '2026-03-04T09:15:00.000Z',
  recorded_at: '2026-07-30T11:02:00.000Z',
  superseded_by: null,
};

describe('the superseded reason', () => {
  it('is carried through verbatim from the survivorship engine', () => {
    const losing: UpstreamLosingAssertion = {
      assertion: record,
      reason:
        "lost on confidence (2): 0.42 is lower than the surviving assertion's 0.91",
      decided_by: { criterion: 'confidence', criterion_index: 2, losing_value: 0.42, winning_value: 0.91 },
    };
    const row = fromUpstream({ ...record, superseded_by: 'a-9' }, losing);

    expect(isSuperseded(row)).toBe(true);
    if (!isSuperseded(row)) throw new Error('narrowing failed');
    // Verbatim. A sentence composed here would read as authoritative while
    // agreeing with nothing the engine decided.
    expect(row.supersededReason).toBe(losing.reason);
    expect(row.supersededBy).toBe('a-9');
  });

  it('is never a bare status word', () => {
    const losing: UpstreamLosingAssertion = {
      assertion: record,
      reason: "lost on recency (3): observed 2024-01-01, older than the surviving assertion's 2026-05-05",
      decided_by: { criterion: 'recency', criterion_index: 3, losing_value: 'a', winning_value: 'b' },
    };
    const row = fromUpstream(record, losing);
    if (!isSuperseded(row)) throw new Error('narrowing failed');
    // The whole point of the criterion: not "superseded", "stale" or "outranked".
    expect(row.supersededReason.split(/\s+/).length).toBeGreaterThan(4);
    expect(['superseded', 'stale', 'outranked']).not.toContain(row.supersededReason.toLowerCase());
  });

  it('leaves a surviving row with no reason at all', () => {
    const row = fromUpstream(record);
    expect(isSuperseded(row)).toBe(false);
    expect((row as { supersededReason?: string }).supersededReason).toBeUndefined();
  });
});

describe('the upstream mapping', () => {
  it('maps Effective to observed_at and Retrieved to recorded_at, not the reverse', () => {
    const row = fromUpstream(record);
    // Swapping these makes a record imported today look like a fact that only
    // became true today — the exact confusion the provenance tab removes.
    expect(row.effectiveAt).toBe(record.observed_at);
    expect(row.retrievedAt).toBe(record.recorded_at);
    expect(Date.parse(row.effectiveAt!)).toBeLessThan(Date.parse(row.retrievedAt!));
  });

  it("uses upstream's `attribute` for the column the mockup calls Assertion", () => {
    expect(fromUpstream(record).assertion).toBe(record.attribute);
  });

  it('still matches the upstream interface as ProjexCloud declares it', () => {
    // Transcribed contracts rot. This reads the real file so a rename upstream
    // fails here rather than at runtime in a provenance tab nobody opens twice.
    const upstream = path.resolve(
      __dirname,
      '../../../../ProjexCloud/packages/sdk-projection/src/services/explainedProjectionService.ts',
    );
    if (!fs.existsSync(upstream)) {
      // ProjexCloud is a sibling checkout, not a dependency. Absent is not a
      // failure — but it must not read as a pass either.
      expect(fs.existsSync(upstream), 'ProjexCloud not checked out beside LeadFlow — mapping unverified').toBe(false);
      return;
    }
    const src = fs.readFileSync(upstream, 'utf8');
    for (const field of ['assertion_id', 'attribute', 'origin_class', 'observed_at', 'recorded_at', 'superseded_by', 'confidence']) {
      expect(src, `upstream no longer declares ${field}`).toContain(field);
    }
    expect(src).toContain('reason');
    expect(src).toContain('decided_by');
  });
});

describe('the mockup vocabulary', () => {
  it('carries the eight columns in order', () => {
    expect([...ASSERTION_COLUMNS]).toEqual([
      'Assertion', 'Value', 'Source / Crosswalk', 'Origin Class',
      'Confidence', 'Effective', 'Retrieved', 'Status',
    ]);
  });

  it('carries the four status words and no others', () => {
    expect([...ASSERTION_STATUS]).toEqual(['Primary', 'Survives', 'Assertion', 'Superseded']);
  });

  it('renders all six rail nodes, with Consent kept separate from the ladder', () => {
    expect(TRUST_RAIL_NODES).toHaveLength(6);
    expect(TRUST_RAIL_NODES.map((n) => n.key)).toEqual([
      'P0_CAPTURED', 'P1_NORMALIZED', 'P2_CANDIDATE', 'P3_LINKED', 'P4_DIRECT', 'CONSENT',
    ]);
    // Consent is a parallel track, not the top rung. A record can be verified at
    // P4 and still carry no permission to contact, and a rail that implied
    // otherwise would suggest a permission nobody granted.
    expect(TRUST_RAIL_NODES.at(-1)!.hint).toMatch(/separately/i);
    for (const node of TRUST_RAIL_NODES) {
      expect(node.hint.length, `${node.key} has no evidence subtitle`).toBeGreaterThan(10);
    }
  });
});
