# LeadFlow — Architecture & SDK Sourcing Decision

**Date:** 28 July 2026
**Status:** Approved for build — planned and tracked in ProjexLight (project `894bc4c8`)
**Sources:** Lynked Up Pro Prelaunch License Sales SOP v3.0 (50pp) · LeadFlow PRD · InboundCRM Component Sourcing Matrix · InboundCRM Build Strategy Analysis (rev. 15 Jul 2026) · `lynkeduppro_contact_workflow_studio (1).html` design template · ProjexCloud SDK catalog v2026.07.21 (67 SDKs / 469 APIs)

---

## 1. The decision in one line

Build LeadFlow as an **SDK-only application** on ProjexCloud. Identity, tenancy, authorisation, consent, audit and every horizontal capability come from ProjexCloud. Where the SOP needs something no SDK covers, **build it once as a reusable ProjexCloud SDK** — never as LeadFlow-local code. LeadFlow itself contains only screens, orchestration sagas, and Lynked-Up-specific configuration.

This continues the 15 Jul 2026 decision that reduced the ProjexCRM copy-list to **zero**.

---

## 2. The three-way split

| Bucket | Count | What it is |
|---|---|---|
| **Consumed as-is from ProjexCloud** | 38 SDKs | Mature capability that already fits |
| **New SDKs contributed upstream** | 5 | Genuine platform gaps, reusable by every vertical |
| **Extensions to existing SDKs** | 9 | The SDK exists but is thin or geo/field-service tuned |
| **Built locally in LeadFlow only** | — | Screens, orchestration sagas, customer config |

---

## 3. NEW SDKs → ProjexCloud (5)

Each is a genuine platform gap. None contains a LeadFlow identifier, stage name, role name or business rule — all vertical specifics arrive as configuration. Tracked as epics **EP-346** (contact data platform) and **EP-351** (revenue operations).

### 3.1 `sdk-source-record` — provenance-first assertion store
The design template's entire premise: *source first, entity later; link, don't overwrite.*
Immutable raw evidence + origin class (8-value enum) + P0→P4 trust ladder + bitemporal effective/retrieved + source-rights attestation with permitted uses + external-ID crosswalks that are never replaced.
**Why upstream:** healthcare MDM, insurance, field service and logistics all ingest external data and need identical provenance semantics. Nothing in the 67-SDK catalog provides it.

### 3.2 `sdk-import` — governed import runs
Preview → AI-assisted mapping → versioned reusable templates → value crosswalks → transform plan → dry-run impact → exception file → atomic idempotent commit → 24-hour rollback, with full run lineage.
**Why upstream:** `sdk-ingest` is a *write primitive* (3 endpoints, idempotent upsert). It has no mapping, preview, dry-run, exception or rollback layer. Every vertical rebuilds this today.

### 3.3 `sdk-sla` — business-clock SLA engine
Named IANA business calendars (never fixed UTC offsets), holidays, late-coverage extension, recipient-local contact windows, configurable escalation ladders, breach reason codes, attainment metrics.
**Why upstream:** `sdk-approval` offers per-step SLA *inside an approval only*. There is no standalone response-clock engine. Support, field service, logistics and healthcare all need one.
**This is the single most reused new primitive** — it is what makes the customer's 30-minute non-negotiable enforceable rather than aspirational.

### 3.4 `sdk-coverage` — who can act right now
Schedules, PTO, meeting blocks, holiday calendars, live presence, on-call rosters, capacity caps with current load, backup designation with acceptance clocks.
**Why upstream:** `sdk-assignment` ships **one** endpoint (`assign-by-task`) and assumes eligibility is already known. "Who can act right now" is universal.

### 3.5 `sdk-data-credits` — vendor-abstracted capability broker
Outcome-named capability catalog, credit pricing, reserve → settle → refund, no-match-no-charge, result cache with reuse counter, provider fallback and health hidden from the tenant, role-based budgets and approval thresholds, exportable ledger.
**Why upstream:** every vertical buys third-party data or AI capability and needs identical reserve/settle/refund/cache/budget semantics with the vendor hidden.
*Note:* `packages/sdk-capability` is CLI scaffolding, not a runtime broker — this is genuinely new.

---

## 4. EXTENSIONS to existing ProjexCloud SDKs (9)

All additive and backward compatible.

| SDK | Today | Extension |
|---|---|---|
| `sdk-assignment` | 1 endpoint | Full six-step routing order, round-robin rotation, primary/backup/manager, acceptance clocks, simulation |
| `sdk-crm` | deal-scoped NEXT + save-gate | Generalise to any subject; close-reason taxonomy; date-push log; stage aging |
| `sdk-conversation` | sessions + messages | Omnichannel unified thread, purpose/eligibility scoping, compose guardrails, reply linkage |
| `sdk-parsing` | orchestrator + schema resolver | Smart-paste, email-signature, business-card, vCard, voice-note extraction schemas |
| `sdk-projection` | subject view service | Explainable survivorship rules, replay-on-retract |
| `sdk-notification` | rich already | Per-purpose channel decision, frequency caps, no-answer dedup window |
| `sdk-rebac` | relationship graph | Bitemporal contextual roles with trust state, validity and evidence refs |
| `sdk-lead-scoring` | geo/field-service tuned | B2B firmographic and intent feature families |
| `sdk-connectors` | DLQ advertised, not implemented | Implement retry/DLQ/reconcile + Meta/LinkedIn/TikTok/Google/chat lead-form adapters |

---

## 5. LOCAL to LeadFlow only

Everything here is genuinely app-specific and would not help another vertical:

- **All 12+ screens** implementing the Contact Workflow Studio design template, plus Contact 360's eight tabs
- **The design system** — dark token set, shell, command palette, 10-step wizard, tables, drawers, signature canvas
- **Four orchestration sagas** that span SDKs: `LeadIntakeOrchestrator`, `ChannelDecisionComposer`, `ClosedWonSaga`, `EscalationGlue`
- **The Leadership Operational Dashboard** — explicitly an app-build item; no SDK provides it
- **Lynked-Up configuration:** 10 pipeline stages, disposition codes, close reasons, role names, purpose taxonomy, business hours, holiday list, offer content, 8 email + 10 SMS templates, call scripts, objection library, 13-step cadence, certification scorecards
- **12 LeadFlow-only tables** — dashboard rollup, saved view, stage config, disposition code, close reason, template library, KPI definition, certification score, digest, purpose map, routing config, outbox

**No contact, consent, assignment, SLA, sequence, appointment, payment or audit table exists locally.** Those belong to SDKs.

---

## 6. How this scales

**Adding a capability to LeadFlow** → check the catalog first; if it exists, configure it; if it does not and it is horizontal, it becomes an SDK that every vertical inherits.

**Adding the next vertical** (field service, insurance, healthcare CRM) → it installs the same 43 SDKs, implements its own screens against the same design system, and supplies its own config. The five new SDKs built here mean the next vertical gets provenance, governed import, SLA clocks, coverage and a capability broker on day one.

**The cost curve inverts.** LeadFlow pays a one-time upstream premium for five SDKs; vertical two pays nothing for them. That is the whole argument for SDK-only over lift-and-adapt, and it is why the copy-list is zero.

**Load scales per SDK.** Each SDK owns its tables and scales independently. LeadFlow's read projections absorb dashboard load so no dashboard ever fans out into N+1 SDK reads.

---

## 7. Design template compliance

`lynkeduppro_contact_workflow_studio (1).html` is the **binding UI contract**, not a reference.

- Its exact `:root` token values are ported verbatim into the design system (EP-352)
- Every frontend task names the mockup section (`#view-capture`, `#quickModal`, `#importModal` step N, `#c-overview`…) and the CSS classes it must reproduce
- A lint rule fails any build introducing a raw hex colour, a bespoke modal, a bespoke table or an ad-hoc KPI tile
- Visual-regression baselines are pinned to the approved mockup screens

---

## 8. What is tracked in ProjexLight

| Entity | Count |
|---|---|
| Epics | 28 (`EP-346` … `EP-373`) |
| Features | 117 |
| Tasks | 136 (`TK-3902` … `TK-4037`) |
| BDD scenarios | 12 launch-critical (`SC-3036` … `SC-3047`) |

Every backend and frontend task states: which **ProjexCloud APIs** it calls (by exact method + path), which **new SDK or SDK extension** it depends on, and which **new local APIs, services and UI components** it must build.

---

## 9. Build sequence

1. **Phase 0 — Upstream** (`EP-346`, `EP-351`): the 5 new SDKs + 9 extensions, published to the registry, catalog regenerated. Blocking for everything else.
2. **Phase 1 — Foundation** (`EP-347`, `EP-352`, `EP-353`): identity spine, design system, composition layer.
3. **Phase 2 — Contact Data Platform** (`EP-348`, `EP-354`–`EP-361`): the design template's nine screens.
4. **Phase 3 — Revenue Operations** (`EP-349`, `EP-362`–`EP-369`): the SOP's twelve P0 capabilities.
5. **Phase 4 — Intelligence & Governance** (`EP-350`, `EP-370`–`EP-373`): campaigns, dashboards, AI, workflow studio, go-live QA.

**Go-live gate:** all twelve SOP acceptance tests green (`TK-4036`), all five approval signatures recorded, every rep certified.

---

## 10. Open item for the customer

The pre-existing prototype epic **EP-345 "Lead Management Epic"** (4 stub features, 15 auto-generated tasks) is superseded by this plan and now overlaps `EP-349` and `EP-362`–`EP-364`. Recommend archiving it. Not actioned — that is the customer's call.
