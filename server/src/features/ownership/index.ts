// @governance-tracked
// Definition: tests/api_definitions/ownership/leads-id-accept-post.json
// Definition: tests/api_definitions/ownership/leads-id-decline-post.json
// Definition: tests/api_definitions/ownership/leads-id-reassign-post.json
// Definition: tests/api_definitions/ownership/leads-orphans-get.json

export { ownershipRoutes } from './ownershipController';
export {
  ACCEPTANCE_MINUTES,
  CAPACITY_FREEZE_MINUTES,
  CAPACITY_LIMIT,
  REQUIRED_FIELDS,
  acceptanceOverdue,
  capacityVerdict,
  findOrphans,
  minutesSinceSource,
} from './ownershipService';
export type { LeadOwnershipRow, OrphanRow, OwnershipEventKind, RequiredField } from './ownershipService';
