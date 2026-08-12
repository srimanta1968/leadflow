@feature_id:71eca3cc-f642-48e2-947c-9a91ae93d9b4
@epic_id:2f860885-b8ac-4db6-ba54-62cfa4be5772
Feature: Coverage administration - schedules, PTO, holidays, late coverage, on-call
  The coverage console, per SOP 02 and 26.

  Quoted strings are rendered text and name attributes from
  client/src/pages/app/CoverageConsole.tsx. "check_phone",
  "check_overnight_queue" and "manager_confirms_coverage" are name attributes.
  ALL ASSERTED STRINGS ARE ASCII.

  WHAT IS ASSERTED AND WHAT IS NOT. These scenarios assert the rule the console
  exists to enforce - a window with no named person is a GAP - plus the 8:45
  checklist and its manager-last ordering, and the late-coverage roster. They
  do NOT assert real schedules, real gaps or a recorded validation, because
  those come from sdk-coverage and this environment has no gateway credential.

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:c498298e-c462-4104-bb4a-e35a50e72e47
  Scenario: The console states that a shared queue is not coverage
    # The failure it prevents is the hardest to see: a queue everybody can reach
    # is a queue nobody owns, so a 4:59pm lead sits in it until morning while
    # four people each assume one of the others has it.
    When I navigate to "/app/coverage"
    Then I should see "Coverage"
    And I should see "Every business window resolves to a named available person"
    And I should see "a queue everybody can reach is a queue nobody owns"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:1e65d05d-5660-472a-96a4-978fb9f03343
  Scenario: Gaps are reported before the window opens
    # AC2. An alert at 8:45 that nobody is covering 9:00 is actionable; the same
    # alert at 9:30 is a post-mortem.
    When I navigate to "/app/coverage"
    Then I should see "Upcoming coverage gaps"
    And I should see "Detected before the window begins"
    And I should see "An alert after it opens is a post-mortem"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:3f4357d0-df04-4342-8c5b-4b459978400c
  Scenario: An unread register does not claim there is no gap
    When I navigate to "/app/coverage"
    Then I should see "no gap can be claimed either way"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:3b36326d-eea3-489f-9372-683350597751
  Scenario: The opening validation lists all four channels and the queue
    # AC3.
    When I navigate to "/app/coverage"
    Then I should see "Opening validation"
    And I should see "Phone verified"
    And I should see "Email verified"
    And I should see "SMS verified"
    And I should see "Calendar verified"
    And I should see "Overnight queue cleared"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:6eafe3eb-1473-429a-9234-3e4db0dcae1f
  Scenario: The manager confirms last, and the form says why
    # Their sign-off is the accountable step, not one check among five.
    When I navigate to "/app/coverage"
    Then I should see "Manager confirms coverage for the day"
    And I should see "The manager confirms last"
    And I should see "not one check among five"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:18ff2ed9-dd5b-461c-8ac5-518ec44b951c
  Scenario: Late coverage is enforced and its roster is visible
    # AC4. A 4:59pm lead is entitled to the same response window as one arriving
    # at 9:00, and that only survives contact with a Friday if a name is on it.
    When I navigate to "/app/coverage"
    Then I should see "Late coverage"
    And I should see "A 4:59pm lead gets its full response window"
    And I should see "There is no early sign-off"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:e50606d3-4aed-49a2-b3eb-a33028304b3e
  Scenario: An empty late roster is reported as an uncovered window
    # AC1. Silence here would read as "covered by the team", which is the exact
    # fiction the console exists to remove.
    When I navigate to "/app/coverage"
    Then I should see "Nobody is rostered for late coverage"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:90a38127-b3cf-4a06-bd9b-6af0bb951323
  Scenario: Schedules, time off, holidays and the manager rota are all present
    When I navigate to "/app/coverage"
    Then I should see "Schedules"
    And I should see "Time off & holidays"
    And I should see "Manager on duty"
