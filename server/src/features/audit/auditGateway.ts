import { SdkGatewayClient } from '../../platform/sdkGateway';
import { upstreamStatusOf } from '../../platform/sdkGateway/errorMapping';
import { unreachable, type Reached } from '../../platform/sdkGateway/degradingRead';
import { config } from '../../config/env';

/**
 * The three upstreams behind the Advanced Query surface.
 *
 * sdk-search runs the query, sdk-audit proves the chain over the range, and
 * sdk-trace supplies the cross-service causation timeline when a trace id is
 * named. Each degrades independently: a search that cannot run must not stop the
 * screen reporting that the chain is broken, which is the more urgent fact.
 */

/** One matched governed action, as the composer projects it. */
export interface EvidenceHit {
  id?: string;
  event?: string;
  actor?: string;
  persona_role?: string;
  purpose?: string;
  outcome?: string;
  decision_ref?: string;
  policy_version?: string;
  consent_epoch?: string;
  entity_ref?: string;
  case_id?: string;
  import_run_id?: string;
  trace_id?: string;
  occurred_at?: string;
}

/**
 * The chain verdict for a range.
 *
 * THREE STATES, NOT TWO, and this is the whole reason this file has a bespoke
 * verifier instead of calling degradingRead. sdk-audit answers 200 when the
 * proof holds and **409 when it does not** — so an ordinary degrading read,
 * which folds every non-404 error into `available: false`, would report a
 * provably BROKEN chain as "we could not check". On an audit screen those two
 * are opposites: one says stop trusting these rows, the other says try again
 * later.
 */
export type ChainState = 'verified' | 'broken' | 'unknown';

export interface ChainVerdict {
  state: ChainState;
  entriesChecked: number | null;
  breakAtSeq: number | null;
  breakReason: string | null;
  detail: string;
}

/**
 * Verify the audit chain over a sequence range.
 *
 * DELIBERATELY NOT platform/audit/auditLog.ts verifyAuditChain(). That function
 * walks the WHOLE pool and OPENS AN INCIDENT when it fails, which is correct for
 * the nightly sweep and wrong here: an auditor running twenty exploratory
 * queries against a known-broken window would open twenty incidents and bury the
 * one that mattered. This path is range-scoped and side-effect free.
 */
export async function verifyChainRange(
  fromSeq?: number,
  toSeq?: number
): Promise<ChainVerdict> {
  if (!SdkGatewayClient.isConfigured()) {
    return {
      state: 'unknown',
      entriesChecked: null,
      breakAtSeq: null,
      breakReason: null,
      detail: 'No ProjexCloud gateway is configured, so the chain could not be checked.',
    };
  }

  const body: Record<string, unknown> = { pool_index: config.projexCloud.tenantId };
  if (typeof fromSeq === 'number') body.from_seq = fromSeq;
  if (typeof toSeq === 'number') body.to_seq = toSeq;

  try {
    const result = await SdkGatewayClient.call<{
      data?: {
        ok?: boolean;
        entries_checked?: number;
        break_at_seq?: number | null;
        break_reason?: string | null;
      };
    }>({ sdk: 'sdk-audit', path: '/api/audit/verify', method: 'POST', body });

    if (!result.delivered) {
      return {
        state: 'unknown',
        entriesChecked: null,
        breakAtSeq: null,
        breakReason: null,
        detail: 'The audit service did not answer, so the chain could not be checked.',
      };
    }

    const proof = result.data?.data;
    // `=== true`, so a malformed response reads as NOT verified rather than
    // letting a missing field pass as a clean chain.
    if (proof?.ok === true) {
      return {
        state: 'verified',
        entriesChecked: proof.entries_checked ?? 0,
        breakAtSeq: null,
        breakReason: null,
        detail: 'The audit chain verified across this range.',
      };
    }

    return {
      state: 'broken',
      entriesChecked: proof?.entries_checked ?? null,
      breakAtSeq: proof?.break_at_seq ?? null,
      breakReason: proof?.break_reason ?? null,
      detail: `The audit chain did NOT verify across this range${
        proof?.break_at_seq != null ? `, breaking at sequence ${proof.break_at_seq}` : ''
      }. Rows in this window cannot be relied on.`,
    };
  } catch (error) {
    /*
     * A 409 IS THE SERVICE ANSWERING "NO". It is the documented reply when the
     * proof fails, so folding it into `unknown` here would hide the exact
     * finding this endpoint exists to surface.
     */
    if (upstreamStatusOf(error) === 409) {
      return {
        state: 'broken',
        entriesChecked: null,
        breakAtSeq: null,
        breakReason: null,
        detail:
          'The audit service reported the chain as NOT verified across this range. Rows in this window cannot be relied on.',
      };
    }
    return {
      state: 'unknown',
      entriesChecked: null,
      breakAtSeq: null,
      breakReason: null,
      detail: 'The audit service could not be reached, so the chain could not be checked.',
    };
  }
}

/**
 * Run the evidence query against sdk-search.
 *
 * SCOPES ARE NOT SENT. sdk-search resolves effective scopes from the verified
 * JWT and explicitly ignores anything in the body — passing them would be at
 * best redundant and at worst an attempt to escalate that the service is built
 * to refuse. What travels is the filter.
 */
export async function runEvidenceSearch(input: {
  dsl: Record<string, unknown>;
  limit: number;
}): Promise<Reached<{ hits: EvidenceHit[]; total: number | null }>> {
  try {
    const result = await SdkGatewayClient.call<{
      data?: { hits?: EvidenceHit[]; items?: EvidenceHit[]; total?: number };
    }>({
      sdk: 'sdk-search',
      path: '/api/search',
      method: 'POST',
      body: {
        tenant_id: config.projexCloud.tenantId,
        entity_kind: 'audit_entry',
        dsl: input.dsl,
        size: input.limit,
      },
    });
    if (!result.delivered) return unreachable({ hits: [], total: null });
    const bag = result.data?.data ?? {};
    const hits = Array.isArray(bag.hits) ? bag.hits : Array.isArray(bag.items) ? bag.items : [];
    return { value: { hits, total: bag.total ?? hits.length }, available: true };
  } catch {
    return unreachable({ hits: [], total: null });
  }
}

/** One span of a cross-service trace. */
export interface TraceSpan {
  span_id?: string;
  service?: string;
  operation?: string;
  started_at?: string;
  ended_at?: string;
  status?: string;
  parent_span_id?: string | null;
}

/**
 * The causation chain behind one trace id.
 *
 * AN UNKNOWN TRACE IS AN ANSWER. sdk-trace replies 404 when it has never seen
 * the id, which means "no such trace" rather than "the tracer is down" — so it
 * comes back available with an empty timeline. Collapsing the two would make a
 * typo in a trace id indistinguishable from an outage.
 */
export async function readTrace(traceId: string): Promise<Reached<TraceSpan[]>> {
  if (!SdkGatewayClient.isConfigured()) return unreachable([]);
  try {
    const result = await SdkGatewayClient.call<{ data?: { spans?: TraceSpan[] } | TraceSpan[] }>({
      sdk: 'sdk-trace',
      path: `/api/trace/${encodeURIComponent(traceId)}`,
      method: 'GET',
    });
    if (!result.delivered) return unreachable([]);
    const data = result.data?.data as { spans?: TraceSpan[] } | TraceSpan[] | undefined;
    const spans = Array.isArray(data) ? data : Array.isArray(data?.spans) ? data.spans : [];
    return { value: spans, available: true };
  } catch (error) {
    if (upstreamStatusOf(error) === 404) return { value: [], available: true };
    return unreachable([]);
  }
}

/**
 * Assert that a trace contains the layer chain it should.
 *
 * Reported rather than enforced: a missing layer means the evidence for this
 * action is incomplete, which an auditor must be told about, but it is not a
 * reason to refuse them the rows that DO exist.
 */
export async function assertTraceLayers(
  traceId: string,
  expectedLayers: string[]
): Promise<Reached<{ ok: boolean; missing: string[] } | null>> {
  if (!SdkGatewayClient.isConfigured() || expectedLayers.length === 0) return unreachable(null);
  try {
    const result = await SdkGatewayClient.call<{
      data?: { ok?: boolean; missing?: string[] };
    }>({
      sdk: 'sdk-trace',
      path: '/api/trace/regression-assert',
      method: 'POST',
      body: {
        tenant_id: config.projexCloud.tenantId,
        trace_id: traceId,
        expected_layers: expectedLayers,
      },
    });
    if (!result.delivered) return unreachable(null);
    return {
      value: {
        ok: result.data?.data?.ok === true,
        missing: result.data?.data?.missing ?? [],
      },
      available: true,
    };
  } catch {
    return unreachable(null);
  }
}

/**
 * Mirror a saved query into the platform store.
 *
 * BEST EFFORT BY DESIGN. The local row is the source of truth for visibility,
 * so a failed mirror is reported and does not fail the save — but it is
 * REPORTED, because two stores silently disagreeing about what exists is worse
 * than one store admitting it is behind.
 */
export async function mirrorSavedQuery(input: {
  personaId: string;
  name: string;
  dsl: Record<string, unknown>;
}): Promise<Reached<{ query_id?: string } | null>> {
  try {
    const result = await SdkGatewayClient.call<{ data?: { saved_query?: { query_id?: string } } }>({
      sdk: 'sdk-search',
      path: '/api/search/saved-queries',
      method: 'POST',
      idempotencyKey: `audit-saved-query:${input.personaId}:${input.name}`,
      body: {
        tenant_id: config.projexCloud.tenantId,
        persona_id: input.personaId,
        name: input.name,
        dsl: input.dsl,
      },
    });
    if (!result.delivered) return unreachable(null);
    return { value: result.data?.data?.saved_query ?? null, available: true };
  } catch {
    return unreachable(null);
  }
}
