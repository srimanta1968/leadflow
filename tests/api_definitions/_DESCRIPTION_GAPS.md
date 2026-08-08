# ⚠️ API Definition Description / Error-Case Gaps (MUST-42 / MUST-43)

Single reused backlog — regenerated every commit; entries drop off as they are
fixed. Each api_definition below is missing a QA-grade `description` (what it does
+ EDGE CASES) and/or a root-level `errorCases` array (every error the handler
returns: {status, code, message, when}). These feed **api_library.description**
and the **LLM test-data generator**. Fix EVERY file below — read each handler to
enumerate real errors; do not guess.

- [ ] `POST /api/leadflow/ai/coach/calls` — tests/api_definitions/ai/coach-calls-post.json → missing: negative testCase for 1 errorCase(s) (MUST-64): 400/VALIDATION_ERROR
- [ ] `GET /api/leadflow/ai/manager/risk-signals` — tests/api_definitions/ai/manager-risk-signals-get.json → missing: negative testCase for 1 errorCase(s) (MUST-64): 403/FORBIDDEN
- [ ] `POST /api/leadflow/ai/proposals/:id/decide` — tests/api_definitions/ai/proposals-id-decide-post.json → missing: negative testCase for 2 errorCase(s) (MUST-64): 403/FORBIDDEN, 403/APPROVAL_REQUIRED
- [ ] `POST /api/leadflow/ai/propose` — tests/api_definitions/ai/propose-post.json → missing: negative testCase for 1 errorCase(s) (MUST-64): 403/FORBIDDEN
- [ ] `GET /api/leadflow/ai/revops/proposals` — tests/api_definitions/ai/revops-proposals-get.json → missing: negative testCase for 1 errorCase(s) (MUST-64): 403/FORBIDDEN
- [ ] `POST /api/leadflow/ai/sdr/proposals/:id/accept` — tests/api_definitions/ai/sdr-proposals-id-accept-post.json → missing: negative testCase for 2 errorCase(s) (MUST-64): 400/VALIDATION_ERROR, 422/OFFER_TRUTH_VIOLATION
- [ ] `GET /api/leadflow/calls/:id/intelligence` — tests/api_definitions/calls/id-intelligence-get.json → missing: negative testCase for 2 errorCase(s) (MUST-64): 403/FORBIDDEN, 404/NOT_FOUND
- [ ] `GET /api/leadflow/calls/recording-eligibility` — tests/api_definitions/calls/recording-eligibility-get.json → missing: negative testCase for 1 errorCase(s) (MUST-64): 403/FORBIDDEN
- [ ] `POST /api/leadflow/capture/:id/resolve` — tests/api_definitions/capture/resolve-post.json → missing: negative testCase for 1 errorCase(s) (MUST-64): 403/FORBIDDEN
- [ ] `GET /api/events/stream` — tests/api_definitions/events/stream-get.json → missing: negative testCase for 2 errorCase(s) (MUST-64): 401/UNAUTHENTICATED, 401/INVALID_TOKEN
- [ ] `POST /api/leadflow/channel-decision/bulk` — tests/api_definitions/orchestration/channel-decision-bulk-post.json → missing: negative testCase for 1 errorCase(s) (MUST-64): 403/FORBIDDEN
- [ ] `POST /api/leadflow/channel-decision` — tests/api_definitions/orchestration/channel-decision-post.json → missing: negative testCase for 1 errorCase(s) (MUST-64): 403/FORBIDDEN
- [ ] `POST /api/leadflow/closed-won/start` — tests/api_definitions/orchestration/closed-won-start-post.json → missing: negative testCase for 3 errorCase(s) (MUST-64): 401/UNAUTHENTICATED, 401/INVALID_TOKEN, 403/FORBIDDEN
- [ ] `POST /api/leadflow/intake/orchestrate` — tests/api_definitions/orchestration/intake-orchestrate-post.json → missing: negative testCase for 1 errorCase(s) (MUST-64): 403/FORBIDDEN
- [ ] `GET /api/leadflow/sagas/{run_id}` — tests/api_definitions/orchestration/sagas-run-get.json → missing: negative testCase for 3 errorCase(s) (MUST-64): 401/UNAUTHENTICATED, 401/INVALID_TOKEN, 403/FORBIDDEN
- [ ] `POST /api/sla/alerts/acknowledge` — tests/api_definitions/sla/alerts-acknowledge-post.json → missing: negative testCase for 1 errorCase(s) (MUST-64): 404/NOT_FOUND
- [ ] `POST /api/sla/evaluate` — tests/api_definitions/sla/evaluate-post.json → missing: negative testCase for 1 errorCase(s) (MUST-64): 404/NOT_FOUND

Call `projexlight_get_api_definition_rules` for the exact format.