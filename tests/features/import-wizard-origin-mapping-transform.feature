@feature_id:393b54ab-4c86-442a-a3c9-ebb7d381f328
@epic_id:8eca7fd1-6541-4863-81ec-bf170938403d
Feature: Import wizard steps 4-6 - Origin, Mapping, Transform
  The governance middle of #importModal: attest to where the data came from,
  confirm what each column means, and choose what may be rewritten.

  Control labels below are the real ones from
  client/src/components/app/ImportWizardModal.tsx and
  client/src/content/importGovernance.ts, not paraphrases.

  THREE OF THE FOUR CRITERIA ARE REFUSALS, NOT WARNINGS, and the scenarios are
  written to fail if any of them softens into advice:
    - a licensed or partner origin cannot be attested without evidence, so the
      attestation checkbox is DISABLED rather than merely flagged;
    - an address column is not OFFERED a person target at all, so there is no
      wrong choice to click past;
    - mapping the source system's lifecycle onto Lead is off until somebody
      turns it on, and says at length why.

  The eight origin classes are mirrored from sdk-source-record's ORIGIN_CLASSES.
  The mockup's dropdown showed only seven - it omits USER_PROVIDED - and the
  first scenario asserts all eight, because a screen offering seven makes one
  class silently unreachable while the commit still validates against it.

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  Scenario: A licensed origin cannot be attested without evidence attached
    When I navigate to "/app/import"
    And I click "Start Import"
    And I click "2. Connect"
    And I click "Load sample CSV"
    And I click "4. Origin"
    Then I should see "Data Origin & Permitted Use"
    And I should see "An authorized person attests to source and rights. Unknown origin is quarantined, not guessed."
    And I should see "User provided"
    And I should see "First-party direct"
    And I should see "Tenant first-party CRM"
    And I should see "User-authorised contact store"
    And I should see "Public record"
    And I should see "Licensed third-party"
    And I should see "Partner provided"
    And I should see "Unknown — quarantined"
    When I click "origin-class"
    Then I should see "Origin does not equal consent."

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  Scenario: Evidence is demanded for a licensed origin and optional otherwise
    # The right to hold licensed data comes from a document somebody else wrote.
    # For every other class the attester speaks about their own organisation's
    # collection and their signed word IS the evidence.
    When I navigate to "/app/import"
    And I click "Start Import"
    And I click "2. Connect"
    And I click "Load sample CSV"
    And I click "4. Origin"
    Then I should see "Optional for tenant CRM and first-party origins."
    And I should see "The attestation is signed with my platform principal, timestamp, source fingerprint and mapping version."
    And I should see "Choose an origin class first."

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  Scenario: Every mapping suggestion shows confidence and a reason
    # An assistant that cannot say WHY cannot be checked, and one shown without a
    # confidence invites the operator to accept every row without reading it.
    When I navigate to "/app/import"
    And I click "Start Import"
    And I click "2. Connect"
    And I click "Load sample CSV"
    And I click "5. Map"
    Then I should see "Column Mapping"
    And I should see "Every suggestion is advisory until you confirm it."
    And I should see "Source Column"
    And I should see "Canonical Target"
    And I should see "Confidence"
    And I should see "column name matches an email pattern"
    And I should see "looks like the source system"
    # AC3 - an address column reports the Place relationship, and no person
    # target is offered for it at all.
    And I should see "Becomes a Place linked by ASSOCIATED_WITH."
    And I should see "Property Link"
    And I should see "Source Crosswalk"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  Scenario: Mapping the source lifecycle onto Lead is off until enabled
    # Another system's "qualified" is not this one's. Importing it silently
    # would drop thousands of records into a stage nobody assessed them for -
    # they would then be worked, messaged and counted in forecasts on a
    # judgement no human made.
    When I navigate to "/app/import"
    And I click "Start Import"
    And I click "2. Connect"
    And I click "Load sample CSV"
    And I click "6. Transform"
    Then I should see "Transform & Normalize"
    And I should see "Every step keeps the value it started from, so a transformation we got wrong stays readable."
    And I should see "Normalise phone numbers to E.164"
    And I should see "Resolve property-address candidates"
    And I should see "Map source lifecycle status to Lead"
    And I should see "OFF BY DEFAULT."
    And I should see "Value Crosswalks"
