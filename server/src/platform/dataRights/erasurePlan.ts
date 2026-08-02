import { ERASURE_SURFACES, ErasureSurface, actionableSurfaces } from '../../config/erasureSurfaces';

/** Proof that one surface was cleared. */
export interface ShredProof {
  surface: string;
  method: ErasureSurface['method'];
  /** Rows affected, or 0 for a surface that held nothing. */
  rowsAffected: number;
  /** For crypto_shred: the vault key destroyed. */
  keyRef?: string;
  /** When it was done. */
  completedAt: string;
}

export interface ErasureCertificate {
  requestId: string;
  subjectRef: string;
  proofs: ShredProof[];
  /** Surfaces the plan names that produced no proof. Empty is the goal. */
  missingProofs: string[];
  /** True only when every planned surface produced a proof. */
  complete: boolean;
  /** Limits a reader must know about, e.g. surfaces beyond our reach. */
  caveats: string[];
}

/**
 * Reconcile the proofs an execution produced against the plan.
 *
 * THE PLAN IS THE SOURCE OF TRUTH, not the proofs. Reconciling the other way —
 * "every proof we have corresponds to a surface" — always passes, because a
 * surface nobody touched produces no proof to check. The discrepancy that
 * matters is the surface that was planned and skipped.
 *
 * @param requestId  The data-rights request being certified.
 * @param subjectRef The subject erased.
 * @param proofs     What the execution reported.
 */
export function reconcileErasure(
  requestId: string,
  subjectRef: string,
  proofs: ShredProof[]
): ErasureCertificate {
  const proved = new Set(proofs.map((proof) => proof.surface));

  // Only surfaces that require an action can be missing. A surface recorded as
  // holding no subject data is satisfied by the record itself.
  const missingProofs = actionableSurfaces()
    .map((surface) => surface.surface)
    .filter((name) => !proved.has(name));

  // Caveats travel WITH the certificate rather than living in a runbook. A
  // reader deciding whether the erasure is sufficient needs to know what it
  // could not reach at the moment they read it.
  const caveats = ERASURE_SURFACES.filter(
    (surface) => surface.surface === 'client_saved_view'
  ).map(
    (surface) => `${surface.surface}: ${surface.rationale}`
  );

  return {
    requestId,
    subjectRef,
    proofs,
    missingProofs,
    complete: missingProofs.length === 0,
    caveats,
  };
}

/**
 * The surfaces an execution must clear, in the order it should clear them.
 *
 * Ordered so REFERENCED rows are redacted before the rows referencing them:
 * clearing a lead's note in sla_metrics after the lead itself is fine, but
 * doing it the other way round means a partial failure leaves the derived note
 * quoting a person whose primary record is already gone — the worst partial
 * state, because the remaining copy is the one nobody thinks to look for.
 */
export function erasureExecutionOrder(): ErasureSurface[] {
  const order = ['sla_metrics', 'leads', 'users'];
  return actionableSurfaces().sort(
    (a, b) => order.indexOf(a.surface) - order.indexOf(b.surface)
  );
}

/** A proof for a surface that genuinely held nothing, so the record is explicit. */
export function emptyProof(surface: string, method: ErasureSurface['method']): ShredProof {
  return {
    surface,
    method,
    rowsAffected: 0,
    completedAt: new Date().toISOString(),
  };
}
