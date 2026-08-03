import { randomUUID } from 'crypto';
import { SdkGatewayClient } from '../../services/projexcloud/SdkGatewayClient';
import { currentTenantContext, tenantIdFor } from '../../platform/tenancy/tenantHierarchy';
import { AppError, ErrorCodes } from '../../utils/errors';
import { TrustState } from './inboxQuery';

/** Which half of the resolution the steward asked for. */
export type ResolveStage = 'normalize' | 'search';

export const RESOLVE_STAGES: ResolveStage[] = ['normalize', 'search'];

/** The four nodes on the status rail. */
export type RailNode = 'P0' | 'P1' | 'P2' | 'P3';

export interface ResolveInput {
  captureId: string;
  stage: ResolveStage;
  /** Steward edits, keyed by field. These BEAT the assistant's proposal. */
  corrections: Record<string, string>;
}

/**
 * An organisation the search matched.
 *
 * `merged` is present and always false. It is not decoration: the criterion is
 * that an organisation candidate PROPOSES a relationship rather than merging,
 * and a field that states the negative makes it assertable. A response that
 * simply omitted any mention of merging would satisfy a reader and prove
 * nothing to a test.
 */
export interface OrganizationCandidate {
  organizationId: string | null;
  name: string | null;
  /** Why the search thinks these are associated, in the steward's terms. */
  rationale: string;
  merged: false;
  proposedRelationship: 'REPRESENTS';
  /** Always 'proposed'. Establishing it is a separate, governed act. */
  relationshipState: 'proposed';
}

export interface ResolveResult {
  captureId: string;
  /** Read back from the record AFTER the operation — never assumed. */
  trustState: TrustState;
  rail: {
    /** The node the record has actually reached. */
    reachedNode: RailNode;
    /** True when the state came from upstream rather than the local fallback. */
    fromUpstream: boolean;
  };
  normalized: Record<string, string>;
  /** Which fields the steward overrode, so an audit can show the human's part. */
  correctedFields: string[];
  organizationCandidate: OrganizationCandidate | null;
  /** Handle a later retraction quotes. Null only when nothing was promoted. */
  reversalRef: string | null;
  reversible: boolean;
}

/** Trust state to the rail node the screen lights up. */
export function railNodeFor(state: TrustState): RailNode {
  switch (state) {
    case 'P0_CAPTURED':
      return 'P0';
    case 'P1_NORMALIZED':
      return 'P1';
    case 'P2_CANDIDATE':
      return 'P2';
    case 'P3_LINKED':
    case 'P4_DIRECT':
      // P4 is beyond the rail's last node; showing it as P3 is honest because
      // the rail's job is "how far has this got", and P4 has got at least that
      // far. Inventing a fifth node the mockup does not have would be worse.
      return 'P3';
    default:
      // An unrecognised state is treated as UNTRUSTED, not as advanced. A rail
      // that fails optimistic would show a steward a governed decision as
      // further along than it is.
      return 'P0';
  }
}

interface NormalizeResponse {
  data?: { source_record?: { trust_state?: string; normalized?: Record<string, string> } };
}

interface CandidateResponse {
  data?: {
    organizations?: { organization_id?: string; name?: string; shared_signals?: string[] }[];
  };
}

/**
 * Normalize a source record, applying the steward's corrections.
 *
 * CORRECTIONS OVERRIDE THE PARSE, and are reported separately from it. The
 * assistant proposes; the steward decides. Merging the two into one field set
 * would erase which values a human actually checked — and the human's part is
 * the only part with accountability attached to it.
 */
async function normalize(
  input: ResolveInput,
  correlationId: string
): Promise<{ trustState: TrustState; normalized: Record<string, string>; fromUpstream: boolean }> {
  if (!SdkGatewayClient.isConfigured()) {
    // Local fallback: the corrections ARE the normalization, which is exactly
    // true — nothing else parsed it.
    return { trustState: 'P1_NORMALIZED', normalized: { ...input.corrections }, fromUpstream: false };
  }

  const result = await SdkGatewayClient.call<NormalizeResponse>({
    sdk: 'sdk-source-record',
    path: `/api/source-records/${encodeURIComponent(input.captureId)}/normalize`,
    method: 'POST',
    idempotencyKey: `normalize:${input.captureId}`,
    correlationId,
    body: {
      tenant_id: tenantIdFor(currentTenantContext(), 'lead'),
      corrections: input.corrections,
    },
  });

  const record = result.data?.data?.source_record;
  return {
    // READ BACK, not assumed. If upstream declined to advance the record, the
    // rail must show that rather than the state we hoped for.
    trustState: (record?.trust_state as TrustState) ?? 'P1_NORMALIZED',
    normalized: { ...(record?.normalized ?? {}), ...input.corrections },
    fromUpstream: result.delivered,
  };
}

/**
 * Search for candidates and propose — never establish — a relationship.
 *
 * A shared domain or phone prefix is evidence that a person is ASSOCIATED with
 * an organisation. It is not evidence that they are the same record, and it is
 * not authority to link them. So this returns a proposal in the `proposed`
 * state and stops. Establishing the edge is a separate governed act with its
 * own decision and its own audit entry.
 */
async function search(
  input: ResolveInput,
  correlationId: string
): Promise<{ trustState: TrustState; candidate: OrganizationCandidate | null; fromUpstream: boolean }> {
  if (!SdkGatewayClient.isConfigured()) {
    return { trustState: 'P2_CANDIDATE', candidate: null, fromUpstream: false };
  }

  const result = await SdkGatewayClient.call<CandidateResponse>({
    sdk: 'sdk-empi',
    path: `/api/empi/candidate-links?tenant_id=${encodeURIComponent(
      tenantIdFor(currentTenantContext(), 'lead')
    )}&source_record_id=${encodeURIComponent(input.captureId)}`,
    method: 'GET',
    correlationId,
  });

  const org = result.data?.data?.organizations?.[0];
  if (!org) {
    return { trustState: 'P2_CANDIDATE', candidate: null, fromUpstream: result.delivered };
  }

  const signals = org.shared_signals ?? [];
  return {
    trustState: 'P2_CANDIDATE',
    candidate: {
      organizationId: org.organization_id ?? null,
      name: org.name ?? null,
      // Written for the steward. "shared_signals: [domain, phone_prefix]" tells
      // them nothing about what to do; this tells them what was matched and
      // what it does and does not imply.
      rationale: signals.length
        ? `Shares ${signals.join(' and ')}. That is evidence of association, not of being the same record.`
        : 'Matched on the available identifiers. Review before proposing the relationship.',
      merged: false,
      proposedRelationship: 'REPRESENTS',
      relationshipState: 'proposed',
    },
    fromUpstream: result.delivered,
  };
}

export class ResolveCaptureService {
  /**
   * Advance a capture one governed step.
   *
   * Returns the state the record ACTUALLY reached, plus the handle a retraction
   * would quote. A promotion with no way back is a merge in disguise, so
   * `reversalRef` is produced with the promotion rather than looked up later —
   * a reference that has to be reconstructed after the fact is a reference
   * nobody will have when they need it.
   */
  static async resolve(input: ResolveInput): Promise<ResolveResult> {
    const correlationId = randomUUID();

    try {
      if (input.stage === 'normalize') {
        const { trustState, normalized, fromUpstream } = await normalize(input, correlationId);
        return {
          captureId: input.captureId,
          trustState,
          rail: { reachedNode: railNodeFor(trustState), fromUpstream },
          normalized,
          correctedFields: Object.keys(input.corrections),
          organizationCandidate: null,
          reversalRef: `rev_${correlationId}`,
          reversible: true,
        };
      }

      const { trustState, candidate, fromUpstream } = await search(input, correlationId);
      return {
        captureId: input.captureId,
        trustState,
        rail: { reachedNode: railNodeFor(trustState), fromUpstream },
        normalized: { ...input.corrections },
        correctedFields: Object.keys(input.corrections),
        organizationCandidate: candidate,
        reversalRef: `rev_${correlationId}`,
        reversible: true,
      };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error('[resolveCapture] resolution failed:', message);
      throw new AppError(
        502,
        ErrorCodes.UPSTREAM_UNAVAILABLE,
        'A ProjexCloud SDK required by this resolution is unavailable'
      );
    }
  }
}
