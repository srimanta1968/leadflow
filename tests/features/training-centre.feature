@feature_id:c12362d4-3479-46e6-b243-47c04b68b61e
@epic_id:224f72e3-9444-4923-96da-477e76aa9654
Feature: Training Centre - card grid, per-screen guides and the Guide affordance
  Step-by-step guides for the screens this product actually has.

  Quoted strings are rendered text from client/src/pages/app/TrainingCentre.tsx
  and client/src/content/trainingGuides.ts, and "Guide" is the top-bar control in
  client/src/design-system/shell/AppShell.tsx.
  ALL ASSERTED STRINGS ARE ASCII.

  WHY THIS IS FULLY EXERCISABLE HERE, unlike most screens in this suite: the
  guides are a typed content module rather than a CMS read, so every card, every
  step and every success check renders from the bundle with no upstream involved.
  The only thing this file does NOT assert is the live grant standing on each
  card, which comes from the policy decision point and therefore depends on the
  role the runner signs in as.

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:5545140f-d536-44ab-91d1-3199610a59f5
  Scenario: The grid is grouped the way the sidebar is grouped
    # A training area organised by its own taxonomy makes the reader translate
    # twice - from their problem to the training's categories, and back again.
    When I navigate to "/app/training"
    Then I should see "Training Centre"
    And I should see "Getting started"
    And I should see "Contact operations"
    And I should see "Identity and trust"
    And I should see "Administration"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:304861ad-d375-4149-985d-14c635691b19
  Scenario: Every card states the grant its task needs
    # Most support questions on this product are "why is this greyed out", and
    # the answer is nearly always a role rather than a fault.
    When I navigate to "/app/training"
    Then I should see "each card states the grant its task needs"
    And I should see "Needs user.invite"
    And I should see "Needs routing.configure"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:2680be3f-c4cd-450c-b16e-f3c328512a4a
  Scenario: No guide is written for a screen that is not built
    # Training that does not match the product teaches people it is broken.
    When I navigate to "/app/training"
    Then I should see "Screens with no guide, and why"
    And I should see "Contact Command and Associated Properties render as"
    And I should see "worse than admitting the screen is not here yet"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:b25f49b5-a5a7-4abf-b107-55b7285f121e
  Scenario: A guide is ordered steps with real control names and a success check
    # A guide that stops at the last click never tells the reader whether they
    # succeeded.
    When I navigate to "/app/training/adding-a-user"
    Then I should see "Add a user and assign a role"
    And I should see "What this needs"
    And I should see "Steps"
    And I should see "invite_user"
    And I should see "You will know it worked when"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:2041d254-98ab-4689-9e7f-a46e7e9af21c
  Scenario: A guide names the grant a step needs rather than describing an unreachable flow
    # Rule one of the two that keep this honest.
    When I navigate to "/app/training/capture-and-resolve-a-lead"
    Then I should see "This task needs source_record.promote"
    And I should see "the resolve control will be disabled"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:3cebd60c-9f94-402d-b7a1-15c0142cf77d
  Scenario: The Guide affordance deep-links to the guide for the current screen
    # A training area nobody can find from the screen they are stuck on gets
    # read once during onboarding and never again.
    When I navigate to "/app/sequences"
    And I click "Guide"
    Then I should see "Sequences and the reply-pause rule"
    And I should see "You will know it worked when"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:fe1743ba-b395-498e-a8e9-965413fdce6f
  Scenario: A guide that does not exist says so rather than showing a plausible one
    # A Guide button that silently opens the wrong guide is worse than one that
    # opens the index.
    When I navigate to "/app/training/no-such-guide"
    Then I should see "No such guide"
    And I should see "a guide is not written for a screen that is not built"
