import { degradingRead, unreachable, type Reached } from '../../platform/sdkGateway/degradingRead';
import { SdkGatewayClient } from '../../platform/sdkGateway';

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

/** The resolver's own account of a match, from POST /api/resolver/explain. */
export interface ResolverExplanation {
  score?: number;
  rules?: { rule?: string; matched?: boolean; weight?: string | number; detail?: string }[];
  features?: Record<string, unknown>;
  explanation?: string;
}

/**
 * Ask the resolver why it proposed this link.
 *
 * A WRITE VERB FOR A READ, which is why this does not use `degradingRead`:
 * `/api/resolver/explain` is a POST because the signal bundle goes in the body,
 * but it changes nothing. It still degrades rather than throwing — a modal that
 * cannot show the reasoning must say so and keep the evidence table, not fail
 * the whole screen, because the steward can still read the comparison.
 */
export async function explainResolution(linkId: string): Promise<Reached<ResolverExplanation | null>> {
  if (!SdkGatewayClient.isConfigured()) {
    return unreachable(null);
  }
  try {
    const result = await SdkGatewayClient.call<{ data?: unknown }>({
      sdk: 'sdk-identity-resolver',
      path: '/api/resolver/explain',
      method: 'POST',
      body: { link_id: linkId },
    });
    if (!result.delivered) {
      return unreachable(null);
    }
    const bag = (result.data?.data ?? {}) as Record<string, unknown>;
    const explanation = (bag.explanation ?? bag) as ResolverExplanation;
    return { value: explanation, available: true };
  } catch {
    return unreachable(null);
  }
}

/**
 * Put a candidate in front of a steward, producing the approval step a decision
 * is later recorded against.
 *
 * @returns The pending step ids; the first is the one the decision uses.
 */
export async function enqueueStewardReview(
  linkId: string,
  routeId: string
): Promise<{ pending_step_ids: string[] }> {
  const result = await SdkGatewayClient.call<{ data?: { pending_step_ids?: string[] } }>({
    sdk: 'sdk-identity-resolver',
    path: `/api/empi/candidate-links/${encodeURIComponent(linkId)}/steward-review`,
    method: 'POST',
    idempotencyKey: `steward-review:${linkId}`,
    body: { route_id: routeId },
  });
  return { pending_step_ids: result.data?.data?.pending_step_ids ?? [] };
}

/**
 * Record the steward's decision.
 *
 * `approve` writes a merge EVENT — an assertion that these two are the same —
 * and does NOT collapse the records: `mergeRecords` only inserts into
 * `empi.merge_event` and flips the link's status. Both person ids survive
 * inside the event, which is precisely what lets `unmerge` reverse it. The
 * returned `merge_id` is that reversibility reference.
 */
export async function adjudicateCandidate(
  linkId: string,
  stepId: string,
  decision: 'approve' | 'reject',
  reason: string
): Promise<{ merge_id: string | null; status: string | null }> {
  const result = await SdkGatewayClient.call<{
    data?: { link?: { status?: string }; merge?: { merge_id?: string } | null };
  }>({
    sdk: 'sdk-identity-resolver',
    path: `/api/empi/candidate-links/${encodeURIComponent(linkId)}/adjudicate`,
    method: 'POST',
    idempotencyKey: `adjudicate:${linkId}:${stepId}`,
    body: { step_id: stepId, decision, reason },
  });
  return {
    merge_id: result.data?.data?.merge?.merge_id ?? null,
    status: result.data?.data?.link?.status ?? null,
  };
}
