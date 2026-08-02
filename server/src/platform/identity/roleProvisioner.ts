import { config } from '../../config/env';
import { ROLE_DEFINITIONS, RoleDefinition } from '../../config/roles';
import { SdkGatewayClient } from '../../services/projexcloud/SdkGatewayClient';

/** What one role's provisioning attempt produced. */
export interface RoleProvisionResult {
  roleKey: string;
  /** `created` first time, `already_present` on every restart after. */
  outcome: 'created' | 'already_present' | 'skipped' | 'failed';
  detail?: string;
}

export interface ProvisionSummary {
  /** False when no gateway is configured and nothing was attempted. */
  attempted: boolean;
  created: number;
  alreadyPresent: number;
  failed: number;
  results: RoleProvisionResult[];
}

/**
 * True when the upstream refusal means "this already exists".
 *
 * `SdkGatewayClient` collapses every non-ok response into one
 * UPSTREAM_UNAVAILABLE error carrying `returned <status>` in its message, so the
 * status is recovered from there. Reading a status out of a message is not
 * lovely, and the alternative is worse: sdk-rebac publishes no GET for role
 * templates (confirmed against the catalog — `get_sdk_api` returns found:false
 * for GET /api/role-templates), so there is no way to ASK what exists before
 * creating. Create-and-tolerate-conflict is the only idempotent shape available.
 *
 * If a list endpoint is ever published, replace this with a read.
 */
function isAlreadyExists(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /returned (409|422)\b/.test(message);
}

/**
 * Provision the role catalogue into ProjexCloud.
 *
 * IDEMPOTENT BY CONSTRUCTION. Every identifier sent upstream is derived from the
 * role's `key` in the config, so a restart sends byte-identical requests and the
 * second run reports `already_present` rather than creating duplicates. Nothing
 * is remembered locally between runs — a local "have I provisioned this?" flag
 * would be a second source of truth that drifts the moment someone edits the
 * tenant directly.
 *
 * NOT FATAL. A failure to provision is logged and returned, never thrown: the
 * app must still boot when ProjexCloud is unreachable, or an identity-provider
 * outage becomes a total outage. The caller decides what to do with a summary
 * showing failures.
 *
 * @param roles Definitions to provision. Defaults to the whole config, and is
 *              injectable so a test can drive one role without a fixture file.
 */
export async function provisionRoles(
  roles: RoleDefinition[] = ROLE_DEFINITIONS
): Promise<ProvisionSummary> {
  const summary: ProvisionSummary = {
    attempted: false,
    created: 0,
    alreadyPresent: 0,
    failed: 0,
    results: [],
  };

  if (!SdkGatewayClient.isConfigured()) {
    // Nothing to provision against. Reported rather than logged as an error:
    // a developer machine with no gateway is a normal state, not a fault.
    summary.results = roles.map((role) => ({
      roleKey: role.key,
      outcome: 'skipped' as const,
      detail: 'No ProjexCloud gateway configured',
    }));
    return summary;
  }

  summary.attempted = true;

  for (const role of roles) {
    try {
      await SdkGatewayClient.call({
        sdk: 'sdk-rebac',
        path: '/v1/role-templates',
        method: 'POST',
        // Keyed on the role, so a retry after a timeout cannot create a second
        // template for the same actor.
        idempotencyKey: `role-template:${role.key}`,
        body: {
          // Payload shape taken from the SDK catalog entry for
          // POST /api/role-templates: app_id, name, permissions, tenant_id.
          app_id: config.projexCloud.appId,
          tenant_id: config.projexCloud.tenantId,
          name: role.key,
          // Only the unaided grants. `requiresApproval` is deliberately NOT sent
          // as a permission — granting it here would hand the role the very
          // thing the SOP says it may not do alone, and the approval workflow
          // that gates it lives in the ABAC policy bundle.
          permissions: role.canDo,
        },
      });

      summary.created += 1;
      summary.results.push({ roleKey: role.key, outcome: 'created' });
    } catch (error) {
      if (isAlreadyExists(error)) {
        summary.alreadyPresent += 1;
        summary.results.push({ roleKey: role.key, outcome: 'already_present' });
        continue;
      }
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[roleProvisioner] ${role.key} could not be provisioned:`, detail);
      summary.failed += 1;
      summary.results.push({ roleKey: role.key, outcome: 'failed', detail });
    }
  }

  return summary;
}

/**
 * Put a persona into a business unit — the "North Dallas Sales" case.
 *
 * Separate from role provisioning because the two answer different questions.
 * A role says WHAT someone may do; a business unit says WHOSE records they may
 * do it to. Granting a Sales Manager their role without scoping them to a unit
 * would make them manager of every region at once.
 *
 * @param personaId  The persona being scoped.
 * @param businessUnitId The unit, e.g. the id for North Dallas Sales.
 */
export async function assignPersonaToBusinessUnit(
  personaId: string,
  businessUnitId: string
): Promise<boolean> {
  if (!SdkGatewayClient.isConfigured()) {
    return false;
  }

  try {
    await SdkGatewayClient.call({
      sdk: 'sdk-persona',
      path: `/v1/personas/${encodeURIComponent(personaId)}/bu`,
      method: 'POST',
      idempotencyKey: `persona-bu:${personaId}:${businessUnitId}`,
      body: { business_unit_id: businessUnitId, tenant_id: config.projexCloud.tenantId },
    });
    return true;
  } catch (error) {
    if (isAlreadyExists(error)) {
      // Already in the unit. Re-running the provisioner must not report a
      // failure for work that is already done.
      return true;
    }
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[roleProvisioner] persona ${personaId} -> BU ${businessUnitId} failed:`, detail);
    return false;
  }
}

/** Set a persona's role label, so the profile chip and guards agree on it. */
export async function assignPersonaRole(personaId: string, roleKey: string): Promise<boolean> {
  if (!SdkGatewayClient.isConfigured()) {
    return false;
  }

  try {
    await SdkGatewayClient.call({
      sdk: 'sdk-persona',
      path: `/v1/personas/${encodeURIComponent(personaId)}/role`,
      method: 'POST',
      idempotencyKey: `persona-role:${personaId}:${roleKey}`,
      // Payload shape from the catalog entry for POST /api/personas/:persona_id/role.
      body: { role: roleKey },
    });
    return true;
  } catch (error) {
    if (isAlreadyExists(error)) {
      return true;
    }
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[roleProvisioner] persona ${personaId} -> role ${roleKey} failed:`, detail);
    return false;
  }
}
