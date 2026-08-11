@feature_id:14f9e5bb-a805-410f-a34c-d0cfef2fc212
@epic_id:00328fe3-4d27-4712-928a-2fa673523c1b
Feature: Audit and History screen and correlated evidence timeline
  Evidence, causality and reversibility, per mockup #view-audit.

  Quoted strings are rendered text and name attributes from
  client/src/pages/app/AuditHistory.tsx. "subject_ref" and "read_chain" are
  name attributes. ALL ASSERTED STRINGS ARE ASCII.

  WHAT IS ASSERTED AND WHAT IS NOT. These scenarios assert the screen's shape
  and the rule it is built on - nothing is read until a subject is named, and
  all four correlation references are present. They do NOT assert timeline
  ENTRIES or resolved correlation ids, because the chain comes from sdk-audit,
  sdk-trace, sdk-evidence and sdk-policy and this environment has no gateway
  credential.

  ONE OF THIS FEATURE'S CRITERIA IS KNOWN TO BE UNMEETABLE HERE and is recorded
  as such rather than papered over: sdk-trace is not provisioned against a
  LeadFlow tenant in any reachable environment, so the span half of the
  correlation panel resolves to nothing on every read. The row still renders,
  and renders as UNRESOLVED, which is the honest state.

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:39ce2f2a-ed44-4a80-afa8-f336c9f29aec
  Scenario: The screen frames itself as evidence rather than as logging
    When I navigate to "/app/audit"
    Then I should see "Audit & History"
    And I should see "Evidence, causality and reversibility"
    And I should see "Advanced query"
    And I should see "Export evidence bundle"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:8a509ea7-f808-42de-b5b4-cf97af1644db
  Scenario: Nothing is read until a subject is named
    # An audit query with no subject returns either an arbitrary window or
    # somebody else's events, and both look like an answer.
    When I navigate to "/app/audit"
    Then I should see "Subject reference"
    And I should see "Nothing is read until a subject is named"
    And I should see "Name a subject above to read its evidence timeline"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:ce85ccf7-2d7a-43cf-aa65-e9f9ba332362
  Scenario: The timeline promises the four things an entry must carry
    # AC1 and AC2. A log tail answers "what happened" in the order the machine
    # wrote it; this answers who, under what authority, and what can be quoted.
    When I navigate to "/app/audit"
    Then I should see "Contact Evidence Timeline"
    And I should see "who did it, the reference you can quote and the policy decision it was taken under"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:cfabd298-fe85-48f9-a82a-ee934bd75466
  Scenario: All four correlation references are on screen
    # AC3. Each resolves independently, which is what turns an entry from an
    # assertion into evidence.
    When I navigate to "/app/audit"
    Then I should see "Correlation Context"
    And I should see "Canonical Entity"
    And I should see "Trace / Causation"
    And I should see "Policy Bundle"
    And I should see "Consent Epoch"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:1227c4a8-1c17-4d30-a7d3-35ac1c71b543
  Scenario: Each correlation row carries the note the mockup gives it
    When I navigate to "/app/audit"
    Then I should see "MDM write kernel"
    And I should see "Browser to workflow to MDM"
    And I should see "Decision references preserved"
    And I should see "Current at latest action"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:09edaca7-9a0d-4e18-813f-dd1cd8abe721
  Scenario: An unresolved reference says so rather than showing a blank
    # The trace row is genuinely unresolvable in this environment. Rendering it
    # blank would read as "no trace was involved" rather than "no trace store
    # was reachable".
    When I navigate to "/app/audit"
    Then I should see "Not resolved"
