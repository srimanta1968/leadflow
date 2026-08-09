@feature_id:9188e42b-275c-4251-a52e-c8cec1d2defc
@epic_id:8eca7fd1-6541-4863-81ec-bf170938403d
Feature: Import wizard steps 7-9 - Identity, Access, Consent
  What happens to matches, who can see the result, and what may be claimed
  about permission.

  Control labels below are the real ones from
  client/src/components/app/ImportWizardModal.tsx and
  client/src/content/importGovernance.ts, not paraphrases.

  THE FIRST CRITERION IS ABOUT AN ABSENCE, which is unusual to test and worth
  saying plainly: there must be no destructive merge anywhere in the flow. The
  scenario therefore asserts the three bands offer only link-or-review choices
  AND that the screen states the absence outright, because an absence nobody
  documents reads as an oversight rather than a decision.

  A merge cannot be undone even in principle - once two source records are
  collapsed, which assertion came from which is gone. A link keeps both, which
  is exactly why a verified link can be retracted and the projections replayed.

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:e8d208de-652d-4326-b8a5-121cb01677c7
  Scenario: No band offers a destructive merge, and the screen says so
    When I navigate to "/app/import"
    And I click "Start Import"
    And I click "2. Connect"
    And I click "Load sample CSV"
    And I click "7. Resolve"
    Then I should see "Identity Resolution Strategy"
    And I should see "Exact Matches"
    And I should see "Auto-link safe exact matches"
    And I should see "Send all to review"
    And I should see "Possible Matches"
    And I should see "Create review cases"
    And I should see "Import separately as provisional entities"
    And I should see "Skip, retaining only the exception file"
    And I should see "No Match"
    And I should see "Create canonical entity after validation"
    And I should see "Create provisional only"
    And I should see "There is no destructive merge."
    And I should see "LeadFlow links records, it never destroys one into another."

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:d8706636-c4e8-4ea1-9dcb-b2e448b74ef9
  Scenario: Leads cannot be created until a reachable contact point is confirmed
    # A Lead must carry an owner, a next action and an intended outcome. A row
    # with no email or phone supports none of those, so creating Leads from it
    # manufactures records that are broken the moment anybody opens them - and
    # they are worked, messaged and counted in forecasts meanwhile.
    When I navigate to "/app/import"
    And I click "Start Import"
    And I click "2. Connect"
    And I click "Load sample CSV"
    And I click "8. Access"
    Then I should see "Visibility, Ownership & Downstream Creation"
    And I should see "Private to importer"
    And I should see "Selected teams"
    And I should see "Entire organization"
    And I should see "Preserve mapped source owner"
    And I should see "Round robin by team"
    And I should see "Unassigned queue"
    And I should see "Contacts and Property relationships"
    And I should see "Unavailable: no reachable contact point is mapped and confirmed yet."
    And I should see "Campaign eligibility is evaluated separately at send time"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:ab429295-8a8f-48f6-90e0-755e08000008
  Scenario: A generic consent value produces no receipt
    # "yes" is the single most common value in a consent column and it carries
    # no notice version, no timestamp and no record of what the person was
    # actually told - which is precisely what a receipt has to state.
    When I navigate to "/app/import"
    And I click "Start Import"
    And I click "2. Connect"
    And I click "Load sample CSV"
    And I click "9. Consent"
    Then I should see "Consent, Preference & Suppression Import"
    And I should see "No consent is being imported"
    And I should see "Consent evidence is mapped from the file"
    And I should see "Rows whose value is blank or generic produce NO receipt."
    And I should see "Unknown is not granted."
    And I should see "A missing consent value means no permission was recorded, not that permission exists."

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:69ab125d-c854-4f3c-80b6-7634728259a6
  Scenario: Suppression merges most-restrictive-wins across every source
    # An import can add a suppression but never lift one. The person who
    # unsubscribed did not change their mind by appearing in a spreadsheet.
    When I navigate to "/app/import"
    And I click "Start Import"
    And I click "2. Connect"
    And I click "Load sample CSV"
    And I click "9. Consent"
    Then I should see "Suppression sources"
    And I should see "Suppression flags in this file"
    And I should see "Existing LeadFlow suppressions"
    And I should see "Provider suppression lists"
    And I should see "Most restrictive wins"
    And I should see "an import can add a suppression, never lift one"
