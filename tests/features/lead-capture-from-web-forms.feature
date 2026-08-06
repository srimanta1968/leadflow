@feature_id:897499d9-17fb-49b7-b49d-b087b130ee16
@epic_id:8f1ff867-089c-40e7-b889-0fd4b06ac1f0
Feature: Lead Capture from Web Forms
  A prospect submits the public web form and the capture reaches the Capture Inbox.

  Scenarios run against the /demo page rather than the landing page: the landing
  page renders the capture form twice (hero and closing CTA), so a text-based
  selector there would be ambiguous. /demo renders exactly one form with a
  distinct submit label.

  Field names below are copied from client/src/components/marketing/LeadForm.tsx
  (name, email, company, phone, message) and the sign-in fields from
  client/src/pages/auth/SignIn.tsx - they are the real name attributes, not
  human-friendly labels.

  @scenario_id:0dec5580-3697-46ca-b311-cb98a3536cb8
  @scenario_type:UI
  @ui_test
  @portal:leadflow
  Scenario: Leads are captured and stored upon form submission
    Given I navigate to "/demo"
    When I fill "name" with "${random_name}"
    And I fill "email" with "${random_email}"
    And I fill "company" with "${random_name}"
    And I fill "phone" with "${random_phone}"
    And I click "Request the session"
    Then I should see "You are in the queue"

  @scenario_id:2aef63cb-3936-401f-a006-eae8e8c14fe0
  @scenario_type:UI
  @ui_test
  @portal:leadflow
  Scenario: Submitting with no name or email is rejected before any request is sent
    Given I navigate to "/demo"
    When I click "Request the session"
    Then I should see "Full name is required."

  @scenario_id:0f3d10bd-a244-407f-b307-f50d7bff94cf
  @scenario_type:UI
  @ui_test
  @portal:leadflow
  Scenario: A malformed email is rejected before the request is sent
    Given I navigate to "/demo"
    When I fill "name" with "${random_name}"
    And I fill "email" with "not-an-email"
    And I click "Request the session"
    Then I should see "Enter a valid email address"

  @scenario_id:ad9a1863-71ce-4f84-a347-2b1a226bfd89
  @scenario_type:UI
  @ui_test
  @portal:leadflow
  Scenario: The rejection appears against the field that caused it
    Given I navigate to "/demo"
    When I fill "name" with "${random_name}"
    And I fill "email" with "missing-the-at-sign.example.com"
    And I click "Request the session"
    Then I should see "Enter a valid email address, like name@company.com."

  @scenario_id:3a4b049f-8e44-45ae-82b9-8d071a51d798
  @scenario_type:UI
  @ui_test
  @portal:leadflow
  Scenario: The confirmation states that the response clock has started
    Given I navigate to "/demo"
    When I fill "name" with "${random_name}"
    And I fill "email" with "${random_email}"
    And I click "Request the session"
    Then I should see "the clock is running"

  @scenario_id:382dde3c-5607-49a1-975b-cc372175922d
  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  Scenario: A signed-in operator reaches the Capture Inbox
    Then I should see "Universal Quick Capture"

  @scenario_id:103f6657-06f1-4771-a92c-ad91df915701
  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  Scenario: An operator captures a lead by hand through Quick Capture
    When I click "Quick Capture"
    And I fill "name" with "${random_name}"
    And I fill "email" with "${random_email}"
    And I fill "company" with "${random_name}"
    And I fill "phone" with "${random_phone}"
    And I select "Phone" from "source"
    And I select "User asserted" from "origin_class"
    And I click "Capture lead"
    Then I should see "Lead captured"
