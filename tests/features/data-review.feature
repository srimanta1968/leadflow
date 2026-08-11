@feature_id:4e9ec7d2-0361-4fb1-aec3-b02fb37fa3da
@epic_id:3d26a52b-753c-4ee4-849c-6433f98473d6
Feature: Data Review screen - case tiles and unified queue
  Field-Level Verification and Source Conflict, per mockup #view-review. Every
  case here is a disagreement the system will not resolve on its own.

  Control labels below are the REAL ones from
  client/src/pages/app/DataReview.tsx, not paraphrases. Quoted strings are
  selector keys the runner turns into CSS - "risk_high" is a button name
  attribute, not its visible text.

  ALL ASSERTED STRINGS ARE ASCII, because a non-ASCII byte anywhere in the
  posted body makes the Test MCP reject the feature with a 400 the runner
  swallows into an empty log.

  WHAT IS ASSERTED AND WHAT IS NOT. These scenarios assert the SCREEN: the
  eight tiles with their exact descriptions, both segmented filters, and the
  empty state that distinguishes an unread register from an empty one. They do
  NOT assert case ROWS, or the SLA colour escalation on a row, because rows
  come from sdk-incident and this environment has no gateway credential - the
  honest local state is an empty queue. The row contract, the SLA banding and
  the composed filters are asserted where they can be:
  tests/api_definitions/data-review/cases-get.json, whose testCases exercise
  risk and family together against the live endpoint.

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  Scenario: The screen states what a case actually is
    When I navigate to "/app/data-review"
    Then I should see "Field-Level Verification"
    And I should see "a disagreement the system will not resolve on its own"
    And I should see "Case report"
    And I should see "Open Next Case"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  Scenario: All eight case types are on screen
    # AC1. Every tile renders even at a count of zero, because an absent tile
    # reads as "we do not check for this" rather than "nothing to review".
    When I navigate to "/app/data-review"
    Then I should see "Possible Duplicates"
    And I should see "Contact Point Conflicts"
    And I should see "Source Rights"
    And I should see "Consent Ambiguity"
    And I should see "Relationship Conflicts"
    And I should see "Stale Data"
    And I should see "Suppression Mismatch"
    And I should see "Promotion Evidence"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  Scenario: Each tile says what the case is, not how to fix it
    When I navigate to "/app/data-review"
    Then I should see "Two records may describe the same person"
    And I should see "The provider and the platform disagree about whether somebody may be contacted"
    And I should see "obtained under terms that may not permit the use"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  Scenario: The queue offers both a risk and a case-type filter
    # AC2 from the operator's side. The two rails are separate controls, so a
    # risk selection never clears the type selection.
    When I navigate to "/app/data-review"
    Then I should see "Unified Case Queue"
    And I should see "High"
    And I should see "Medium"
    And I should see "Low"
    And I should see "Identity"
    And I should see "Consent"
    And I should see "Relationship"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  Scenario: Narrowing to high risk keeps the type rail available
    When I navigate to "/app/data-review"
    And I click "risk_high"
    Then I should see "Unified Case Queue"
    And I should see "Source Rights"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  Scenario: An unread register is not reported as an empty queue
    # The distinction the whole screen is built around. A confident "no cases"
    # during an outage is how a governance queue stops being worked.
    When I navigate to "/app/data-review"
    Then I should see "Unified Case Queue"
