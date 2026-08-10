@feature_id:528b6e48-8c46-4bcf-b375-4af635eb886e
@epic_id:9b0dd42c-1871-4a47-aae2-ab76e48d0d5c
Feature: Identity Review screen and steward case queue
  The steward's queue for #view-identity: possible-same matches the resolver
  refused to link on its own, ordered the way they should be worked.

  Control labels below are the real ones from
  client/src/pages/app/IdentityReview.tsx, not paraphrases.

  THE SCREEN IS STEWARD-ONLY, hence @login:data_steward rather than the default
  identity. identity.merge_review is held by the Data Steward alone, so the
  default operator - who bridges to sales_rep - correctly receives 403 and would
  see an error toast instead of the screen. Signing in as the wrong person would
  test the policy, not the page.

  ASSERTIONS ARE CONFINED TO WHAT RENDERS WITH NO CASES, deliberately. Nothing
  in LeadFlow creates a candidate link - they are raised inside
  sdk-identity-resolver - so in any environment without a populated EMPI the
  table body is empty. Asserting on a risk chip or the "not auto-linkable"
  annotation would be asserting on rows that cannot exist here, which is how a
  green suite starts lying. The row treatments are held by the api_definition
  instead, where the sort and the SLA flag are computed.

  ALL ASSERTED STRINGS ARE ASCII. A non-ASCII byte anywhere in the posted body
  makes the Test MCP reject the feature with a 400 the caller swallows, so the
  run comes back empty rather than failed. The hero sentence continues past an
  em dash; the clause before it carries the meaning and is asserted alone.

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:data_steward
  @scenario_id:6db3d561-ab49-4b03-9f3d-9bf98f44d595
  Scenario: The queue states that merge is unavailable, not merely absent
    # The epic's whole premise. An absence nobody documents reads as an
    # oversight rather than a decision, and a steward who assumes a merge button
    # is hidden somewhere will go looking for it.
    When I navigate to "/app/identity"
    Then I should see "Identity Review"
    And I should see "Link-over-merge stewardship."
    And I should see "Destructive merge is unavailable"
    And I should see "verified or retracted"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:data_steward
  @scenario_id:b178d381-3b69-490e-ba72-903af82b97d2
  Scenario: All six tiles from the mockup are present with their captions
    When I navigate to "/app/identity"
    Then I should see "Review Cases"
    And I should see "Exact Auto-Links"
    And I should see "Crosswalk or deterministic exact match"
    And I should see "Kept Separate"
    And I should see "Retracted Links"
    And I should see "Replayed downstream projections"
    And I should see "Median Review"
    And I should see "Resolver Calibration"
    And I should see "High-risk precision benchmark"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:data_steward
  @scenario_id:9554dce1-a108-426f-ba79-5f1faa0441df
  Scenario: A tile with no upstream metric says so instead of showing zero
    # Three of the six tiles have no metric behind them - EmpiMetrics carries no
    # count of exact auto-links, no time-bounded kept-separate figure and no
    # adjudication latency at all. A zero would be read as "none happened",
    # which is a different and false claim. Median Review is the one worth
    # refusing hardest: the obvious substitute is the median age of OPEN cases,
    # which reads as a service level while measuring its inverse.
    When I navigate to "/app/identity"
    Then I should see "Not measured"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:data_steward
  @scenario_id:404cc903-1c7c-4f57-b0e6-9561bd038daa
  Scenario: An empty queue always says WHY it is empty
    # One stem, two endings, so the assertion holds whichever branch renders.
    # "Nothing to review" during a resolver outage is the message that stops an
    # operator looking, which is why the screen never says it on its own.
    When I navigate to "/app/identity"
    Then I should see "No cases to review"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:data_steward
  @scenario_id:ae83cd79-eb4f-43b7-83e6-bcdeae32374a
  Scenario: The risk filter is offered as bands, not as a free text search
    # Filtering happens on the SERVER so the tiles and the rows describe the
    # same slice. A client-side filter would leave the counters describing a
    # queue the table is no longer showing.
    When I navigate to "/app/identity"
    Then I should see "All risk"
    When I click "Medium"
    Then I should see "No cases to review"
