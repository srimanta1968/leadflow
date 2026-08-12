@feature_id:9cdeb92f-5d55-4436-8f54-067de516ce1d
@epic_id:2979a602-317e-49cd-8b38-2d2914a88afa
Feature: Relationship graph canvas and its accessible table equivalent
  The contextual relationship graph, per mockup #nodeG in the Relationships tab.

  Quoted strings are rendered text and name attributes from
  client/src/features/contacts/tabs/RelationshipsTab.tsx. "graph_view",
  "table_view", "role_filter" and "trust_filter" are name attributes.
  ALL ASSERTED STRINGS ARE ASCII.

  WHAT IS ASSERTED AND WHAT IS NOT. These scenarios assert that the table is a
  FIRST-CLASS view reachable by a control rather than a hidden fallback, that
  both filters exist, and that the legend explains the two visual channels. They
  do NOT assert nodes, edges or a 500-node frame rate, because the neighbourhood
  comes from sdk-rebac and this environment has no gateway credential.

  THE EQUIVALENCE OF THE TWO VIEWS IS STRUCTURAL, NOT TESTED HERE. Both render
  from ONE row model (`describe` in the component), so a field added to an edge
  appears in both or in neither. That is stronger than a test comparing two
  independently-authored views, which passes right up until somebody adds a
  column to only one of them.

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:66b2268b-a6b8-4945-a164-7f6351f665e5
  Scenario: The graph states what a contextual role does and does not do
    When I navigate to "/app/contacts/local-demo-contact/relationships"
    Then I should see "Relationships"
    And I should see "Contextual roles connect the Person to Properties, Organizations, tenant teams and other people without mutating pure identity"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:3fec9638-96c8-4d73-8e04-919798141f11
  Scenario: The table view is offered as a peer of the graph, not as a fallback
    # AC2. An accessible equivalent reached only by a screen reader is a lesser
    # view that nobody notices is lesser.
    When I navigate to "/app/contacts/local-demo-contact/relationships"
    Then I should see "Graph view"
    And I should see "Table view"


  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:6b9c5909-f7ac-4bde-9483-1d8f2a1a6f44
  Scenario: Both filters are present on the graph
    # AC4's control surface. The filter LABELS are asserted rather than their
    # unset options: an <option> is not visible text while its select is
    # closed, so the runner cannot assert one - it falls through every selector
    # strategy and the healer then tries to FILL the select.
    When I navigate to "/app/contacts/local-demo-contact/relationships"
    Then I should see "Filter by role"
    And I should see "Filter by trust state"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:3e01c900-112d-46da-b3a8-5235860252a0
  Scenario: An empty neighbourhood is reported as empty rather than drawn blank
    When I navigate to "/app/contacts/local-demo-contact/relationships"
    Then I should see "No relationships match these filters"
