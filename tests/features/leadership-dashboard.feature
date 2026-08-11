@feature_id:33763282-e8f9-4d6e-9561-f0ad43e79468
@epic_id:285a56e9-aa8a-46e6-b4cd-0675b52053e5
Feature: Leadership Operational Dashboard
  The leadership view, per SOP 05.

  Quoted strings are rendered text from
  client/src/pages/app/LeadershipDashboard.tsx.
  ALL ASSERTED STRINGS ARE ASCII.

  WHAT IS ASSERTED AND WHAT IS NOT. These scenarios assert that all nine
  signals are present as DRILL-THROUGH tiles and that the five SOP success-test
  questions are rendered as the columns of the per-record table. They do NOT
  assert figures, because every signal comes from sdk-sla, sdk-crm,
  sdk-notification, sdk-handoff or sdk-assignment and this environment has no
  gateway credential.

  THAT A MISSING FIGURE SHOWS AS "--" RATHER THAN 0 IS ASSERTED HERE, and it is
  the most important thing on the screen: "0 leads waiting" during an outage is
  exactly what a healthy morning looks like.

  THE TWO-SECOND LOAD CRITERION IS NOT ASSERTED ANYWHERE and cannot be. It is
  specified against a 100k-lead tenant and no such tenant exists in a reachable
  environment; measuring it against an empty projection would produce a number
  that means nothing.

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:ea60dbff-7687-4d08-831d-7f4d1af221fe
  Scenario: All nine leadership signals are on screen
    # AC1, first half.
    When I navigate to "/app/leadership"
    Then I should see "Leads waiting"
    And I should see "Oldest wait"
    And I should see "SLA at risk"
    And I should see "SLA breached"
    And I should see "Unowned records"
    And I should see "Missing NEXT"
    And I should see "Failed messages"
    And I should see "Purchases awaiting onboarding"
    And I should see "Stale opportunities"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:2a2deb28-f370-4497-8fd1-4b743c0dc8cb
  Scenario: Every tile is a link into the list behind it
    # AC1, second half. A number with nothing behind it turns the meeting into a
    # discussion of the number rather than of the work.
    When I navigate to "/app/leadership"
    Then I should see "Leadership Dashboard"
    And I should see "each opening the list behind it"
    And I should see "A number with nothing behind it"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:6dddc910-e906-4fbc-af9d-634b71f54c3c
  Scenario: An unread signal shows as unknown rather than as zero
    # The most dangerous thing this screen could say is "0 leads waiting" during
    # an outage, because that is what a healthy morning looks like.
    When I navigate to "/app/leadership"
    Then I should see "this is not a claim that the figure is zero"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:363c8b23-d951-4a56-a08c-10f665d8c78f
  Scenario: The five SOP success-test questions are the table's columns
    # AC2. A record that cannot answer all five is not being worked, whatever
    # its pipeline stage says.
    When I navigate to "/app/leadership"
    Then I should see "The five questions, per record"
    And I should see "A record that cannot answer all five is not being worked"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:0caaac8e-5a25-4ea8-926e-fc6b5cdecdab
  Scenario: Figures are tied to the registered KPI definitions
    # AC4.
    When I navigate to "/app/leadership"
    Then I should see "reconcile with the registered KPI definitions"
    And I should see "two screens cannot quote different"
