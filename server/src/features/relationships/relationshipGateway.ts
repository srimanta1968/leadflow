import { SdkGatewayClient } from '../../platform/sdkGateway';
import { degradingRead, unreachable, type Reached } from '../../platform/sdkGateway/degradingRead';
import { upstreamStatusOf } from '../../platform/sdkGateway/errorMapping';
import { config } from '../../config/env';
import type { Role, TrustState } from './roleVocabulary';

/**
 * Typed access to sdk-rebac's bitemporal contextual-role surface.
 *
 * THE PLATFORM ALREADY MODELS THIS PROPERLY, which is why this file is thin.
 * sdk-rebac's contextualRoleService gives role_label for concurrent roles,
 * valid_from/valid_to for their independent lives, an evidence rule enforced by
 * both a service check AND a database CHECK constraint, and a traversal budget on
 * reachability. LeadFlow's job is the vocabulary, the composition and the
 * refusals — not a second implementation of bitemporality.
 */

/** One contextual role, as `ContextualRole` returns it. */
export interface ContextualRoleRow {
  relationship_id?: string;
  kind?: string;
  persona_a?: string;
  persona_b?: string;
  role_label?: string | null;
  trust_state?: string;
  valid_from?: string;
  valid_to?: string | null;
  closed_reason?: string | null;
  evidence_refs?: string[];
  scope?: Record<string, unknown>;
  status?: string;
  created_at?: string;
}

/** What a reachability walk concluded, and what it cost. */
export interface ReachabilityResult {
  decision?: 'allow' | 'deny';
  reason?: string;
  traversal_depth?: number;
  budget_used?: { visits?: number; depth?: number };
  cached?: boolean;
}

const SDK = 'sdk-rebac';

/**
 * The roles attached to a subject.
 *
 * `kind` is pinned to the LeadFlow namespace so a tenant using sdk-rebac for
 * something else entirely does not have its edges surface on this screen.
 */
export async function listRoles(input: {
  subjectRef: string;
  objectRef?: string;
  role?: Role;
  trustState?: TrustState;
  includeClosed: boolean;
  asOf?: string;
  limit: number;
}): Promise<Reached<ContextualRoleRow[]>> {
  const params = new URLSearchParams({
    persona_a: input.subjectRef,
    limit: String(input.limit),
  });
  if (input.objectRef) params.set('persona_b', input.objectRef);
  if (input.role) params.set('role_label', input.role);
  if (input.trustState) params.set('trust_state', input.trustState);
  // Only sent when true: the upstream reads the literal string 'true', so
  // sending 'false' explicitly is the same as omitting it but harder to read.
  if (input.includeClosed) params.set('include_closed', 'true');
  if (input.asOf) params.set('as_of', input.asOf);

  return degradingRead<ContextualRoleRow[]>(
    SDK,
    `/api/relationships/roles?${params.toString()}`,
    [],
    (body) => {
      const bag = (body ?? {}) as Record<string, unknown>;
      return Array.isArray(bag.roles) ? (bag.roles as ContextualRoleRow[]) : [];
    }
  );
}

/**
 * Establish one role.
 *
 * A 409 IS RETURNED AS A 409, not folded into an outage. Upstream answers it when
 * a live role of the same kind already exists for the pair, which is a genuine
 * conflict the caller can act on — end the existing one, or re-attest it — and
 * reporting it as "the graph is down" would send them to look for an incident
 * that never happened.
 */
export async function grantRole(input: {
  subjectRef: string;
  objectRef: string;
  role: Role;
  trustState: TrustState;
  evidenceRefs: string[];
  validFrom?: string;
  scope?: Record<string, unknown>;
}): Promise<{ ok: true; role: ContextualRoleRow } | { ok: false; conflict: boolean }> {
  try {
    const result = await SdkGatewayClient.call<{ data?: { role?: ContextualRoleRow } }>({
      sdk: SDK,
      path: '/api/relationships/roles',
      method: 'POST',
      // Keyed on the pair and the role, so a retry after a timeout cannot create
      // a second live role for a relationship that already exists.
      idempotencyKey: `rel-role:${input.subjectRef}:${input.objectRef}:${input.role}`,
      body: {
        tenant_id: config.projexCloud.tenantId,
        kind: 'leadflow_contextual_role',
        persona_a: input.subjectRef,
        persona_b: input.objectRef,
        role_label: input.role,
        trust_state: input.trustState,
        evidence_refs: input.evidenceRefs,
        valid_from: input.validFrom,
        scope: input.scope,
      },
    });
    if (!result.delivered || !result.data?.data?.role) return { ok: false, conflict: false };
    return { ok: true, role: result.data.data.role };
  } catch (error) {
    return { ok: false, conflict: upstreamStatusOf(error) === 409 };
  }
}

/**
 * Close a role by dating it.
 *
 * NEVER A DELETE, and the verb upstream is `scope` rather than `delete` for the
 * same reason. Setting valid_to keeps the row answering "who was the decision
 * maker last March", which is exactly the question asked when something has gone
 * wrong.
 *
 * IDEMPOTENT UPSTREAM: closing an already-closed role returns it unchanged
 * rather than moving the date, because the first close is when it actually
 * stopped being true and a retry must not rewrite that.
 */
export async function closeRole(input: {
  relationshipId: string;
  reason: string;
  validTo?: string;
}): Promise<Reached<ContextualRoleRow | null>> {
  try {
    const result = await SdkGatewayClient.call<{ data?: { role?: ContextualRoleRow } }>({
      sdk: SDK,
      path: `/api/relationships/${encodeURIComponent(input.relationshipId)}/scope`,
      method: 'PUT',
      idempotencyKey: `rel-close:${input.relationshipId}`,
      body: {
        tenant_id: config.projexCloud.tenantId,
        status: 'terminated',
        valid_to: input.validTo,
        closed_reason: input.reason,
      },
    });
    if (!result.delivered) return unreachable(null);
    return { value: result.data?.data?.role ?? null, available: true };
  } catch (error) {
    // A 404 is an ANSWER: no such relationship. The caller turns that into its
    // own 404 rather than reporting the graph as unreachable.
    if (upstreamStatusOf(error) === 404) return { value: null, available: true };
    return unreachable(null);
  }
}

/**
 * Ask whether one persona is reachable from another, under a bounded walk.
 *
 * THE BUDGET IS ALWAYS SENT, never left to the upstream default. Two services
 * each holding their own idea of the cap is how a deny comes to mean different
 * things on different screens, and the whole value of a bounded traversal is
 * that "not reachable" has one defined meaning.
 */
export async function checkReachable(input: {
  subjectRef: string;
  targetRef: string;
  depthCap: number;
  visitCap: number;
}): Promise<Reached<ReachabilityResult | null>> {
  try {
    const result = await SdkGatewayClient.call<{ data?: ReachabilityResult }>({
      sdk: SDK,
      path: '/api/relationships/check',
      method: 'POST',
      body: {
        tenant_id: config.projexCloud.tenantId,
        subject_persona_id: input.subjectRef,
        target_persona_id: input.targetRef,
        kind: 'leadflow_contextual_role',
        budget: { depth_cap: input.depthCap, visit_cap: input.visitCap },
      },
    });
    if (!result.delivered) return unreachable(null);
    return { value: result.data?.data ?? null, available: true };
  } catch {
    return unreachable(null);
  }
}
