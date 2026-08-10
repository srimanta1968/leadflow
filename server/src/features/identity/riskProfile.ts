import { dataService } from '../../services/DataService';

/**
 * The tenant's auto-link policy: read per request, written as a new version.
 *
 * READ PER REQUEST IS THE POINT (AC1). The policy lives in the database, not in
 * config or an environment variable, so raising a threshold changes behaviour on
 * the next call rather than on the next deploy. A rule about what the system may
 * do to real records without a human watching should not need a release to
 * tighten.
 */

export interface RiskProfile {
  version_id: string;
  tenant_id: string;
  auto_link_threshold: number;
  review_floor: number;
  crosswalk_auto_links: boolean;
  phone_and_property_auto_links: boolean;
  conflict_forces_case: boolean;
  weights: Record<string, unknown>;
  created_by_user_id: string;
  reason: string;
  supersedes_version_id: string | null;
  created_at: string;
}

/**
 * The policy a tenant has never set.
 *
 * Mirrors sdk-identity-resolver's own bands (bandRange: high at 0.9, medium from
 * 0.7) so a tenant that never tunes anything behaves exactly as the resolver
 * expects, rather than to a default we invented that quietly disagrees with the
 * service raising the candidates.
 */
export const DEFAULT_PROFILE = {
  auto_link_threshold: 0.9,
  review_floor: 0.7,
  crosswalk_auto_links: true,
  phone_and_property_auto_links: true,
  conflict_forces_case: true,
  weights: {} as Record<string, unknown>,
};

/** Postgres returns NUMERIC as a string; the API must not leak that. */
const num = (value: unknown): number =>
  typeof value === 'number' ? value : Number.parseFloat(String(value));

function toProfile(row: Record<string, unknown>): RiskProfile {
  return {
    version_id: String(row.version_id),
    tenant_id: String(row.tenant_id),
    auto_link_threshold: num(row.auto_link_threshold),
    review_floor: num(row.review_floor),
    crosswalk_auto_links: row.crosswalk_auto_links === true,
    phone_and_property_auto_links: row.phone_and_property_auto_links === true,
    conflict_forces_case: row.conflict_forces_case === true,
    weights: (row.weights ?? {}) as Record<string, unknown>,
    created_by_user_id: String(row.created_by_user_id),
    reason: String(row.reason),
    supersedes_version_id: row.supersedes_version_id ? String(row.supersedes_version_id) : null,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

/**
 * The live policy, or null when the tenant has never set one.
 *
 * NULL IS NOT AN ERROR and is deliberately distinct from the defaults: a caller
 * that wants to show "this tenant has never tuned anything" can, and the
 * resolver path can fall back to DEFAULT_PROFILE without pretending somebody
 * chose it.
 */
export async function readActiveProfile(tenantId: string): Promise<RiskProfile | null> {
  const row = await dataService.queryOne<Record<string, unknown>>(
    `SELECT * FROM leadflow_identity_risk_profile
      WHERE tenant_id = $1 AND superseded_at IS NULL`,
    [tenantId]
  );
  return row ? toProfile(row) : null;
}

/** One earlier version, for the history panel and for reverting. */
export async function listProfileHistory(tenantId: string, limit = 20): Promise<RiskProfile[]> {
  const rows = await dataService.query<Record<string, unknown>>(
    `SELECT * FROM leadflow_identity_risk_profile
      WHERE tenant_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [tenantId, limit]
  );
  return rows.map(toProfile);
}

export interface ProfileChange {
  auto_link_threshold: number;
  review_floor: number;
  crosswalk_auto_links: boolean;
  phone_and_property_auto_links: boolean;
  weights: Record<string, unknown>;
  reason: string;
  created_by_user_id: string;
}

/**
 * Append a new version and retire the previous one.
 *
 * BOTH STATEMENTS IN ONE TRANSACTION, and the order matters. The partial unique
 * index allows exactly one row per tenant with `superseded_at IS NULL`, so the
 * insert would collide with the outgoing version if it went first. Superseding
 * first and inserting second means a crash between them leaves a tenant with NO
 * active policy — which reads as "never configured" and falls back to the
 * resolver's own bands, rather than leaving two active policies where nothing
 * can say which one was in force. Given a choice between an absent rule and an
 * ambiguous one, absent is recoverable.
 *
 * @returns The version that is now live.
 */
export async function writeProfileVersion(
  tenantId: string,
  change: ProfileChange
): Promise<RiskProfile> {
  // `transaction` hands back a raw pg PoolClient, so this speaks client.query
  // and reads rows[0] rather than the dataService helpers.
  return dataService.transaction(async (client) => {
    const retired = await client.query<{ version_id: string }>(
      `UPDATE leadflow_identity_risk_profile
          SET superseded_at = now()
        WHERE tenant_id = $1 AND superseded_at IS NULL
        RETURNING version_id`,
      [tenantId]
    );

    const inserted = await client.query<Record<string, unknown>>(
      `INSERT INTO leadflow_identity_risk_profile
         (tenant_id, auto_link_threshold, review_floor, crosswalk_auto_links,
          phone_and_property_auto_links, weights, created_by_user_id, reason,
          supersedes_version_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
       RETURNING *`,
      [
        tenantId,
        change.auto_link_threshold,
        change.review_floor,
        change.crosswalk_auto_links,
        change.phone_and_property_auto_links,
        JSON.stringify(change.weights ?? {}),
        change.created_by_user_id,
        change.reason,
        retired.rows[0]?.version_id ?? null,
      ]
    );

    const row = inserted.rows[0];
    if (!row) {
      throw new Error('risk profile version could not be written');
    }
    return toProfile(row);
  });
}
