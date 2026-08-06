@feature_id:fccb7197-9262-47dd-9a8f-96892cc877ad
@epic_id:befcccab-d3b9-4629-828b-0df9f2c981d6
Feature: Capture Inbox screen and unresolved-capture queue
  Every quick add, browser capture, business-card scan, signature parse or
  mobile selection lands here first as a source record with its evidence kept,
  before it is anybody's lead.

  Control labels below are the real ones from
  client/src/pages/app/CaptureInbox.tsx, not human-friendly paraphrases.

  SIGN-IN is the @login:default tag, never hand-written steps. The runner runs
  the flow from tests/config/test-config.json loginConfig, whose
  successIndicator is "Capture Inbox" - so a tagged scenario is already ON this
  screen when its first step runs, and needs no navigation of its own. That is
  also why no scenario below clicks the sidebar: this is the landing screen.

  THREE SCENARIOS RATHER THAN ONE, because the single one they replaced ran to
  28 steps and most of them were setup and static copy. Split by what would
  make them fail: the rail scenario fails when a tile's caption drifts from the
  mockup, the panels scenario when the governance copy is edited or dropped,
  and the drill-in scenario when the filter stops working. One scenario
  reported all three as a single red line and named none of them.

  WHAT IS ASSERTED HERE AND WHAT IS NOT. These scenarios assert the screen: the
  mockup copy, the six tiles, the drill-in, the source breakdown and the three
  governance rules. They do NOT assert the queue's ROWS, because the rows come
  from the ProjexCloud provenance store and this environment has no gateway
  configured, so the honest state of the queue in a local run is empty with the
  banner saying why. The row contract is asserted where it can be:
  tests/api_definitions/capture/inbox-get.json for the composed payload, and
  client/tests/unit/captureInboxAction.test.ts for the per-trust-state action,
  which walks every combination of rung, origin class and caller authority that
  a browser click cannot reach one row at a time.

  @scenario_id:6c147e73-a73c-4214-a7a2-37cec6655198
  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  Scenario: An operator triages the Capture Inbox and drills into a trust rung
    Then I should see "Universal Quick Capture"
    And I should see "Unresolved Captures"
    When I click "New P0"
    Then I should see "Filtered to New P0"
    When I click "Show all captures"
    Then I should see "Unresolved Captures"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:65af0c48-5ae1-4ac4-9725-4e9984196bdb
  Scenario: The six-tile KPI rail carries the mockup's captions
    Then I should see "New P0"
    And I should see "Not yet normalized"
    And I should see "Parsed P1"
    And I should see "Ready for candidate search"
    And I should see "Candidate P2"
    And I should see "Need review"
    And I should see "Offline Queue"
    And I should see "Mobile sync pending"
    And I should see "Browser Captures"
    And I should see "This week"
    And I should see "SLA Risk"
    And I should see "Older than 24 hours"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:19e3b328-e9a5-4322-bd3b-dc0a48b2ef32
  Scenario: The source breakdown and the three capture rules are stated on the screen
    Then I should see "Capture Sources"
    And I should see "Capture Rules"
    And I should see "No automatic enrichment"
    And I should see "Source first, entity later"
    And I should see "Restricted sites"
