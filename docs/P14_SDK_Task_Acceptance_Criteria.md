# P14 New-SDK Tasks — Acceptance Criteria (pre-coding spec)

Acceptance criteria for the 20 existing P14 tasks (EP-331..334) that were created with
descriptions only. Apply each block to the matching task in ProjexLight (UI → task →
Acceptance Criteria), or bulk-apply via DB. Tasks TK-3632..3637 (the gap-closure additions)
already carry acceptance criteria and are not repeated here.

Grounding: each task's scope + the customer SOP requirements (SOP §27 P0 list, §06 stages,
§22/§23 go-live gates) captured in InboundCRM/docs. Provider/source parity is to
`c:\Users\srima\projex_crm` modules named per epic.

---

## EP-331 · sdk-sequence

### TK-3612 — schema + migrations (sequences, steps, templates, triggers) · database
- db-runtime migration under `migrationsDir` creates `sequence.sequence`, `.step`, `.template`, `.execution_step`, `.trigger` (parity with projex_crm `outreach_*`).
- Tables carry tenant scoping and the indexes needed for the executor's due-step query (status + next_run_at).
- Migration is idempotent and re-runnable; down-migration defined.
- No dependency on projex_crm `prospects`/`prospect_stage` tables (coupling dropped).

### TK-3613 — definition & enrollment service + Fastify routes · service_layer
- CRUD for sequences, templates, and steps exposed as Fastify routes with tenant auth.
- Event-based enrollment supports form-submit, reply, and stage-change triggers.
- Enrolling the same lead twice into the same active sequence is idempotent (no duplicate execution).
- No `baseAgentService.register()` call (agent-mesh coupling severed).

### TK-3614 — step executor tick loop (send-window gating + idempotent enqueue) · service_layer
- Durable tick loop advances due `execution_step` rows and enqueues sends.
- Sends outside the send-window / during quiet-hours are deferred, not dropped.
- Enqueue is idempotent: a retry or duplicate tick never sends the same step twice.
- Sends are emitted through sdk-notification adapters (not a direct provider call).

### TK-3615 — executor integration tests (send-window, dedup, retry) · testing
- Test proves an in-window step sends exactly once.
- Test proves a quiet-hours/out-of-window step defers and later sends.
- Test proves a retry after partial failure does not double-send.
- Tests run in CI against a disposable db-runtime schema.

### TK-3616 — reactive control (pause-on-reply, stop-on-optout/payment, replace-CTA) · service_layer
- Inbound reply pauses the sequence and records the reason.
- Opt-out and payment/closed-won events stop the sequence and cancel queued steps.
- Booking event replaces the "book a call" CTA step rather than only appending a reminder.
- Every reactive action captures a reason and is auditable; cancellation is idempotent.

### TK-3617 — frequency-cap + circuit-breaker guard with audit log · service_layer
- Per-lead cooldown and max-messages caps block over-messaging before enqueue.
- Duplicate-send dedup within the cap window.
- Circuit breaker halts a sequence on an abnormal failure/bounce rate.
- Every guard decision (allow/block + reason) is written to a guard audit log.

---

## EP-332 · sdk-scheduling

### TK-3618 — availability slotting + schema (business hours, IANA tz, meeting types) · service_layer
- Slot generation respects configured business hours and IANA timezones.
- Meeting types (e.g. 15/30/60 min) are configurable and drive slot length.
- Double-booking is prevented at slot-grant time (concurrent requests cannot both win a slot).
- Schema for `calendar_appointments` + `scheduling_links` created via migration.

### TK-3619 — booking lifecycle + ICS + scheduling links · service_layer
- Create / confirm / reschedule / cancel booking operations with state transitions.
- Valid ICS invite generated and attached; both parties notified via sdk-notification.
- Reschedule/cancel are self-serve-linkable and update the underlying appointment.
- Lifecycle events are emitted for downstream consumers (e.g. sequence replace-CTA).

### TK-3620 — public booking + confirmation routes · api_endpoint
- Unauthenticated slug/booking-page endpoints resolve host availability.
- Booking a slot creates the appointment and returns a confirmation.
- Input validated; taken/expired slots rejected with a clear error.
- Rate-limited / abuse-guarded for public exposure.

### TK-3621 — timed reminders + no-show detection & rebook · service_layer
- 24h / 2h / 15m reminders fire on schedule through sdk-notification.
- A 1:1 appointment with no attendance is marked no-show (not blanket "completed").
- No-show triggers a rescue/rebook task/sequence.
- Reminder + no-show jobs are idempotent under retries.

### TK-3622 — two-way Google/Microsoft sync via connectors · service_layer
- Real two-way sync via connector-gworkspace / connector-microsoft365 (not simulated).
- External event IDs stored; local reschedule/cancel propagate to the provider and vice-versa.
- Requires calendar scopes; missing-scope failure surfaces a clear remediation error.
- Sync conflicts resolved deterministically (last-write / documented rule).

---

## EP-333 · sdk-deliverability

### TK-3623 — suppression list + opt-out tokens (schema + service) · database
- Reason-tagged suppression list + token-based unsubscribe + DNC, schema created via migration.
- Suppression supports tenant scope AND optional cross-org/global scope.
- Opt-out tokens are single-purpose and verifiable; no plaintext PII leaked.
- No projex_crm `prospects` UPDATE branch (coupling dropped).

### TK-3624 — pre-send suppression enforcement API · service_layer
- `isSuppressed` / `suppress` / `unsuppress` / `list` surface exposed.
- Every send path (email + SMS) checks suppression before dispatch; suppressed recipients are skipped with a reason.
- Global-scope suppression takes precedence over tenant-scope.
- Enforcement is idempotent and O(1)-ish per check (indexed lookup).

### TK-3625 — provider bounce/complaint webhooks (HMAC verify + classify + suppress) · api_endpoint
- SendGrid / Mailgun / Postmark webhooks HMAC-verified; unsigned rejected.
- Events classified hard / soft / complaint.
- Hard bounces and complaints auto-suppress the recipient with the reason tag.
- Handler idempotent for duplicate provider deliveries.

### TK-3626 — IMAP inbound reply sync + reply events · service_layer
- IMAP polling with In-Reply-To / References thread-matching correlates replies to sends.
- Reply captured and a reply event emitted that pauses the originating sequence.
- Correlation re-points to `communication_logs` (not projex_crm `prospect_outreach`).
- Poll cursor is durable; no missed or double-processed messages on restart.

### TK-3627 — bounce-rate auto-pause + reputation signals · service_layer
- Per-account bounce-rate threshold breach auto-pauses sending for that account.
- Reputation signals exposed to callers (sequence executor can read before sending).
- Auto-pause is reversible once the rate recovers / on manual override.
- Threshold configurable per tenant.

---

## EP-334 · sdk-crm & sdk-notification extensions

### TK-3628 — funnel stages + richer deal fields + stage-aging (schema) · database
- Configurable funnel stages (not a hardcoded enum) via migration.
- Richer deal fields added (priority, fit, pain/impact/outcome, stakeholders, decision_date, offer_version, forecast).
- Stage-aging support (entered_stage_at / last_stage_change) present for stale detection.
- Migration idempotent; existing sdk-crm deal data preserved.

### TK-3629 — pipeline/deal service + Fastify routes + stage-aging detection · service_layer
- Pipeline/deal CRUD + board queries (funnel.service parity) exposed as Fastify routes.
- Stale detection flags deals idle > 5 business days (business-day aware, not calendar days).
- Board queries return stage-grouped, ordered results suitable for a pipeline view.
- Tenant-scoped; no cross-tenant leakage.

### TK-3630 — NEXT-action model + save-gate enforcement · service_layer
- Mandatory NEXT action object (type, owner, due-time, purpose, intended outcome).
- Save/stage-advance on a non-terminal record is blocked when NEXT is missing, with a clear error.
- Terminal records exempt from the gate.
- Gate is enforced server-side (not just UI).

### TK-3631 — route sequence email/SMS sends through SES/SMTP/Twilio adapters · service_layer
- Sequence email routes through sdk-notification SES/SMTP; SMS through the Twilio adapter.
- Template rendering + recipient-local quiet-hours applied (reuses existing sdk-notification capabilities).
- Suppression checked pre-send (integrates TK-3624).
- Send failures are retryable/failover-capable; no duplicate send on retry.

---

## Note on apiDefinitions
`api_endpoint` tasks (TK-3620, TK-3625) and route-bearing `service_layer` tasks
(TK-3613, TK-3624, TK-3629, TK-3631) will each need a non-empty `apiDefinitions` array to be
completable per the ProjexLight backend-completion rule. Those are produced during
implementation (create → capture → reference chain), not pre-filled here.
