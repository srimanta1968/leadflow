/**
 * Platform data rights — the LeadFlow erasure plan and its reconciliation.
 *
 * The plan enumerates every local surface holding subject data. A certificate
 * is only as honest as that list, so it is derived from the real schema and
 * records the surfaces that hold NOTHING as explicitly as the ones that do.
 */
export { reconcileErasure, erasureExecutionOrder, emptyProof } from './erasurePlan';
export type { ShredProof, ErasureCertificate } from './erasurePlan';
export {
  ERASURE_SURFACES,
  actionableSurfaces,
  allSurfaceNames,
} from '../../config/erasureSurfaces';
export type { ErasureSurface, ErasureMethod } from '../../config/erasureSurfaces';
