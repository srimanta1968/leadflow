@feature_id:fb874462-082a-4567-a9f6-72ac0769796d
@epic_id:8f1ff867-089c-40e7-b889-0fd4b06ac1f0
Feature: SLA Management
  Implement SLA management to track response times and alert managers of any violations.

  Field names below are the real name attributes copied from
  client/src/pages/app/SlaSettings.tsx (name, source_channel,
  first_response_minutes, evaluation_order) and the sign-in fields from
  client/src/pages/auth/SignIn.tsx - not human-friendly labels.

  The UI scenario is SELF-CLEANING: it retires the target it created before
  finishing. Active targets are unique on (lead type, evaluation order), so a
  scenario that left its target behind would collide with itself on the next run
  and fail with CONFLICT. Retiring is a soft delete, so the row survives for
  audit while the slot is freed.

  Two of this feature's requirements are API behaviour, not browser behaviour, so
  they are asserted in tests/api_definitions - with real status and body
  assertions, producer chains and captured values - rather than here. A .feature
  file describes what a USER does in a BROWSER; API behaviour never belongs in
  Gherkin. Their scenario ids are recorded below so the traceability back to the
  requirement survives, but they are NOT written as scenarios: the BDD runner
  executes only navigate / fill / click / select / should-see / login, and a
  prose step such as "Given User has configured SLAs for lead types" does not
  merely skip - it aborts the WHOLE file, so the executable UI scenario above it
  never runs at all.

   - scenario_id 7edb69e0-1317-4b79-a6a3-f1bdca1a391a, "Alerts are sent when SLAs
     are violated" -> tests/api_definitions/sla/evaluate-post.json, which asserts
     the sweep marks a breach and reports each newly-breached lead exactly once.
   - scenario_id 36e4b811-8c82-40f4-b131-381d126af1a4, "Response times are logged
     for analysis" -> tests/api_definitions/leads/id-first-response-post.json,
     which asserts the clock stops and the measured response time is recorded.

  @scenario_id:d36492ae-aac5-4ad6-825a-283b48661cb0
  @scenario_type:UI
  @ui_test
  @portal:leadflow
  Scenario: SLAs can be configured for different lead types
    Given I navigate to "/signin"
    When I fill "email" with "${login:email}"
    And I fill "password" with "${login:password}"
    And I click "Sign in"
    And I click "SLA targets"
    Then I should see "SLA targets"
    When I fill "name" with "${random_name}"
    And I select "Live chat" from "source_channel"
    And I fill "first_response_minutes" with "5"
    And I fill "evaluation_order" with "9911"
    And I click "Save SLA target"
    Then I should see "SLA target saved"
    When I click "Retire"
    Then I should see "SLA target retired"
