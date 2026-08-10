import { degradingRead, Reached } from '../../platform/sdkGateway/degradingRead';

/**
 * Typed reads of sdk-identity-resolver's EMPI surface.
 *
 * THESE THREE ROUTES ARE ABSENT FROM `sdk-capability.json`. They are real and
 * mounted — `packages/sdk-identity-resolver/src/server/routes.ts` declares
 * `/api/empi/candidate-links`, `/api/empi/candidate-links/:link_id/*` and
 * `/api/empi/metrics` — but the capability manifest lists only
 * `/api/resolver/resolve` and `/api/resolver/explain`. The manifest is the
 * document anyone integrating reads FIRST, so the shapes below were taken from
 * the handler and the service, never from the manifest. Raised as a handoff.
 */

/** A possible-same match awaiting adjudication, as `CandidateLink` returns it. */
export interface CandidateLinkRow {
  link_id?: string;
  person_id_a?: string;
  person_id_b?: string;
  confidence?: number;
  match_type?: string;
  provenance?: Record<string, unknown> | null;
  status?: string;
  steward_request_id?: string | null;
  created_at?: string;
  updated_at?: string;
}

/** EMPI observability, verbatim from `EmpiMetrics`. */
export interface EmpiMetricsRow {
  unresolved_candidate_links?: number;
  merge_reversals?: number;
  total_merges?: number;
  calibration_ece?: number;
  confidence_distribution?: { band?: string; count?: number }[];
  drift_alert?: boolean;
}

const asArray = <T>(body: unknown, key: string): T[] => {
  const bag = (body ?? {}) as Record<string, unknown>;
  const raw = bag[key];
  return Array.isArray(raw) ? (raw as T[]) : [];
};

/**
 * The open candidate links a steward has to work.
 *
 * `status=open` is pinned rather than exposed. A merged or rejected link is a
 * decision somebody already took; putting it in a REVIEW queue invites it to be
 * taken again, and a steward re-adjudicating a settled case is how a link gets
 * quietly retracted by accident.
 *
 * @param band  Optional confidence band filter, already validated by the caller.
 * @param limit Upstream clamps this to 500 itself.
 */
export async function listOpenCandidateLinks(
  band: string | undefined,
  limit: number
): Promise<Reached<CandidateLinkRow[]>> {
  const params = new URLSearchParams({ status: 'open', limit: String(limit) });
  if (band) {
    params.set('band', band);
  }
  return degradingRead<CandidateLinkRow[]>(
    'sdk-identity-resolver',
    `/api/empi/candidate-links?${params.toString()}`,
    [],
    (body) => asArray<CandidateLinkRow>(body, 'candidate_links')
  );
}

/** EMPI's counters and calibration. */
export async function readEmpiMetrics(): Promise<Reached<EmpiMetricsRow | null>> {
  return degradingRead<EmpiMetricsRow | null>(
    'sdk-identity-resolver',
    '/api/empi/metrics',
    null,
    (body) => {
      const bag = (body ?? {}) as Record<string, unknown>;
      const metrics = bag.metrics;
      return metrics && typeof metrics === 'object' ? (metrics as EmpiMetricsRow) : null;
    }
  );
}
