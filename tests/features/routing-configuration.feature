@feature_id:08798a01-43c6-42ce-8f82-b24848e38fca
@epic_id:2f860885-b8ac-4db6-ba54-62cfa4be5772
Feature: Routing rule configuration and the six-step decision engine
  The routing configuration screen and its decision trace, per SOP 30.

  Quoted strings are rendered text and name attributes from
  client/src/pages/app/RoutingConfiguration.tsx. "open_decision_trace" and
  "read_trace" are name attributes. ALL ASSERTED STRINGS ARE ASCII.

  WHAT IS ASSERTED AND WHAT IS NOT. These scenarios assert the six steps in
  order, the four SOP priority bands with their definitions, the seven
  specialty dimensions, the review-queue rule and the publish gate. They do NOT
  assert a real trace for a real lead, because the trace comes from
  sdk-assignment and sdk-audit and this environment has no gateway credential.

  THE SIX STEPS AND THE FOUR BANDS RENDER FROM CONSTANTS, deliberately, so the
  screen can state WHAT the engine does even when it cannot reach the engine.
  An operator opening this during an outage still needs to know the order.

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:ddeb8f22-7a3e-4437-bbbe-89f8ab3d3e0b
  Scenario: The screen states the promise the trace has to keep
    When I navigate to "/app/routing-config"
    Then I should see "Routing Configuration"
    And I should see "Every assignment can be explained back to a rep"
    And I should see "a lead the rules cannot resolve goes to review"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:d1c39b03-180c-4c2b-858c-bbbd341f8d6b
  Scenario: All six steps are named in evaluation order
    # AC1. "Step 4 filtered" is not an explanation and a manager cannot repeat
    # it to a rep.
    When I navigate to "/app/routing-config"
    Then I should see "The six-step decision engine"
    And I should see "Eligibility"
    And I should see "Priority band"
    And I should see "Coverage"
    And I should see "Specialty match"
    And I should see "Capacity"
    And I should see "Rotation"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:d47261d0-4e41-47a7-9d37-1d2acdfd270b
  Scenario: The four priority bands carry the SOP definitions exactly
    # AC4. A local re-interpretation is how P0 stops meaning a verified purchase
    # and starts meaning whatever felt urgent.
    When I navigate to "/app/routing-config"
    Then I should see "Verified purchase"
    And I should see "Form, demo, pricing or checkout intent"
    And I should see "Active social engagement or referral"
    And I should see "Nurture or content"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:5997d0cf-f35b-4d59-85a9-41b22732acd3
  Scenario: All seven specialty dimensions are configurable
    When I navigate to "/app/routing-config"
    Then I should see "Specialty matchers"
    And I should see "Segment"
    And I should see "Geography"
    And I should see "Language"
    And I should see "Partner"
    And I should see "Product need"
    And I should see "Conflict rules"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:5c3108ae-4e37-4736-9514-312a45394b65
  Scenario: An ambiguous lead goes to review, never to a forced assignment
    # AC2. A forced assignment produces an owner who does not know why they own
    # it; a review queue produces one visible decision.
    When I navigate to "/app/routing-config"
    Then I should see "Review queue"
    And I should see "never force-assigned"
    And I should see "an owner who does not know why they own it"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:2c5008ef-926d-4cef-ae87-fabaacd05ff7
  Scenario: Publishing a routing change needs an approval
    # AC3. A routing change silently redirects revenue, and the person best
    # placed to catch a mistake is not the one making it.
    When I navigate to "/app/routing-config"
    Then I should see "Request publish approval"
    And I should see "Publishing requires an approval and is rollback-able"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:5551a8e3-e89a-4156-a88a-35f68cfdb99e
  Scenario: The decision trace is opened per lead
    When I navigate to "/app/routing-config"
    And I click "open_decision_trace"
    Then I should see "Why this lead went to this rep, one step at a time"
    And I should see "Lead reference"
