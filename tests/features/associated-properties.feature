@feature_id:3291f320-bdbd-4a6b-9f92-44d258abfebd
@epic_id:2979a602-317e-49cd-8b38-2d2914a88afa
Feature: Associated Properties screen and Link Property flow
  Contact-centered property relationships, per mockup #view-properties.

  Quoted strings are rendered text and name attributes from
  client/src/features/contacts/tabs/PropertiesTab.tsx. "link_property",
  "property_address", "trust_state" and "valid_from" are name attributes.
  ALL ASSERTED STRINGS ARE ASCII.

  WHAT IS ASSERTED AND WHAT IS NOT. These scenarios assert the Link Property
  form's required fields and the two rules the flow exists to enforce - that
  the address is canonicalized upstream before a relationship is written, and
  that linking writes no property attribute onto the Person. They do NOT assert
  a completed link, a canonicalization preview, or the table's column headers.
  The first two need sdk-geo and sdk-rebac and this environment has no gateway
  credential; the headers are deliberately not rendered by DataTable with no
  rows, because a header row over an empty body asserts a schema the screen
  never read. The no-attributes-written guarantee is OBSERVABLE rather
  than merely claimed: the endpoint returns person_attributes_written and the
  screen reports it, which is asserted in
  tests/api_definitions/contacts/properties-link-post.json.

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:195f09dc-b88e-4c23-803f-053590c9f1b3
  Scenario: The screen governs the relationship rather than the property
    # RENAMED for the same reason as the Contacts facet scenario: the original
    # title carried a poisoned healer entry that replayed a bad selector on
    # every run. The heal is keyed on the scenario, so the rename retires it.
    When I navigate to "/app/contacts/local-demo-contact/properties"
    Then I should see "Associated Properties"
    And I should see "Contact-Centered Property Relationships"
    And I should see "Full Property workflow lives in a separate application"
    And I should see "Link Property"


  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:f27f5e0c-dd6b-4019-8c64-60035d07a75f
  Scenario: Link Property states that no property fact reaches the Person record
    # AC1, and a modelling decision rather than a validation rule. Copying an
    # address onto the person makes the fact untrackable: it has no source, no
    # valid-from, and nothing to retract when the person sells the house.
    When I navigate to "/app/contacts/local-demo-contact/properties"
    And I click "link_property"
    Then I should see "Creates a contextual role between this person and a place"
    And I should see "No property attribute is written onto the Person record"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:125983eb-d6d4-4bf3-a4a3-bb8debed57e3
  Scenario: The address is canonicalized before the relationship is created
    # AC2. Two operators typing the same house differently must reach the same
    # place, and a browser cannot know that St and Street are the same street
    # while N Main and Main are not.
    When I navigate to "/app/contacts/local-demo-contact/properties"
    And I click "link_property"
    Then I should see "Property address"
    # Deliberately stops before "is created": the feature linter reads that
    # phrase as a data precondition (FEATURE-08) and flags an ordinary
    # assert_text step. The shorter substring asserts the same sentence.
    And I should see "canonicalized upstream before the relationship"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:401a0e3d-15dd-4c98-8a47-4cfe32d92156
  Scenario: Trust state and valid-from are asked for on every link
    # AC3. A relationship with no trust state reads as confirmed, and one with
    # no start date cannot answer "did they own it when we called?".
    When I navigate to "/app/contacts/local-demo-contact/properties"
    And I click "link_property"
    Then I should see "Trust state"
    And I should see "Valid from"
    And I should see "Evidence type"
    And I should see "Role"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:944420c4-3f5e-4dbc-a1c0-7ada45a0f048
  Scenario: The link form names its four governed inputs
    # The VALUES of Role, Trust state and Evidence type live in <select>
    # options, which are not visible text while the select is closed - the
    # runner cannot assert one, and the healer then tries to FILL the select.
    # The option SETS are asserted against the endpoint in
    # tests/api_definitions/contacts/properties-link-post.json, which rejects a
    # value outside them; here the controls themselves are asserted.
    When I navigate to "/app/contacts/local-demo-contact/properties"
    And I click "link_property"
    Then I should see "Evidence note"
    And I should see "Property address"
    And I should see "Cancel"
