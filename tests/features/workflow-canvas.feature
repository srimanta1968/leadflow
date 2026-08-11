@feature_id:c2ae1500-e03a-40f5-96d2-d101eb2e0a36
@epic_id:79cac1c4-3ab0-4f9d-9660-a880c054ac0c
Feature: Workflow canvas, node palette and definition authoring
  The visual builder and its keyboard outline, per PRD 7.

  Quoted strings are rendered text and name attributes from
  client/src/pages/app/WorkflowStudio.tsx. "add_trigger", "add_action",
  "outline_view", "connect_from", "connect_to" and "connect_nodes" are name
  attributes. ALL ASSERTED STRINGS ARE ASCII.

  WHAT IS ASSERTED AND WHAT IS NOT. These scenarios assert all nine node types,
  that the outline is a peer view rather than a fallback, and - the criterion
  that matters most - that an incompatible connection is refused WITH A
  READABLE EXPLANATION. That last one is genuinely exercisable locally, because
  the connection rules are a pure function in the browser: no gateway is
  involved in deciding that nothing may connect into a Trigger.

  They do NOT assert compilation to sdk-workflow step definitions, nor a
  hundred-node frame rate. Compilation needs sdk-workflow and this environment
  has no gateway credential; the frame rate is a property of the render path
  (one SVG layer, no per-node state, no force simulation) that a Gherkin step
  cannot measure.

  THE OUTLINE-EQUIVALENCE CRITERION IS STRUCTURAL. Both views render and mutate
  ONE model, so the moment the canvas owned state the outline could not reach,
  the outline would become a viewer. A test comparing two independently
  authored views passes right up until somebody adds a feature to one of them.

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:eaaf5cdf-0896-41bb-aec3-27e170e0801a
  Scenario: All nine node types are in the palette
    When I navigate to "/app/workflows"
    Then I should see "Node palette"
    And I should see "Trigger"
    And I should see "Condition"
    And I should see "Action"
    And I should see "Delay"
    And I should see "Loop"
    And I should see "Webhook"
    And I should see "Approval"
    And I should see "CRM Update"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:1759bab8-0bfe-45a8-9d14-62c9eab43201
  Scenario: The outline is offered as the same editor, not as a fallback
    # AC1. Anything you can do with a pointer you can do from the keyboard.
    When I navigate to "/app/workflows"
    Then I should see "Canvas view"
    And I should see "Outline view"
    And I should see "They are the same editor over the same model"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:f92619a0-958c-4e12-8fbf-b80d1704eb5f
  Scenario: The outline view offers node authoring and connection authoring
    When I navigate to "/app/workflows"
    And I click "outline_view"
    Then I should see "Outline"
    And I should see "Every capability here, reachable by keyboard"
    And I should see "Connect two nodes"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:3bdbacfc-7b17-45d1-b471-c80a0c64a9bc
  Scenario: A node added from the palette appears in the outline
    # The shared model, demonstrated: the palette is canvas chrome and the
    # outline is the other view, and one add is visible in both.
    When I navigate to "/app/workflows"
    And I click "add_trigger"
    And I click "outline_view"
    Then I should see "Outline"
    And I should see "connects to"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:98204b29-3f86-4b8e-b7a8-223f8a3c6844
  Scenario: An incompatible connection is refused with a readable explanation
    # AC2, and the reason it is a sentence rather than a toast: silently
    # dropping the edge teaches the author the canvas is unreliable, and
    # "connection invalid" teaches them nothing.
    When I navigate to "/app/workflows"
    And I click "add_trigger"
    And I click "add_action"
    And I select "n2 Action" from "connect_from"
    And I select "n1 Trigger" from "connect_to"
    And I click "connect_nodes"
    Then I should see "A Trigger starts a run, so nothing can connect INTO it"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:aa5b1818-4155-4ebc-ae8b-579e0358d2bb
  Scenario: A node cannot connect to itself
    When I navigate to "/app/workflows"
    And I click "add_action"
    And I select "n1 Action" from "connect_from"
    And I select "n1 Action" from "connect_to"
    And I click "connect_nodes"
    Then I should see "A node cannot connect to itself"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:b704895d-9c5a-49e1-ac55-579c2582f071
  Scenario: The studio offers compile, undo and the publish controls
    # AC3. The canvas is an authoring surface over step definitions; treating
    # the diagram as the source of truth is how a workflow comes to mean
    # something subtly different from what it runs.
    When I navigate to "/app/workflows"
    Then I should see "Compile"
    And I should see "Undo"
    And I should see "Publishing goes through an approval"
    And I should see "kill switch"
