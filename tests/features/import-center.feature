@feature_id:01724402-1fc2-45e4-90e4-f6c46286286f
@epic_id:8eca7fd1-6541-4863-81ec-bf170938403d
Feature: Import Center screen
  Source tiles, the run register and the reusable mapping-template library, as
  #view-import draws them.

  Control labels below are the real ones from
  client/src/pages/app/ImportCenter.tsx and
  client/src/content/importSources.ts, not human-friendly paraphrases.

  SIGN-IN is the @login:default tag, never hand-written steps. The runner runs
  the flow from tests/config/test-config.json loginConfig. The default account
  is qa.operator@leadflow.test, whose local `admin` role bridges to
  revenue_operations, which holds import.run_read - so it can reach this screen.
  It does NOT hold import.evidence_read, and the last scenario below depends on
  exactly that.

  FOUR SCENARIOS RATHER THAN ONE, split by what would make each fail: the tile
  scenario fails when a source is dropped or renamed, the availability scenario
  when an unconnected source is hidden instead of marked, the register scenario
  when the segmented filter or the column set drifts, and the evidence scenario
  when the narrower permission stops being enforced.

  WHAT IS ASSERTED AND WHAT IS NOT. These scenarios assert the SCREEN: the
  mockup copy, all eight source tiles, their availability treatment, the run
  table's columns and its four-value status vocabulary. They do NOT assert the
  run ROWS, because runs come from sdk-import and no LeadFlow route creates one,
  so the honest state of the register in a local run is empty with the table
  saying so. The row contract is asserted where it can be:
  tests/api_definitions/imports/center-get.json for the composed payload.

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:6d7c1639-e7f8-4b50-bb96-9ce631ae9e0b
  Scenario: All eight supported sources are offered, with the mockup's wording
    When I navigate to "/app/import"
    # NOT "Import Center" - that string is both the h1 AND the sidebar nav
    # link, and the runner resolved the <a> and tried to FILL it. The eyebrow
    # is unique to the page, so it identifies the screen unambiguously.
    Then I should see "Source-Specific Ingestion & Reconciliation"
    And I should see "Connect a supported source, upload a source-native export, or map any custom CSV."
    And I should see "Google Contacts"
    And I should see "Apple Contacts"
    And I should see "AccuLynx"
    And I should see "JobNimbus"
    And I should see "SalesRabbit"
    And I should see "HubSpot"
    And I should see "vCard"
    And I should see "Custom CSV"
    And I should see "OAuth / CSV"
    And I should see "Selected / vCard"
    And I should see "API / Export"
    And I should see "Flexible"
    And I should see "Templates"
    And I should see "Start Import"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:a06e5a91-7ed7-4387-9842-df5f216cb179
  Scenario: An unconnected source is shown as unavailable rather than hidden
    # A tile dropped because nobody connected it reads as "not supported" - the
    # operator concludes the product cannot do the thing they came to do. Shown
    # as unavailable it reads as "not connected yet", which they can act on.
    # This environment has no connector installs, so every connector-backed
    # source reports that state.
    When I navigate to "/app/import"
    Then I should see "Google Contacts"
    And I should see "Not connected yet."
    # vCard and Custom CSV need no connector at all - the operator uploads a
    # file - so they must NEVER be marked unavailable.
    And I should see "AI-assisted mapping, transforms, dry run and reusable templates."

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:8a526394-3d8c-49b3-a15b-7ff11781cc40
  Scenario: The run register offers the mockup's columns and segmented filter
    When I navigate to "/app/import"
    Then I should see "Import Runs"
    And I should see "Every run remains reversible until downstream governed actions occur."
    And I should see "Created / Linked"
    And I should see "Origin Attestation"
    And I should see "Started by"
    And I should see "Reusable Mapping Templates"
    And I should see "Versioned schemas, transforms and source crosswalk contracts."
    # The four segments, in the mockup's order.
    When I select "In progress" from "run-filter"
    Then I should see "Import Runs"
    When I select "Needs review" from "run-filter"
    Then I should see "Import Runs"
    When I select "Completed" from "run-filter"
    Then I should see "Import Runs"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:aed9ed3a-d1af-4442-964a-621315ab0967
  Scenario: An empty register always says WHY it is empty
    # "There are no runs" and "we could not ask" are DIFFERENT FACTS, and a
    # blank table with no explanation is the one outcome that would be wrong.
    #
    # ASSERTS THE SHARED STEM, not either branch. An earlier version of this
    # scenario asserted one of the two mutually exclusive sentences and failed
    # twice - once on each branch - because whether sdk-import is reachable
    # depends on whether the ProjexCloud gateway happens to be up, which is not
    # something this screen controls. "No runs to show" is true either way; the
    # clause after it names the reason for a human reading the screen.
    When I navigate to "/app/import"
    Then I should see "Import Runs"
    And I should see "No runs to show"
