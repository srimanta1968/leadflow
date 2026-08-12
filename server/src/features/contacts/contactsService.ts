import { dataService } from '../../services/DataService';
import { config } from '../../config/env';
import { SdkGatewayClient } from '../../platform/sdkGateway';

/**
 * Reads for the Contacts workspace and the Contact 360 tabs.
 *
 * EVERY RESPONSE CARRIES `upstream_available` AND `field_gaps`, because most of
 * what this screen shows belongs to ProjexCloud rather than to LeadFlow, and a
 * panel that renders blank when an SDK is down is indistinguishable from one
 * rendering a person who genuinely has no history. The client contract was
 * built around that distinction; these reads honour it rather than throwing.
 */

export interface Gap { field: string; reason: string }

/** A read that answers "what did we get, and was anybody home". */
export async function probe<T>(
  sdk: string, path: string, method: 'GET' | 'POST' = 'GET', body?: unknown
): Promise<{ data: T | null; available: boolean }> {
  if (!SdkGatewayClient.isConfigured()) return { data: null, available: false };
  try {
    const result = await SdkGatewayClient.call<{ data?: T }>({
      sdk, path, method, ...(body === undefined ? {} : { body }),
      idempotencyKey: `contacts-read:${sdk}:${path}`,
    });
    /*
     * A 404 IS AN ANSWER, NOT AN OUTAGE. "This person has no property
     * relationships" and "the relationship service is down" must not render the
     * same way, so a delivered-but-empty response reports available: true.
     */
    return { data: (result.data?.data ?? null) as T | null, available: result.delivered };
  } catch {
    return { data: null, available: false };
  }
}

const gap = (field: string, sdk: string): Gap => ({
  field,
  reason: `${sdk} could not be reached, so this is unknown rather than absent.`,
});

/* ------------------------------------------------------------ the list */

export interface ContactRow {
  contact_id: string; canonical_id: string | null; display_name: string | null;
  initials: string; trust_state: string | null; role: string | null;
  contact_point_summary: string | null; property_summary: string | null;
  origin: string | null; channel_state: string | null; channel_reason: string | null;
  owner: string | null; updated_at: string | null;
}

/**
 * The facet options the list offers.
 *
 * `owners` holds IDs because that is what the filter matches on; `owner_names`
 * maps each to a label. Two separate fields rather than one list of pairs, so
 * the other four facets keep the plain string[] shape the client already
 * renders — and so a filter can never accidentally be keyed on a display name,
 * which stops being unique the moment two colleagues share one.
 */
export interface ContactListFacets {
  entity_types: string[];
  trust_states: string[];
  origins: string[];
  channel_states: string[];
  owners: string[];
  owner_names: Record<string, string>;
}

const initialsOf = (name: string | null): string => {
  if (!name) return '??';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '??';
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
};

/**
 * The faceted list, from the local lead projection.
 *
 * READ LOCALLY rather than from sdk-search, deliberately. The projection is the
 * only place that knows which contacts this tenant has actually worked, and a
 * search index that has not caught up would drop a lead somebody created two
 * minutes ago — which on a worklist reads as the lead being lost.
 */
export async function listContacts(filters: {
  entity_type?: string; trust_state?: string; origin?: string;
  channel_state?: string; owner?: string; q?: string;
}): Promise<{ rows: ContactRow[]; total: number; facets: ContactListFacets }> {
  const where: string[] = ['1=1'];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown): void => {
    params.push(value);
    where.push(clause.replace('$?', `$${params.length}`));
  };

  if (filters.origin) add('COALESCE(l.source, \'unknown\') = $?', filters.origin);
  if (filters.owner) add('l.owner_user_id::text = $?', filters.owner);
  if (filters.q) add('(l.name ILIKE $? OR l.email ILIKE $?)'.replace('$?', `$${params.length + 1}`), `%${filters.q}%`);

  const rows = await dataService.query<{
    id: string; name: string | null; email: string | null; source: string | null;
    stage: string | null; owner_user_id: string | null; owner_name: string | null;
    updated_at: string | null;
    canonical_email: string | null; canonical_phone: string | null;
  }>(
    // The owner's NAME, joined. The column is here so a rep can see who to
    // chase; an id answers a question nobody asked.
    `SELECT l.id, l.name, l.email, l.source, l.stage, l.owner_user_id::text AS owner_user_id,
            COALESCE(
              NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''),
              u.email
            ) AS owner_name,
            l.updated_at, l.canonical_email, l.canonical_phone
       FROM leads l
       LEFT JOIN users u ON u.id = l.owner_user_id
      WHERE ${where.join(' AND ')}
      ORDER BY l.updated_at DESC NULLS LAST
      LIMIT 200`,
    params
  );

  const total = await dataService.query<{ v: string }>(
    `SELECT COUNT(*)::text AS v FROM leads l WHERE ${where.join(' AND ')}`, params
  );

  const facetRows = await dataService.query<{
    origin: string; owner: string | null; owner_name: string | null; stage: string | null;
  }>(
    `SELECT DISTINCT COALESCE(l.source,'unknown') AS origin,
            l.owner_user_id::text AS owner,
            COALESCE(
              NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''),
              u.email
            ) AS owner_name,
            l.stage
       FROM leads l
       LEFT JOIN users u ON u.id = l.owner_user_id
      LIMIT 500`
  );

  return {
    rows: rows.map((r) => ({
      contact_id: r.id,
      canonical_id: r.canonical_email ?? r.canonical_phone ?? null,
      display_name: r.name,
      initials: initialsOf(r.name),
      /* NOT INVENTED. Trust state lives in the identity platform; the list says
         null rather than guessing P2, because a made-up trust state on a
         worklist is acted on as though somebody had established it. */
      trust_state: null,
      role: null,
      contact_point_summary: [r.email, r.canonical_phone].filter(Boolean).join(' · ') || null,
      property_summary: null,
      origin: r.source ?? 'unknown',
      channel_state: null,
      channel_reason: null,
      owner: r.owner_name,
      updated_at: r.updated_at,
    })),
    total: Number(total[0]?.v ?? 0),
    facets: {
      entity_types: ['person', 'organization'],
      trust_states: ['P0', 'P1', 'P2', 'P3', 'P4'],
      origins: [...new Set(facetRows.map((f) => f.origin))].filter(Boolean),
      channel_states: ['eligible', 'review', 'suppressed'],
      /* The ID remains the option VALUE, because that is what the filter matches
         on — a label cannot be a filter key without breaking the moment two
         people share a name. `owner_names` carries the label separately. */
      owners: [...new Set(facetRows.map((f) => f.owner).filter((o): o is string => o !== null))],
      owner_names: Object.fromEntries(
        facetRows
          .filter((f): f is typeof f & { owner: string } => f.owner !== null)
          .map((f) => [f.owner, f.owner_name ?? f.owner])
      ),
    },
  };
}

export const listGaps = (searchAvailable: boolean): Gap[] => ([
  { field: 'trust_state', reason: 'Trust state is held by the identity platform and is not projected into the local list, so it is reported as unknown rather than guessed.' },
  { field: 'channel_state', reason: 'Eligibility is evaluated per purpose and channel at send time; a stored verdict on a list row would outlive the consent that produced it.' },
  { field: 'property_summary', reason: 'Property relationships are read per contact from sdk-rebac rather than joined into the list, which would be one traversal per row.' },
  ...(searchAvailable ? [] : [gap('search_ranking', 'sdk-search')]),
]);

/* --------------------------------------------------------- one contact */

export async function localContact(contactId: string): Promise<{
  id: string; name: string | null; email: string | null; source: string | null;
  stage: string | null; owner_user_id: string | null; created_at: string | null;
  updated_at: string | null; canonical_email: string | null; canonical_phone: string | null;
  source_timestamp: string | null; next_action: string | null; next_due_at: string | null;
  owner_name: string | null;
} | null> {
  const rows = await dataService.query<{
    id: string; name: string | null; email: string | null; source: string | null;
    stage: string | null; owner_user_id: string | null; created_at: string | null;
    updated_at: string | null; canonical_email: string | null; canonical_phone: string | null;
    source_timestamp: string | null; next_action: string | null; next_due_at: string | null;
    owner_name: string | null;
  }>(
    // owner_name is JOINED, not derived at render time. The record header showed
    // the raw owner UUID because the controller had nothing else to put there —
    // an id displayed where a person's name belongs reads as data corruption to
    // whoever sees it. Same COALESCE as LeadCaptureService.LEAD_SELECT: a full
    // name when there is one, the email when there is not, NULL when the owner
    // is not a local user, so the caller can say "Not recorded" honestly.
    `SELECT l.id, l.name, l.email, l.source, l.stage, l.owner_user_id::text AS owner_user_id, l.created_at,
            l.updated_at, l.canonical_email, l.canonical_phone, l.source_timestamp, l.next_action, l.next_due_at,
            COALESCE(
              NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''),
              u.email
            ) AS owner_name
       FROM leads l
       LEFT JOIN users u ON u.id = l.owner_user_id
      WHERE l.id::text = $1 LIMIT 1`,
    [contactId]
  );
  return rows[0] ?? null;
}

/**
 * The trust rail: how far this record has travelled toward being operational.
 *
 * Each node is derived from a fact that already exists rather than from a stored
 * status column. A status column drifts from the facts it summarises, and this
 * rail is exactly the thing somebody uses to decide whether to trust the record.
 */
export function trustRail(contact: {
  source: string | null; canonical_email: string | null; canonical_phone: string | null;
  owner_user_id: string | null; stage: string | null;
}): { node: string; state: 'reached' | 'current' | 'pending' | 'blocked'; evidence: string | null }[] {
  const captured = Boolean(contact.source);
  const canonical = Boolean(contact.canonical_email ?? contact.canonical_phone);
  const owned = Boolean(contact.owner_user_id);
  const worked = Boolean(contact.stage);

  const state = (done: boolean, prior: boolean): 'reached' | 'current' | 'pending' =>
    done ? 'reached' : prior ? 'current' : 'pending';

  return [
    { node: 'Captured', state: state(captured, true), evidence: contact.source ? `Arrived from ${contact.source}.` : null },
    { node: 'Canonicalised', state: state(canonical, captured), evidence: canonical ? 'A canonical contact point was resolved.' : null },
    { node: 'Owned', state: state(owned, canonical), evidence: owned ? 'A named owner holds this record.' : null },
    { node: 'Worked', state: state(worked, owned), evidence: contact.stage ? `At stage ${contact.stage}.` : null },
  ];
}

/* ---------------------------------------------------------- saved views */

export interface SavedViewRow {
  view_id: string; name: string; description: string | null;
  filters: Record<string, string>; scope: string; pinned: boolean;
  pin_order: number | null; shipped: boolean; owner: string | null;
}

export async function savedViews(userId: string | null): Promise<SavedViewRow[]> {
  return dataService.query<SavedViewRow>(
    `SELECT id AS view_id, name, description, filters, scope, pinned, pin_order, shipped,
            owner_user_id::text AS owner
       FROM leadflow_saved_view
      WHERE tenant_id = $1
        AND (scope <> 'private' OR owner_user_id::text = $2)
      ORDER BY pinned DESC, pin_order NULLS LAST, name`,
    [config.projexCloud.tenantId, userId]
  );
}

/**
 * Live counts for the pinned views.
 *
 * NULL, NEVER ZERO, for a view whose count could not be computed. Zero is a
 * real answer that says "nothing matches, move on"; a failed count that renders
 * as zero tells somebody their queue is empty when it is not.
 */
export async function viewCounts(views: SavedViewRow[]): Promise<Record<string, number | null>> {
  const counts: Record<string, number | null> = {};
  for (const view of views.filter((v) => v.pinned)) {
    try {
      const result = await listContacts((view.filters ?? {}) as Record<string, string>);
      counts[view.view_id] = result.total;
    } catch {
      counts[view.view_id] = null;
    }
  }
  return counts;
}
