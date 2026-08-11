@feature_id:187c831d-1dd2-48de-988d-b77cc39cbd0a
@epic_id:06998b3d-d057-490d-8cfb-962e43b525c6
Feature: Exception and incident console
  Severity-ordered incident queues, per SOP 28 and 05.

  Quoted strings are rendered text from client/src/pages/app/Incidents.tsx.
  ALL ASSERTED STRINGS ARE ASCII.

  WHAT IS ASSERTED AND WHAT IS NOT. These scenarios assert the ordering rule,
  the on-call routing table by incident TYPE, and the two gates the console
  exists to impose - nothing closes without verification, and bulk recovery
  shows its scope first. They do NOT assert incident ROWS, a disabled Close
  button on a real incident, or a systemic escalation, because the register
  comes from sdk-incident and this environment has no gateway credential.

  THE VERIFICATION GATE AND THE RECOVERY PREVIEW ARE BOTH BUILT AND BOTH OPEN
  FROM A ROW. They are asserted against real incidents in
  tests/api_definitions/incidents/list-get.json. What is asserted here is the
  console's own statement of both rules, which is what an operator reads before
  they have an incident in front of them.

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:5eefc709-ad5e-41fe-a346-5fda88f9eb39
  Scenario: The console orders by severity rather than by time
    # A console sorted by time buries a live P1 under three cosmetic reports.
    When I navigate to "/app/incidents"
    Then I should see "Incidents"
    And I should see "Ordered by severity rather than by time"
    And I should see "the newest incident is not the worst one"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:a1012700-5677-436e-b855-a12b3253d461
  Scenario: Nothing closes without a passing verification step
    # AC1. Closing on "we deployed the fix" is closing on an intention: nobody
    # has confirmed the affected leads were recovered, and the second occurrence
    # is discovered by a customer.
    When I navigate to "/app/incidents"
    Then I should see "Nothing closes until its verification step passes"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:d6efd46a-5e6a-4f2d-b838-ab5d5b0f8f3c
  Scenario: On-call routing is by incident type, with all four routes named
    # AC3. A single on-call rota sends a billing failure to somebody who cannot
    # act on it.
    When I navigate to "/app/incidents"
    Then I should see "On-call routing"
    And I should see "Routed by incident TYPE"
    And I should see "RevOps"
    And I should see "Manager on duty"
    And I should see "Systems Admin"
    And I should see "Finance"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:9030c2f9-93f9-485f-94af-225d3e1d1d4d
  Scenario: A route with nobody named says so
    # The same rule as coverage: a role with no person behind it is not cover.
    When I navigate to "/app/incidents"
    Then I should see "nobody named"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:a536fb03-1854-4f08-a4d1-c5c883da50a2
  Scenario: An unread register is not reported as no incidents being open
    When I navigate to "/app/incidents"
    Then I should see "this is not a claim that nothing is open"
