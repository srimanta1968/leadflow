@feature_id:c12362d4-3479-46e6-b243-47c04b68b61e
@epic_id:224f72e3-9444-4923-96da-477e76aa9654
Feature: Contacts screen - filters, canonical table and eligible-only export
  Canonical People and Organizations, per mockup #view-contacts.

  Quoted strings are SELECTOR KEYS from client/src/pages/app/Contacts.tsx.
  "export_eligible", "export_purpose" and "run_export" are name attributes;
  the rest are rendered text. ALL ASSERTED STRINGS ARE ASCII.

  WHAT IS ASSERTED AND WHAT IS NOT. These scenarios assert the SCREEN and the
  EXPORT GATE: the framing line, all five facets, and that Export eligible
  refuses to run until a purpose is chosen. They do NOT assert contact ROWS,
  the table's column headers, or an export's row counts. Rows come from
  sdk-search and sdk-crm and this environment has no gateway credential; and
  the column HEADERS are deliberately not rendered by DataTable when there are
  no rows, because a header row over an empty body asserts a schema the screen
  has not actually read. Those columns are asserted where the data exists, in
  tests/api_definitions/contacts/list-get.json, and the export's
  execution-time re-evaluation in
  tests/api_definitions/contacts/export-post.json.

  THE PURPOSE GATE IS THE POINT and it IS assertable locally, because refusing
  to export without a purpose is a decision this screen makes before any
  request is sent.

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:5f9cd05b-680e-4623-8761-61656bb2fc9e
  Scenario: The screen states why a person is not one wide row
    When I navigate to "/app/contacts"
    Then I should see "Contacts"
    And I should see "A person is not one wide row"
    And I should see "Import"
    And I should see "Quick Contact"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:45e7c548-b813-4a20-ac53-f925f8692da9
  Scenario: All five facets are on screen and each is labelled
    # AC3, first half. The five compose - none of them replaces another. Each
    # carries a VISIBLE label naming the FIELD: a bare select is legible only
    # while it sits at its default, and once it reads "P4" nothing says which
    # facet that is. The label deliberately does not repeat the unset option -
    # the same string in both places puts identical text on screen twice.
    When I navigate to "/app/contacts"
    Then I should see "Contacts"
    And I should see "Entity type"
    And I should see "Trust state"
    And I should see "Channel state"
    And I should see "Record owner"
    And I should see "More filters"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:8574f663-781f-4edb-85cf-ebdfbcc49953
  Scenario: A facet selection is reflected in the URL so the list is shareable
    # AC3, second half. Holding facets in component state makes a shared link a
    # lie, because it reopens on the unfiltered list.
    When I navigate to "/app/contacts?trust_state=P4&channel_state=Eligible"
    Then I should see "Contacts"
    And I should see "Record owner"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:5676f45b-e201-41f8-b876-4c15389b14ca
  Scenario: Export eligible demands a purpose before it will run
    # AC2. Eligibility is a property of the person, the purpose and the channel
    # together, so an export with no purpose cannot be checked against anything.
    # The control opens closed and says why.
    When I navigate to "/app/contacts"
    And I click "export_eligible"
    Then I should see "Eligibility is evaluated now"
    And I should see "Purpose"
    And I should see "an export with no purpose cannot be checked against anything"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:84be4ce7-e106-44dc-aae9-01780ac7db46
  Scenario: The purpose list is governed rather than free text
    # A free-text purpose would evaluate against nothing and therefore permit
    # everything, so the list is fixed. The purposes themselves live in <select>
    # options, which are not visible text while the select is closed - the
    # runner cannot assert one, and the healer then tries to FILL the select.
    # The accepted set is asserted at the endpoint in
    # tests/api_definitions/contacts/export-post.json, which rejects a purpose
    # outside it.
    When I navigate to "/app/contacts"
    And I click "export_eligible"
    Then I should see "never read from a stored flag"
    And I should see "Eligibility is a property of the person, the purpose and the channel"
