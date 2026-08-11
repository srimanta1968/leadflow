@feature_id:6ce46d15-439d-4f5d-a143-4053c94518fa
@epic_id:2f860885-b8ac-4db6-ba54-62cfa4be5772
Feature: Routing simulation sandbox and fair-share audit
  Replay real leads through a candidate configuration, per SOP P1.

  Quoted strings are rendered text and name attributes from
  client/src/pages/app/RoutingSimulation.tsx. "run_simulation" and
  "window_days" are name attributes. ALL ASSERTED STRINGS ARE ASCII.

  WHAT IS ASSERTED AND WHAT IS NOT. These scenarios assert that the three
  side-effect counters are rendered as a first-class result, that the diff is
  per-rep rather than a total, and that the fair-share audit looks for
  starvation as well as skew. They do NOT assert a completed replay, because
  that needs sdk-assignment, sdk-sla and sdk-analytics and this environment has
  no gateway credential.

  THE ZERO-SIDE-EFFECT CRITERION IS ASSERTED AGAINST THE ENDPOINT, in
  tests/api_definitions/routing/simulate-post.json, because it is a property of
  the RUN and not of the screen. What the screen contributes - and what is
  asserted here - is that the counters are always shown, so the guarantee is
  observable on every run instead of once at review time.

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:0dedddc0-24f2-40a7-b4df-4db8b19e2494
  Scenario: The sandbox states what a run does and does not do
    When I navigate to "/app/routing-simulation"
    Then I should see "Routing Simulation"
    And I should see "assigns nothing, notifies nobody and starts no clock"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:507c77ef-45eb-4ad1-aee5-3b816beb35fc
  Scenario: All three side-effect counters are on screen
    # AC1's visible half. A simulation replays REAL leads, so the only thing
    # between it and re-notifying a hundred people is that these stay at zero.
    When I navigate to "/app/routing-simulation"
    Then I should see "Side effects"
    And I should see "Assignments made"
    And I should see "Notifications sent"
    And I should see "SLA clocks started"
    And I should see "Reported on every run rather than promised once"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:1be4e7ab-849a-4072-9810-01e23b3a39fb
  Scenario: The diff compares actual against simulated per rep
    # AC2. "The new rules assign 40 leads" is useless; who gains and who loses
    # is the decision.
    When I navigate to "/app/routing-simulation"
    Then I should see "Actual versus simulated, per rep"
    And I should see "A total tells you nothing"
    And I should see "Would-be breaches"
    And I should see "Capacity violations"
    And I should see "Specialty match rate"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:ea29daf6-e68a-4b9f-a0f0-51184f923c39
  Scenario: The fair-share audit looks for starvation, not only for skew
    # AC3. Over-allocation is noticed because the rep complains; a starved rep
    # has nothing to complain about and looks like a low performer at review.
    When I navigate to "/app/routing-simulation"
    Then I should see "Fair share audit"
    And I should see "Distribution skew"
    And I should see "Starved reps"
    And I should see "a rep with no leads has"
    And I should see "Rotation health"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:842c36f8-6a3b-4100-9d63-bfe17e3c8c77
  Scenario: Publishing a routing change is approved, versioned and reversible
    # AC4.
    When I navigate to "/app/routing-simulation"
    Then I should see "requires an approval, is versioned and is rollback-able"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:8b24c9fb-759c-4467-b310-b8bd758b2c4d
  Scenario: With no run yet there is nothing to compare, and it says so
    When I navigate to "/app/routing-simulation"
    Then I should see "No simulation has been run yet"
