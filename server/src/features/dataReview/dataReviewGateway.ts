import { degradingRead, unreachable, type Reached } from '../../platform/sdkGateway/degradingRead';
import { SdkGatewayClient } from '../../platform/sdkGateway';
import { config } from '../../config/env';

/**
 * Typed reads behind the Data Review screen.
 *
 * EVERY READ DEGRADES RATHER THAN THROWS. A review queue that 500s because one
 * of three upstreams is out is a queue nobody can work; a queue that renders
 * with a named gap is one where the cases that ARE readable still get triaged.
 */

/** One incident as sdk-incident projects it. */
export interface IncidentRow {
  incident_id?: string;
  case_type?: string;
  risk?: string;
  entity_ref?: string;
  entity_label?: string;
  issue?: string;
  evidence_summary?: string;
  status?: string;
  opened_at?: string;
  due_at?: string;
  owner_role?: string;
}

/** An SLA breach record, keyed back to its incident. */
export interface SlaBreachRow {
  incident_id?: string;
  due_at?: string;
  minutes_remaining?: number;
  breached?: boolean;
}

const asArray = <T>(body: unknown, ...keys: string[]): T[] => {
  const bag = (body ?? {}) as Record<string, unknown>;
  for (const key of keys) {
    if (Array.isArray(bag[key])) return bag[key] as T[];
  }
  const data = bag.data as Record<string, unknown> | undefined;
  if (data) {
    for (const key of keys) {
      if (Array.isArray(data[key])) return data[key] as T[];
    }
  }
  return [];
};

/** The open case register. */
export async function listIncidents(limit: number): Promise<Reached<IncidentRow[]>> {
  return degradingRead<IncidentRow[]>(
    'sdk-incident',
    `/api/incidents?tenant_id=${encodeURIComponent(config.projexCloud.tenantId)}&limit=${limit}`,
    [],
    (body) => asArray<IncidentRow>(body, 'incidents', 'items'),
  );
}

/**
 * The per-case clocks.
 *
 * READ SEPARATELY rather than assumed from `due_at`, because the SLA policy
 * decides what the deadline MEANS - business hours, pauses while a case waits
 * on a third party - and subtracting two timestamps here would quietly invent
 * a different clock from the one the tenant agreed.
 */
export async function listSlaBreaches(): Promise<Reached<SlaBreachRow[]>> {
  return degradingRead<SlaBreachRow[]>(
    'sdk-incident',
    `/api/incidents/sla-breaches?tenant_id=${encodeURIComponent(config.projexCloud.tenantId)}`,
    [],
    (body) => asArray<SlaBreachRow>(body, 'breaches', 'items'),
  );
}

/**
 * Resolve the role that owns a case type to the person who holds it (AC4).
 *
 * ASKED, NOT ASSUMED. The screen must name an owner, and the only honest source
 * for "who is the privacy officer in this tenant today" is the policy service.
 * An unreachable policy leaves the ROLE on the row and the person null - which
 * still routes the case correctly and says plainly that the name is unknown,
 * where a placeholder name would send somebody to the wrong desk.
 */
export async function resolveOwners(
  roles: string[],
): Promise<Reached<Record<string, string | null>>> {
  if (roles.length === 0) return { value: {}, available: true };
  try {
    const res = await SdkGatewayClient.call<{ data?: { assignments?: Record<string, string> } }>({
      sdk: 'sdk-policy',
      path: '/api/policies/role-holders',
      method: 'POST',
      body: { tenant_id: config.projexCloud.tenantId, roles },
    });
    if (!res.delivered) return unreachable({});
    const assignments = res.data?.data?.assignments ?? {};
    const out: Record<string, string | null> = {};
    for (const role of roles) out[role] = assignments[role] ?? null;
    return { value: out, available: true };
  } catch {
    return unreachable({});
  }
}
