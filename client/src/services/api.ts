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
};
