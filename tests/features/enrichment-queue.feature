@feature_id:443a19e7-52e9-4c92-972f-a0106cc5dd0f
@epic_id:c889c809-5a56-4eb6-b499-0e940d93c83e
Feature: Enrichment Queue screen and capability catalog
  Permissioned Data Capabilities, per mockup #view-enrichment. Buying an
  outcome at a stated price, and seeing every request that was made.

  Control labels below are the REAL ones from
  client/src/pages/app/EnrichmentQueue.tsx, not paraphrases. Quoted strings are
  selector keys the runner turns into CSS - "credits_and_budgets" is a button
  name attribute, not its visible text.

  ALL ASSERTED STRINGS ARE ASCII, because a non-ASCII byte anywhere in the
  posted body makes the Test MCP reject the feature with a 400 the runner
  swallows into an empty log.

  WHAT IS ASSERTED AND WHAT IS NOT. These scenarios assert the SCREEN: the
  framing line, the six KPI tiles, the segmented filter, the capability cards
  and the governance caveats. They do NOT assert register ROWS, because the
  rows come from sdk-data-credits and this environment has no gateway
  credential - the honest local state is an empty register with the banner
  saying why, which is what the last scenario asserts instead of pretending
  rows exist. The row contract is asserted where it can be:
  tests/api_definitions/enrichment/queue-get.json.

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:5eadb6c5-f786-4505-a5ac-5f9f5309a87d
  Scenario: The screen states what a tenant is actually buying
    # The product's whole claim about this screen: an outcome at a price, and
    # who answers it is not part of what you are buying.
    When I navigate to "/app/enrichment"
    Then I should see "Permissioned Data Capabilities"
    And I should see "Buy an outcome at a stated price"
    And I should see "no result creates permission to contact anybody"
    And I should see "Credits & Budgets"
    And I should see "New Request"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:4f4c0bca-f25e-4744-ab13-f175baa99c83
  Scenario: All six KPI tiles are present with their mockup captions
    When I navigate to "/app/enrichment"
    Then I should see "Awaiting Approval"
    And I should see "credits estimated"
    And I should see "Processing"
    And I should see "Completed Today"
    And I should see "successful matches"
    And I should see "No Match"
    And I should see "No-charge policy applied"
    And I should see "Cache Reuse"
    And I should see "credits saved"
    And I should see "Budget Remaining"
    And I should see "reserved"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:8f6627cf-a28c-4767-8652-168602024dc1
  Scenario: The one unavailable tile says why instead of showing a zero
    # AC1. The mockup asks for a provider-fallback count. It is the single
    # figure that would describe the shape of the provider chain even without
    # naming a brand, so it is permanently unavailable BY DESIGN - and the tile
    # prints that reason. A blank would read as "zero fallbacks".
    When I navigate to "/app/enrichment"
    Then I should see "Provider fallbacks are recorded per provider"
    And I should see "which this screen exists not to do"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:85c9c242-08f9-4d1b-8e91-3d958544e5f4
  Scenario: Capability cards state the outcome and the price, never the method
    # AC4. Each card carries what the operator gets and what it costs, plus the
    # two caveats that belong to the whole broker rather than to some cards.
    When I navigate to "/app/enrichment"
    Then I should see "Capability Catalog"
    And I should see "Does not create consent"
    And I should see "carries no permission to use it"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:a1bad801-b09d-4798-b550-8b357209ac2b
  Scenario: The register can be narrowed by status
    # The segmented filter re-reads the register rather than filtering rows in
    # the browser, so a segment count never moves with itself.
    When I navigate to "/app/enrichment"
    And I click "filter_awaiting"
    Then I should see "Awaiting"
    And I should see "Capability Catalog"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:0f0bdf8a-4e84-465d-b489-1187f48b5862
  Scenario: An unread register is not reported as an empty one
    # The distinction the whole rail is built around. With no gateway
    # credential the register cannot be read, and the screen says so rather
    # than showing a confident zero.
    When I navigate to "/app/enrichment"
    Then I should see "could not be read, so this is not an empty queue"
