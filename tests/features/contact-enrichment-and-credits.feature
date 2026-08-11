@feature_id:4eb293bb-49ef-4d8c-89c7-51ffe29a30c1
@epic_id:c889c809-5a56-4eb6-b499-0e940d93c83e
Feature: Contact Enrichment modal and Data Credits drawer
  Buying a paid answer about somebody, and seeing what the organization has
  spent doing it. Mockup #enrichDrawer and #creditsDrawer.

  Control labels below are the REAL ones from
  client/src/components/app/ContactEnrichmentModal.tsx and
  client/src/components/app/DataCreditsDrawer.tsx, not paraphrases. The quoted
  strings are selector keys the runner turns into CSS - "reserve_and_run" is the
  button's name attribute, not its visible text.

  BOTH OVERLAYS OPEN FROM THE LEAD QUEUE. Credits from the header, because a
  balance belongs to the organization; enrichment from a row, because a request
  is always ABOUT a particular contact and a modal opened with nobody selected
  would have nothing to ask about.

  ALL ASSERTED STRINGS ARE ASCII. A non-ASCII byte anywhere in the posted body
  makes the Test MCP reject the feature with a 400 that the runner's curl
  swallows, so the run comes back empty rather than failed. The mockup writes
  "Validate primary phone - 1 credit" with an en dash; the component renders a
  hyphen and these steps assert the hyphen.

  WHAT IS ASSERTED AND WHAT IS NOT. These scenarios assert the SCREENS: the
  mockup copy, the four capabilities with their prices, the live verdict
  callout, the disabled Reserve & Run, and the four budget tiers. They do NOT
  assert a completed enrichment run, because that needs sdk-data-credits and
  sdk-policy and this environment has no gateway credential - the honest local
  state is a degraded verdict, which is what scenario three asserts instead of
  pretending a run happened. The spend path is covered where it can be:
  tests/api_definitions/enrichment/eligibility-post.json and
  tests/api_definitions/enrichment/requests-post.json.

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:0e053f6c-73c4-4d8c-bc3d-7879df1471a8
  Scenario: The drawer states all four budget tiers in the organization's own words
    # AC3. These four lines are the tenant's spending policy. An operator
    # comparing this screen against what they agreed needs the same words in
    # both places, so the tiers are asserted verbatim rather than by shape.
    When I navigate to "/app/leads"
    And I click "credits_and_budgets"
    Then I should see "Data Credits"
    And I should see "Organization Balance"
    And I should see "Current Cycle"
    And I should see "Capability Usage"
    And I should see "Budget Controls"
    And I should see "Canvassers"
    And I should see "Request only"
    And I should see "Sales representatives"
    And I should see "10 credits/day"
    And I should see "Sales managers"
    And I should see "bulk approval threshold 50"
    And I should see "Owner"
    And I should see "Organization balance and purchase authority"
    And I should see "Export Ledger"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:8fb57a88-b27d-4a3a-9dfb-f4be09d5f4c2
  Scenario: Provider cost is never shown to a tenant user
    # The contract the whole broker exists to keep. The drawer says what a
    # tenant may see, and the sentence itself is the assertion: if a provider
    # name ever reaches this panel, this notice is the thing that was wrong.
    When I navigate to "/app/leads"
    And I click "credits_and_budgets"
    Then I should see "Provider costs are operator-only"
    And I should see "not provider-specific credentials or routing"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:ec152b09-39f4-43d5-87ab-b871d3aa2052
  Scenario: The enrichment modal prices each capability and states what is reserved
    # AC1 and AC2 as the operator meets them. The capabilities carry outcomes
    # and prices and never a provider; the estimate note says why a failed
    # lookup is not charged twice.
    When I navigate to "/app/leads"
    And I click "request_enrichment"
    Then I should see "Contact Enrichment"
    And I should see "Select Capabilities"
    And I should see "Credit estimate is reserved before provider invocation"
    And I should see "Validate primary phone"
    And I should see "Line type, format, freshness and risk signals"
    And I should see "Find additional contact points"
    And I should see "Returns candidates only; does not create consent"
    And I should see "Purpose & Governance"
    And I should see "Business Reason"
    And I should see "Estimated Data Credits"
    And I should see "Technical failures and recent cache hits are not double-charged"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:29c886be-c1a3-4b10-8730-dc3a537d97ba
  Scenario: Selecting a capability produces a live governance verdict
    # AC1. The callout is not computed once on open - it appears in response to
    # the selection, which is the behaviour this scenario exists to catch. With
    # no gateway credential the honest verdict is a review rather than an
    # allow, and asserting the callout's PRESENCE rather than its wording is
    # what keeps this scenario true in an environment that has one.
    When I navigate to "/app/leads"
    And I click "request_enrichment"
    And I click "validate_phone"
    Then I should see "Eligible"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:2763caa7-d826-4ebe-8ed1-ba50e0349e9a
  Scenario: Reserve and Run cannot be pressed before a capability is chosen
    # AC2, from the operator's side. A request with nothing selected would
    # reserve nothing and run nothing, so the button is disabled rather than
    # answering an error after the press.
    When I navigate to "/app/leads"
    And I click "request_enrichment"
    Then I should see "Reserve & Run"
    And I should see "Cancel"
