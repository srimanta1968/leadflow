/**
 * The single HTTP client for the LeadFlow API.
 *
 * Every request goes through `request` so the response envelope is unwrapped in
 * one place and a failure always surfaces as an `ApiError` carrying the server's
 * machine-readable code. Components branch on `error.code`, never on message
 * text, so wording changes cannot break behaviour.
 *
 * In development Vite proxies `/api` to the server on port 3000, so the relative
 * base works in both environments without configuration.
 */

const API_BASE = '/api';
const TOKEN_STORAGE_KEY = 'leadflow.session.token';

/** A failure returned by the API, carrying the server's error code. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Read the stored session token, or null when signed out. */
export function getToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Persist the session token. Passing null signs the user out. */
export function setToken(token: string | null): void {
  try {
    if (token === null) {
      window.localStorage.removeItem(TOKEN_STORAGE_KEY);
    } else {
      window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
    }
  } catch {
    // Storage can be unavailable in private modes; the session simply does not
    // survive a reload, which is preferable to failing the sign-in.
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Set false for public endpoints so no Authorization header is sent. */
  authenticated?: boolean;
  signal?: AbortSignal;
}

/**
 * Issue an API request and unwrap the `{ success, data }` envelope.
 *
 * @throws ApiError with the server's `code` on any non-2xx response, or
 *         UPSTREAM_UNAVAILABLE when the request never reached the server.
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, authenticated = true, signal } = options;

  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (authenticated) {
    const token = getToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    throw new ApiError(0, 'UPSTREAM_UNAVAILABLE', 'Could not reach the LeadFlow API');
  }

  const text = await response.text();
  const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};

  if (!response.ok || payload.success === false) {
    throw new ApiError(
      response.status,
      typeof payload.code === 'string' ? payload.code : 'INTERNAL_ERROR',
      typeof payload.error === 'string' ? payload.error : 'The request failed',
      payload.details
    );
  }

  return payload.data as T;
}

// ---------------------------------------------------------------------------
// Typed endpoint wrappers
// ---------------------------------------------------------------------------

export interface SessionUser {
  id: string;
  email: string;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  role: string;
  is_active: boolean;
  email_verified: boolean;
  last_login: string | null;
  created_at: string;
}

export interface AuthResult {
  token: string;
  expires_in: string;
  user: SessionUser;
}

/** Which step of the routing order chose a lead's owner. */
export type RoutingMethod = 'sdk_assignment' | 'rule_match' | 'round_robin' | 'manual';

export interface Lead {
  id: string;
  name: string | null;
  email: string | null;
  source: string | null;
  created_at: string;
  updated_at: string;
  /** Null until the lead has been routed. */
  owner_user_id: string | null;
  owner_name: string | null;
  assigned_at: string | null;
  sla_due_at: string | null;
  routing_method: RoutingMethod | null;
  sla_breached: boolean;
  first_response_at: string | null;
}

export interface RoutingDecision {
  lead_id: string;
  owner_user_id: string | null;
  assigned_at: string | null;
  sla_due_at: string | null;
  routing_method: RoutingMethod | null;
  /** Why this owner was chosen, in words. */
  routing_reason: string | null;
  routing_rule_id: string | null;
  sla_breached: boolean;
}

export interface RoutingRule {
  id: string;
  name: string | null;
  criteria: string | null;
  /** Null is a catch-all that matches every channel. */
  source_channel: LeadSource | null;
  assigned_user_id: string | null;
  /** Lower runs first; the first matching rule wins. */
  evaluation_order: number;
  is_active: boolean;
  created_at: string;
}

/**
 * A per-lead-type first-response SLA target.
 *
 * Matched first-match-wins in ascending `evaluation_order`; a null
 * `source_channel` is the catch-all. When nothing matches, the server applies
 * the flat default reported as `effective_default_minutes`.
 */
export interface SlaPolicy {
  id: string;
  name: string;
  /** Null is a catch-all that governs every lead type nothing else claims. */
  source_channel: LeadSource | null;
  first_response_minutes: number;
  /**
   * Intent that the target runs on the tenant's business calendar. Honoured by
   * ProjexCloud sdk-sla; the local wall-clock fallback cannot apply it.
   */
  business_hours_only: boolean;
  /** Lower runs first; the first matching policy wins. */
  evaluation_order: number;
  is_active: boolean;
  created_at: string;
}

/** Source channels accepted by the capture endpoints. */
export type LeadSource =
  | 'web_form'
  | 'landing_page'
  | 'facebook'
  | 'instagram'
  | 'linkedin'
  | 'tiktok'
  | 'google_ads'
  | 'live_chat'
  | 'phone'
  | 'email'
  | 'referral'
  | 'webhook'
  | 'api'
  | 'csv_import';

/** The eight origin classes of the ProjexCloud source-record trust ladder. */
export type LeadOriginClass =
  | 'first_party_declared'
  | 'first_party_observed'
  | 'partner_shared'
  | 'public_record'
  | 'third_party_licensed'
  | 'inferred'
  | 'user_asserted'
  | 'unknown';

export interface LeadCapturePayload {
  name: string;
  email: string;
  source: LeadSource;
  phone?: string;
  company?: string;
  message?: string;
  /** Defaults to first_party_declared server-side when omitted. */
  origin_class?: LeadOriginClass;
  consent_granted?: boolean;
  utm?: Record<string, string>;
}

export interface CaptureResult {
  lead: Lead;
  asserted_upstream: boolean;
  /** True when intake routing assigned an owner. */
  routed: boolean;
  correlation_id: string;
}

/** Filters the analytics overview accepts. All optional, and they combine. */
export interface AnalyticsFilters {
  /** Inclusive start of the window, by lead arrival. ISO date or datetime. */
  from?: string;
  /** Exclusive end of the window. */
  to?: string;
  source?: LeadSource;
  owner_user_id?: string;
}

/**
 * The analytics rollup.
 *
 * Every rate and duration is `null` rather than `0` when there is nothing to
 * measure — an empty window is not a score of zero, and the dashboard renders
 * the two differently.
 */
export interface AnalyticsOverview {
  generated_at: string;
  filters: {
    from: string;
    to: string;
    source: LeadSource | null;
    owner_user_id: string | null;
  };
  funnel: {
    captured: number;
    routed: number;
    responded: number;
    breached: number;
  };
  conversion: {
    routed_rate: number | null;
    response_rate: number | null;
    breach_rate: number | null;
  };
  response_times: {
    average_seconds: number | null;
    median_seconds: number | null;
    p90_seconds: number | null;
  };
  /**
   * How the window performed against its response target.
   *
   * `delivered` says whether ProjexCloud `sdk-sla` answered. When it did, the
   * figures are judged on the tenant's business calendar; when it did not, the
   * server counted them locally on elapsed time. The screen has to say which,
   * because a calendar-aware rate and a wall-clock rate are not the same claim.
   */
  attainment: {
    delivered: boolean;
    source: 'sdk_sla' | 'local_wallclock';
    target_minutes: number | null;
    closed: number;
    met: number;
    breached: number;
    attainment_rate: number | null;
  };
  /** Which clock produced the closed verdicts this window's breach figures rest on. */
  clock_provenance: {
    gateway_configured: boolean;
    current_clock_source: 'sdk_sla' | 'local_wallclock';
    by_clock_source: {
      clock_source: 'sdk_sla' | 'local_wallclock' | null;
      closed: number;
      breached: number;
    }[];
    mixed: boolean;
  };
  by_source: {
    source: LeadSource | null;
    captured: number;
    responded: number;
    breached: number;
    average_response_seconds: number | null;
  }[];
  daily: {
    day: string;
    captured: number;
    responded: number;
    breached: number;
  }[];
}

/** One PDP verdict as the evaluate endpoint returns it. */
export interface PolicyDecisionResponse {
  action: string;
  effect: 'permit' | 'deny' | 'requires_approval';
  reason: string;
  obligations: { type: string; detail: string }[];
  decision_ref: string;
}


/** What the Quick Contact modal sends. */
export interface QuickCapturePayload {
  mode: 'manual' | 'assisted';
  /** Exactly what the operator pasted or typed. Never trimmed client-side. */
  rawInput: string;
  parsedProposal?: Record<string, unknown> | null;
  /** Required. No default — see the note on `api.quickCapture`. */
  originClass: string;
  visibility?: string;
  recordOwnerPersonaId?: string | null;
  relationshipHint?: string;
  note?: string | null;
  searchAfterCapture?: boolean;
  evidenceBlobRef?: string | null;
}

/** What the capture endpoint returns. */
export interface QuickCaptureResult {
  sourceRecordId: string;
  trustState: string;
  originClass: string;
  /** Echoed verbatim, so the operator can confirm what was stored. */
  rawInput: string;
  evidenceStored: boolean;
  resolution: {
    attempted: boolean;
    autoLinked: boolean;
    personId: string | null;
    candidateCaseRef: string | null;
    explanation: string;
  };
  proposal: Record<string, unknown> | null;
}


/* ------------------------------------------------------------ Import Center */

/** The eight states an import run moves through, in lifecycle order. */
export type ImportRunStatus =
  | 'draft'
  | 'previewing'
  | 'mapping'
  | 'dry_run'
  | 'committing'
  | 'complete'
  | 'quarantined'
  | 'rolled_back';

/**
 * Whether the rollback window is still open, computed by the server.
 *
 * `available` rather than a raw deadline the screen has to compare against now:
 * "rollback_deadline: last Tuesday" asks the reader to do date arithmetic to
 * answer the only question they have.
 */
export interface ImportRollbackState {
  deadline: string | null;
  rolled_back_at: string | null;
  available: boolean;
}

/**
 * One row of the run register.
 *
 * TWO STATUS VOCABULARIES, deliberately. `status` is sdk-import's eight-state
 * lifecycle, which the drill-in needs; `presentation_status` is the four words
 * the table is allowed to say. The server derives the second from the first
 * plus the rights attestation, so every consumer says the same word — two
 * screens each mapping eight onto four is two chances to disagree about what
 * "Restricted" means, and the one that matters is the compliance one.
 */
export interface ImportRunSummary {
  run_id: string | null;
  status: ImportRunStatus | null;
  presentation_status: 'review' | 'complete' | 'restricted' | 'quarantined' | null;
  origin_attestation: 'tenant_first_party' | 'third_party' | 'unknown' | null;
  /** Rows this run brought into existence. */
  created_count: number | null;
  /** Rows it attached to somebody already known. */
  linked_count: number | null;
  /** Steward cases it left behind. A candidate needing a human is not an error. */
  review_count: number | null;
  mapping_template_id: string | null;
  started_by: string | null;
  source_kind: string | null;
  file_name: string | null;
  row_count: number | null;
  committed_row_count: number | null;
  exception_count: number;
  quarantine_reason: string | null;
  created_at: string | null;
  committed_at: string | null;
  rollback: ImportRollbackState;
}

export interface ImportTemplateSummary {
  template_id: string | null;
  name: string | null;
  kind: 'certified' | 'custom' | null;
  version: number | null;
  source_kind: string | null;
  canonical_field_count: number | null;
  transform_count: number | null;
  /** How often it has been reused — the reason to prefer it over a new one. */
  use_count: number | null;
}

export interface ImportConnectorSummary {
  install_id: string | null;
  kind: string | null;
  status: string | null;
  last_sync_at: string | null;
}

/**
 * PER PANEL, not one flag for the page.
 *
 * A connector outage must empty the connector tiles and leave the register
 * intact — the register is what the screen is for. One combined flag would make
 * the screen claim it knows nothing when it knows most of it.
 */
export interface ImportUpstreamAvailability {
  runs?: boolean;
  templates?: boolean;
  connectors?: boolean;
  source_kinds?: boolean;
  run?: boolean;
  exceptions?: boolean;
  attestation?: boolean;
  permitted_use?: boolean;
}

/**
 * One source tile's usability.
 *
 * Reported for EVERY kind the product supports, never a filtered list: a tile
 * dropped because nobody connected it reads as "not supported", where the same
 * tile marked unavailable reads as "not connected yet".
 */
export interface ImportSourceAvailability {
  kind: string | null;
  label: string | null;
  installed: boolean;
  available: boolean;
}

export interface ImportCenter {
  runs: ImportRunSummary[];
  source_availability: ImportSourceAvailability[];
  installed_kinds: string[];
  run_count: number;
  /** Counted in the PRESENTATION vocabulary, matching the segmented filter. */
  status_counts: Partial<Record<'review' | 'complete' | 'restricted' | 'quarantined', number>>;
  templates: ImportTemplateSummary[];
  template_count: number;
  connectors: ImportConnectorSummary[];
  connector_count: number;
  upstream_available: ImportUpstreamAvailability;
  tenant_id: string | null;
}

/** One dry-run governance check, verbatim — including the ones that passed. */
export interface ImportGovernanceVerdict {
  check?: string;
  passed?: boolean;
  detail?: string;
}

/**
 * Created-entity lineage as a SHAPE rather than as rows.
 *
 * A committed run can create tens of thousands of lineage rows; the drill-in
 * needs how many of each kind and how many are already reversed.
 */
export interface ImportLineageSummary {
  total: number;
  by_entity_kind: Record<string, number>;
  by_action: Record<string, number>;
  reversed: number;
}

export interface ImportRunDetail {
  run_id: string;
  run: Record<string, unknown> | null;
  lineage: ImportLineageSummary;
  governance: ImportGovernanceVerdict[];
  /**
   * NULL, not zero, when the store could not be reached. "No exceptions" is the
   * most reassuring thing this screen can say and the most dangerous thing to
   * say while blind.
   */
  exception_count: number | null;
  rollback: ImportRollbackState;
  upstream_available: ImportUpstreamAvailability;
  tenant_id: string | null;
}

export interface ImportRunReport {
  report: {
    run_id: string;
    status: ImportRunStatus | null;
    source: { kind: string | null; file_name: string | null };
    rows: {
      read: number | null;
      committed: number | null;
      excepted: number | null;
      /** Stated rather than left to the reader to work out. */
      unaccounted: number | null;
    };
    lineage: ImportLineageSummary;
    governance: ImportGovernanceVerdict[];
    rollback: ImportRollbackState;
    committed_at: string | null;
    started_by: string | null;
    correlation_id: string | null;
  };
  upstream_available: ImportUpstreamAvailability;
  tenant_id: string | null;
}

export interface ImportRunEvidence {
  run_id: string;
  attestation_id: string | null;
  attestation: Record<string, unknown> | null;
  permitted_use: Record<string, unknown> | null;
  governance: ImportGovernanceVerdict[];
  evidence: {
    source_kind: string | null;
    source_ref: string | null;
    correlation_id: string | null;
    committed_at: string | null;
    /** Says plainly why there is nothing to show, so empty is never mistaken for missing. */
    basis: string;
  };
  upstream_available: ImportUpstreamAvailability;
  tenant_id: string | null;
}

/** The trust ladder, in the order the inbox climbs it. */
export type TrustState =
  | 'P0_CAPTURED'
  | 'P1_NORMALIZED'
  | 'P2_CANDIDATE'
  | 'P3_LINKED'
  | 'P4_DIRECT';

/** An action the caller may take on a capture, after state ∩ policy. */
export type CaptureAction =
  | 'source_record.normalize'
  | 'source_record.promote'
  | 'identity.link.verify'
  | 'suppression.apply';

/** One row of the unresolved queue. */
export interface CaptureInboxItem {
  sourceRecordId: string;
  trustState: TrustState;
  originClass: string;
  /** The evidence line — exactly what was captured. Never re-worded. */
  primaryEvidence: string | null;
  /** Why the row is at this rung, in plain language. */
  explanation: string;
  ageMinutes: number;
  captureSource: string;
  /** What this caller may do to this row. Empty means read-only. */
  availableActions: CaptureAction[];
}

/** The six headline counts. */
export interface CaptureInboxCounts {
  newP0: number;
  parsedP1: number;
  candidateP2: number;
  offlineQueue: number;
  browserCaptures: number;
  slaRisk: number;
}

/** One row of the Capture Sources breakdown. */
export interface CaptureSourceCount {
  key: string;
  label: string;
  count: number;
}

/** Everything the Capture Inbox renders, from one call. */
export interface CaptureInbox {
  counts: CaptureInboxCounts;
  items: CaptureInboxItem[];
  sources: CaptureSourceCount[];
  next_cursor: string | null;
  /** False when the provenance store could not be reached. */
  upstream_available: boolean;
  /** False when the SLA figure is derived from age rather than live clocks. */
  sla_from_upstream: boolean;
  tenant_id: string | null;
}

/** How the inbox queue is narrowed. */
export interface CaptureInboxFilters {
  trust_state?: TrustState;
  origin_class?: string;
  limit?: number;
  cursor?: string;
}

/** What resolving a capture returns. */
export interface ResolveCaptureResult {
  captureId: string;
  /** Read back from the record after the operation — never assumed. */
  trustState: string;
  rail: { reachedNode: string; fromUpstream: boolean };
  normalized: Record<string, string>;
  /** Which fields the steward overrode. */
  correctedFields: string[];
  organizationCandidate: {
    organizationId: string | null;
    name: string | null;
    rationale: string;
    /** Always false. A candidate is proposed, never merged. */
    merged: false;
    proposedRelationship: 'REPRESENTS';
    relationshipState: 'proposed';
  } | null;
  /** Handle a retraction quotes. A promotion with no way back is a merge. */
  reversalRef: string | null;
  reversible: boolean;
}


/** One case in the identity steward queue. */
export interface IdentityReviewCase {
  link_id: string | null;
  risk_band: 'high' | 'medium' | 'low';
  model_score: number;
  not_auto_linkable: true;
  person_id_a: string | null;
  person_id_b: string | null;
  status: string | null;
  provenance: Record<string, unknown> | null;
  created_at: string | null;
  age_minutes: number | null;
  sla_breached: boolean | null;
}

/** A tile the mockup asks for that EMPI has no metric behind. */
export interface IdentityMetricGap {
  metric: string;
  reason: string;
}

/** Everything the Identity Review screen renders, from one call. */
export interface IdentityReviewQueue {
  kpis: {
    review_cases: { total: number | null; high_risk: number | null };
    exact_auto_links: number | null;
    kept_separate: number | null;
    retracted_links: number | null;
    median_review_minutes: number | null;
    resolver_calibration: { ece: number | null; drift_alert: boolean } | null;
  };
  metric_gaps: IdentityMetricGap[];
  cases: IdentityReviewCase[];
  sla: { review_minutes: number };
  band: string | null;
  upstream_available: { candidate_links: boolean; metrics: boolean };
}


/** What a recorded steward decision answers with. */
export interface IdentityDecisionResult {
  link_id: string;
  decision: string;
  recorded: boolean;
  status?: string | null;
  /** The merge_id `unmerge` takes. Null means nothing to undo, never "lost". */
  reversibility_ref: string | null;
  both_records_retained?: boolean;
}


/** One consent receipt in the register. */
export interface ConsentReceipt {
  receipt_id: string | null;
  person_id: string | null;
  purpose_id: string | null;
  processor: string | null;
  jurisdiction: string | null;
  granted_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  status: 'active' | 'expiring' | 'revoked';
}

/** One channel's suppression count, reconciled against the provider. */
export interface SuppressionChannel {
  channel: string;
  /** Null means NOT MEASURED - the provider was unreachable. Never zero. */
  count: number | null;
  provider_reachable: boolean;
  reconciled: boolean;
  note: string | null;
}

/** Everything #view-consent renders, from one call. */
export interface ConsentOverview {
  expiring_within_days: number;
  kpis: {
    active_receipts: number;
    expiring_soon: number;
    revoked: number;
    sms_permitted: Record<string, unknown> | null;
    bounce_events: number | null;
  };
  receipts: ConsentReceipt[];
  register: { source: string; limit: number; truncated: boolean; note: string };
  suppressions: SuppressionChannel[];
  purposes: string[];
  purpose_taxonomy_gap: { reason: string; rejected_alternative: string } | null;
  upstream_available: Record<string, boolean>;
}

/* --------------------------------------------------------- Enrichment Queue */

/** The four words the register is allowed to say about a request. */
export type EnrichmentStatus = 'awaiting' | 'processing' | 'complete' | 'blocked';

/** What the policy decided, derived from the upstream state. */
export type EnrichmentVerdict = 'approval' | 'eligible' | 'denied';

/** How a lookup settled. Only MATCHED is ever charged. */
export type EnrichmentOutcome = 'MATCHED' | 'NO_MATCH' | 'TECHNICAL_FAILURE' | 'CACHE_HIT';

/** One row of the capability-request register. */
export interface EnrichmentRequest {
  request_id: string | null;
  created_at: string | null;
  /** Null until the broker projects a contact label. See `field_gaps`. */
  contact: string | null;
  /** Rendered as chips. One key today; an array because bulk is next. */
  capabilities: string[];
  /** Null until the broker projects request metadata. See `field_gaps`. */
  purpose: string | null;
  /** Null until the broker projects the requesting persona. See `field_gaps`. */
  requested_by: string | null;
  /** What the tenant was quoted. */
  estimate: number | null;
  /** What the tenant was billed. Zero for anything but a match. */
  credits_charged: number | null;
  policy_verdict: EnrichmentVerdict;
  status: EnrichmentStatus;
  /** The broker's own state, kept so a drill-in never has to un-collapse four. */
  upstream_status: string | null;
  outcome: EnrichmentOutcome | null;
  served_from_cache: boolean;
  action: string;
  /**
   * Why a refusal happened, quoted from the credit ledger rather than composed.
   * Null on every row that was not refused.
   */
  explain_reason: string | null;
}

/**
 * One capability card.
 *
 * OUTCOME AND PRICE, and nothing about how the answer is obtained. `offered`
 * false means this tenant holds no entitlement — the card still renders, because
 * a missing card reads as "not a thing this product does" where an unoffered one
 * reads as "not enabled for you", and only the second is actionable.
 */
export interface EnrichmentCapability {
  key: string;
  outcome_label: string;
  description: string | null;
  /** Null, never 0, when unoffered. A zero price reads as free. */
  credit_price: number | null;
  category: string | null;
  offered: boolean;
  /** The governance caveats, carried by every card without exception. */
  caveats: string[];
}

/** A tile or a column the mockup asks for that has no upstream source. */
export interface EnrichmentMetricGap {
  metric: string;
  reason: string;
}

export interface EnrichmentFieldGap {
  field: string;
  reason: string;
}

/**
 * Everything the Enrichment Queue screen renders, from one call.
 *
 * Every count is `null` rather than `0` when the register could not be read. An
 * empty window is not a score of zero, and the rail renders the two differently.
 */
export interface EnrichmentQueue {
  kpis: {
    awaiting_approval: { count: number | null; estimated_credits: number | null };
    /** `provider_fallbacks` is permanently null — see `metric_gaps`. */
    processing: { count: number | null; provider_fallbacks: number | null };
    completed_today: { count: number | null; matched: number | null };
    no_match: { count: number | null; policy: string };
    cache_reuse: {
      /** A fraction in 0..1, or null when nothing has settled. */
      rate: number | null;
      credits_saved: number | null;
      settled_count: number | null;
    };
    budget_remaining: {
      available: number | null;
      reserved: number | null;
      balance: number | null;
    };
  };
  metric_gaps: EnrichmentMetricGap[];
  field_gaps: EnrichmentFieldGap[];
  requests: EnrichmentRequest[];
  request_count: number;
  /** Counted over the WHOLE window, so a segment count never moves with itself. */
  status_counts: Record<string, number>;
  capabilities: EnrichmentCapability[];
  status: EnrichmentStatus | null;
  upstream_available: {
    capabilities: boolean;
    requests: boolean;
    balance: boolean;
    ledger: boolean;
  };
}

export const api = {
  /** Create an account and receive a session token. */
  register: (payload: {
    email: string;
    password: string;
    username?: string;
    first_name?: string;
    last_name?: string;
    phone?: string;
  }) => request<AuthResult>('/auth/register', { method: 'POST', body: payload, authenticated: false }),

  /** Exchange credentials for a session token. */
  login: (payload: { email: string; password: string }) =>
    request<AuthResult>('/auth/login', { method: 'POST', body: payload, authenticated: false }),

  /** Read the signed-in user. */
  me: () => request<{ user: SessionUser }>('/auth/me'),

  /** Submit the public marketing form. Deliberately unauthenticated. */
  submitPublicLead: (payload: LeadCapturePayload) =>
    request<CaptureResult>('/public/leads', { method: 'POST', body: payload, authenticated: false }),

  /**
   * Capture a contact in one call from the Quick Contact modal.
   *
   * DISTINCT from `captureLead`. That writes a LEAD to LeadFlow's projection;
   * this creates a provisional P0 SOURCE RECORD with the raw input kept as
   * immutable evidence, which is what the trust ladder reads. The two take
   * different origin vocabularies for that reason — see
   * `content/captureOriginClasses.ts`.
   *
   * `originClass` is deliberately REQUIRED with no default: the server answers
   * 422 without it rather than guessing, and the modal must not paper over that
   * by choosing one.
   */
  /**
   * Advance a capture one governed step.
   *
   * `stage` has NO default — the server refuses a missing one rather than
   * guessing which half of a promotion the steward meant.
   */
  resolveCapture: (
    captureId: string,
    payload: { stage: 'normalize' | 'search'; corrections?: Record<string, string> }
  ) =>
    request<ResolveCaptureResult>(`/leadflow/capture/${encodeURIComponent(captureId)}/resolve`, {
      method: 'POST',
      body: payload,
    }),

  quickCapture: (payload: QuickCapturePayload) =>
    request<QuickCaptureResult>('/leadflow/capture/quick', { method: 'POST', body: payload }),

  /**
   * Read the whole Capture Inbox — tiles, queue and source breakdown — in one
   * call.
   *
   * ONE REQUEST BY DESIGN, not by accident. Splitting the tiles from the rows
   * would mean two reads taken at different instants, so the headline count and
   * the queue under it could disagree; drilling into a tile that says 27 and
   * landing on 24 rows reads as a bug in the queue rather than as the second it
   * took to fetch.
   *
   * Empty filters are omitted rather than sent blank, so the request URL states
   * exactly what was asked for.
   */
  captureInbox: (filters: CaptureInboxFilters = {}, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== '') {
        params.set(key, String(value));
      }
    }
    const query = params.toString();
    return request<CaptureInbox>(`/leadflow/capture/inbox${query ? `?${query}` : ''}`, { signal });
  },

  /** Capture a lead as an authenticated operator. */
  captureLead: (payload: LeadCapturePayload) =>
    request<CaptureResult>('/leads', { method: 'POST', body: payload }),

  /** List captured leads, newest first. */
  listLeads: (limit = 50, offset = 0) =>
    request<{ leads: Lead[]; total: number }>(`/leads?limit=${limit}&offset=${offset}`),

  /**
   * Route a lead to an owner and start its response clock.
   *
   * Idempotent: a lead that already has an owner comes back unchanged with
   * `already_routed: true` rather than being reassigned.
   */
  routeLead: (leadId: string) =>
    request<{ decision: RoutingDecision; already_routed: boolean }>(`/leads/${leadId}/route`, {
      method: 'POST',
      body: {},
    }),

  /** List routing rules in the order the engine evaluates them. */
  listRoutingRules: (activeOnly = false) =>
    request<{ rules: RoutingRule[]; total: number }>(
      `/routing-rules${activeOnly ? '?active=true' : ''}`
    ),

  /** Create a routing rule. */
  createRoutingRule: (payload: {
    name: string;
    assigned_user_id: string;
    source_channel?: LeadSource;
    criteria?: string;
    evaluation_order?: number;
    is_active?: boolean;
  }) => request<{ rule: RoutingRule }>('/routing-rules', { method: 'POST', body: payload }),

  /** List the team roster — who can own a lead. */
  listUsers: (activeOnly = true) =>
    request<{ users: SessionUser[]; total: number }>(`/users?active=${activeOnly}`),

  /**
   * Read the analytics rollup for a filtered window.
   *
   * Empty filters are omitted from the query string rather than sent blank: the
   * server treats an empty `source` as "no filter" anyway, but sending
   * `?source=` makes the request URL — which is what the browser caches and what
   * shows up in a network log — misrepresent what was asked for.
   */
  analyticsOverview: (filters: AnalyticsFilters = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value) {
        params.set(key, value);
      }
    }
    const query = params.toString();
    return request<AnalyticsOverview>(`/analytics/overview${query ? `?${query}` : ''}`);
  },

  /**
   * Partially update a routing rule.
   *
   * Only the fields present are written. Passing `source_channel: null`
   * explicitly turns the rule into a catch-all, so absence and null differ.
   */
  /**
   * Ask the policy decision point about a screen's whole action set at once.
   *
   * One call per screen rather than one per control: a screen gating six
   * controls would otherwise spend six round trips before its first paint.
   */
  evaluatePermissions: (actions: { action: string; resourceType: string; resourceId?: string }[]) =>
    request<{ batch_ref: string; decisions: PolicyDecisionResponse[] }>('/leadflow/authz/evaluate', {
      method: 'POST',
      body: {
        actions: actions.map((entry) => ({
          action: entry.action,
          resource_type: entry.resourceType,
          resource_id: entry.resourceId,
        })),
      },
    }),

  updateRoutingRule: (
    ruleId: string,
    changes: {
      name?: string;
      source_channel?: LeadSource | null;
      assigned_user_id?: string;
      criteria?: string | null;
      evaluation_order?: number;
      is_active?: boolean;
    }
  ) => request<{ rule: RoutingRule }>(`/routing-rules/${ruleId}`, { method: 'PATCH', body: changes }),

  /**
   * Retire a routing rule.
   *
   * A soft delete: leads reference `routing_rule_id`, so the row is deactivated
   * rather than removed and a past routing decision stays explainable.
   */
  retireRoutingRule: (ruleId: string) =>
    request<{ rule: RoutingRule; already_inactive: boolean }>(`/routing-rules/${ruleId}`, {
      method: 'DELETE',
    }),

  /**
   * List SLA policies in the order the matcher walks them.
   *
   * `effective_default_minutes` is the window applied to a lead no policy
   * matches, so the screen never has to hard-code that number.
   */
  listSlaPolicies: (activeOnly = false) =>
    request<{ policies: SlaPolicy[]; total: number; effective_default_minutes: number }>(
      `/sla/policies${activeOnly ? '?active=true' : ''}`
    ),

  /** Define an SLA target for a lead type. */
  createSlaPolicy: (payload: {
    name: string;
    source_channel?: LeadSource | null;
    first_response_minutes: number;
    business_hours_only?: boolean;
    evaluation_order?: number;
    is_active?: boolean;
  }) => request<{ policy: SlaPolicy }>('/sla/policies', { method: 'POST', body: payload }),

  /**
   * Partially update an SLA target.
   *
   * Only the fields present are written. Passing `source_channel: null`
   * explicitly turns the policy into the catch-all, so absence and null differ.
   */
  updateSlaPolicy: (
    policyId: string,
    changes: {
      name?: string;
      source_channel?: LeadSource | null;
      first_response_minutes?: number;
      business_hours_only?: boolean;
      evaluation_order?: number;
      is_active?: boolean;
    }
  ) => request<{ policy: SlaPolicy }>(`/sla/policies/${policyId}`, { method: 'PATCH', body: changes }),

  /**
   * Retire an SLA target.
   *
   * A soft delete: a lead's deadline was computed from the policy in force when
   * it was assigned, so the row is deactivated rather than removed and a past
   * deadline stays explainable.
   */
  retireSlaPolicy: (policyId: string) =>
    request<{ policy: SlaPolicy; already_inactive: boolean }>(`/sla/policies/${policyId}`, {
      method: 'DELETE',
    }),

  /**
   * The whole Import Center in ONE call.
   *
   * The register, the template library and connector availability arrive
   * together and already reconciled — the server derives status_counts from the
   * same run list it returns, so a tile cannot disagree with the rows beneath
   * it. Three separate browser calls would reintroduce exactly that drift.
   */
  importCenter: () => request<ImportCenter>('/leadflow/imports/center'),

  /**
   * The steward queue and its tiles, composed server-side.
   *
   * The band filter is passed to the SERVER rather than applied here: the KPI
   * counts and the rows have to describe the same slice, and filtering in the
   * browser would leave the tiles counting a queue the table is no longer
   * showing.
   */
  identityReviewQueue: (band?: string) =>
    request<IdentityReviewQueue>(
      `/leadflow/identity/review-queue${band ? `?band=${encodeURIComponent(band)}` : ''}`
    ),

  /**
   * The Consent & Preferences screen, composed server-side.
   *
   * The expiring window goes to the SERVER rather than being applied here: the
   * tiles and the register must describe the same window, and filtering in the
   * browser would leave the counters describing a period the table no longer
   * shows.
   */
  consentOverview: (expiringWithinDays?: number) =>
    request<ConsentOverview>(
      `/leadflow/consent/overview${expiringWithinDays ? `?expiring_within_days=${expiringWithinDays}` : ''}`
    ),

  /**
   * Issue one signed, purpose-specific receipt.
   *
   * purpose_id is a SINGLE string, matching sdk-consent's grant. The modal uses
   * a radio group so an array cannot be produced here at all - blanket consent
   * is not expressible on the screen, rather than rejected after the fact.
   */
  issueConsentReceipt: (body: Record<string, unknown>) =>
    request<{ receipt_id?: string; signature_ref: string | null; signature_searchable: boolean }>(
      '/leadflow/consent/receipts',
      { method: 'POST', body: JSON.stringify(body) }
    ),

  /** Withdraw one receipt. Never optimistic - the row updates on confirmation. */
  revokeConsentReceipt: (receiptId: string, reason: string) =>
    request<{ receipt_id: string; revoked: boolean; cascade: Record<string, unknown> }>(
      `/leadflow/consent/receipts/${encodeURIComponent(receiptId)}/revoke`,
      { method: 'POST', body: JSON.stringify({ reason }) }
    ),


  /** Record (or defer) a steward's verdict on one candidate link. */
  identityDecision: (linkId: string, decision: string, reason: string) =>
    request<IdentityDecisionResult>(
      `/leadflow/identity/candidates/${encodeURIComponent(linkId)}/decision`,
      { method: 'POST', body: JSON.stringify({ decision, reason }) }
    ),



  /** One run: its lineage summary, governance verdicts and exception count. */
  importRun: (runId: string) =>
    request<ImportRunDetail>(`/leadflow/imports/runs/${encodeURIComponent(runId)}`),

  /**
   * The completed-run report behind the Report action.
   *
   * A POST because composing it fans out across three upstream reads and is
   * recorded as a disclosure — an import report names what happened to whose
   * data, and reports get forwarded.
   */
  importRunReport: (runId: string) =>
    request<ImportRunReport>(`/leadflow/imports/runs/${encodeURIComponent(runId)}/report`, {
      method: 'POST',
      body: {},
    }),

  /**
   * The Enrichment Queue — tiles, register and catalog — composed server-side.
   *
   * The status filter goes to the SERVER for the same reason the identity band
   * does: the tiles and the rows have to describe the same window. Filtering in
   * the browser would leave the rail counting a register the table is no longer
   * showing, and the rail is what an operator clicks to narrow the table.
   */
  enrichmentQueue: (status?: EnrichmentStatus, signal?: AbortSignal) =>
    request<EnrichmentQueue>(
      `/leadflow/enrichment/queue${status ? `?status=${encodeURIComponent(status)}` : ''}`,
      { signal }
    ),

  /**
   * The rights attestation behind a restricted run.
   *
   * Gated more narrowly than the rest of the screen — `import.evidence_read` is
   * held by the Data Steward and the Privacy Officer alone — so this is the one
   * call here that can 403 for somebody who can see everything else.
   */
  importRunEvidence: (runId: string) =>
    request<ImportRunEvidence>(`/leadflow/imports/runs/${encodeURIComponent(runId)}/evidence`),

  /**
   * The LIVE policy verdict behind the Contact Enrichment callout.
   *
   * NON-SPENDING, which is why it is a separate call from enrichmentRequest.
   * The modal re-asks it on every capability tick and every change of business
   * reason, and holding the tenant's credits to find out whether they may be
   * held would charge them for changing their mind.
   */
  enrichmentEligibility: (payload: {
    subject_ref: string;
    capability_keys: string[];
    purpose: string;
  }) => request<EnrichmentEligibility>('/leadflow/enrichment/eligibility', {
    method: 'POST',
    body: payload,
  }),

  /** Reserve & Run. Answers `awaiting_approval` when the tier may not spend. */
  enrichmentRequest: (payload: {
    subject_ref: string;
    capability_keys: string[];
    purpose: string;
    notes?: string;
  }) => request<EnrichmentRequestResult>('/leadflow/enrichment/requests', {
    method: 'POST',
    body: payload,
  }),

  /** Everything the Data Credits drawer renders, in one call. */
  creditsSummary: (signal?: AbortSignal) =>
    request<CreditsSummary>('/leadflow/credits/summary', { signal }),

  /**
   * The Data Review queue and its eight tiles, in one call.
   *
   * Both filters go to the SERVER rather than being applied in the browser, so
   * the counts always describe the same window the rows came from.
   */
  dataReviewCases: (
    filters: { risk?: string; family?: string } = {},
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams();
    if (filters.risk && filters.risk !== 'all') query.set('risk', filters.risk);
    if (filters.family && filters.family !== 'all') query.set('family', filters.family);
    const suffix = query.toString();
    return request<DataReviewCases>(
      `/leadflow/data-review/cases${suffix ? `?${suffix}` : ''}`,
      { signal },
    );
  },

  /* ------------------------------------------------ contacts workspace */

  /** The Contact 360 header, trust rail and survivorship note, in one call. */
  contactSummary: (contactId: string, signal?: AbortSignal) =>
    request<ContactSummary>(`/leadflow/contacts/${encodeURIComponent(contactId)}/summary`, {
      signal,
    }),

  /** Everything the six Overview panels render, in one call. */
  contactOverview: (contactId: string, signal?: AbortSignal) =>
    request<ContactOverview>(`/leadflow/contacts/${encodeURIComponent(contactId)}/overview`, {
      signal,
    }),

  /**
   * The faceted contact list.
   *
   * Every facet goes to the SERVER and is mirrored into the URL by the screen,
   * so a filtered list is shareable and the counts always describe the window
   * the rows came from.
   */
  contacts: (filters: ContactFacets = {}, signal?: AbortSignal) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== '' && value !== 'all') query.set(key, String(value));
    }
    const suffix = query.toString();
    return request<ContactList>(`/leadflow/contacts${suffix ? `?${suffix}` : ''}`, { signal });
  },

  /**
   * Export the contacts a purpose is actually permitted for.
   *
   * The purpose is REQUIRED rather than defaulted: an export with no stated
   * purpose cannot be eligibility-checked against anything, and a default would
   * silently pick one on the operator's behalf.
   */
  exportContacts: (payload: { purpose: string; filters: ContactFacets }) =>
    request<ContactExportResult>('/leadflow/contacts/export', { method: 'POST', body: payload }),

  /** Saved views — filter definitions, never materialized result sets. */
  savedViews: (signal?: AbortSignal) =>
    request<SavedViewList>('/leadflow/saved-views', { signal }),

  /** The sidebar's live counts, refreshed for every pinned view in ONE call. */
  savedViewCounts: (signal?: AbortSignal) =>
    request<SavedViewCounts>('/leadflow/saved-views/counts', { signal }),

  createSavedView: (payload: {
    name: string;
    description?: string;
    filters: Record<string, string>;
    scope: SavedViewScope;
    pinned?: boolean;
  }) => request<{ view: SavedView }>('/leadflow/saved-views', { method: 'POST', body: payload }),

  /** The per-contact property relationships, with trust and evidence. */
  contactProperties: (contactId: string, signal?: AbortSignal) =>
    request<ContactPropertyList>(
      `/leadflow/contacts/${encodeURIComponent(contactId)}/properties`,
      { signal },
    ),

  /**
   * Link a property to a person as a CONTEXTUAL ROLE.
   *
   * The address is canonicalized upstream before the relationship is written,
   * which is why this takes a raw address rather than an id: resolving it here
   * would let the browser decide which place a string means.
   */
  linkContactProperty: (
    contactId: string,
    payload: {
      address: string;
      role: string;
      trust_state: string;
      valid_from: string;
      evidence_type: string;
      evidence_note?: string;
    },
  ) => request<LinkPropertyResult>(
    `/leadflow/contacts/${encodeURIComponent(contactId)}/properties/link`,
    { method: 'POST', body: payload },
  ),

  /** The contextual relationship neighbourhood, for the graph and its table. */
  contactRelationships: (contactId: string, signal?: AbortSignal) =>
    request<RelationshipGraph>(
      `/leadflow/contacts/${encodeURIComponent(contactId)}/relationships`,
      { signal },
    ),

  /** Contact points, source assertions and the governed-action timeline. */
  contactProvenance: (contactId: string, signal?: AbortSignal) =>
    request<ContactProvenance>(
      `/leadflow/contacts/${encodeURIComponent(contactId)}/provenance`,
      { signal },
    ),

  /** The unified thread plus the live compose guardrail verdict. */
  contactConversations: (contactId: string, signal?: AbortSignal) =>
    request<ContactConversations>(
      `/leadflow/contacts/${encodeURIComponent(contactId)}/conversations`,
      { signal },
    ),

  /** Enrollment history with the verdict evaluated at EXECUTION time. */
  campaignEnrollments: (contactId: string, signal?: AbortSignal) =>
    request<CampaignEnrollmentList>(
      `/leadflow/contacts/${encodeURIComponent(contactId)}/campaign-enrollments`,
      { signal },
    ),

  /** The correlated audit narrative for a subject — not a log tail. */
  auditTimeline: (subjectRef: string, signal?: AbortSignal) =>
    request<AuditTimeline>(
      `/leadflow/audit/timeline?subject_ref=${encodeURIComponent(subjectRef)}`,
      { signal },
    ),

  /** The blast radius of a reversible action, computed before anything commits. */
  reversalPreview: (payload: { subject_ref: string; action: string }) =>
    request<ReversalPreview>('/leadflow/audit/reversals/preview', {
      method: 'POST',
      body: payload,
    }),

  /** The portable, independently verifiable evidence package. */
  evidenceBundle: (payload: { subject_ref: string; include: string[] }) =>
    request<EvidenceBundle>('/leadflow/audit/evidence-bundle', { method: 'POST', body: payload }),

  /**
   * Filtered evidence across the twelve correlation dimensions.
   *
   * A POST because the filter set is a document, not a lookup — and because a
   * query naming an actor and a purpose does not belong in a URL that lands in
   * a proxy log.
   */
  auditQuery: (payload: { filters: EvidenceFilters; limit?: number }, signal?: AbortSignal) =>
    request<AuditQueryResult>('/leadflow/audit/query', {
      method: 'POST',
      body: { ...payload.filters, limit: payload.limit },
      signal,
    }),

  /** Saved queries this caller may run — their own, plus role and tenant shares. */
  savedAuditQueries: (signal?: AbortSignal) =>
    request<{ queries: SavedAuditQuery[] }>('/leadflow/audit/saved-queries', { signal }),

  /** Save a query and say who may run it. Visibility is required, never defaulted. */
  saveAuditQuery: (payload: {
    name: string;
    visibility: SavedQueryVisibility;
    filters: EvidenceFilters;
  }) =>
    request<SavedAuditQuery>('/leadflow/audit/saved-queries', { method: 'POST', body: payload }),

  /* ------------------------------------------- routing, coverage, capacity */

  /** The versioned routing configuration: predicates, bands and matchers. */
  routingConfig: (signal?: AbortSignal) =>
    request<RoutingConfig>('/leadflow/routing/config', { signal }),

  /** Why THIS lead went to THIS rep, step by step. */
  routingTrace: (leadId: string, signal?: AbortSignal) =>
    request<RoutingTrace>(`/leadflow/leads/${encodeURIComponent(leadId)}/routing-trace`, { signal }),

  /**
   * Replay a historical window through a CANDIDATE configuration.
   *
   * Zero side effects by contract: no assignment, no notification, no clock.
   */
  simulateRouting: (payload: { window_days: number; config_version: string | null }) =>
    request<RoutingSimulation>('/leadflow/routing/simulate', { method: 'POST', body: payload }),

  /** Distribution skew and starvation across the rep pool. */
  fairShareAudit: (signal?: AbortSignal) =>
    request<FairShareAudit>('/leadflow/routing/fair-share-audit', { signal }),

  /** Schedules, holidays, on-call, opening validation and the gap detector. */
  coverageConsole: (signal?: AbortSignal) =>
    request<CoverageConsole>('/leadflow/coverage/console', { signal }),

  /** Records the 8:45am checklist with the manager's confirmation. */
  recordOpeningValidation: (payload: {
    checks: Record<string, boolean>;
    overnight_queue_cleared: boolean;
    manager_confirmed: boolean;
  }) => request<{ recorded_at: string | null }>('/leadflow/coverage/opening-validation', {
    method: 'POST',
    body: payload,
  }),

  /* ------------------------------------------------- pipeline and NEXT */

  pipelineBoard: (signal?: AbortSignal) =>
    request<PipelineBoard>('/leadflow/pipeline/board', { signal }),

  overdueNextActions: (signal?: AbortSignal) =>
    request<OverdueNextActions>('/leadflow/next-actions/overdue', { signal }),

  /* --------------------------------------------------- communications */

  /** The unified inbox: one chronological thread across every channel. */
  inbox: (filter?: string, signal?: AbortSignal) =>
    request<UnifiedInbox>(`/leadflow/inbox${filter && filter !== 'all' ? `?filter=${encodeURIComponent(filter)}` : ''}`, { signal }),

  /* ------------------------------------------------------- meetings */

  bookLive: (payload: {
    contact_ref: string;
    starts_at: string;
    purpose: string;
    agenda: string;
    meeting_link?: string;
  }) => request<BookLiveResult>('/leadflow/meetings/book-live', { method: 'POST', body: payload }),

  /* --------------------------------------------- offers and commercial */

  offerStaleness: (opportunityId: string, signal?: AbortSignal) =>
    request<OfferStaleness>(
      `/leadflow/opportunities/${encodeURIComponent(opportunityId)}/offer-staleness`,
      { signal },
    ),

  /* ---------------------------------------------------------- handoff */

  handoffDraft: (handoffId: string, signal?: AbortSignal) =>
    request<HandoffRecord>(`/leadflow/handoffs/${encodeURIComponent(handoffId)}`, { signal }),

  /* ------------------------------------------------------- dashboards */

  leadershipDashboard: (signal?: AbortSignal) =>
    request<LeadershipDashboard>('/leadflow/dashboards/leadership', { signal }),

  roleDashboard: (role: string, signal?: AbortSignal) =>
    request<RoleDashboard>(`/leadflow/dashboards/${encodeURIComponent(role)}`, { signal }),

  /* --------------------------------------------------------- workflows */

  workflowDefinitions: (signal?: AbortSignal) =>
    request<WorkflowDefinitionList>('/leadflow/workflows/definitions', { signal }),

  workflowRuns: (signal?: AbortSignal) =>
    request<WorkflowRunList>('/leadflow/workflows/runs', { signal }),

  releaseGate: (definitionId: string) =>
    request<ReleaseGateResult>(
      `/leadflow/workflows/${encodeURIComponent(definitionId)}/release-gate`,
      { method: 'POST', body: {} },
    ),

  /* --------------------------------------------------------- incidents */

  incidents: (signal?: AbortSignal) =>
    request<IncidentList>('/leadflow/incidents', { signal }),

  /* --------------------------------------- governance and certification */

  certification: (personaId: string, signal?: AbortSignal) =>
    request<CertificationRecord>(
      `/leadflow/certification/${encodeURIComponent(personaId)}`,
      { signal },
    ),

  goLiveStatus: (signal?: AbortSignal) =>
    request<GoLiveStatus>('/leadflow/go-live/status', { signal }),

  /* ------------------------------------------ sequences and templates */

  sequences: (signal?: AbortSignal) =>
    request<SequenceList>('/leadflow/sequences', { signal }),

  /** Stops every queued step across every enrollment. The loop breaker. */
  pauseSequence: (sequenceId: string, reason: string) =>
    request<{ paused: boolean; queued_steps_cancelled: number }>(
      `/leadflow/sequences/${encodeURIComponent(sequenceId)}/pause`,
      { method: 'POST', body: { reason } },
    ),

  templates: (signal?: AbortSignal) =>
    request<TemplateList>('/leadflow/templates', { signal }),

  /* ------------------------------------------------------ the user register */

  /**
   * The team register with its lifecycle states.
   *
   * Distinct from `listUsers`, which is the roster every screen that must name a
   * colleague already calls. This one carries invitation stamps and closures,
   * which only the administration screen has any use for.
   */
  userRegister: (includeDeactivated = false, signal?: AbortSignal) =>
    request<UserRegisterList>(`/users/register?deactivated=${includeDeactivated}`, { signal }),

  /** What each assignable role grants, in SOP terms. */
  assignableRoles: (signal?: AbortSignal) =>
    request<{ roles: LocalRoleSummary[]; total: number }>('/users/roles', { signal }),

  /** The SOP §28 grid as the policy decision point evaluates it. Read-only. */
  permissionMatrix: (signal?: AbortSignal) =>
    request<PermissionMatrixResponse>('/users/permission-matrix', { signal }),

  /** Add a colleague to the register, pending. */
  inviteUser: (payload: {
    email: string;
    role: string;
    first_name?: string;
    last_name?: string;
  }) => request<{ user: RegisterUser }>('/users/invite', { method: 'POST', body: payload }),

  /** Change what a colleague may do. Governed and audited with both roles. */
  assignUserRole: (userId: string, role: string) =>
    request<{
      user: RegisterUser;
      previous_role: string;
      changed: boolean;
      /** Whether the change reached the ProjexCloud persona, when there is one. */
      persona: PersonaMirror;
    }>(`/users/${encodeURIComponent(userId)}/role`, { method: 'PATCH', body: { role } }),

  /**
   * Open an account for use, optionally issuing its first credential.
   *
   * `initial_password` is omitted rather than sent blank when absent: the server
   * treats a blank string as "no password supplied" too, but a request body that
   * carries an empty password field is one refactor away from being read as one.
   */
  activateUser: (userId: string, initialPassword?: string) =>
    request<{ user: RegisterUser; credential_issued: boolean }>(
      `/users/${encodeURIComponent(userId)}/activate`,
      { method: 'POST', body: initialPassword ? { initial_password: initialPassword } : {} },
    ),

  /** Close an account. Never a delete — see the endpoint's own note. */
  deactivateUser: (userId: string, reason: string) =>
    request<{
      user: RegisterUser;
      actions_remain_attributable: boolean;
      /** False when a linked persona still holds its grants. Null when local-only. */
      persona_revoked: boolean | null;
      persona_note: string;
    }>(`/users/${encodeURIComponent(userId)}/deactivate`, { method: 'POST', body: { reason } }),
};

/* ------------------------------------------------------- the user register */

/** The three states an account can be in. Never a boolean — see the server note. */
export type RegisterState = 'pending' | 'active' | 'deactivated';

export interface RegisterUser {
  id: string;
  email: string;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  role: string;
  state: RegisterState;
  is_active: boolean;
  email_verified: boolean;
  invited_at: string | null;
  invited_by: string | null;
  activated_at: string | null;
  deactivated_at: string | null;
  deactivated_by: string | null;
  last_login: string | null;
  created_at: string;
  /**
   * The ProjexCloud persona this account projects, or null for a local-only one.
   *
   * It changes what a role assignment MEANS: a platform session enforces the
   * persona's grants, not `users.role`, so for a linked account the register
   * mirrors the change upstream and reports whether that landed.
   */
  platform_persona_id: string | null;
}

/** What happened when a local role change was pushed to the linked persona. */
export interface PersonaMirror {
  /** Null when nothing needed mirroring — no persona, or nothing changed. */
  applied: boolean | null;
  role: string | null;
  detail: string;
}

export interface UserRegisterList {
  users: RegisterUser[];
  total: number;
  pending: number;
  /** False once ProjexCloud is the identity authority — no password may be set here. */
  local_credentials_permitted: boolean;
}

/** One SOP §28 actor a local role speaks for. */
export interface SopRoleSummary {
  key: string;
  label: string;
  purpose: string;
  can_do: string[];
  requires_approval: string[];
  sop_basis: string;
}

/** One assignable `users.role` value, with the authority it confers. */
export interface LocalRoleSummary {
  key: string;
  sop_roles: SopRoleSummary[];
  can_do: string[];
  requires_approval: string[];
  grants_nothing: boolean;
}

export interface PermissionMatrixResponse {
  rows: {
    role_key: string;
    role_label: string;
    decisions: PolicyDecisionResponse[];
  }[];
  total: number;
  /** The files the grid is derived from, quoted back so the screen can name them. */
  source: string;
  /** Always false. The matrix is a view of versioned code, not configuration. */
  editable: boolean;
}

/* -------------------------------------------- sequences and templates */

/** The playbook's ten triggers. A sequence enters on exactly one. */
export type SequenceTrigger =
  | 'immediate_inbound' | 'after_hours' | 'no_answer' | 'callback_confirmed'
  | 'demo_booked' | 'two_hour_reminder' | 'no_show' | 'decision_checkout'
  | 'closed_won' | 'breakup';

export interface SequenceStep {
  step_id: string;
  order: number;
  channel: string;
  delay: string;
  purpose: string;
  template_ref: string | null;
  /** The gate verdict for THIS step, evaluated before it may be enabled. */
  gate: { verdict: 'allow' | 'review' | 'deny'; reason: string } | null;
}

export interface SequenceSummary {
  sequence_id: string;
  name: string;
  trigger: SequenceTrigger | null;
  status: string | null;
  steps: SequenceStep[];
  /** Non-null when the whole sequence is stopped, with the reason. */
  paused: { at: string | null; reason: string; by: string | null } | null;
  active_enrollments: number | null;
  /**
   * Enrollments halted by an inbound reply. The SOP's rule states this twice,
   * so it is a first-class field rather than something to read out of a log.
   */
  reply_paused: { contact: string; replied_at: string | null; task_ref: string | null }[];
  /** Cancelled by STOP, unsubscribe, complaint, bad number or do-not-contact. */
  suppressed: { contact: string; reason: string; cancelled_steps: number }[];
}

export interface SequenceList {
  sequences: SequenceSummary[];
  upstream_available: { workflow: boolean; campaign: boolean; decision: boolean };
  field_gaps: { field: string; reason: string }[];
}

export interface TemplateRow {
  template_id: string;
  trigger: SequenceTrigger | null;
  channel: string;
  /** The approved wording. Never edited in place — see `version`. */
  body: string;
  merge_fields: string[];
  /** The ONE thing this message asks for. Two is the defect. */
  intended_action: string | null;
  version: number | null;
  status: 'draft' | 'published' | null;
  /** Required on channels that mandate one; absent means it cannot publish. */
  opt_out_affordance: string | null;
  gate: { verdict: 'allow' | 'review' | 'deny'; reason: string } | null;
}

export interface TemplateList {
  templates: TemplateRow[];
  /** Who owns the final rules, stated rather than implied. */
  gate_owner: string;
  upstream_available: { content: boolean; notification: boolean; decision: boolean };
  field_gaps: { field: string; reason: string }[];
}

/* ------------------------------------------------------ contacts workspace */

export interface ContactSummaryTrustNode {
  node: string;
  state: 'reached' | 'current' | 'pending' | 'blocked';
  evidence: string | null;
}

export interface ContactSummary {
  contact_id: string;
  canonical_id: string | null;
  entity_type: string | null;
  display_name: string | null;
  /**
   * How the display name was chosen. Null when the projection could not be
   * read — which the header states, rather than showing a name with no
   * provenance as though it were undisputed.
   */
  display_name_provenance: { projection: string; source_count: number | null } | null;
  relationship_label: string | null;
  organization: string | null;
  record_owner: { name: string | null; business_unit: string | null } | null;
  badges: string[];
  trust_rail: ContactSummaryTrustNode[];
  saved_at: string | null;
  upstream_available: { crm: boolean; projection: boolean; source_record: boolean };
  field_gaps: { field: string; reason: string }[];
}

export interface ContactabilityComponent {
  channel: string;
  eligible: boolean;
  /** Always present. A component with no reason cannot be argued with. */
  reason: string;
}

export interface ContactOverview {
  identity: {
    display_name: string | null;
    survivorship_note: string | null;
    contextual_role: string | null;
    /** What the role was confirmed FOR — a role is never global. */
    role_scope_note: string | null;
    organization: string | null;
    record_owner: { name: string | null; business_unit: string | null } | null;
  };
  /**
   * Computed from the live eligibility components below, never a stored field —
   * a cached contactability score outlives the consent that produced it.
   */
  contactability: {
    score: number | null;
    basis: string;
    components: ContactabilityComponent[];
  };
  contact_points: { type: string; value: string; label: string | null; eligibility_note: string }[];
  properties: { label: string; trust_state: string | null; active_work: string | null }[];
  recent_conversations: { channel: string; summary: string; occurred_at: string | null }[];
  data_passport: {
    canonical_person_id: string | null;
    primary_data_origin: string | null;
    crosswalk_retention_note: string | null;
    direct_relationship: { established_at: string | null; method: string | null } | null;
    last_identity_review: string | null;
  };
  channel_decisions: ChannelDecision[];
  /** From the scoring SDK. An empty list is reported as such, never padded. */
  recommended_actions: {
    key: string;
    label: string;
    detail: string;
    /** Null when the action costs nothing. Shown BEFORE invocation. */
    credit_cost: number | null;
    source: string;
  }[];
  upstream_available: { projection: boolean; decision: boolean; scoring: boolean; credits: boolean };
  field_gaps: { field: string; reason: string }[];
}

export interface ContactFacets {
  entity_type?: string;
  trust_state?: string;
  origin?: string;
  channel_state?: string;
  owner?: string;
  q?: string;
}

export interface ContactRow {
  contact_id: string;
  canonical_id: string | null;
  display_name: string | null;
  initials: string;
  trust_state: string | null;
  role: string | null;
  contact_point_summary: string | null;
  property_summary: string | null;
  origin: string | null;
  /** The eligibility verdict, always with the reason that produced it. */
  channel_state: string | null;
  channel_reason: string | null;
  owner: string | null;
  updated_at: string | null;
}

export interface ContactList {
  contacts: ContactRow[];
  total: number;
  filters: ContactFacets;
  facets: {
    entity_types: string[];
    trust_states: string[];
    origins: string[];
    channel_states: string[];
    /* IDs — the filter matches on these. `owner_names` carries the label. */
    owners: string[];
    owner_names?: Record<string, string>;
  };
  upstream_available: { search: boolean; crm: boolean; source_record: boolean };
  field_gaps: { field: string; reason: string }[];
}

export interface ContactExportResult {
  purpose: string;
  /** Rows the purpose was actually permitted for, at export time. */
  exported: number;
  /** Rows excluded, and why — an export that silently drops rows is a lie. */
  excluded: { reason: string; count: number }[];
  audit_ref: string | null;
  evaluated_at: string | null;
}

export type SavedViewScope = 'private' | 'team' | 'organization';

export interface SavedView {
  view_id: string;
  name: string;
  description: string | null;
  /** The FILTER, never a result set. A stored count says "5" forever. */
  filters: Record<string, string>;
  scope: SavedViewScope;
  pinned: boolean;
  pin_order: number | null;
  shipped: boolean;
  owner: string | null;
}

export interface SavedViewList {
  views: SavedView[];
  upstream_available: { saved_queries: boolean };
  field_gaps: { field: string; reason: string }[];
}

export interface SavedViewCounts {
  /** Null, never 0, for a view whose count could not be computed. */
  counts: Record<string, number | null>;
  computed_at: string | null;
  upstream_available: { search: boolean };
}

export interface ContactPropertyRow {
  relationship_id: string | null;
  property_label: string | null;
  parcel_note: string | null;
  relationship: string | null;
  trust_state: 'Confirmed' | 'Candidate' | 'Documented' | null;
  valid_from: string | null;
  evidence_summary: string | null;
  active_work: string | null;
}

export interface ContactPropertyList {
  properties: ContactPropertyRow[];
  upstream_available: { rebac: boolean; geo: boolean; source_record: boolean };
  field_gaps: { field: string; reason: string }[];
}

export interface LinkPropertyResult {
  relationship_id: string | null;
  /** What the address resolved to upstream, shown before the link is written. */
  canonical_address: string | null;
  address_id: string | null;
  /** Proof the link wrote no property fact onto the Person record. */
  person_attributes_written: number;
}

export interface RelationshipNode {
  node_id: string;
  label: string;
  kind: 'person' | 'property' | 'organization' | 'team';
}

export interface RelationshipEdge {
  edge_id: string;
  from_id: string;
  to_id: string;
  role: string;
  trust_state: string | null;
  valid_from: string | null;
  valid_to: string | null;
  evidence_count: number;
}

export interface RelationshipGraph {
  center_id: string;
  nodes: RelationshipNode[];
  edges: RelationshipEdge[];
  /** True when traversal stopped at the budget rather than at the graph edge. */
  budget_exhausted: boolean;
  traversal_budget: number;
  upstream_available: { rebac: boolean };
  field_gaps: { field: string; reason: string }[];
}

export interface ContactPointRow {
  contact_point_id: string | null;
  type: string | null;
  value: string | null;
  label: string | null;
  trust_state: string | null;
  source: string | null;
  effective_at: string | null;
  retrieved_at: string | null;
  eligibility: string | null;
  /** Candidates are not operational until a person confirms them. */
  requires_confirmation: boolean;
}

export interface ProvenanceAssertionRow {
  assertion_id: string;
  assertion: string;
  value: string;
  source: string | null;
  crosswalk_ref: string | null;
  origin_class: string | null;
  confidence: number | null;
  effective_at: string | null;
  retrieved_at: string | null;
  status: 'Primary' | 'Survives' | 'Assertion' | 'Superseded';
  /** Required by the server whenever status is Superseded. */
  superseded_reason: string | null;
  evidence_ref: string | null;
  sensitive: boolean;
}

export interface ContactProvenance {
  contact_points: ContactPointRow[];
  assertions: ProvenanceAssertionRow[];
  upstream_available: { source_record: boolean; projection: boolean; vault: boolean };
  field_gaps: { field: string; reason: string }[];
}

export interface ConversationMessage {
  message_id: string;
  channel: string | null;
  direction: 'inbound' | 'outbound' | 'internal' | null;
  body: string | null;
  quoted_body: string | null;
  purpose: string | null;
  property_context: string | null;
  /** The single ordering key, normalized upstream across providers. */
  occurred_at: string | null;
  delivery_state: string | null;
  read_state: string | null;
  /** Internal notes are never customer-visible, and say so. */
  customer_visible: boolean;
}

export interface ChannelDecision {
  purpose: string;
  channel: string;
  verdict: 'allow' | 'review' | 'deny';
  /** The engine's sentence, rendered verbatim. Never composed in the browser. */
  reason: string;
}

export interface ContactConversations {
  messages: ConversationMessage[];
  compose_guardrails: ChannelDecision[];
  upstream_available: { conversation: boolean; decision: boolean };
  field_gaps: { field: string; reason: string }[];
}

export interface CampaignEnrollmentRow {
  enrollment_id: string | null;
  campaign_name: string | null;
  campaign_id: string | null;
  purpose: string | null;
  enrolled_at: string | null;
  channels: string[];
  /** Evaluated at SEND time, never read from a build-time flag. */
  verdict: 'Eligible' | 'Suppressed' | null;
  suppression_reason: string | null;
  response: string | null;
  outcome: string | null;
  evidence_ref: string | null;
}

export interface CampaignEnrollmentList {
  enrollments: CampaignEnrollmentRow[];
  evaluated_at: string | null;
  upstream_available: { campaign: boolean; decision: boolean };
  field_gaps: { field: string; reason: string }[];
}

export interface AuditTimelineEntry {
  event_id: string;
  title: string;
  reference: string | null;
  actor: string | null;
  policy_decision_ref: string | null;
  credit_estimate: string | null;
  occurred_at: string | null;
  effect: 'permit' | 'deny' | 'requires_approval' | null;
  evidence_ref: string | null;
  trace_id: string | null;
}

export interface AuditTimeline {
  entries: AuditTimelineEntry[];
  correlation: {
    canonical_entity: { value: string | null; note: string };
    trace: { value: string | null; note: string };
    policy_bundle: { value: string | null; note: string };
    consent_epoch: { value: string | null; note: string };
  };
  upstream_available: { audit: boolean; trace: boolean; evidence: boolean; policy: boolean };
  field_gaps: { field: string; reason: string }[];
}

export interface ReversalPreview {
  action: string;
  /** What the reversal would touch, named category by category. */
  blast_radius: { category: string; count: number | null; detail: string }[];
  reversible: boolean;
  /** Why a count is unknown, rather than a confident zero. */
  field_gaps: { field: string; reason: string }[];
}

/** The twelve dimensions an evidence query can be narrowed by. */
export interface EvidenceFilters {
  actor?: string;
  persona_role?: string;
  purpose?: string;
  decision_outcome?: string;
  policy_version?: string;
  consent_epoch?: string;
  entity_ref?: string;
  case_id?: string;
  import_run_id?: string;
  trace_id?: string;
  from?: string;
  to?: string;
}

export type SavedQueryVisibility = 'private' | 'role' | 'tenant';

export interface SavedAuditQuery {
  query_id: string;
  name: string;
  filters: EvidenceFilters;
  visibility: SavedQueryVisibility;
  owner_persona_id: string;
  owner_role: string | null;
  upstream_query_id: string | null;
  created_at: string;
}

/**
 * A query answer AND a chain verdict.
 *
 * `chain.state` is on every response and is never optional: a broken chain and
 * an unreachable verifier are opposite instructions to the reader — stop
 * trusting these rows, versus try again later.
 */
export interface AuditQueryResult {
  query_ref: string;
  filters: EvidenceFilters;
  results: Record<string, unknown>[];
  result_count: number;
  total: number | null;
  chain: {
    state: 'verified' | 'broken' | 'unknown';
    verified: boolean;
    entries_checked: number | null;
    break_at_seq: number | null;
    break_reason: string | null;
    detail: string | null;
    range: { from_seq: number | null; to_seq: number | null };
  };
  trace: {
    trace_id: string;
    spans: Record<string, unknown>[];
    span_count: number;
    available: boolean;
    layers: Record<string, unknown> | null;
    layers_available: boolean;
  } | null;
  upstream_available: { search: boolean; audit: boolean; trace: boolean | null };
}

export interface EvidenceBundle {
  bundle_ref: string | null;
  signature: string | null;
  /** The algorithm a recipient needs in order to verify independently. */
  signature_algorithm: string | null;
  contents: { section: string; included: boolean; detail: string }[];
  upstream_available: { audit: boolean; evidence: boolean; consent: boolean; trace: boolean };
}

export type DataReviewRisk = 'high' | 'medium' | 'low';
export type DataReviewFamily = 'identity' | 'source_rights' | 'consent' | 'relationship';
/** How close a case is to breaching. `breached` is distinct from `critical`. */
export type SlaBand = 'breached' | 'critical' | 'warning' | 'ok' | 'unknown';

export interface DataReviewCaseType {
  key: string;
  label: string;
  description: string;
  family: DataReviewFamily;
  owner_role: string;
  /** Null, never 0, when the register could not be read. */
  count: number | null;
}

export interface DataReviewCase {
  case_id: string | null;
  case_type: string | null;
  case_type_label: string;
  /** Null for a case type this screen has no tile for. Kept, never dropped. */
  family: DataReviewFamily | null;
  risk: DataReviewRisk;
  entity: string | null;
  issue: string | null;
  evidence_summary: string | null;
  /** The durable half of ownership; present even when the person is not. */
  owner_role: string | null;
  owner: string | null;
  sla_minutes_remaining: number | null;
  sla_band: SlaBand;
  status: string;
  opened_at: string | null;
}

export interface DataReviewCases {
  case_types: DataReviewCaseType[];
  cases: DataReviewCase[];
  case_count: number;
  risk_counts: Record<string, number>;
  family_counts: Record<string, number>;
  filters: { risk: string; family: string };
  known_case_types: string[];
  upstream_available: { register: boolean; sla: boolean; owners: boolean };
  field_gaps: { field: string; reason: string }[];
}

export interface EnrichmentEligibility {
  eligible: boolean;
  verdict: 'allow' | 'review' | 'deny';
  headline: string;
  reason: string;
  estimated_credits: number;
  requires_approval: boolean;
  budget_tier: string;
  policy_reached: boolean;
}

export interface EnrichmentRequestResult {
  status: 'reserved' | 'not_reserved' | 'awaiting_approval';
  executed: boolean;
  estimated_credits: number;
  budget_tier: string;
  /** Present only when a tier or a threshold stopped the run. */
  blocked_reason?: string | null;
  approval_ref?: string | null;
}

export interface CreditsLedgerRow {
  request_id: string | null;
  capability_key: string | null;
  reserved: number;
  charged: number;
  refunded: number;
  outcome: string | null;
  served_from_cache: boolean;
}

export interface CreditsSummary {
  organization_balance: { balance: number | null; reserved: number | null; available: boolean };
  current_cycle: { used: number; saved_through_cache: number; available: boolean };
  capability_usage: { capability: string; credits: number }[];
  budget_controls: { label: string; detail: string; allowance: string; mode: string }[];
  ledger_export: CreditsLedgerRow[];
  ledger_available: boolean;
  export_complete: boolean;
  operator_only_notice: string;
}

/* ------------------------------------------ routing, coverage and capacity */

/** The four SOP priority bands. P0 is a verified purchase, not a hot lead. */
export type PriorityBand = 'P0' | 'P1' | 'P2' | 'P3';

export interface RoutingConfig {
  version: number | null;
  status: 'draft' | 'published' | null;
  eligibility_predicates: { key: string; expression: string; description: string }[];
  /** Band -> the SOP definition it maps to. Never a local re-interpretation. */
  priority_bands: { band: PriorityBand; definition: string; sources: string[] }[];
  specialty_matchers: { dimension: string; enabled: boolean; detail: string }[];
  requires_approval_to_publish: boolean;
  upstream_available: { assignment: boolean; coverage: boolean; scoring: boolean };
  field_gaps: { field: string; reason: string }[];
}

export interface RoutingTraceStep {
  step: number;
  name: string;
  /** Plain language. A manager reads this to answer "why this rep". */
  explanation: string;
  outcome: string;
  candidates_before: number | null;
  candidates_after: number | null;
}

export interface RoutingTrace {
  lead_id: string;
  steps: RoutingTraceStep[];
  assigned_to: string | null;
  /** True when the lead was sent to review instead of being force-assigned. */
  sent_to_review_queue: boolean;
  review_reason: string | null;
  upstream_available: { assignment: boolean; audit: boolean };
}

export interface RoutingSimulation {
  window_days: number;
  leads_replayed: number | null;
  /** The assertion that makes a simulation safe to run against real leads. */
  side_effects: { assignments: number; notifications: number; clocks: number };
  per_rep: {
    rep: string;
    actual_volume: number | null;
    simulated_volume: number | null;
    actual_p1: number | null;
    simulated_p1: number | null;
    time_to_accept_delta: string | null;
  }[];
  would_be_breaches: number | null;
  capacity_violations: number | null;
  specialty_match_rate: number | null;
  upstream_available: { assignment: boolean; sla: boolean; analytics: boolean };
  field_gaps: { field: string; reason: string }[];
}

export interface FairShareAudit {
  /** A rep receiving disproportionate volume, or one being starved. */
  skew: { rep: string; band: PriorityBand; share: number; expected_share: number; verdict: string }[];
  starved: string[];
  rotation_healthy: boolean | null;
  rotation_note: string;
  upstream_available: { assignment: boolean; analytics: boolean };
}

export interface CoverageWindow {
  label: string;
  starts_at: string;
  ends_at: string;
  /** The whole point: a window with no named person is not covered. */
  covered_by: string | null;
  gap: boolean;
}

export interface CoverageConsole {
  schedules: { rep: string; timezone: string; hours: string; status: string }[];
  time_off: { rep: string; from: string; to: string; kind: string }[];
  holiday_calendar: { date: string; name: string }[];
  manager_on_duty: { date: string; manager: string | null }[];
  windows: CoverageWindow[];
  /** Gaps detected BEFORE the window opens, which is the only useful time. */
  upcoming_gaps: { window: string; starts_at: string; reason: string }[];
  opening_validation: {
    checks: { key: string; label: string; passed: boolean | null }[];
    overnight_queue_cleared: boolean | null;
    manager_confirmed: boolean | null;
    recorded_at: string | null;
  };
  late_coverage: { roster: string[]; enforced_until: string; note: string };
  upstream_available: { coverage: boolean; notification: boolean };
  field_gaps: { field: string; reason: string }[];
}

/* ------------------------------------------------------------- pipeline */

export interface PipelineCard {
  record_id: string;
  title: string;
  owner: string | null;
  priority: PriorityBand | null;
  score: number | null;
  sla_band: SlaBand;
  next_action: string | null;
  next_due_at: string | null;
  next_minutes_remaining: number | null;
  offer_version: string | null;
  age_days: number | null;
  /** How many times the due date has been pushed. */
  push_count: number;
}

export interface PipelineStage {
  key: string;
  label: string;
  /** What must be true to LEAVE this stage. An invalid drop names what is missing. */
  exit_criteria: string[];
  cards: PipelineCard[];
}

export interface PipelineBoard {
  stages: PipelineStage[];
  total_open: number;
  stale: { record_id: string; title: string; days_since_activity: number }[];
  upstream_available: { crm: boolean; sla: boolean };
  field_gaps: { field: string; reason: string }[];
}

export interface OverdueNextActions {
  overdue: {
    record_id: string;
    title: string;
    owner: string | null;
    next_action: string | null;
    minutes_overdue: number | null;
    manager_alerted: boolean;
    push_history: { pushed_at: string; reason: string | null; by: string | null }[];
  }[];
  repeated_pushers: { record_id: string; push_count: number }[];
  upstream_available: { crm: boolean };
}

/* -------------------------------------------------------------- inbox */

export interface InboxThread {
  thread_id: string;
  subject: string | null;
  contact: string | null;
  channel: string | null;
  last_message_at: string | null;
  unread: boolean;
  awaiting_reply: boolean;
  sla_at_risk: boolean;
  needs_review: boolean;
  owner: string | null;
}

export interface UnifiedInbox {
  threads: InboxThread[];
  filters: { key: string; label: string; count: number | null }[];
  upstream_available: { conversation: boolean; crm: boolean };
  field_gaps: { field: string; reason: string }[];
}

/* ----------------------------------------------------------- meetings */

export interface BookLiveResult {
  appointment_id: string | null;
  /** Verified INSIDE the call, before the rep hangs up. */
  receipt_verified: boolean;
  confirmation_email_sent: boolean;
  sms_sent: boolean | null;
  sms_skipped_reason: string | null;
  calendar_pushed: boolean;
  rep_prep_task_id: string | null;
  content_standard: { field: string; present: boolean }[];
}

/* ------------------------------------------------------------- offers */

export interface OfferStaleness {
  stamped_version: string | null;
  current_version: string | null;
  /** True when the stamped version is no longer the current one. */
  stale: boolean;
  note: string;
  upstream_available: { offer_catalog: boolean };
}

/* ------------------------------------------------------------ handoff */

export interface HandoffSection {
  key: string;
  label: string;
  fields: { key: string; label: string; value: string | null; required: boolean }[];
}

export interface HandoffRecord {
  handoff_id: string | null;
  status: string | null;
  sections: HandoffSection[];
  /** Every commitment, as a discrete auditable item rather than free text. */
  promises: { promise_id: string; text: string; made_by: string | null; delivered: boolean | null }[];
  rejection: { reason: string | null; returned_to: string | null } | null;
  upstream_available: { handoff: boolean };
}

/* --------------------------------------------------------- dashboards */

export interface LeadershipSignal {
  key: string;
  label: string;
  /** Null, never 0, when the signal could not be computed. */
  value: number | null;
  detail: string;
  /** Where the tile drills to. A tile with no list is a poster. */
  drill_to: string;
  role: 'success' | 'warning' | 'blocked' | 'info' | 'identity';
}

export interface LeadershipDashboard {
  signals: LeadershipSignal[];
  /** The SOP's five success-test questions, answered per record. */
  success_test: {
    record_id: string;
    owner: string | null;
    last_activity: string | null;
    next_action: string | null;
    due_at: string | null;
    blocker: string | null;
  }[];
  kpi_registry_version: string | null;
  upstream_available: { sla: boolean; crm: boolean; notification: boolean; handoff: boolean };
  field_gaps: { field: string; reason: string }[];
}

export interface RoleDashboard {
  role: string;
  panels: {
    key: string;
    label: string;
    description: string;
    metrics: { label: string; value: string | null; detail: string | null }[];
  }[];
  /** The same registered definitions every dashboard shares. */
  kpi_registry_version: string | null;
  permitted: boolean;
  denied_reason: string | null;
  upstream_available: Record<string, boolean>;
  field_gaps: { field: string; reason: string }[];
}

/* ---------------------------------------------------------- workflows */

export interface WorkflowDefinitionSummary {
  definition_id: string;
  name: string;
  version: number | null;
  status: string | null;
  node_count: number | null;
  kill_switch_engaged: boolean;
}

export interface WorkflowDefinitionList {
  definitions: WorkflowDefinitionSummary[];
  /** The palette the canvas and the outline view both render. */
  node_types: { key: string; label: string; description: string }[];
  upstream_available: { workflow: boolean; flags: boolean; approval: boolean };
  field_gaps: { field: string; reason: string }[];
}

export interface WorkflowRunSummary {
  run_id: string;
  definition: string | null;
  version: number | null;
  subject: string | null;
  outcome: string | null;
  started_at: string | null;
  elapsed_ms: number | null;
  steps: {
    name: string;
    state: string;
    input_summary: string | null;
    output_summary: string | null;
    elapsed_ms: number | null;
    error: string | null;
  }[];
  signals_received: string[];
  compensation_history: { step: string; compensated_at: string; reason: string }[];
}

export interface WorkflowRunList {
  runs: WorkflowRunSummary[];
  upstream_available: { workflow: boolean; trace: boolean };
  field_gaps: { field: string; reason: string }[];
}

export interface ReleaseGateResult {
  definition_id: string;
  /** All twelve, always reported - a skipped scenario is not a pass. */
  scenarios: { key: string; label: string; passed: boolean | null; detail: string }[];
  passed: boolean;
  blocks_publish: boolean;
  evidence_ref: string | null;
  approval_request_ref: string | null;
}

/* ---------------------------------------------------------- incidents */

export interface IncidentRow {
  incident_id: string;
  severity: string | null;
  type: string | null;
  title: string | null;
  owner: string | null;
  on_call_role: string | null;
  status: string | null;
  opened_at: string | null;
  affected_records: number | null;
  /** An incident cannot close until this passes. */
  verification: { required: boolean; passed: boolean | null; detail: string | null };
  systemic: boolean;
}

export interface IncidentList {
  incidents: IncidentRow[];
  /** A recurring type escalates to leadership without anybody noticing it. */
  systemic_patterns: { type: string; occurrences: number; escalated: boolean; detail: string }[];
  on_call: { incident_type: string; role: string; person: string | null }[];
  upstream_available: { incident: boolean; sla: boolean };
  field_gaps: { field: string; reason: string }[];
}

/* ------------------------------------------- governance and certification */

export interface CertificationRecord {
  persona_id: string;
  score: number | null;
  /** The eight stations of the SOP, with the standard each must meet. */
  stations: {
    key: string;
    label: string;
    pass_standard: string;
    score: number | null;
    passed: boolean | null;
    simulated_at: string | null;
  }[];
  /** Until this passes, the rep receives no live P0 or P1 lead. */
  gate: { passed: boolean; blocks_p0_p1: boolean; reason: string };
  upstream_available: { assignment: boolean; approval: boolean };
  field_gaps: { field: string; reason: string }[];
}

export interface GoLiveStatus {
  gates: { key: string; label: string; passed: boolean | null; detail: string }[];
  signatures: { role: string; name: string | null; signed_at: string | null }[];
  /** True only with all twelve gates and all five signatures. */
  ready: boolean;
  blocked_reason: string | null;
  audit_ref: string | null;
  immutable: boolean;
  upstream_available: { approval: boolean; audit: boolean };
}
