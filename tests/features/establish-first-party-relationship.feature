@feature_id:b2acccfe-df26-4e2f-8ce4-f2e37a06047b
@epic_id:3d26a52b-753c-4ee4-849c-6433f98473d6
Feature: Establish First-Party Relationship modal and case resolution
  The promotion modal and the case workspace, per mockup #promotionModal.

  Quoted strings are rendered text and name attributes from
  client/src/features/dataReview/EstablishRelationshipModal.tsx and
  pages/app/DataReview.tsx. "establish_relationship_open", "bulk_resolve" and
  "acknowledge_no_consent" are name attributes. ALL ASSERTED STRINGS ARE ASCII.

  WHAT IS ASSERTED AND WHAT IS NOT. These scenarios assert the two rules the
  modal exists to enforce - that the original assertion survives, and that a P4
  relationship is NOT channel consent - plus the six relationship types, the
  three evidence types, and the blast-radius gate on bulk resolution. They do
  NOT assert a completed promotion, because writing the assertion needs
  sdk-source-record and sdk-rebac and this environment has no gateway
  credential.

  THAT THIS FLOW NEVER CALLS sdk-consent IS STRUCTURAL, not tested here: the
  component imports no consent client at all, so there is no code path to
  assert against. A test could only prove that a mock was not called.

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:da57f0bb-e925-46f6-8bb0-37a29cae57e5
  Scenario: The modal opens from the Data Review screen
    When I navigate to "/app/data-review"
    Then I should see "Establish Relationship"
    And I should see "Bulk resolve"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:77cdceb8-0b34-47af-a3a4-1e129aa088c5
  Scenario: The immutability callout is the first thing on screen
    # AC2. The intuition it corrects is strong: a rep who confirms "yes, I spoke
    # to them" reasonably expects that to settle the matter and supersede the
    # broker's claim. It must not - a later dispute is argued from what we
    # believed at the moment we acted.
    When I navigate to "/app/data-review"
    And I click "establish_relationship_open"
    Then I should see "The licensed or public assertion remains"
    And I should see "This workflow ADDS new evidence alongside it and supersedes nothing"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:7dc68ea6-01b7-4244-ad1b-16b643fd60cf
  Scenario: The modal states that a relationship is not consent
    # AC1, and the most expensive conflation available here. "We have a direct
    # relationship" is a statement about identity provenance; "we may market to
    # them" is a permission only the person can grant.
    When I navigate to "/app/data-review"
    And I click "establish_relationship_open"
    Then I should see "It does not grant permission to contact them"
    And I should see "creates a P4 relationship assertion but does not create channel"
    And I should see "Permission to contact is separate and only the person can grant it"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:d1b6f09a-aa59-4648-a10c-129060dc16c4
  Scenario: Relationship type is asked for and is required
    # The six TYPES live in <select> options, which are not visible text while
    # the select is closed - the runner cannot assert one, and the healer then
    # tries to FILL the select. The set is asserted against the endpoint in
    # tests/api_definitions/data-review/promote-post.json, which rejects a type
    # outside it; here the control and its required-ness are asserted.
    When I navigate to "/app/data-review"
    And I click "establish_relationship_open"
    Then I should see "Relationship Type"
    And I should see "Effective From"
    And I should see "Required."

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:e51fe928-45e5-4c7d-af05-95d5bfafb168
  Scenario: Each evidence type explains what it actually means
    # The descriptions are the decision, not help text. A rep choosing between
    # them is deciding how strong the resulting assertion is, and that is not
    # guessable from the labels.
    When I navigate to "/app/data-review"
    And I click "establish_relationship_open"
    Then I should see "In-person confirmation"
    And I should see "A person confirmed their identity face to face"
    And I should see "Inbound response"
    And I should see "Signed document"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:492a7a56-f7ef-429d-a4bb-8a1c77a4346e
  Scenario: The form asks what the relationship was confirmed FOR
    # A role confirmed in one context is not a claim about the whole person.
    When I navigate to "/app/data-review"
    And I click "establish_relationship_open"
    Then I should see "Property / Business Context"
    And I should see "A role confirmed in one context is not a claim about the whole person"
    And I should see "Effective From"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:68a6afca-b6f8-40a4-8c47-ba4deb9a34cc
  Scenario: Bulk resolution shows its blast radius before committing
    # AC3. A bulk action over a mixed set applies one decision to cases that
    # differ in exactly the way that made them cases.
    When I navigate to "/app/data-review"
    And I click "bulk_resolve"
    Then I should see "Blast radius"
    And I should see "only for homogeneous low-risk cases"
    And I should see "I have read the blast radius above and accept it"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:1163a6b5-ce47-4515-aea2-7a654c670bc8
  Scenario: Quarantined records are held out of every downstream activation
    # AC4. Quarantine is a state of the RECORD, not a filter on this screen, so
    # it cannot be worked around by changing the view.
    When I navigate to "/app/data-review"
    Then I should see "held out of every downstream activation"
    And I should see "no campaign, no export"
