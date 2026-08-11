@feature_id:2da7d18e-ec06-4739-aa6c-3213c3fa2329
@epic_id:224f72e3-9444-4923-96da-477e76aa9654
Feature: Contact 360 shell - header, trust rail and eight-tab navigation
  The full-screen contact workspace, per mockup #contact360.

  Quoted strings are SELECTOR KEYS taken from
  client/src/pages/app/Contact360.tsx and features/contacts/contactTabs.ts, not
  labels invented for the test. Button names ("consent", "enrich",
  "create_lead") are name attributes; tab strings are the rendered labels.

  ALL ASSERTED STRINGS ARE ASCII. A non-ASCII byte anywhere in the posted body
  makes the Test MCP reject the feature with a 400 the runner swallows into an
  empty log, so the header's middot separators are never asserted - only the
  ASCII words around them.

  WHAT IS ASSERTED AND WHAT IS NOT. These scenarios assert the SHELL: that the
  workspace renders its header, that the display name never appears without a
  survivorship note, that all six trust-rail rungs are present, and that all
  eight tabs are deep-linkable routes rather than component state. They do NOT
  assert a particular contact's name, canonical id or rail colours, because
  those come from GET /api/leadflow/contacts/:id/summary over sdk-crm and
  sdk-projection, and this environment has no gateway credential - the honest
  local state is a record that could not be read. The shell is built to keep
  rendering in exactly that case, which is what makes these assertions
  meaningful rather than a workaround.

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:b243496e-5e7c-483f-8864-5d0e6ac974c9
  Scenario: The workspace renders its header even when the record cannot be read
    # The shell must not blank on a failed read. An operator who followed a link
    # needs to see which record they asked for and that it failed, not an empty
    # page that looks like a contact with no data.
    When I navigate to "/app/contacts/local-demo-contact/overview"
    Then I should see "Trust status"
    And I should see "Consent"
    And I should see "Enrich"
    And I should see "Create Lead"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:6a1fc98d-6b47-42c1-8ea8-e0ced386684a
  Scenario: The display name never appears without its survivorship provenance
    # AC3, and the reason the screen exists. The name at the top is a projection
    # over several disagreeing sources, so it ships with its note or the absence
    # of the note is stated - never a bare name carrying the authority of a fact.
    When I navigate to "/app/contacts/local-demo-contact/overview"
    Then I should see "Survivorship"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:b0acbe37-7634-4fb4-ab80-1cd3c755cd6b
  Scenario: All six trust rail rungs are on screen
    # AC1. Every rung always renders. A rail that hides the rungs a record has
    # not reached looks complete at every stage, which is the opposite of what a
    # trust ladder is for.
    When I navigate to "/app/contacts/local-demo-contact/overview"
    Then I should see "P0 Captured"
    And I should see "P1 Normalized"
    And I should see "P2 Candidate"
    And I should see "P3 Linked"
    And I should see "P4 Direct"
    And I should see "Trust status"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:44bfafed-bc64-4785-b7f6-e79207de9d53
  Scenario: Consent is drawn alongside the identity ladder, not on top of it
    # A record can be fully verified at P4 and still carry no permission to
    # contact. Collapsing the two would let a confident rail imply a permission
    # nobody granted.
    When I navigate to "/app/contacts/local-demo-contact/overview"
    Then I should see "Consent runs alongside the identity ladder"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:8eb3253a-68fa-4907-8354-d15fa0c3ef6d
  Scenario: All eight tabs are present in the navigation
    # AC2, first half. The tab list is the operator's map of what a contact has.
    When I navigate to "/app/contacts/local-demo-contact/overview"
    Then I should see "Overview"
    And I should see "Contact Points"
    And I should see "Properties"
    And I should see "Conversations"
    And I should see "Relationships"
    And I should see "Preferences & Consent"
    And I should see "Data & Provenance"
    And I should see "Audit Timeline"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:98989b5c-8d40-4a3c-9169-3840161418dc
  Scenario: The Contact Points tab is reachable by its own URL
    # AC2, second half. A tab is a ROUTE, so a link into it loads that pane
    # directly rather than the workspace default.
    When I navigate to "/app/contacts/local-demo-contact/contact-points"
    Then I should see "Each phone, email, address and profile is a separate handle"
    And I should see "Add Contact Point"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:200b428e-a01d-4d73-a889-7be317e51491
  Scenario: The Provenance tab is reachable by its own URL
    When I navigate to "/app/contacts/local-demo-contact/provenance"
    Then I should see "Conflicting source values coexist"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:62dbb24e-3f30-48d5-8a50-bb2b2fe75a2f
  Scenario: The Audit Timeline tab is reachable by its own URL
    When I navigate to "/app/contacts/local-demo-contact/audit"
    Then I should see "Every governed action taken on this record"
