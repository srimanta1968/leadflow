@feature_id:b76cf99a-719e-4288-8f4c-82de393f33c4
@epic_id:ef8a21ec-c1a9-4d26-ac59-e0fa28b41a3b
Feature: Commercial Review workspace and offer version stamping
  The commercial review, per SOP 13 and 32.

  Quoted strings are rendered text and name attributes from
  client/src/pages/app/CommercialReview.tsx.
  "request_exception_approval" is a name attribute.
  ALL ASSERTED STRINGS ARE ASCII.

  WHAT IS ASSERTED AND WHAT IS NOT. These scenarios assert the four feature
  status labels with their meanings, the approval-before-communication
  ordering, and the fit-summary composer including its required honest
  limitation. They do NOT assert the staleness BANNER, because it renders only
  when a stamped version is superseded and both versions come from
  sdk-offer-catalog, which this environment cannot reach - a banner asserted
  against no data would be asserting a hard-coded string.

  THE STALENESS CRITERION IS COVERED at the endpoint in
  tests/api_definitions/offers/staleness-get.json, where a stamped version and
  a current version genuinely differ.

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:f72c109b-4e01-42c3-8b7a-40ca5105918b
  Scenario: The workspace states why the version is stamped
    # AC1. A dispute six months later is settled by what the customer was
    # actually shown.
    When I navigate to "/app/offers"
    Then I should see "Commercial Review"
    And I should see "stamped onto this record and onto every recap"
    And I should see "settled from evidence rather than from memory"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:043005e9-a4c7-4d9d-a1be-9d09490a9197
  Scenario: The recap is named as the artefact that must carry the version
    # Stamping only the opportunity is the near-miss that fails in practice: the
    # recap email is what the customer keeps.
    When I navigate to "/app/offers"
    Then I should see "Offer version"
    And I should see "the recap is the artefact the customer keeps"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:0081ff5e-2992-4211-a497-a726610d2c4e
  Scenario: All four feature status labels render with their meanings
    # AC4. Four different promises, which a rep working from memory collapses
    # into "yes".
    When I navigate to "/app/offers"
    Then I should see "Feature status"
    And I should see "LIVE"
    And I should see "BETA"
    And I should see "ROADMAP"
    And I should see "NOT INCLUDED"
    And I should see "No date may be promised"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:59eadd8f-0827-4588-93bb-e2c243250f4d
  Scenario: An exception must be approved before it can be communicated
    # AC2, and the ordering is the whole control. Once an exception has been
    # said out loud it has been granted in the customer's mind.
    When I navigate to "/app/offers"
    Then I should see "Discounts and exceptions"
    And I should see "BEFORE it can be communicated"
    And I should see "every approval after that is a negotiation about withdrawing it"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:9768a263-f8e7-49c9-88d0-652c4b94e57b
  Scenario: With no exception requested, nothing beyond the stamped offer may be said
    When I navigate to "/app/offers"
    Then I should see "Nothing beyond the stamped offer may be communicated"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:cbeab2cb-ef35-4ee3-a0df-c5f21d4f3fdc
  Scenario: Requesting an exception blocks communication until it is decided
    When I navigate to "/app/offers"
    And I click "request_exception_approval"
    Then I should see "Awaiting approval"
    And I should see "may not be communicated to the customer yet"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:0c533549-df5d-4ef0-8dca-3b1cf61171a7
  Scenario: The fit summary requires an honest limitation
    # An offer with no stated limitation is not a fit assessment.
    When I navigate to "/app/offers"
    Then I should see "Fit summary"
    And I should see "Honest limitation"
    And I should see "an offer with no stated limitation is not a fit assessment"
