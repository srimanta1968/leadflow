# ProjexCRM → ProjexCloud Coverage Audit & Copy-List

**Purpose:** decide, for building the customer's **Inbound CRM** on the ProjexCloud SDK platform, which
`projex_crm` code must be **copied**, which is already **covered** by an SDK, which warrants a **new SDK**,
and which to **drop** — mapped to the customer SOP's 12 P0 launch-blocker capabilities.

**Method:** classified all **148 services + 14 workers + inbound routes** in `c:\Users\srima\projex_crm\server\src`
against ProjexCloud's 70+ existing SDKs **plus** the P14 SDKs now planned (sdk-sequence, sdk-scheduling,
sdk-deliverability, and the sdk-crm / sdk-notification / sdk-assignment extensions — EP-331..335).

> Timing note: the P14 SDKs are planned, not yet coded, so "COVERED by P14 SDK" is judged against **planned
> scope**. Re-run at the code level once the SDKs are built (the Phase-1 → Phase-2 checkpoint).

---

## Headline

| Bucket | Count | Meaning |
|---|---:|---|
| **COVERED** | 84 (73 svc + 11 workers) | Consume an existing/P14 SDK — do **not** copy |
| **COPY** | 7 | Copy into the InboundCRM app layer (no SDK owner) |
| **NEW-SDK** | 2 svc → **1 SDK** | Propose `sdk-qualification` (reusable) |
| **DROP** | 68 (65 svc + 3 workers) | Outbound prospecting / LinkedIn / MCP-fleet / AI-agent mesh — not needed |

**Bottom line:** ~57% of `projex_crm` is dropped, ~40% is already covered by SDKs.

> **⚠️ SOP VALIDATION (2026-07-15, authoritative — supersedes the original copy-list):** Re-checked the 7 copy items
> and the proposed new SDK against the primary source — `Lynked_Up_Pro_..._Build_Standard_v3.0.pdf` (50 pp., §27
> P0/P1/P2 tiering + §28 data-model). **None of the 7 is a P0 must-have; do NOT copy any of them.** Each item is
> either absent from the SOP or its required *substance* already belongs to a planned SDK. `sdk-qualification` is
> P2 (AI-assist), not launch-blocking. The real action is the opposite of copying: **assign owners for
> SOP-required objects that currently have no home** (Offer/feature-status truth, Onboarding Handoff, Exception/
> Incident, call/voicemail logging). See §1 (revised) and the new §1a.

---

## 1. THE COPY-LIST — REVISED after SOP validation: copy NOTHING

The original audit (based on the derived Gap-Analysis) proposed 7 copies. Validated against the **authoritative SOP
PDF**, every one fails to be a P0 requirement. The required *substance* of each already has an SDK home — so copy
none; instead ensure the named SDK covers it.

| # | Candidate | SOP verdict | Evidence (SOP) | Where the required substance lives |
|---|---|---|---|---|
| 1 | `event.service` | **NOT-REQUIRED** | §03/§27/§29 intake list = forms, DMs, chat, calls, referrals, checkout, purchases. "Event" = **Source Event** or **Meeting** only; no public event-registration channel; "capacity" = *rep* capacity. | Source-event capture in `sdk-crm`/`sdk-ingest` |
| 2 | `permanent-link.service` | **NOT-REQUIRED** | §09 requires an *approved booking link connected to the rep calendar*; no "slug/landing-page" text. | `sdk-scheduling` (booking link) |
| 3 | `website-domain-integration.service` | **NOT-REQUIRED** | §29/§22 require website source capture + attribution (UTM/referrer/session); "company/domain" = the *lead's* domain for dedupe, not a tenant map. Single-company SOP — no domain→tenant mapping. | `sdk-crm` source adapter + `sdk-identity-resolver` |
| 4 | `lead-notes.service` | **NICE-TO-HAVE** | §28 Activity = "calls, SMS, email, DMs, **notes**, replies, meetings" on **one chronological timeline** (§27). Favorites/threads absent from SOP. | `sdk-crm` Activity timeline |
| 5 | `business-context.service` | **NOT-REQUIRED** | §28 Account = the *lead's* company, not the tenant's profile. Only tenant-profile need is **sender identity + physical address** (§21, a compliance concern). AI copy is P2 (§27). | `sdk-deliverability`/compliance (sender identity); AI copy = P2 |
| 6 | `organization-readiness.service` | **NOT-REQUIRED** | §23/§26 "readiness" = a **manual signature-based go-live gate** run by people, not a runtime feature. | N/A — process gate, not software |
| 7 | `filter-config.service` | **NICE-TO-HAVE (P1)** | §27 P1: "…**saved views**, task queues…" — explicitly P1 roadmap, not P0. | Defer to P1 |

**Net: the copy-list is now empty.** Don't copy any projex_crm service; ensure the SDKs above carry the required
substance (notes → Activity timeline; website/UTM → source adapter; sender identity → deliverability).

---

## 1a. SOP-REQUIRED objects with NO owner (the real gap — decide these before coding)

The SOP validation flipped the actionable finding: instead of copying, these **mandatory** §28 objects / §27 P0
capabilities need an owner. **All are cross-customer reusable** (reusable engine → SDK; the customer's content/config
→ InboundCRM app). Resolutions are **verified against the actual SDK code (2026-07-15)** — extend-vs-new is
evidence-backed, not guessed.

| # | SOP-required item (evidence) | Reuse (verified exists) | Build new | Verified resolution |
|---|---|---|---|---|
| 1 | **Offer Data Sheet (versioned) + feature-status matrix** — launch-blocker #1 (§22 "CRM requires version"; §13 "never from memory") | `sdk-taxonomy` versioned-record pattern (immutable versions, status lifecycle, activate/resolve-current-with-fallback); `sdk-approval` publish gate | offer/data-sheet model + feature-status matrix + `live/beta/roadmap/retired` enum + **stale-reference guard** (absent in all SDKs) | **NEW thin `sdk-offer-catalog`** (clone taxonomy pattern + sdk-approval gate) |
| 2 | **Onboarding Handoff** (§28; §19 "CS accepts/rejects handoff") | `sdk-workflow` saga (typed steps + compensation); `sdk-approval` `approve`/`reject` gate — both exist | handoff record + status only | **NEW thin `sdk-handoff`** (orchestration→sdk-workflow, accept/reject→sdk-approval) |
| 3a | **Exception/Incident object** (§28 type/root-cause/owner/recovery/verification) | `sdk-audit` immutable evidence sink; `sdk-service-request` SLA-scan pattern | incident record + lifecycle (no SDK models this) | **NEW thin `sdk-incident`** (backed by sdk-audit) |
| 3b | **Connector dead-letter / manual-fallback queue** (§21/§29) | `sdk-webhook` proven DLQ pattern (`dlqReplay.ts`, `outboxWriter.ts`) | DLQ/retry/reconciliation for failed connector syncs | **EXTEND `sdk-connectors`** — ⚠️ manifest advertises DLQ but `src/` has **zero implementation** (latent defect) |
| 4a | **Call/voicemail logging as P0 Activity** (§27; §29 disposition/missed-call) | `sdk-crm` Activity (`kind:'call'` accepted) | `'voicemail'` kind + direction/disposition/duration/recording_url/recording_consent + migration | **EXTEND `sdk-crm`** (small activity-schema change) |
| 4b | **Telephony channel** — tracking numbers, recording+consent (§29) | `sdk-consent` (recording-consent); existing connector pattern | number provisioning, AMD→voicemail, status/recording callbacks | **NEW `connector-twilio-voice`** (+ optional thin `sdk-voice`); NOT sdk-notification (send() has no webhook surface) |
| 5 | **Security + audit** (§27 immutable events/retention; §28 role matrix) | `sdk-audit` + `sdk-rebac`/`sdk-policy` + `sdk-data-rights` | — (role *names* = app config) | **ALREADY COVERED** — confirm wiring only |

**Summary:** 4 new packages (`sdk-offer-catalog`, `sdk-handoff`, `sdk-incident`, `connector-twilio-voice` [+opt `sdk-voice`]),
2 extensions (`sdk-crm` call fields, `sdk-connectors` DLQ), 1 already-covered (#5). Reusable engine → SDK; the customer's
offers/promises/disposition-codes/role-names → InboundCRM app.

Lower-confidence (likely covered — verify): **NEXT Action/Task object** owner = `sdk-crm` (TK-3630 save-gate);
**America/Chicago business clock + recipient-local tz** owner = scheduling/SLA.

## 2. `sdk-qualification` — DEFER (P2, not launch-blocking)

The proposed new SDK (`lead-questions` + `lead-response-scoring` → AI question-gen + AI response scoring) is **not**
SOP-required for launch. Per §27 the qualification *stage* and the lead *score field* are P0 and already owned by
`sdk-crm`; the **AI-generated / AI-scored** layer is explicitly **P2 "AI Assist … with human review."** §41
qualification uses the **approved human SPIN/Sandler script**, not AI-generated questions. **Do not build now** —
revisit in the P2 optimization phase.

---

## 3. SOP 12 P0 coverage — where each launch-blocker is satisfied

| # | P0 capability | How it's met | Status |
|---|---|---|---|
| 1 | Universal lead intake | `sdk-ingest` + **COPY** event/permanent-link/website-domain + public-capture/events routes | SDK + copy |
| 2 | Canonical identity + dedupe | `sdk-identity-resolver` (lead-dedup, global-contact, prospect-unification all covered) | SDK |
| 3 | Ownership + backup | `sdk-assignment` (+ P14 round-robin) + `sdk-rebac` + `sdk-tenant`; **COPY** lead-notes | SDK + copy |
| 4 | NEXT-action enforcement | `sdk-crm` P14 save-gate (TK-3630) + funnel; **NEW** `sdk-qualification` for triage | SDK + new-SDK |
| 5 | **SLA clock + alerts** | **No projex_crm source** (missing there too) → **BUILD** on `sdk-approval` + `sdk-notification` | **App BUILD** |
| 6 | Two-way comms incl SMS | `sdk-notification` (P14 SMS STOP/HELP + receipts) + `sdk-deliverability` | SDK (P14) |
| 7 | Consent + suppression | `sdk-consent` + `sdk-deliverability` (unsubscribe, bounce-sync, webhook-security) | SDK |
| 8 | Sequence orchestration | `sdk-sequence` — absorbs the entire outreach/send/sequence cluster (~18 svc + 6 workers) | SDK (P14) |
| 9 | Calendar engine | `sdk-scheduling` (calendar, booking, appointment-cleanup, 2-way sync) | SDK (P14) |
| 10 | Payment + onboarding | `sdk-payment`/`sdk-billing` (stripe, subscription); **COPY** business-context/org-readiness; **BUILD** onboarding saga on `sdk-workflow` | SDK + copy + build |
| 11 | Dashboards + exceptions | `sdk-analytics` (dashboard-view, report-generation); **COPY** filter-config; **BUILD** leadership dashboard | SDK + copy + build |
| 12 | Security + audit | `sdk-audit`, `sdk-secrets`/`sdk-vault`, `sdk-rebac`, `sdk-identity` (whole auth cluster covered) | SDK |

**App-layer BUILD items (not copies, no SDK source):** SLA clock + escalation (SOP 5), leadership dashboard (SOP 11),
onboarding handoff saga (SOP 10), next-best-action (SOP 4, or reuse `sdk-recommendation`). These are the docs'
"BUILD-new" items and belong in the InboundCRM app project.

---

## 4. COVERED — the big wins (consume, don't copy)

| Cluster | projex_crm files | Covered by |
|---|---|---|
| Outreach / sequence / send | outreach-*, sequence-*, send-queue/window/time, followup-* (~18 svc + 6 workers) | **sdk-sequence** + sdk-engagement |
| Deliverability | webhook-security, unsubscribe, {sendgrid,mailgun,postmark}-bounce-sync, inbox-sync (5 svc + 5 workers) | **sdk-deliverability** |
| Calendar / booking | calendar, calendar-integration, booking-notification, booking-verification, appointment-cleanup | **sdk-scheduling** |
| Pipeline / funnel | funnel, lead-prioritization, recommendation, workflow | **sdk-crm** (P14) + sdk-lead-scoring + sdk-recommendation + sdk-workflow |
| Identity / auth | auth, auth-*, google-oauth, mfa, linkedin-login-oauth, rbac, organization, workspace-context | **sdk-identity** + sdk-rebac + sdk-tenant |
| Payment / billing | stripe, subscription, billing-resolver, usage-history | **sdk-payment** / **sdk-billing** |
| Comms transport | email-sender, email-outreach, system-email, sendgrid-system-mail, notification | **sdk-notification** |
| Analytics | dashboard-view, report-generation, communication-analytics, engagement, outreach-signal | **sdk-analytics** / sdk-engagement |
| Security / secrets | encryption, system-settings, user-integration, integration, access-log | **sdk-secrets**/**sdk-vault** + sdk-audit |

---

## 5. DROP — not needed for an inbound CRM (68 files)

| Cluster | Count | Examples |
|---|---:|---|
| Outbound campaign engine | ~9 | campaign, campaign-defaults/forecast/progress/readiness/scheduler, admin-campaign, weekly-campaign(+worker) |
| Prospect discovery / enrichment | ~10 | prospect-discovery/import/provider/enrichment/unification/archive, enrichment, offer-matching, product-alignment |
| Email-pattern / list-hygiene AI | ~6 | email-pattern-intelligence, email-pattern-study-agent, email-validation(+agent), domain-vocabulary, validation-worker |
| LinkedIn scraping / outreach | ~9 | linkedin, linkedin-dm, linkedin-oauth, linkedin-rate-limiter, linkedin-social-outreach, linkedin-extraction-config, signal-analysis, extension-capture, prospect-discovery |
| MCP-fleet / AI-agent mesh | ~10 | base-agent, message-bus, workflow-agent-dispatcher, mcp-instance/feedback/reconciler/work, mongo-health, context-agent, company-pattern-agent |
| projex_crm infra | ~8 | aws-fleet, fleet-manager, container-sizes, db-optimization, performance-report, error-logger, support, credit |
| Misc / not-P0 | ~rest | experiment, feedback(+summary), demo-funnel, website-scraper, ai-model/feedback, sequence-auto-generator, promotion-evaluator |

Rationale: an inbound CRM receives leads; `projex_crm`'s outbound-prospecting machinery (find prospects, scrape
LinkedIn, guess emails, blast campaigns) and its ECS/MCP worker-fleet infra have no inbound role.

---

## 6. Judgment calls / optional follow-ups

- **`validation-worker`** (email-address verification) — DROP for P0, but the one unclaimed reusable capability; fold into `sdk-deliverability` **only if** list-hygiene later matters.
- **`credit`** — DROP as prospecting-quota; if the Inbound CRM wants usage metering, that's `sdk-billing`, not a copy.
- **`business-context`** — listed as COPY, but prefer **extending `sdk-profile`/`sdk-tenant`** to hold company-profile fields → then it's COVERED and reusable.
- **`sdk-qualification`** — the sole NEW-SDK; decide SDK-now vs copy-then-promote.

---

## 7. Recommended sequencing

1. **Finish P14 SDKs** (EP-331..335) — unblocks all the COVERED clusters above.
2. **Decide `sdk-qualification`** (new SDK) vs copy — before the InboundCRM app project starts its qualification stage.
3. **Create the InboundCRM ProjexLight app project** whose epics are the 12 SOP P0 capabilities; wire SDKs, copy the 7 files, and BUILD the 4 app-layer items (SLA clock, leadership dashboard, onboarding saga, next-best-action).
4. **Re-run this audit at code level** once SDKs are built to confirm no covered capability regressed to a gap.

---

*Generated from a full classification pass over `projex_crm/server/src` (services + workers + routes) against the
current ProjexCloud SDK inventory and the P14 plan. Counts: 148 services + 14 workers → 84 covered, 7 copy,
2→1 new-SDK, 68 drop.*
