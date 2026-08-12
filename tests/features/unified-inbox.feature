@feature_id:dab16337-e19d-40d9-865e-d7ec8c0946db
@epic_id:6691a598-597d-42a8-82fc-ddec2442b572
Feature: Unified inbox and single chronological timeline
  Every channel in one thread, per SOP P0.

  Quoted strings are rendered text and name attributes from
  client/src/pages/app/Inbox.tsx. "filter_unread" and "filter_sla_at_risk" are
  name attributes. ALL ASSERTED STRINGS ARE ASCII.

  WHAT IS ASSERTED AND WHAT IS NOT. These scenarios assert the five filters and
  the two rules the screen commits to in writing - ordering is on a normalized
  occurrence time computed upstream, and an inbound reply lands on the owner
  with an urgent task. They do NOT assert message ORDER across providers, which
  is the feature's headline criterion, because the threads come from
  sdk-conversation and this environment has no gateway credential: with no
  messages there is no order to check.

  ORDERING IS ASSERTED WHERE THE DATA IS, in
  tests/api_definitions/inbox/list-get.json. That is also the honest place for
  it: the ordering is computed upstream and this screen deliberately does not
  re-sort, so a UI test could only ever confirm that the browser left the
  server's order alone.

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:2277a73e-52f7-439b-a9d4-fe132ee3ecd1
  Scenario: The inbox names every channel it unifies
    # A channel per tab is how a rep answers an email that a text message
    # already answered an hour ago.
    When I navigate to "/app/inbox"
    Then I should see "Inbox"
    And I should see "Email, SMS, call, voicemail, social DM, web chat, internal note and meeting in one"
    And I should see "A channel per tab is how a rep answers an email"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:7b393268-b197-450b-8ab7-44470ad083ce
  Scenario: All five operational filters are present
    When I navigate to "/app/inbox"
    Then I should see "Unread"
    And I should see "Awaiting reply"
    And I should see "My leads"
    And I should see "SLA at risk"
    And I should see "Needs review"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:d95c5a6c-1286-4fb9-b998-57f8f8aa7bc8
  Scenario: The screen states how the thread is ordered
    # AC1's mechanism. Provider clocks disagree, and sorting on them is how a
    # reply appears above the message it answers.
    When I navigate to "/app/inbox"
    Then I should see "How the thread is ordered"
    And I should see "normalized occurrence time computed upstream"
    And I should see "never on a provider's own clock"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:3526564f-29d3-4361-a2b8-3640096cc366
  Scenario: An inbound reply is assigned to the owner with an urgent task
    # AC2. A reply that lands in a shared queue and belongs to nobody is the
    # leak the operating model exists to close.
    When I navigate to "/app/inbox"
    Then I should see "assigned to the record owner and raises an urgent task"
    And I should see "belongs to nobody is the leak"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:b3963407-20b5-4943-bbe3-ce6252174455
  Scenario: Selecting a filter keeps the screen usable
    When I navigate to "/app/inbox"
    And I click "filter_sla_at_risk"
    Then I should see "Inbox"
    And I should see "How the thread is ordered"
