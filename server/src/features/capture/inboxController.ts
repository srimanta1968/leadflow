import { Response } from 'express';
import { config } from '../../config/env';
import { AuthenticatedRequest } from '../../middleware/auth';
import { SdkGatewayClient } from '../../services/projexcloud/SdkGatewayClient';
import { PlatformRequest } from '../../platform/auth/sessionContext';
import { evaluateBatch } from '../../platform/policy/policyEngine';
import {
  availableActions,
  encodeCursor,
  InboxQuery,
  parseInboxQuery,
  TrustState,
} from './inboxQuery';

/** One row as sdk-source-record returns it. */
interface SourceRecordRow {
  capture_id?: string;
  trust_state?: string;
  origin_class?: string;
  evidence_ref?: string;
  quarantine_reason?: string;
  created_at?: string;
}

/** The headline counts across the top of the screen. */
interface InboxCounts {
  newP0: number;
  parsedP1: number;
  candidateP2: number;
  offlineQueue: number;
  browserCaptures: number;
  slaRisk: number;
}

/** Actions the inbox can offer, for one batched policy evaluation per request. */
const GATED_ACTIONS = [
  'source_record.normalize',
  'source_record.promote',
  'identity.link.verify',
  'suppression.apply',
];

/** Minutes since a capture arrived, floored at zero. */
function ageMinutes(createdAt: string | undefined): number {
  if (!createdAt) {
    return 0;
  }
  const parsed = Date.parse(createdAt);
  return Number.isNaN(parsed) ? 0 : Math.max(0, Math.round((Date.now() - parsed) / 60000));
}

/**
 * A plain-language reason the row is where it is.
 *
 * Written for the operator, not the developer. "P2_CANDIDATE" tells somebody
 * who already knows the ladder nothing they did not know; "a possible match was
 * found and needs a human decision" tells them what to do next, which is the
 * only reason the row is on a triage screen.
 */
function explain(state: TrustState, quarantineReason?: string): string {
  if (quarantineReason) {
    return `Quarantined: ${quarantineReason}. Provenance could not be established, so it cannot be promoted.`;
  }
  switch (state) {
    case 'P0_CAPTURED':
      return 'Captured as received. Not yet parsed into fields.';
    case 'P1_NORMALIZED':
      return 'Parsed into fields. No identity match attempted yet.';
    case 'P2_CANDIDATE':
      return 'A possible match was found and needs a human decision.';
    case 'P3_LINKED':
      return 'Linked to a known person. Can be promoted once directly confirmed.';
    case 'P4_DIRECT':
      return 'Confirmed by the person themselves. Fully trusted.';
    default:
      return 'State unrecognised; treated as untrusted.';
  }
}

/** The caller's roles, failing closed to none. */
function rolesFor(req: AuthenticatedRequest & PlatformRequest): string[] {
  if (req.platformSession?.roles.length) {
    return req.platformSession.roles;
  }
  return req.session?.role ? [req.session.role] : [];
}

/** Ask sdk-source-record for a page, or report that it could not be reached. */
async function fetchRecords(
  query: InboxQuery
): Promise<{ rows: SourceRecordRow[]; upstreamAvailable: boolean }> {
  if (!SdkGatewayClient.isConfigured()) {
    return { rows: [], upstreamAvailable: false };
  }

  try {
    const result = await SdkGatewayClient.call<{ data?: { records?: SourceRecordRow[] } }>({
      sdk: 'sdk-source-record',
      // Path from the SDK catalog: GET /api/source-records.
      path: '/api/source-records',
      method: 'GET',
      body: undefined,
    });
    return { rows: result.data?.data?.records ?? [], upstreamAvailable: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[captureInbox] source records unavailable:', message);
    return { rows: [], upstreamAvailable: false };
  }
}

export class CaptureInboxController {
  /**
   * GET /api/leadflow/capture/inbox — the composed triage view.
   *
   * DEGRADES TO AN EMPTY, HONEST ANSWER. When ProjexCloud cannot be reached the
   * response is a 200 with zeroed counts and `upstream_available: false`, not a
   * 502. A triage screen that renders nothing and says why leaves the operator
   * able to use the rest of the product; an error page does not, and the
   * distinction matters most during exactly the outage that produces it.
   */
  static async inbox(
    req: AuthenticatedRequest & PlatformRequest,
    res: Response
  ): Promise<void> {
    const query = parseInboxQuery(req.query as Record<string, unknown>);

    // ONE policy evaluation for the whole page, not one per row. Every row asks
    // the same question of the same caller, so the answer is identical and a
    // per-row call would multiply a constant by the page size.
    const decisions = evaluateBatch(
      GATED_ACTIONS.map((action) => ({ action, resourceType: 'source_record' })),
      rolesFor(req)
    );
    const permitted = new Set(
      decisions.filter((decision) => decision.effect === 'permit').map((d) => d.action)
    );

    const { rows, upstreamAvailable } = await fetchRecords(query);

    const items = rows.slice(0, query.limit).map((row) => {
      const state = (row.trust_state ?? 'P0_CAPTURED') as TrustState;
      return {
        sourceRecordId: row.capture_id ?? '',
        trustState: state,
        originClass: row.origin_class ?? 'UNKNOWN_QUARANTINED',
        primaryEvidence: row.evidence_ref ?? null,
        explanation: explain(state, row.quarantine_reason),
        ageMinutes: ageMinutes(row.created_at),
        availableActions: availableActions(state, permitted),
      };
    });

    const counts: InboxCounts = {
      newP0: items.filter((item) => item.trustState === 'P0_CAPTURED').length,
      parsedP1: items.filter((item) => item.trustState === 'P1_NORMALIZED').length,
      candidateP2: items.filter((item) => item.trustState === 'P2_CANDIDATE').length,
      // Not yet sourced: the offline queue and browser-capture counters belong
      // to surfaces that do not exist yet. Reported as 0 rather than omitted, so
      // the screen renders a stable shape and a future value slots in.
      offlineQueue: 0,
      browserCaptures: 0,
      slaRisk: 0,
    };

    const last = items[items.length - 1];
    const nextCursor =
      items.length === query.limit && last
        ? encodeCursor({
            createdAt: rows[items.length - 1]?.created_at ?? new Date().toISOString(),
            sourceRecordId: last.sourceRecordId,
          })
        : null;

    res.status(200).json({
      success: true,
      data: {
        counts,
        items,
        next_cursor: nextCursor,
        // Stated explicitly so the screen can say "we could not reach the
        // provenance store" rather than implying the queue is empty.
        upstream_available: upstreamAvailable,
        tenant_id: config.projexCloud.tenantId || null,
      },
    });
  }
}
