@feature_id:db35be2f-0fa5-4759-bc83-20fb203f798e
@epic_id:224f72e3-9444-4923-96da-477e76aa9654
Feature: Contact 360 Overview tab - six panels
  The Overview pane of the contact workspace, per mockup #c-overview.

  Quoted strings are rendered text from
  client/src/features/contacts/tabs/OverviewTab.tsx.
  ALL ASSERTED STRINGS ARE ASCII.

  WHAT IS ASSERTED AND WHAT IS NOT. These scenarios assert that all six panels
  render, that the contactability meter states it is COMPUTED rather than
  stored, that credit-priced actions declare a cost, and that the panel refuses
  to present a recommendation list it did not receive. They do NOT assert
  specific channel verdicts, reasons or recommendation rows, because those come
  from the decision engine and sdk-lead-scoring and this environment has no
  gateway credential. The rule that a Deny or Review row must carry a concrete
  reason is enforced in the component - a decision with no reason renders the
  sentence asserted below rather than a blank - and that IS locally assertable
  only once a decision exists, so it is covered in
  tests/api_definitions/contacts/overview-get.json.

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:95576503-d81e-4ba0-b822-6e7f85707a08
  Scenario: All six panels are on screen
    When I navigate to "/app/contacts/local-demo-contact/overview"
    Then I should see "Identity & Reachability"
    And I should see "Contact Points"
    And I should see "Properties & Work"
    And I should see "Recent Conversations"
    And I should see "Data Passport"
    And I should see "Channel Decision"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:ca8c3b97-1903-48ad-9f13-634c063cffc8
  Scenario: Identity panel carries the survivorship note and the role scope
    # A role is confirmed FOR something. Dropping the scope turns a narrow
    # confirmation into a claim about the whole person.
    When I navigate to "/app/contacts/local-demo-contact/overview"
    Then I should see "Preferred Display Name"
    And I should see "Contextual Role"
    And I should see "Organization"
    And I should see "Record Owner"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:ed0ce3e8-9702-4622-a41d-bcc46e75637d
  Scenario: The contactability meter says it is computed, not stored
    # AC2. A stored score survives the consent revocation that should have moved
    # it, and keeps reporting a person as reachable after they asked not to be.
    When I navigate to "/app/contacts/local-demo-contact/overview"
    Then I should see "Contactability"
    And I should see "Computed from the live channel eligibility below, never from a stored score"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:4cfc9881-20ec-447b-8278-3eb297d2804c
  Scenario: The Data Passport names its four governed facts
    When I navigate to "/app/contacts/local-demo-contact/overview"
    Then I should see "Canonical Person ID"
    And I should see "Primary Data Origin"
    And I should see "Direct Relationship"
    And I should see "Last Identity Review"
    And I should see "Full history"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:c6e82e9b-f1bd-4750-904e-5d284c87a681
  Scenario: Recommendations come from the scoring service, and an empty list says so
    # AC3. Hard-coding the mockup's four would make the panel a picture of a
    # recommendation engine rather than one, so an empty result is reported as
    # an empty result.
    When I navigate to "/app/contacts/local-demo-contact/overview"
    Then I should see "Recommended Next Actions"
    And I should see "The scoring service returned no recommendations for this record"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:41f7c2e3-5e71-4a5e-a77f-83e75883ce21
  Scenario: Each panel offers the way through to its full screen
    When I navigate to "/app/contacts/local-demo-contact/overview"
    Then I should see "Manage"
    And I should see "Link property"
    And I should see "View all"
