/**
 * Permission-aware UI gating.
 *
 * Every gate here decides what to RENDER. The server evaluates the same policy
 * on the write, because a hidden button stops nobody who can call the API.
 */
export { usePermissions, decisionFor, isAllowed } from './usePermissions';
export type {
  PermissionQuery,
  PermissionState,
  PolicyDecision,
  PolicyEffect,
  PolicyObligation,
} from './usePermissions';
export { RequirePermission, DeniedReason } from './RequirePermission';
