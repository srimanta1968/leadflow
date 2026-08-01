/**
 * LeadFlow shared server types.
 *
 * The response envelope here is the project-wide contract: every handler
 * answers with `{ success, data }` or `{ success:false, error, code }`.
 * `code` values come from the single vocabulary in `utils/errors.ts`.
 */

export interface ApiSuccess<T> {
  success: true;
  data: T;
}

export interface ApiFailure {
  success: false;
  error: string;
  code: string;
  details?: unknown;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

/** A row of the `users` table as it exists in PostgreSQL. */
export interface UserRow {
  id: string;
  email: string;
  username: string | null;
  password_hash: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  role: string;
  is_active: boolean;
  email_verified: boolean;
  last_login: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** A user as exposed over the API — never carries `password_hash`. */
export interface PublicUser {
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

/** Claims carried by a LeadFlow session JWT. */
export interface SessionClaims {
  userId: string;
  email: string;
  role: string;
}

export interface RegisterInput {
  email: string;
  password: string;
  username?: string;
  first_name?: string;
  last_name?: string;
  phone?: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface AuthResult {
  token: string;
  expires_in: string;
  user: PublicUser;
}

/**
 * Origin class of an inbound lead signal. Mirrors the eight-value origin
 * enum the ProjexCloud `sdk-source-record` trust ladder is built on.
 */
export type LeadOriginClass =
  | 'first_party_declared'
  | 'first_party_observed'
  | 'partner_shared'
  | 'public_record'
  | 'third_party_licensed'
  | 'inferred'
  | 'user_asserted'
  | 'unknown';

/** Channels a lead can arrive through. */
export type LeadSourceChannel =
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

export interface LeadCaptureInput {
  name: string;
  email: string;
  source: LeadSourceChannel;
  phone?: string;
  company?: string;
  message?: string;
  origin_class?: LeadOriginClass;
  consent_granted?: boolean;
  utm?: Record<string, string>;
}

export interface LeadRecord {
  id: string;
  name: string | null;
  email: string | null;
  source: string | null;
  created_at: string;
  updated_at: string;
  /**
   * Ownership and clock state. Present on every lead read so the Capture Inbox
   * can order by urgency and show who owns what without a second request per
   * row. Null across the board means the lead has not been routed yet.
   */
  owner_user_id: string | null;
  owner_name: string | null;
  assigned_at: string | null;
  sla_due_at: string | null;
  routing_method: string | null;
  sla_breached: boolean;
  first_response_at: string | null;
}

/**
 * Which step of the routing order chose a lead's owner.
 *
 * Recorded on every assignment so a decision is explainable after the fact, and
 * so an owner picked by the ProjexCloud six-step engine is never confused with
 * one picked by LeadFlow's local fallback.
 */
export type RoutingMethod = 'sdk_assignment' | 'rule_match' | 'round_robin' | 'manual';

export interface RoutingDecision {
  lead_id: string;
  owner_user_id: string | null;
  assigned_at: string | null;
  /** Deadline for a valid human first response. */
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
  /** Channel this rule matches. Null is a catch-all. */
  source_channel: LeadSourceChannel | null;
  assigned_user_id: string | null;
  /** Lower runs first; the first matching rule wins. */
  evaluation_order: number;
  is_active: boolean;
  created_at: string;
}

/**
 * State of a lead's response clock.
 *
 *  - `on_track`  the clock is running and the deadline is comfortably ahead
 *  - `at_risk`   the clock is running and most of the window has elapsed
 *  - `breached`  the deadline passed without a valid human first response
 *  - `met`       a first response landed before the deadline
 *
 * `at_risk` is deliberately advisory: it changes no column, so the escalation
 * ladder can warn a manager BEFORE a breach rather than reporting one after.
 */
export type SlaState = 'on_track' | 'at_risk' | 'breached' | 'met';

/**
 * Which clock produced an SLA verdict.
 *
 * Recorded on every observation because the two are not the same measurement:
 * `sdk_sla` runs on the tenant's business calendar (working hours, holidays,
 * timezone, pause windows), while `local_wallclock` is LeadFlow's plain
 * elapsed-time fallback for when the gateway is unreachable. Averaging them
 * together without knowing which is which would produce a compliance number
 * nobody can defend.
 */
export type SlaClockSource = 'sdk_sla' | 'local_wallclock';

/** Why a clock is recorded as breached. */
export type SlaBreachReason = 'no_response_in_window' | 'responded_after_due';

/** Channels a valid human first response can arrive through. */
export type ResponseChannel = 'email' | 'phone' | 'sms' | 'live_chat' | 'linkedin' | 'meeting';

/** One lead's clock as the monitor last observed it. */
export interface SlaObservation {
  lead_id: string;
  owner_user_id: string | null;
  /** Deadline for a valid human first response. Null when never routed. */
  sla_due_at: string | null;
  first_response_at: string | null;
  /** Seconds from lead ARRIVAL to the first response. Null while running. */
  response_seconds: number | null;
  /** The window the verdict was measured against. Null when never routed. */
  target_minutes: number | null;
  state: SlaState;
  breach_reason: SlaBreachReason | null;
  clock_source: SlaClockSource;
}

/** A lead the monitor wants a human to look at, ordered by urgency. */
export interface SlaAttentionItem {
  lead_id: string;
  name: string | null;
  owner_user_id: string | null;
  owner_name: string | null;
  sla_due_at: string | null;
  /** Minutes until the deadline. NEGATIVE once overdue. */
  minutes_to_due: number | null;
  state: SlaState;
}

export interface SlaStatusSnapshot {
  window_minutes: number;
  generated_at: string;
  clock_source: SlaClockSource;
  totals: {
    tracked: number;
    on_track: number;
    at_risk: number;
    breached: number;
    met: number;
  };
  /** met / (met + breached) over CLOSED clocks. Null when none have closed. */
  compliance_rate: number | null;
  average_response_seconds: number | null;
  attention: SlaAttentionItem[];
}

export interface SlaSweepResult {
  evaluated: number;
  on_track: number;
  at_risk: number;
  breached: number;
  met: number;
  /** Leads whose breach THIS sweep discovered — an alerting job's work list. */
  newly_breached: string[];
  /**
   * Escalations this sweep created. Lower than the at-risk count on a repeat
   * pass, because an alert is raised once per (lead, recipient, tier) for ever.
   */
  alerts_raised: number;
  /** Of those, how many the notification gateway accepted. */
  alerts_delivered: number;
  clock_source: SlaClockSource;
  monitor_delivered: boolean;
  correlation_id: string;
}

/**
 * A per-lead-type first-response SLA target.
 *
 * Matched first-match-wins in ascending `evaluation_order`; a null
 * `source_channel` is the catch-all. When nothing matches, the flat
 * `DEFAULT_FIRST_RESPONSE_MINUTES` applies.
 */
export interface SlaPolicy {
  id: string;
  name: string;
  /** Lead type this policy governs. Null is a deliberate catch-all. */
  source_channel: LeadSourceChannel | null;
  first_response_minutes: number;
  /**
   * Intent that the target runs on the tenant's business calendar. Honoured by
   * ProjexCloud sdk-sla; LeadFlow's wall-clock fallback cannot apply it.
   */
  business_hours_only: boolean;
  /** Lower runs first; the first matching policy wins. */
  evaluation_order: number;
  is_active: boolean;
  created_at: string;
}

/**
 * Escalation tier of an SLA alert.
 *
 *  - `owner_warning`  the clock is still running; the lead's owner is warned so
 *                     the lead can still be saved
 *  - `manager_breach` the deadline has passed; every active manager is told
 *
 * Two tiers with different recipients rather than one generic alert, because
 * notifying a manager BEFORE a violation is the point — a single after-the-fact
 * message would report failures rather than prevent them.
 */
export type SlaAlertKind = 'owner_warning' | 'manager_breach';

/**
 * Delivery state of an SLA alert.
 *
 * `pending` means the row EXISTS and is visible in-app but the outbound send has
 * not succeeded — the escalation is never lost because the gateway was briefly
 * unreachable. `failed` means the retry budget is exhausted; the row stays
 * readable, because a failed outbound send must not become a silent escalation.
 */
export type SlaAlertState = 'pending' | 'delivered' | 'acknowledged' | 'failed';

/** How an alert reached its recipient. */
export type SlaAlertChannel = 'projexcloud' | 'in_app';

export interface SlaAlert {
  id: string;
  lead_id: string;
  /** Denormalised for the ledger view, so it needs no per-row lookup. */
  lead_name: string | null;
  recipient_user_id: string;
  recipient_name: string | null;
  kind: SlaAlertKind;
  state: SlaAlertState;
  channel: SlaAlertChannel;
  reason: string | null;
  /** Minutes to the deadline AT THE MOMENT the alert was raised. Negative when
   *  already overdue. A snapshot, so the ledger explains itself later. */
  minutes_to_due: number | null;
  raised_at: string;
  delivered_at: string | null;
  acknowledged_at: string | null;
  acknowledged_by_user_id: string | null;
  attempts: number;
  last_error: string | null;
}

export interface FirstResponseInput {
  channel: ResponseChannel;
  note?: string;
  /** Defaults to the calling session's user when omitted. */
  responded_by_user_id?: string;
}
