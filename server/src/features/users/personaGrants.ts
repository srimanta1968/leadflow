import { config } from '../../config/env';
import { SdkGatewayClient } from '../../platform/sdkGateway';

/**
 * Granting a role to a ProjexCloud persona, the way the platform actually
 * models it.
 *
 * WHY THIS FILE EXISTS RATHER THAN A CALL TO `assignPersonaRole`. That helper
 * POSTs to `/api/personas/{id}/role`, and the SDK catalog carries no such
 * operation — `GET /api/personas/{persona_id}/roles` is READ-ONLY and lists what
 * a persona already holds. The developer hub is explicit about the write path:
 *
 *     POST /api/role-assignments { assigned_by, persona_id, role_template_id }
 *
 * A grant sent to a route the gateway does not publish does not fail loudly here
 * — SdkGatewayClient collapses it into one UPSTREAM_UNAVAILABLE and the mirror
 * reports "could not be updated". So the symptom of using the wrong path is a
 * role that silently never lands, which is the failure mode the register was
 * built to remove.
 *
 * THE TEMPLATE IS RESOLVED BY NAME, NOT GUESSED. `role_template_id` is a uuid,
 * and LeadFlow does not store one: `provisionRoles` creates each template by
 * NAME at boot and discards the response. `GET /api/role-templates` lists them,
 * so the id is recoverable — and recovering it is the only honest option, since
 * fabricating a uuid for a foreign key is exactly what MUST-36 forbids and would
 * be rejected by `role_template_app_id_fkey` anyway.
 */

/** One template as the list endpoint returns it. Only the two fields we use. */
interface RoleTemplate {
  role_template_id?: string;
  id?: string;
  name?: string;
}

/**
 * Template ids by role name, for the life of the process.
 *
 * CACHED, because a role assignment would otherwise cost two upstream calls and
 * the list is stable — templates are provisioned at boot from a file. NOT
 * persisted: a stored id would be a second source of truth for something the
 * platform owns, and a stale one is worse than a lookup, because it points at a
 * template that may have been redefined.
 */
const templateIds = new Map<string, string>();

/** Read the id off whichever field the list endpoint uses. */
function idOf(template: RoleTemplate): string | null {
  return template.role_template_id ?? template.id ?? null;
}

/**
 * Find the platform role template that matches an SOP role key.
 *
 * @param roleName The SOP role key, which `provisionRoles` uses as the template name.
 * @returns The template id, or null when the list cannot be read or holds no match.
 */
export async function resolveRoleTemplateId(roleName: string): Promise<string | null> {
  const cached = templateIds.get(roleName);
  if (cached) {
    return cached;
  }

  try {
    const result = await SdkGatewayClient.call<{
      data?: { role_templates?: RoleTemplate[]; items?: RoleTemplate[] } | RoleTemplate[];
    }>({
      sdk: 'sdk-tenant',
      path: `/api/role-templates?app_id=${encodeURIComponent(config.projexCloud.appId)}`,
      method: 'GET',
    });

    if (!result.delivered) {
      return null;
    }

    const body = result.data?.data;
    const templates: RoleTemplate[] = Array.isArray(body)
      ? body
      : body?.role_templates ?? body?.items ?? [];

    for (const template of templates) {
      const id = idOf(template);
      if (template.name && id) {
        templateIds.set(template.name, id);
      }
    }

    return templateIds.get(roleName) ?? null;
  } catch {
    // Swallowed to null rather than thrown: the caller is a best-effort mirror
    // that must never fail a local write, and it reports the null itself.
    return null;
  }
}

/**
 * Grant a role template to a persona.
 *
 * @param personaId  The acting identity — L4, which everything downstream keys on.
 * @param roleTemplateId The template being granted.
 * @param assignedBy The persona or user that ordered it, for attribution upstream.
 * @returns True when the grant landed.
 */
export async function grantRoleTemplate(
  personaId: string,
  roleTemplateId: string,
  assignedBy: string
): Promise<boolean> {
  try {
    await SdkGatewayClient.call({
      sdk: 'sdk-rebac',
      path: '/api/role-assignments',
      method: 'POST',
      // Keyed on the triple, so a retry after a timeout grants once rather than
      // stacking duplicate assignments on the same persona.
      idempotencyKey: `role-assignment:${personaId}:${roleTemplateId}`,
      body: {
        persona_id: personaId,
        role_template_id: roleTemplateId,
        // NAMED, never a service constant. Every cross-boundary action must
        // record the human who took it, and an assignment attributed to
        // "leadflow" cannot answer the only question anyone asks of it.
        assigned_by: assignedBy,
      },
    });
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(
      `[personaGrants] persona ${personaId} -> template ${roleTemplateId} failed:`,
      detail
    );
    return false;
  }
}
