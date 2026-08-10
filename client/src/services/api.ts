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
   * The rights attestation behind a restricted run.
   *
   * Gated more narrowly than the rest of the screen — `import.evidence_read` is
   * held by the Data Steward and the Privacy Officer alone — so this is the one
   * call here that can 403 for somebody who can see everything else.
   */
  importRunEvidence: (runId: string) =>
    request<ImportRunEvidence>(`/leadflow/imports/runs/${encodeURIComponent(runId)}/evidence`),
};
