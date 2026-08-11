@feature_id:c6293928-af67-4f8f-8c9b-c9bd707645eb
@epic_id:224f72e3-9444-4923-96da-477e76aa9654
Feature: Saved Views - operational shortcuts with live filter-based counts
  The Saved Views panel on the Contacts screen.

  Quoted strings are SELECTOR KEYS from
  client/src/features/contacts/SavedViewsPanel.tsx. "save_view",
  "view_name" and "view_scope" are name attributes.
  ALL ASSERTED STRINGS ARE ASCII.

  WHAT IS ASSERTED AND WHAT IS NOT. These scenarios assert that the panel
  states the rule it is built on - a view stores its FILTER, never a result set
  - and that saving one asks for a name and a sharing scope. They do NOT assert
  the four shipped views by name or their counts, because the view register
  comes from sdk-search saved-queries and this environment has no gateway
  credential; the honest local state is an empty panel. The count contract is
  asserted in tests/api_definitions/saved-views/counts-get.json.

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:4ca8e0aa-edc6-46ac-8766-a59fe3c9a427
  Scenario: The panel states that a view stores its filter, not its rows
    # AC1. A stored result says "5" forever while the queue moves on, and the
    # operator who trusts it works a list that stopped being true.
    When I navigate to "/app/contacts"
    Then I should see "Saved Views"
    And I should see "Operational shortcuts based on source, trust and actionability"
    And I should see "Each stores its filter, so the count is always current"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:f00eb2f7-dfd4-4afd-8ccb-c20083b3e76e
  Scenario: Saving a view asks for a name and a sharing scope
    # AC3. Scope is a governed property of the view, chosen when it is created
    # rather than assumed.
    When I navigate to "/app/contacts"
    And I click "save_view"
    Then I should see "Save this view"
    And I should see "Stores the filter definition, never the rows it currently matches"
    And I should see "Sharing scope"
    And I should see "Pinned to the sidebar"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:0c74c624-f49d-4876-ab80-81532b5cb230
  Scenario: Sharing a view never widens who can see the rows
    # The distinction that keeps a shared shortcut from becoming a data leak:
    # the FILTER is shared, and the rows are still resolved against the
    # recipient's own permissions.
    When I navigate to "/app/contacts"
    And I click "save_view"
    Then I should see "Scope is enforced by policy on the server"
    And I should see "never shares access to rows"
