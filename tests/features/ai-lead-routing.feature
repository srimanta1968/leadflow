@feature_id:5b6862f2-18fc-4e8e-8e2a-f8839bcc22d9
@epic_id:8f1ff867-089c-40e7-b889-0fd4b06ac1f0
Feature: AI Lead Routing
  Leads are routed to a named owner and a response clock is started.

  Field names below are the real `name` attributes from
  client/src/pages/app/RoutingRules.tsx (name, source_channel, assigned_user_id,
  evaluation_order, criteria), client/src/pages/app/QuickCapture.tsx and
  client/src/pages/auth/SignIn.tsx.

  The owner select defaults to the signed-in operator, so a scenario does not
  have to guess a colleague's display name from a roster it cannot predict.

  Screens inside /app are reached by CLICKING the sidebar, never by navigating
  to the path directly. Every /app screen holds the event stream open for the
  lifetime of the page, so the browser never reports an idle network and a
  direct navigation waits for a condition that cannot arrive - it fails as "Host
  not accessible" even though the page renders perfectly. A sidebar click is a
  client-side route change with no such wait, and it is also how an operator
  actually moves between screens.

  COVERAGE NOTE: the routing decision itself - which owner the six-step order
  picks, the 30-minute clock, and idempotency on a repeat request - is an API
  contract, not a browser flow. It is covered by
  tests/api_definitions/leads/id-route-post.json, which asserts real status codes
  and response bodies and builds the producer chain. The original
  @scenario_type:API scenario that lived in this file was removed rather than
  rewritten here: a Gherkin "When a new lead is captured" step is unparseable and
  executes nothing, and describing one endpoint in two places guarantees the copy
  nobody runs will drift (MUST-43).

  Background:
    Given I navigate to "/signin"
    When I fill "email" with "${login:email}"
    And I fill "password" with "${login:password}"
    And I click "Sign in"
    Then I should see "Capture Inbox"

  @scenario_id:93bee22d-9946-49e6-8c5b-458fe74d939f
  @scenario_type:UI
  @ui_test
  @portal:leadflow
  # SCOPE NOTE: this scenario covers CREATE and the presence of the per-rule
  # controls. It deliberately does NOT drive Edit / Deactivate / Retire, because
  # the supported step vocabulary has no way to scope a click to a particular
  # row: `I click "Edit"` resolves to button:has-text('Edit') and the screen
  # renders one per rule, so with N rules the click lands on whichever row is
  # first. A test that passes because it happened to hit an arbitrary row is
  # worse than no test. The edit / deactivate / retire SEMANTICS are covered
  # where they can be asserted precisely:
  #  - tests/api_definitions/routing-rules/id-patch.json  (partial update, explicit-null clear, empty-patch rejection)
  #  - tests/api_definitions/routing-rules/id-delete.json (soft retire, idempotency)
  #  - server/tests/integration/routing.test.ts            (11 cases incl. "excludes a retired rule from routing decisions")
  Scenario: A routing rule can be created and offers per-rule controls
    When I click "Routing rules"
    And I fill "name" with "${random_name}"
    And I select "LinkedIn" from "source_channel"
    And I fill "evaluation_order" with "50"
    And I fill "criteria" with "source=linkedin"
    And I click "Create rule"
    Then I should see "Routing rule created"
    And I should see "Evaluation order"

  @scenario_id:312cbc65-3c0c-437e-b248-a01b751e6eee
  @scenario_type:UI
  @ui_test
  @portal:leadflow
  Scenario: A routed lead shows its owner in the Capture Inbox
    When I click "Quick Capture"
    And I fill "name" with "${random_name}"
    And I fill "email" with "${random_email}"
    And I select "Phone" from "source"
    And I click "Capture lead"
    Then I should see "Lead captured"
    When I click "Capture Inbox"
    And I click "Route"
    Then I should see "Lead routed"
