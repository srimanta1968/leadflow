/**
 * Platform policy — the ABAC decision point.
 *
 * The bundle in `config/policies.ts` is derived from `config/roles.ts`, so the
 * permission matrix has one written form and the enforcement cannot drift from
 * the definition.
 */
export { evaluate, evaluateBatch, isKnownAction, isUnconditionalPermit } from './policyEngine';
export type { PolicyDecision, PolicyRequest } from './policyEngine';
export { AuthzController, validateActions, MAX_BATCH } from './authzController';
export { default as authzRoutes } from './authzRoutes';
