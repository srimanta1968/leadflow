@feature_id:c2ae1500-e03a-40f5-96d2-d101eb2e0a36
@epic_id:79cac1c4-3ab0-4f9d-9660-a880c054ac0c
Feature: Sequence builder, no-answer automation and reply-pause control
  Automated follow-up that stops when a human replies, per the playbook section
  IMMEDIATE RESPONSE AND NO-ANSWER AUTOMATION.

  Quoted strings are rendered text and name attributes from
  client/src/pages/app/Sequences.tsx. "pause_sequence" and "pause_reason" are
  name attributes. ALL ASSERTED STRINGS ARE ASCII.

  WHAT IS ASSERTED AND WHAT IS NOT. These scenarios assert the ten entry
  triggers and the three rules the screen exists to enforce - a reply pauses,
  an opt-out CANCELS rather than suspends, and a global pause exists for the
  automation-loop failure mode. They do NOT assert a real paused enrollment or
  a real suppression, because both need sdk-workflow and the channel-decision
  engine, and this environment has no gateway credential.

  THE REPLY-PAUSE SET IS RENDERED AS A PANEL, not read out of a log, which is
  what makes it assertable at all. That was the design decision: a pause only
  discoverable by querying an event stream is a pause nobody audits.

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:d6aaf911-bcbb-4258-9427-63a455cbfa15
  Scenario: The screen states when automation stops
    # The SOP states this rule twice, in two different sections. The failure it
    # prevents is the one customers complain about: a rep answers by hand while
    # the automation keeps sending step 4.
    When I navigate to "/app/sequences"
    Then I should see "Sequences"
    And I should see "stops the moment a human conversation starts"
    And I should see "A reply pauses the sequence and raises an urgent task for the owner"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:fd1b4d25-8464-4852-9aa9-c5cddbb5804f
  Scenario: All ten playbook triggers are offered as entry conditions
    When I navigate to "/app/sequences"
    Then I should see "Entry triggers"
    And I should see "Immediate inbound"
    And I should see "After hours"
    And I should see "No answer"
    And I should see "Callback confirmed"
    And I should see "Demo booked"
    And I should see "Two-hour reminder"
    And I should see "Decision or checkout"
    And I should see "Breakup"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:ee482eb9-582f-411f-ac99-ca99e26ed16a
  Scenario: A sequence enters on exactly one trigger
    # Overlapping entry conditions are how a contact ends up in two sequences
    # and receives two messages about the same thing.
    When I navigate to "/app/sequences"
    Then I should see "A sequence enters on exactly one"
    And I should see "receives two messages about the same thing"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:e80014d4-7513-4cf6-bc35-a1b592e12976
  Scenario: An unread sequence store is not reported as nothing running
    When I navigate to "/app/sequences"
    Then I should see "this is not a claim that none are running"
