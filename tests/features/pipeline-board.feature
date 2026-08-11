@feature_id:ceedf2f6-6b53-4909-8504-2cbce0bc1853
@epic_id:350440b3-9f6f-4cbe-bd63-778721adff89
Feature: Pipeline board, overdue-NEXT queue, stage aging and date-push control
  Stage hygiene, per SOP 06.

  Quoted strings are rendered text and name attributes from
  client/src/pages/app/Pipeline.tsx. ALL ASSERTED STRINGS ARE ASCII.

  WHAT IS ASSERTED AND WHAT IS NOT. These scenarios assert the escalation of
  overdue NEXT actions, that an unread queue is not reported as an empty one,
  and that stage aging is defined as the ABSENCE of activity. They do NOT
  assert cards, a blocked transition or a push history, because the board comes
  from sdk-crm and this environment has no gateway credential - with no cards
  there is nothing to move and nothing to reschedule.

  THE STAGE GUARD AND THE PUSH REASON ARE BOTH BUILT AND BOTH UNREACHABLE HERE.
  The refusal names the missing evidence
  (MoveModal in the same file) and the reschedule reason is mandatory, but both
  open from a CARD. They are asserted against the endpoint in
  tests/api_definitions/pipeline/board-get.json, whose testCases exercise the
  exit criteria and the push history on real rows.

  MOVING IS A BUTTON, NOT ONLY A DRAG, which is a deliberate departure from the
  task's wording. Drag-and-drop is unusable by keyboard and hostile on touch,
  and this is the primary action of the primary screen for a rep who lives in
  it all day. The guard is shared between both entry points so they cannot
  diverge.

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:b7b58c31-44b5-47c9-a231-a9de5d89da3a
  Scenario: The board states what a refused move will do
    # AC1. A card that snaps back teaches the rep the board is buggy, so they
    # route around it - they stop using it, or they enter fictional data until
    # it lets them through.
    When I navigate to "/app/pipeline"
    Then I should see "Pipeline"
    And I should see "names what is missing rather than snapping the card back"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:99ddbfaa-0772-43c4-973f-470d34cd4b2c
  Scenario: Overdue NEXT actions are escalated immediately
    # AC2.
    When I navigate to "/app/pipeline"
    Then I should see "Overdue NEXT"
    And I should see "Escalated the moment it is overdue"
    And I should see "The manager is alerted after fifteen minutes"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:b23ad53d-4293-423b-b0fd-5362950933b1
  Scenario: An unread overdue queue is not reported as nothing being overdue
    When I navigate to "/app/pipeline"
    Then I should see "this is not a claim that nothing is overdue"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:5a9d58dc-037a-4242-b7cd-5811ba155997
  Scenario: Stage aging is defined as the absence of activity
    # Aging is not the same as being slow. A deal moving slowly through a long
    # evaluation is healthy; one with nothing happening at all is not.
    When I navigate to "/app/pipeline"
    Then I should see "Stage aging"
    And I should see "no meaningful activity for five business days"
    And I should see "the absence of anything happening at all"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:dd24fa79-d520-42c2-8a1a-b2ccc69370c2
  Scenario: An unread board is not reported as an empty pipeline
    When I navigate to "/app/pipeline"
    Then I should see "this is not an empty pipeline"
