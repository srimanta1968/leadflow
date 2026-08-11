@feature_id:25a626ba-bd04-4f1b-af70-20694d08dc25
@epic_id:285a56e9-aa8a-46e6-b4cd-0675b52053e5
Feature: Manager, Rep, Marketing, Finance and CS dashboards
  The five role dashboards, per SOP 47 and 20.

  Quoted strings are rendered text and name attributes from
  client/src/pages/app/RoleDashboards.tsx. "role_rep" and "role_finance" are
  name attributes. ALL ASSERTED STRINGS ARE ASCII.

  WHAT IS ASSERTED AND WHAT IS NOT. These scenarios assert that all five roles
  are reachable, that each is its own deep-linkable route, and that every
  dashboard prints the KPI registry it reads. They do NOT assert PANELS or
  metrics, because the panels are returned by the server per role and this
  environment has no gateway credential.

  PANELS ARE SERVER DATA, NOT FIVE COMPONENTS. Building one component per role
  would guarantee that a fix to the SLA tile reaches three of them, and it is
  also why a role gaining a panel needs no frontend release. The consequence
  for testing is that with no server there are no panels, and asserting
  hard-coded panel names here would assert something the product does not do.

  THE PERMISSION CRITERION IS THE SERVER'S ANSWER. The screen renders the PDP's
  refusal rather than deciding in the browser which roles may see which
  dashboard, so the gating is asserted in
  tests/api_definitions/dashboards/role-get.json.

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:18286269-a7a6-4d18-b91c-8f1dc9897e4d
  Scenario: All five role dashboards are reachable
    When I navigate to "/app/dashboards"
    Then I should see "Dashboards"
    And I should see "Manager"
    And I should see "Rep"
    And I should see "Marketing"
    And I should see "Finance"
    And I should see "Customer Success"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:611f7b58-84ed-4b17-92e8-56fd9515d23d
  Scenario: The screen states why five views share one registry
    # AC4. The manager's "response time" being a median over business hours and
    # marketing's a mean over all hours is how every figure becomes negotiable.
    When I navigate to "/app/dashboards"
    Then I should see "one set of registered KPI definitions"
    And I should see "how every figure becomes negotiable"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:a2d9a017-4d2a-40b6-a392-c66e6948e389
  Scenario: Each role dashboard is its own deep-linkable route
    When I navigate to "/app/dashboards/finance"
    Then I should see "Dashboards"
    And I should see "Finance"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:55d8e6bd-a8a4-48ce-94ea-bde0ac46a6ba
  Scenario: Switching role keeps the registry statement on screen
    When I navigate to "/app/dashboards"
    And I click "role_rep"
    Then I should see "Dashboards"
    And I should see "KPI registry"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:ec6156bd-6aa3-4201-ade1-227e6da3772f
  Scenario: An unread registry version is stated rather than assumed
    # Figures cannot be reconciled against a registry nobody read.
    When I navigate to "/app/dashboards"
    Then I should see "Figures cannot be reconciled until it is"
