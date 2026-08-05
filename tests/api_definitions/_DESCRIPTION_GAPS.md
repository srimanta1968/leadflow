# ⚠️ API Definition Description / Error-Case Gaps (MUST-42 / MUST-43)

Single reused backlog — regenerated every commit; entries drop off as they are
fixed. Each api_definition below is missing a QA-grade `description` (what it does
+ EDGE CASES) and/or a root-level `errorCases` array (every error the handler
returns: {status, code, message, when}). These feed **api_library.description**
and the **LLM test-data generator**. Fix EVERY file below — read each handler to
enumerate real errors; do not guess.

- [ ] `POST /api/leadflow/ai/coach/calls` — tests/api_definitions/ai/coach-calls-post.json → missing: negative testCase for 1 errorCase(s) (MUST-64): 400/VALIDATION_ERROR
- [ ] `GET /api/leadflow/ai/coach/scorecard/:callId` — tests/api_definitions/ai/coach-scorecard-callid-get.json → missing: negative testCase for 1 errorCase(s) (MUST-64): 400/VALIDATION_ERROR
- [ ] `POST /api/leadflow/ai/proposals/:id/decide` — tests/api_definitions/ai/proposals-id-decide-post.json → missing: negative testCase for 2 errorCase(s) (MUST-64): 403/FORBIDDEN, 403/APPROVAL_REQUIRED
- [ ] `POST /api/leadflow/ai/propose` — tests/api_definitions/ai/propose-post.json → missing: negative testCase for 1 errorCase(s) (MUST-64): 403/FORBIDDEN
- [ ] `POST /api/leadflow/ai/sdr/proposals/:id/accept` — tests/api_definitions/ai/sdr-proposals-id-accept-post.json → missing: negative testCase for 2 errorCase(s) (MUST-64): 400/VALIDATION_ERROR, 422/OFFER_TRUTH_VIOLATION

Call `projexlight_get_api_definition_rules` for the exact format.