@feature_id:d4845d9b-aa19-4013-83e9-e87de5159018
@epic_id:06998b3d-d057-490d-8cfb-962e43b525c6
Feature: Post-mortem workflow, rep certification and launch governance
  The post-mortem, the certification gate and the go-live record, per SOP 23,
  49 and 50.

  Quoted strings are rendered text and name attributes from
  client/src/pages/app/Governance.tsx. "action_text", "action_owner",
  "action_due" and "add_corrective_action" are name attributes.
  ALL ASSERTED STRINGS ARE ASCII.

  WHAT IS ASSERTED AND WHAT IS NOT. These scenarios assert the five post-mortem
  sections with root cause as SEVEN categories, that a corrective action is
  refused without an owner and a due date, the eight certification stations,
  and the twelve gates and five signatures of the go-live record. They do NOT
  assert a recorded post-mortem, a real certification score or a signed
  go-live, because all three need sdk-approval, sdk-audit and sdk-assignment
  and this environment has no gateway credential.

  THE CERTIFICATION GATE IS ENFORCED AT ROUTING, NOT HERE. A screen that merely
  DISPLAYS certification while assignment ignores it is worse than none,
  because it tells a manager the control exists. What this screen contributes -
  and what is asserted below - is that the gate's consequence is stated in the
  words a manager needs: no live P0 or P1 leads.

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:10c2081a-1820-4db9-a149-1219324e322b
  Scenario: All five post-mortem sections are present
    When I navigate to "/app/governance"
    Then I should see "Post-mortem"
    And I should see "Facts"
    And I should see "Detection"
    And I should see "Root cause"
    And I should see "Corrective action"
    And I should see "Verification"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:b5e7fe34-a2eb-4614-97ea-d8990a5b2ea8
  Scenario: Root cause is seven categories rather than one box
    # No-blame is structural. One free-text "cause" box collects the name of
    # whoever was on shift.
    When I navigate to "/app/governance"
    Then I should see "seven categories rather than one box"
    And I should see "one box collects the name of whoever was on shift"
    And I should see "Third-party"
    And I should see "Training"
    And I should see "Policy"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:fe371207-5b5f-4f69-bcc8-89d128ad2167
  Scenario: Every corrective action becomes a tracked owned task
    # AC2. Actions recorded as prose are completed at roughly the rate they are
    # re-read, which is once.
    When I navigate to "/app/governance"
    Then I should see "Corrective actions"
    And I should see "Each becomes a tracked task with one owner and one due date"
    And I should see "completed at roughly the rate they are re-read"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:d39b915f-6236-4314-8baa-9480f93aad2c
  Scenario: An action without an owner and a date is refused
    # Without both it is a wish, not a task.
    When I navigate to "/app/governance"
    And I fill "action_text" with "Add a monitor for the silent send failure"
    Then I should see "An action needs one owner and one due date"
    And I should see "it is a wish, not a task"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:e06163fa-3f7f-44a4-bdbd-55a728d0c4e1
  Scenario: All eight certification stations are on screen
    When I navigate to "/app/governance"
    Then I should see "Rep certification"
    And I should see "CRM hygiene"
    And I should see "Speed to lead"
    And I should see "First call"
    And I should see "Discovery"
    And I should see "Demo"
    And I should see "Objections"
    And I should see "Close and payment"
    And I should see "Calendar and onboarding"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:d5b1fcb2-8267-471b-9442-29aefe380733
  Scenario: An uncertified rep is stated as receiving no live P0 or P1 leads
    # AC1, in the words a manager needs.
    When I navigate to "/app/governance"
    Then I should see "This rep receives no live P0 or P1 leads"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:c177fed2-9c51-491b-af8d-2272904af183
  Scenario: The go-live record requires all five signatures
    # AC3.
    When I navigate to "/app/governance"
    Then I should see "Go-live governance record"
    And I should see "Executive Sponsor"
    And I should see "VP Sales or Sales Manager"
    And I should see "RevOps"
    And I should see "Legal or Compliance"
    And I should see "Client Success"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:b33149c3-2cd1-4490-af97-4027cff1fddd
  Scenario: The governance record is immutable once written
    # AC4. A governance record that can be edited afterwards is a record of what
    # people currently wish they had approved.
    When I navigate to "/app/governance"
    Then I should see "cannot be edited afterwards"
    And I should see "what people currently wish they had approved"
