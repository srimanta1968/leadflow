// @governance-tracked
// Definition: tests/api_definitions/relationships/relationships-get.json
// Definition: tests/api_definitions/relationships/relationships-post.json
// Definition: tests/api_definitions/relationships/relationships-end-post.json

export { relationshipRoutes } from './relationshipController';
export {
  ROLES,
  ROLE_MEANING,
  TRUST_STATES,
  EVIDENCE_REQUIRED_STATES,
  DEFAULT_BUDGET,
  MAX_DEPTH_CAP,
  MAX_VISIT_CAP,
  isRole,
  isTrustState,
  requiresEvidence,
} from './roleVocabulary';
export type { Role, TrustState } from './roleVocabulary';
export { listRoles, grantRole, closeRole, checkReachable } from './relationshipGateway';
export type { ContextualRoleRow, ReachabilityResult } from './relationshipGateway';
