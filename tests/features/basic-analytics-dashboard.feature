@feature_id:a63a3ca6-90ba-43fc-b342-1de04bfa8350
@epic_id:8f1ff867-089c-40e7-b889-0fd4b06ac1f0
Feature: Basic Analytics Dashboard
  Insight into lead response times and conversion rates.

  Field names below are the real `name` attributes from
  client/src/pages/app/Analytics.tsx (from, to, source, owner_user_id) and the
  sign-in fields from client/src/pages/auth/SignIn.tsx - not human-friendly
  labels.

  The scenarios were rewritten from prose. The original steps ("The user
  navigates to the analytics dashboard") are not executable: the BDD runner runs
  navigate / fill / click / select / should-see / login only, and an unsupported
  step aborts the WHOLE file rather than skipping the one scenario.

  Navigation into the app is by CLICKING the sidebar, not by navigating to
  /app/analytics directly. Both work, but the click also proves the screen is
  reachable from the shell, which is how an operator actually gets there.

  FILTER vs SORT: the four filters (from, to, source, owner_user_id) are query
  parameters - narrowing the window changes the aggregate itself, so each one
  costs a request. The column sort and the daily order are applied to what has
  already been fetched, because by_source is fourteen rows at most and a round
  trip per column click would be pure latency. "Clear filters" resets both and
  also forgets the stored view, so the choice does not come straight back on the
  next visit.

  The ordering rules themselves - that a channel with nothing answered sorts
  last in BOTH directions rather than as the fastest or the slowest, and that
  ties break deterministically so equal rows do not reshuffle under a push
  event - are asserted in client/tests/unit/analyticsView.test.ts. A browser
  test can prove the control responds; it cannot pin down where a null belongs.

  COVERAGE NOTE: the correctness of the numbers - that the breach rate counts
  only closed clocks, that a rate with no denominator is null rather than zero,
  and that response time is measured from arrival - is asserted where it can be
  asserted precisely, against a controlled historical window:
  server/tests/integration/analytics.test.ts (28 cases) and
  tests/api_definitions/analytics/overview-get.json. A browser test cannot pin
  those down, because the dashboard renders whatever the database currently
  holds.

  COVERAGE NOTE, "Data updates in real-time": the scenario below proves the two
  push-refreshed panels RENDER. It does NOT prove they REFRESH, and saying so is
  the point of this note. The screen subscribes to /api/events/stream and
  re-reads on a push (coalesced at 400ms, so a sweep routing fifty leads is one
  query not fifty), and the "Live" indicator appears only once a real data frame
  has arrived - not on connect, and not on a heartbeat comment frame. A linear
  single-tab BDD run cannot produce that frame: the event would have to arrive
  while Analytics is already mounted, and the runner has one tab and no way to
  act as a second operator. The stream itself is covered by
  server/tests/unit/eventStream.test.ts and its api_definition is declared
  manual for the same reason. So the refresh path is implemented and reviewed
  but has no executable artifact, and this criterion is reported partial rather
  than covered.

  "Target attainment" is the ProjexCloud sdk-sla contribution to this screen.
  The step below proves the line RENDERS; which of its two readings appears
  depends on whether a gateway is configured, and no gateway is reachable in
  this environment, so the delivered-from-sdk-sla wording is proven instead by
  the stubbed attainment cases in server/tests/integration/analytics.test.ts.

  SIGN-IN is the @login:default tag, not a Background block. The runner only
  attaches steps after it has seen a Scenario: line, so the hand-written
  Background this file used to carry was parsed into nothing - every scenario
  below ran SIGNED OUT and asserted against the marketing site. The tag runs the
  flow from tests/config/test-config.json loginConfig, which is the same four
  steps (/signin, email, password, "Sign in", then "Capture Inbox"), so nothing
  is lost by deleting them and they stop drifting from the real sign-in screen.

  @scenario_id:e377ca3c-a942-4178-9cf3-fe5c37b2ba6c
  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  Scenario: Dashboard displays key metrics accurately.
    When I click "Analytics"
    Then I should see "Response times and conversion across the capture funnel"
    And I should see "Captured"
    And I should see "Median response"
    And I should see "90th percentile"
    And I should see "Breach rate"
    And I should see "Target attainment"

  @scenario_id:1fca44d2-b06d-4171-a568-3db7d14e77cd
  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  Scenario: Data updates in real-time.
    When I click "Analytics"
    Then I should see "Conversion funnel"
    And I should see "Daily volume"

  @scenario_id:e8fb6134-622e-4586-bb50-2b54f8710354
  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  Scenario: Users can filter data by various parameters.
    When I click "Analytics"
    Then I should see "By source"
    When I select "Live chat" from "source"
    Then I should see "By source"
    When I click "Avg response"
    Then I should see "By source"
    When I click "Newest first"
    Then I should see "Oldest first"
    When I click "Clear filters"
    Then I should see "Filters cleared"
