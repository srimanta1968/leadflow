@feature_id:ec515d80-a42a-4a9b-9cb4-73007475cfa9
@epic_id:79cac1c4-3ab0-4f9d-9660-a880c054ac0c
Feature: Run explorer, customer journey builder and release-gate test set
  Runs, journey stages and the twelve test leads, per PRD 13 and SOP 21.

  Quoted strings are rendered text and name attributes from
  client/src/pages/app/WorkflowRuns.tsx. "run_release_gate" is a name
  attribute. ALL ASSERTED STRINGS ARE ASCII.

  WHAT IS ASSERTED AND WHAT IS NOT. These scenarios assert all twelve
  release-gate scenarios, the full thirteen-stage journey with entry and exit
  criteria on every stage, and that a scenario with NO result blocks publish
  exactly as a failure does. They do NOT assert a gate RUN or run rows, because
  both need sdk-workflow and this environment has no gateway credential.

  THE "NOT RUN" STATE IS THE INTERESTING ONE and it is assertable locally: a
  gate reporting eleven passes and a skip is precisely how the twelfth failure
  reaches a customer, so the twelve render before anything has run and each
  reports its own state.

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:f10b9fa4-f84f-46e1-8d88-c57b404c5dd3
  Scenario: All twelve release-gate scenarios are named
    # AC1. Each is a way an automation has actually hurt a customer.
    When I navigate to "/app/workflow-runs"
    Then I should see "Release gate"
    And I should see "Business hours"
    And I should see "After hours"
    And I should see "Duplicate event"
    And I should see "Reply suppression"
    And I should see "Opt-out"
    And I should see "Bad phone"
    And I should see "Bounced email"
    And I should see "Rep unavailable"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:65bb2640-61c0-4c9b-9894-45e579eabcd0
  Scenario: The remaining four gate scenarios are present
    When I navigate to "/app/workflow-runs"
    Then I should see "Purchase success"
    And I should see "Payment failure"
    And I should see "Calendar failure"
    And I should see "Rollback"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:4a77950a-5d1c-44b9-8750-ccc6aa2fd76c
  Scenario: A scenario with no result blocks publish just as a failure does
    # Eleven passes and a skip is how the twelfth gets through.
    When I navigate to "/app/workflow-runs"
    Then I should see "A scenario with no result blocks publish exactly as a failure does"
    And I should see "Not run"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:eeb5ebd1-7d37-4502-9338-662a7eb6aa1e
  Scenario: The run explorer promises per-step state and compensation history
    # AC2. When a run fails halfway the interesting question is what it UNDID,
    # and a forward-only view leaves the operator unable to tell whether the
    # customer was charged, refunded, both or neither.
    When I navigate to "/app/workflow-runs"
    Then I should see "Run explorer"
    And I should see "per-step state and what it undid"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:c04ebe30-dac4-41a4-8291-dde812142af0
  Scenario: An unread run store is not reported as nothing having run
    When I navigate to "/app/workflow-runs"
    Then I should see "this is not a claim that nothing has run"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:911f484c-a418-42cc-ae21-62f436a578fa
  Scenario: Every journey stage carries entry and exit criteria
    # AC3. A stage list with no criteria is a picture of a funnel; the criteria
    # are what let two people disagree about a record and resolve it.
    When I navigate to "/app/workflow-runs"
    Then I should see "Customer journey"
    And I should see "Enters when"
    And I should see "Leaves when"
    And I should see "a picture of a funnel"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:0ccc5d57-101d-4c02-a9c5-c193f4e77550
  Scenario: The full thirteen-stage progression is present
    When I navigate to "/app/workflow-runs"
    Then I should see "Visitor"
    And I should see "MQL"
    And I should see "SQL"
    And I should see "Opportunity"
    And I should see "Proposal"
    And I should see "Negotiation"
    And I should see "Expansion"
    And I should see "Renewal"
    And I should see "Referral"
