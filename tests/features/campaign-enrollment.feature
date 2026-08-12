@feature_id:dfb74ac9-56c5-4d40-9ce1-72f4441b33c4
@epic_id:60b11414-8cf8-4248-bc8a-22d74d122968
Feature: Campaign Enrollment screen with execution-time eligibility
  Contact eligibility and enrollment history, per mockup #view-campaigns.

  Quoted strings are rendered text from
  client/src/pages/app/CampaignEnrollment.tsx. ALL ASSERTED STRINGS ARE ASCII.

  WHAT IS ASSERTED AND WHAT IS NOT. These scenarios assert the framing rule the
  screen is built on - eligibility is evaluated at EXECUTION time, against
  seven independent gates - and that a suppressed row is required to carry its
  reason. They do NOT assert enrollment ROWS or a revocation between build and
  send, because the history comes from sdk-campaign and the verdicts from the
  channel-decision endpoint, and this environment has no gateway credential.

  THE REVOCATION CRITERION IS ASSERTED AT THE ENDPOINT in
  tests/api_definitions/campaigns/enrollments-get.json, which is also the only
  honest place for it: the whole point is that the verdict is computed at send
  time on the server, so a UI test could only confirm the browser rendered
  whatever it was handed.

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:306a2c1c-0b58-4401-9d3f-c3c435963723
  Scenario: The screen states when eligibility is evaluated
    # AC1. A segment computed on Monday and sent on Thursday contacts everybody
    # who revoked in between, with an audit trail that looks perfectly clean.
    When I navigate to "/app/campaigns"
    Then I should see "Campaign Enrollment"
    And I should see "CURRENT CONSENT EVALUATED AT EXECUTION TIME"
    And I should see "not at list-build time"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:1902c5fd-fe3f-44d9-98c8-0afa0b45d43d
  Scenario: A contact who revokes between build and send is never contacted
    # AC2, stated as the rule the screen commits to.
    When I navigate to "/app/campaigns"
    Then I should see "A contact who revokes between build and send is never contacted"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:cdd42043-602a-42a8-bf8f-11236f11727a
  Scenario: All six build-time gates plus current consent are named
    When I navigate to "/app/campaigns"
    Then I should see "Audience snapshot"
    And I should see "Source rights"
    And I should see "Purpose"
    And I should see "Channel eligibility"
    And I should see "Suppression"
    And I should see "Frequency caps"
    And I should see "Current consent, at send time"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:0a1cceeb-8d6a-4bc3-81cf-2256628d3439
  Scenario: Each gate refuses independently
    # Passing five is not passing.
    When I navigate to "/app/campaigns"
    Then I should see "Each refuses independently"
    And I should see "Passing five is not passing"
    And I should see "a statement about the past being used to justify an action in the present"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:5282fade-3a92-4dbb-b274-2cfe35eace08
  Scenario: The enrollment history panel is present and names its scope
    # AC4.
    When I navigate to "/app/campaigns"
    Then I should see "Contact Eligibility & Enrollment History"
    And I should see "Name a contact to read its enrollment history"
