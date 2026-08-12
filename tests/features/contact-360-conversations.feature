@feature_id:3238ca0a-567d-4747-917a-30487265e238
@epic_id:224f72e3-9444-4923-96da-477e76aa9654
Feature: Contact 360 Conversations tab with compose guardrails
  The unified thread and its guardrail panel, per mockup #c-conversations.

  Quoted strings are rendered text and name attributes from
  client/src/features/contacts/tabs/ConversationsTab.tsx. "compose" is a name
  attribute. ALL ASSERTED STRINGS ARE ASCII.

  WHAT IS ASSERTED AND WHAT IS NOT. These scenarios assert the behaviour the
  criteria are actually about: that Compose is CLOSED before the send rather
  than failing at dispatch, that it fails CLOSED when no verdict has arrived,
  and that the screen states why. They do NOT assert the three verbatim
  guardrail sentences from the mockup, nor the chronological ordering across
  channels, because both need a real decision engine and a real thread and this
  environment has no gateway credential.

  THAT THE VERDICT TEXT IS VERBATIM IS A PROPERTY OF THE COMPONENT, not of a
  fixture: the reason string is rendered with no transformation at all, so
  there is nothing for a test to catch. Asserting a sentence here would prove
  only that the test and a mock agreed on it.

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:de6ed11a-a43c-4fb4-9d23-80f494014b43
  Scenario: The thread states what every interaction is scoped to
    When I navigate to "/app/contacts/local-demo-contact/conversations"
    Then I should see "Unified Conversations"
    And I should see "Every interaction is scoped to channel, purpose, property, lead/project, sender identity and current eligibility"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:7923d22b-75fe-4453-bf9a-8095792d8d78
  Scenario: The guardrail panel sits beside the control it governs
    # AC1. Letting the operator write the message and then failing on dispatch
    # wastes the work and teaches them the refusal is a transient error to
    # retry. A disabled control with the reason beside it is a rule.
    When I navigate to "/app/contacts/local-demo-contact/conversations"
    Then I should see "Compose Guardrails"
    And I should see "The channel decision as the engine returned it"
    And I should see "Compose is disabled here rather than failing at send time"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:d4853afa-1352-4d38-b1d8-839001ead037
  Scenario: Compose stays closed when no channel carries an allow verdict
    # Fails CLOSED, and deliberately not on "no deny present": before the
    # verdicts arrive there are no denies either, and treating that as
    # permission would flash an enabled control on every load.
    When I navigate to "/app/contacts/local-demo-contact/conversations"
    Then I should see "Compose is unavailable because no channel currently carries an allow verdict"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:ee82a615-b5ec-4609-b120-f51e8dac31e2
  Scenario: A missing decision closes composing rather than opening it
    When I navigate to "/app/contacts/local-demo-contact/conversations"
    Then I should see "No channel decision was returned, so composing stays closed"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:ccb48737-69a8-4407-8928-c8ba5ab571d7
  Scenario: An unread thread is not reported as a person nobody spoke to
    When I navigate to "/app/contacts/local-demo-contact/conversations"
    Then I should see "Unified Conversations"
    And I should see "Compose Guardrails"
