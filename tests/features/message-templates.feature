@feature_id:dab16337-e19d-40d9-865e-d7ec8c0946db
@epic_id:6691a598-597d-42a8-82fc-ddec2442b572
Feature: Approved message template library and the SMS gate
  The governed template register, per the playbook section SMS TEMPLATE LIBRARY.

  Quoted strings are rendered text and name attributes from
  client/src/pages/app/Templates.tsx. "new_template" is a name attribute.
  ALL ASSERTED STRINGS ARE ASCII.

  WHAT IS ASSERTED AND WHAT IS NOT. These scenarios assert the library's
  governing rules - one template one action, publishing gated on
  message.publish_template, the SMS gate and its named owner, and versioning -
  plus the uncovered-trigger panel, which is genuinely exercisable locally
  because it is computed in the browser from the ten required triggers against
  whatever the register returned. With no register reachable, all ten are
  uncovered, and that IS the honest state.

  They do NOT assert template ROWS or a publish, because the register comes
  from sdk-content and this environment has no gateway credential.

  THE PERMISSION GATE IS ASSERTABLE HERE. The New template control fails closed
  and says which grant it needs, which is a decision the browser makes before
  any request is sent.

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:bd76aac0-e41b-4e5d-9df7-eaf0b02a05f9
  Scenario: The library states the standard every template must meet
    # "Tied to one action" is the clause that gets lost. A message asking the
    # customer to pick a time AND answer a qualifying question gets neither.
    When I navigate to "/app/templates"
    Then I should see "Message Templates"
    And I should see "tied to one action"
    And I should see "A rep cannot improvise the wording of a governed message"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:61a52a6a-15df-492c-ba36-31f0315e47ad
  Scenario: The SMS gate is stated with its owner named
    # The screen reports the rules; it does not let a sender vary them.
    When I navigate to "/app/templates"
    Then I should see "The SMS gate"
    And I should see "approved eligibility or consent basis"
    And I should see "inside allowed hours"
    And I should see "owns the final rules"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:7093faa2-228a-4ff5-acb9-12f5b30c99f4
  Scenario: Opt-out suppression is named for every terminating signal
    When I navigate to "/app/templates"
    Then I should see "unsubscribe, complaint, invalid number or"
    And I should see "suppresses queued sales texts immediately"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:e7763516-5e8c-4016-a51d-4100323d24e5
  Scenario: A trigger with no approved template is reported as a gap
    # A trigger the playbook expects a message for, with none approved, is a
    # moment where one gets improvised.
    When I navigate to "/app/templates"
    Then I should see "Triggers with no approved template"
    And I should see "or worse, one gets improvised"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:e65a7ffa-6040-4229-b952-8f09c150494d
  Scenario: Publishing fails closed and names the grant it needs
    # The QA operator role does not hold message.publish_template, so this is
    # the real rendered state rather than a contrived one.
    When I navigate to "/app/templates"
    Then I should see "Publishing requires"
    And I should see "You may read the library but not publish to it"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:b5c50091-0f50-4741-9f83-ba2fe99f8748
  Scenario: An edited template becomes a new version
    # A dispute asks what was actually sent, and a template edited in place
    # cannot answer that.
    When I navigate to "/app/templates"
    Then I should see "Versioning"
    And I should see "keeps referencing the version it was sent under"
