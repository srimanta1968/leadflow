# API contract audit — who fixes what

Evidence gathered against the **live production** deployment on 12 August 2026,
not against local dev. Every status below is a real call made with a real token.

---

## 0 · Headline

**No LeadFlow endpoint serves synthetic or mocked data.** I scanned for it
specifically. The only `synthetic` in the codebase is `syntheticBookingTest` —
a weekly canary that books and cancels a real meeting to prove the calendar
integration still works. That is a health check, not fake data, and removing it
would remove the thing that detects a broken integration before a customer does.

The real problem is the opposite of synthetic data: **screens declare fields the
server never sends**, so they render blank, or crash. That is a LeadFlow bug in
almost every case, and it is mine.

---

## 1 · Fixed and deployed already

| Defect | Cause | Status |
|---|---|---|
| Owner shown as a UUID on Inbox, Contact detail, Contacts list, Pipeline, fair-share audit | server emitted `owner_user_id` where a name belonged; no `users` join | ✅ deployed |
| Calendar booking killed the screen | `BookLiveResult` declared 8 fields the handler has never returned; `content_standard.find` threw | ✅ deployed |
| 55 optional chains that stopped one hop early (`x?.y.z()`), across 21 files | every one turns a missing field into a dead screen instead of a blank panel | ✅ deployed |
| Deploys broke every open tab | web root replaced wholesale; lazy chunks 404'd | ✅ deployed |
| `Import` / `Quick Contact` / `Advanced query` buttons inert | no `onClick`; Advanced query had no client surface at all | ✅ deployed |

---

## 2 · Mine to fix — LeadFlow-side, no ProjexCloud involvement

A scan of all 121 client response interfaces found **27 that declare fields the
server source never mentions**. These render as `--` or empty panels today; with
the guards deployed they no longer crash, but they still show nothing.

**Confirmed by reading the handler:**

- **`CoverageConsole`** — declares `time_off`, `holiday_calendar`,
  `manager_on_duty`, `upcoming_gaps`, `late_coverage`. `/coverage/console`
  returns `business_date`, `timezone`, `within_business_hours`, `schedules`,
  `on_call`, `gaps{unowned_active,overnight_unreleased}`. **Nothing overlaps.**
  The whole screen is reading a response that does not exist.

**Remaining 25, to be traced the same way** — `RoutingConfig`,
`RoutingSimulation`, `PipelineCard`, `PipelineStage`, `PipelineBoard`,
`ReleaseGateResult`, `SequenceSummary`, `SequenceStep`, `EvidenceBundle`,
`WorkflowRunSummary`, `WorkflowDefinitionSummary`, `WorkflowDefinitionList`,
`TemplateRow`, `TemplateList`, `RoutingTrace`, `RoutingTraceStep`,
`FairShareAudit`, `CoverageWindow`, `LeadershipDashboard`, `RoleDashboard`,
`IncidentRow`, `IncidentList`, `OverdueNextActions`, `OfferStaleness`,
`LeadershipSignal`, `CertificationRecord`.

**Method that works, and why it is worth doing properly.** Correcting
`BookLiveResult` to the truth made `tsc` immediately point at every hallucinated
read (`receipt_verified` at Calendar.tsx:64). Fixing the *type* first turns a
runtime crash into a compile error. Fixing the screen first leaves the lie in
place. Each of the 25 gets: read the handler, read the api_definition, correct
the interface, let the compiler find the readers.

---

## 3 · ProjexCloud's to fix — evidenced, with the LeadFlow effect

These are SDK calls LeadFlow makes with a valid key against
`cloud.projexlight.com`, captured from the production gateway log.

### Route missing — 404

| SDK | Call | What breaks in LeadFlow |
|---|---|---|
| `sdk-assignment` | `GET /api/assignment/policies` | Routing Configuration cannot show live capacity bands or specialty matchers. LeadFlow already degrades honestly here — it reports the local rules as "the preference" and says the decision owner is unreachable. |
| `sdk-search` | `GET /api/search/health` | **Advanced query returns 0 results** and reports `search_up=false`. The audit search I just built is functional but has nothing to search. |
| `sdk-data-credits` | `GET /api/credits/balance` | Credit and usage figures unavailable. |
| `sdk-policy` | `POST /api/policies/role-holders` | Role-holder resolution. **Note this is adjacent to the destination-resolution work** — worth checking against `listRoleHolders()`, which you built on `sdk-persona`. Two role-holder paths, one of which 404s, is a fault line worth naming before it becomes a bug. |

### Contract disagreement — 400

A 400 means one of us has the payload wrong, and I am **not** assuming it is
yours. These need joint triage, with the request body from our side:

| SDK | Call | Note |
|---|---|---|
| `sdk-incident` | `GET /api/incidents` | 400 on a GET — likely a required query param we are not sending, or one we send that is rejected. |
| `sdk-workflow` | `POST /api/workflows/definitions` | |
| `sdk-audit` | `POST /api/audit/export` | |
| `sdk-audit` | `POST /api/events/types` | Exactly 2 of 59 rejected: `import.run.committed.v1` and `handoff.accepted.v1`, both `retention_class: regulated`. The other 57 registered fine, which points at something specific to those two rather than a broken route. |

### Already resolved, recorded for completeness

`role_template_app_id_fkey` — root-caused as LeadFlow's, fixed our side, and
your (2) and (3) remain the right platform fix. See
`destination-resolution-requirements.md` §1.

---

## 4 · What is NOT a bug

Worth stating so nobody spends time on them:

- **`identity/review-queue` → 403 for admin.** Correct. Identity Review is
  steward-only by design; `admin` deliberately does not hold `data_steward`.
  Sign in as `qa.steward` to reach it.
- **`409` from `sdk-consent /purposes` and `sdk-rebac /role-templates` at boot.**
  Correct. The provisioners are create-and-tolerate-conflict; 409 means "already
  present" and is the expected steady state.
- **`syntheticBookingTest`.** A canary, not fake data. Keep it.

---

## 5 · Suggested order

1. **ProjexCloud: `sdk-search`.** It is the one 404 that makes a shipped feature
   useless rather than degraded.
2. **LeadFlow: the 27 interfaces**, highest-traffic first — Pipeline, Coverage,
   Routing, Incidents.
3. **Joint: the four 400s**, with our request bodies in hand.
