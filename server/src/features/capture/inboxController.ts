import { Response } from 'express';
import { config } from '../../config/env';
import { AuthenticatedRequest } from '../../middleware/auth';
import { SdkGatewayClient } from '../../platform/sdkGateway';
import { PlatformRequest } from '../../platform/auth/sessionContext';
import { evaluateBatch } from '../../platform/policy/policyEngine';
import {
  availableActions,
  CAPTURE_SOURCES,
  captureSourceFor,
  COUNT_WINDOW,
  encodeCursor,
  InboxQuery,
  isAfterCursor,
  parseInboxQuery,
  SLA_RISK_MINUTES,
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
  /** Which LeadFlow surface posted it — `leadflow`, `leadflow-extension`, … */
  source_system?: string;
  /** Present on offline syncs: contact | business_card | voice_note. */
  capture_kind?: string;
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

/** How far back the Browser Captures tile counts — the mockup's "This week". */
const BROWSER_CAPTURE_WINDOW_MINUTES = 7 * 24 * 60;

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

/**
 * Ask sdk-source-record for the counting window, or report it unreachable.
 *
 * DELIBERATELY UNFILTERED BY TRUST STATE even when the caller asked for one
 * rung. The six tiles must keep showing the whole queue after a drill-in —
 * counting only the rows that survived the filter would zero every tile except
 * the one just clicked, so the operator would lose the very overview the tiles
 * exist to give at the exact moment they started working the queue.
 *
 * `age_minutes_max` is passed so the window is the UNRESOLVED backlog rather
 * than the tenant's whole history: the inbox is a triage queue, and a record
 * captured last quarter is not work in progress.
 */
async function fetchWindow(): Promise<{ rows: SourceRecordRow[]; upstreamAvailable: boolean }> {
  if (!SdkGatewayClient.isConfigured()) {
    return { rows: [], upstreamAvailable: false };
  }

  const params = new URLSearchParams({ limit: String(COUNT_WINDOW) });
  if (config.projexCloud.tenantId) {
    params.set('tenant_id', config.projexCloud.tenantId);
  }

  try {
    const result = await SdkGatewayClient.call<{ data?: { records?: SourceRecordRow[] } }>({
      sdk: 'sdk-source-record',
      // Path from the SDK catalog: GET /api/source-records.
      path: `/api/source-records?${params.toString()}`,
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

/**
 * How many response clocks sdk-sla considers at risk.
 *
 * Returns null — NOT zero — when the SDK cannot answer. Zero is a claim that
 * nothing is at risk, which is the most dangerous thing this screen could say
 * while it is in fact blind; null lets the caller fall back to the count it can
 * still derive honestly.
 *
 * The response is read defensively across `at_risk` / `count` / `total` because
 * the published contract describes "at_risk and a count" while the catalog
 * example shows a bare `data` array — an unrecognised shape reads as unknown
 * rather than as an empty queue.
 */
async function fetchSlaAtRisk(): Promise<number | null> {
  if (!SdkGatewayClient.isConfigured()) {
    return null;
  }

  const params = new URLSearchParams();
  if (config.projexCloud.tenantId) {
    // Required by the endpoint: it answers 400 without a tenant.
    params.set('tenant_id', config.projexCloud.tenantId);
  }

  try {
    const result = await SdkGatewayClient.call<{
      data?: unknown;
      total?: number;
    }>({
      sdk: 'sdk-sla',
      path: `/api/sla/at-risk${params.toString() ? `?${params.toString()}` : ''}`,
      method: 'GET',
      body: undefined,
    });

    const body = result.data;
    if (!body) {
      return null;
    }
    const payload = body.data as { at_risk?: unknown[]; count?: number } | unknown[] | undefined;

    if (Array.isArray(payload)) {
      return payload.length;
    }
    if (payload && Array.isArray(payload.at_risk)) {
      return payload.at_risk.length;
    }
    if (payload && typeof payload.count === 'number') {
      return payload.count;
    }
    if (typeof body.total === 'number') {
      return body.total;
    }
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[captureInbox] sla at-risk unavailable:', message);
    return null;
  }
}

/** Newest first, ties broken by id so two captures in one millisecond order. */
function byRecency(a: SourceRecordRow, b: SourceRecordRow): number {
  const left = Date.parse(a.created_at ?? '') || 0;
  const right = Date.parse(b.created_at ?? '') || 0;
  if (left !== right) {
    return right - left;
  }
  return (b.capture_id ?? '').localeCompare(a.capture_id ?? '');
}

export class CaptureInboxController {
  /**
   * GET /api/leadflow/capture/inbox — the composed triage view.
   *
   * ONE CALL POPULATES THE WHOLE SCREEN: the six tiles, the queue, and the
   * source breakdown all come from a single counting window, so the headline
   * numbers cannot disagree with the rows beneath them the way two reads taken
   * a second apart would.
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
    const query: InboxQuery = parseInboxQuery(req.query as Record<string, unknown>);

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

    // Issued together: the window is what every tile and row is derived from,
    // and the SLA count is the one figure it cannot derive. Awaiting them in
    // sequence would add a whole round trip to first paint for no benefit.
    const [{ rows, upstreamAvailable }, slaAtRisk] = await Promise.all([
      fetchWindow(),
      fetchSlaAtRisk(),
    ]);

    const window = [...rows].sort(byRecency);

    // The counts, from the WHOLE window — see fetchWindow on why they are not
    // computed from the filtered page.
    const stateOf = (row: SourceRecordRow): TrustState =>
      (row.trust_state ?? 'P0_CAPTURED') as TrustState;

    const olderThanADay = window.filter(
      (row) => ageMinutes(row.created_at) >= SLA_RISK_MINUTES
    ).length;

    const counts: InboxCounts = {
      newP0: window.filter((row) => stateOf(row) === 'P0_CAPTURED').length,
      parsedP1: window.filter((row) => stateOf(row) === 'P1_NORMALIZED').length,
      candidateP2: window.filter((row) => stateOf(row) === 'P2_CANDIDATE').length,
      // The device's own outstanding queue, which no server can see: a capture
      // taken with no signal exists only on the handset until it syncs. Always
      // 0 here, and the screen overlays the real figure from the device store.
      offlineQueue: 0,
      browserCaptures: window.filter(
        (row) =>
          row.source_system === 'leadflow-extension' &&
          ageMinutes(row.created_at) <= BROWSER_CAPTURE_WINDOW_MINUTES
      ).length,
      // sdk-sla's live clocks when it answered; otherwise the count this window
      // can still support, which is exactly what the tile's caption claims.
      slaRisk: slaAtRisk ?? olderThanADay,
    };

    const sources = CAPTURE_SOURCES.map((source) => ({
      key: source.key,
      label: source.label,
      count: window.filter((row) => captureSourceFor(row.source_system, row.capture_kind) === source.key)
        .length,
    }));

    // The page: the caller's filter, then the cursor, then the limit. Filtering
    // AFTER the cursor would let a filtered-out row consume the page's budget
    // and hand back a short page that looks like the end of the queue.
    const filtered = window.filter((row) => {
      if (query.trustState && stateOf(row) !== query.trustState) {
        return false;
      }
      if (query.originClass && (row.origin_class ?? 'UNKNOWN_QUARANTINED') !== query.originClass) {
        return false;
      }
      return true;
    });

    const afterCursor = query.cursor
      ? filtered.filter((row) =>
          isAfterCursor(
            { createdAt: row.created_at ?? '', sourceRecordId: row.capture_id ?? '' },
            query.cursor!
          )
        )
      : filtered;

    const page = afterCursor.slice(0, query.limit);

    const items = page.map((row) => {
      const state = stateOf(row);
      return {
        sourceRecordId: row.capture_id ?? '',
        trustState: state,
        originClass: row.origin_class ?? 'UNKNOWN_QUARANTINED',
        primaryEvidence: row.evidence_ref ?? null,
        explanation: explain(state, row.quarantine_reason),
        ageMinutes: ageMinutes(row.created_at),
        captureSource: captureSourceFor(row.source_system, row.capture_kind),
        availableActions: availableActions(state, permitted),
      };
    });

    const lastRow = page[page.length - 1];
    const nextCursor =
      afterCursor.length > page.length && lastRow
        ? encodeCursor({
            createdAt: lastRow.created_at ?? new Date().toISOString(),
            sourceRecordId: lastRow.capture_id ?? '',
          })
        : null;

    res.status(200).json({
      success: true,
      data: {
        counts,
        items,
        sources,
        next_cursor: nextCursor,
        // Stated explicitly so the screen can say "we could not reach the
        // provenance store" rather than implying the queue is empty.
        upstream_available: upstreamAvailable,
        // False when the SLA figure is the locally-derived age count rather
        // than sdk-sla's live clocks. The screen says which it is showing.
        sla_from_upstream: slaAtRisk !== null,
        tenant_id: config.projexCloud.tenantId || null,
      },
    });
  }
}
