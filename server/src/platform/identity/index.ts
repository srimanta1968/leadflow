/**
 * Platform identity — persona roles and their ReBAC templates.
 *
 * LeadFlow holds no role table. This module provisions the definitions in
 * `config/roles.ts` into ProjexCloud and reads them back through the session,
 * so the permission model has exactly one written form.
 */
export {
  provisionRoles,
  assignPersonaToBusinessUnit,
  assignPersonaRole,
} from './roleProvisioner';
export type { ProvisionSummary, RoleProvisionResult } from './roleProvisioner';
