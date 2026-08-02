import fs from 'fs';
import path from 'path';
import {
  ERASURE_SURFACES,
  actionableSurfaces,
  allSurfaceNames,
} from '../../src/config/erasureSurfaces';
import {
  reconcileErasure,
  erasureExecutionOrder,
  emptyProof,
  ShredProof,
} from '../../src/platform/dataRights/erasurePlan';

/**
 * The erasure plan and its reconciliation.
 *
 * The claim under test is the one the certificate makes: that every local
 * surface holding subject data was cleared. These assertions are what stop that
 * claim from being a guess.
 */

function proof(surface: string, rows = 1): ShredProof {
  return { surface, method: 'redact', rowsAffected: rows, completedAt: '2026-08-02T00:00:00Z' };
}

describe('the erasure plan', () => {
  it('covers every table the schema actually defines', () => {
    // Read from the migrations rather than a hardcoded list, so a new table
    // fails this test until somebody classifies it. That is the point: an
    // unclassified table is an unerasable surface.
    const dir = path.join(__dirname, '..', '..', 'src', 'db', 'migrations');
    const sql = fs
      .readdirSync(dir)
      .filter((file) => file.endsWith('.sql'))
      .map((file) => fs.readFileSync(path.join(dir, file), 'utf8'))
      .join('\n');

    const tables = new Set(
      [...sql.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g)].map((match) => match[1])
    );
    const planned = new Set(allSurfaceNames());

    for (const table of tables) {
      expect(planned.has(table)).toBe(true);
    }
  });

  it('records the surfaces that hold nothing as explicitly as those that do', () => {
    // "We checked and it is clean" must not look like "we forgot it existed".
    const clean = ERASURE_SURFACES.filter((s) => s.method === 'no_subject_data');

    expect(clean.length).toBeGreaterThan(0);
    for (const surface of clean) {
      expect(surface.personalColumns).toEqual([]);
      expect(surface.rationale.length).toBeGreaterThan(20);
    }
  });

  it('redacts rather than deletes the surfaces other rows reference', () => {
    // Deleting leads or users would cascade away the compliance record or break
    // a foreign key; nulling the personal columns removes the person and keeps
    // the fact that the work happened.
    for (const name of ['leads', 'users']) {
      const surface = ERASURE_SURFACES.find((s) => s.surface === name);
      expect(surface?.method).toBe('redact');
      expect(surface?.personalColumns.length).toBeGreaterThan(0);
    }
  });

  it('clears derived rows before the rows they derive from', () => {
    const order = erasureExecutionOrder().map((s) => s.surface);

    // A partial failure must not leave a note quoting someone whose primary
    // record is already gone - that leftover is the copy nobody looks for.
    expect(order.indexOf('sla_metrics')).toBeLessThan(order.indexOf('leads'));
  });
});

describe('reconciliation', () => {
  it('returns zero discrepancies when every actionable surface is proved', () => {
    const proofs = actionableSurfaces().map((surface) => proof(surface.surface));

    const certificate = reconcileErasure('req-1', 'person:ada', proofs);

    expect(certificate.missingProofs).toEqual([]);
    expect(certificate.complete).toBe(true);
  });

  it('names the surface that was planned and skipped', () => {
    const proofs = actionableSurfaces()
      .filter((surface) => surface.surface !== 'sla_metrics')
      .map((surface) => proof(surface.surface));

    const certificate = reconcileErasure('req-2', 'person:ada', proofs);

    // Reconciling proofs-to-plan rather than plan-to-proofs is what catches
    // this; the other direction always passes.
    expect(certificate.missingProofs).toContain('sla_metrics');
    expect(certificate.complete).toBe(false);
  });

  it('does not demand a proof for a surface that holds no subject data', () => {
    const proofs = actionableSurfaces().map((surface) => proof(surface.surface));

    const certificate = reconcileErasure('req-3', 'person:ada', proofs);

    expect(certificate.missingProofs).not.toContain('routing_rules');
  });

  it('carries the out-of-reach caveat on the certificate itself', () => {
    const certificate = reconcileErasure('req-4', 'person:ada', []);

    // A reader deciding whether the erasure is sufficient needs the limits in
    // front of them, not in a runbook.
    expect(certificate.caveats.join(' ')).toMatch(/client_saved_view/);
  });

  it('accepts a zero-row proof as a real proof', () => {
    const empty = emptyProof('sla_metrics', 'redact');

    expect(empty.rowsAffected).toBe(0);
    // Nothing to erase is a valid outcome; only a MISSING proof is a gap.
    const certificate = reconcileErasure('req-5', 'person:ada', [
      ...actionableSurfaces()
        .filter((s) => s.surface !== 'sla_metrics')
        .map((s) => proof(s.surface)),
      empty,
    ]);
    expect(certificate.complete).toBe(true);
  });
});
