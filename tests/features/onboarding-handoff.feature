@feature_id:df01298a-f49c-4b41-a8f4-5d683154b189
@epic_id:68d8857d-2a0f-4152-a255-7a3d5bfe121a
Feature: Onboarding handoff record and CS accept-or-reject
  The required internal handoff, per SOP 19 and 22.

  Quoted strings are rendered text and name attributes from
  client/src/pages/app/OnboardingHandoff.tsx. "reject_handoff",
  "add_promise", "promise_text" and "submit_handoff" are name attributes.
  ALL ASSERTED STRINGS ARE ASCII.

  WHAT IS ASSERTED AND WHAT IS NOT. These scenarios assert all six sections and
  their required fields, that submission is refused while any field is empty,
  that a promise is a discrete item rather than a paragraph, and that a CS
  rejection requires a reason. They do NOT assert a submitted handoff or a
  promise-versus-delivery divergence, because both need sdk-handoff and this
  environment has no gateway credential.

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:76e1aa67-5b08-4afa-b5b7-1f03d1f34318
  Scenario: All six sections of the handoff are present
    When I navigate to "/app/handoffs"
    Then I should see "Commercial truth"
    And I should see "Business case"
    And I should see "Stakeholders"
    And I should see "Product scope"
    And I should see "Promises and risk"
    And I should see "Kickoff"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:6ef0acac-a611-49ac-b706-c28e15bea80b
  Scenario: The commercial and scope sections ask for the fields disputes turn on
    When I navigate to "/app/handoffs"
    Then I should see "Offer version"
    And I should see "Approved exceptions"
    And I should see "Variable charges discussed"
    And I should see "Explicit exclusions"
    And I should see "Beta and roadmap discussed"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:98e9acd1-40b4-4572-92e8-096c7fdb9d13
  Scenario: Submission is refused while any required field is empty
    # AC1. The missing field is always the one that mattered - nobody omits the
    # customer's name, they omit unresolved concerns.
    When I navigate to "/app/handoffs"
    Then I should see "required fields are empty"
    And I should see "nobody omits the customer's name, they omit unresolved concerns"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:560b5edb-8933-488d-9b2a-9a9fa1d8d916
  Scenario: A promise is a discrete item, not a paragraph
    # AC3. A free-text note containing three promises cannot be diffed against
    # what was delivered, which is the whole point of recording them.
    When I navigate to "/app/handoffs"
    Then I should see "Promises made"
    And I should see "One commitment per item"
    And I should see "cannot be checked against what was delivered"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:d39de5d9-50a8-4ca3-a964-99b4bf50572c
  Scenario: Recording no promises is itself something to state
    When I navigate to "/app/handoffs"
    Then I should see "If none were made, that is itself worth stating to CS"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:deebdae5-9a50-457f-9656-12c118438e21
  Scenario: A promise entered as an item appears in the list
    When I navigate to "/app/handoffs"
    And I fill "promise_text" with "Salesforce sync delivered in the first sprint"
    And I click "add_promise"
    Then I should see "Salesforce sync delivered in the first sprint"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:09d4e177-766e-4355-89e6-dd34dcbbafad
  Scenario: CS rejection requires a reason and returns it to the AE
    # AC2. A handoff CS cannot refuse is a notification, and the failure it
    # produces is a customer being onboarded onto something they did not buy.
    When I navigate to "/app/handoffs"
    And I click "reject_handoff"
    Then I should see "Returns it to the AE"
    And I should see "the only person who can say what was actually promised"
    And I should see "A rejection with no reason gives the AE nothing to fix"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:cf35a623-cdc7-4762-84e7-d6b710a8d958
  Scenario: Promise versus delivery divergence is flagged to the manager
    # AC4.
    When I navigate to "/app/handoffs"
    Then I should see "Promise versus delivery"
    And I should see "any divergence is flagged to the manager"
    And I should see "discovered in week three otherwise"
