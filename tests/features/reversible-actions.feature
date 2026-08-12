@feature_id:551f63e0-5092-4538-b624-a9f77c549158
@epic_id:00328fe3-4d27-4712-928a-2fa673523c1b
Feature: Reversible actions panel and signed evidence bundle export
  The four reversible operations and the portable evidence package.

  Quoted strings are rendered text and name attributes from
  client/src/features/audit/ReversibleActionsPanel.tsx and
  EvidenceBundleModal.tsx. "export_evidence_bundle" is a name attribute.
  ALL ASSERTED STRINGS ARE ASCII.

  WHAT IS ASSERTED AND WHAT IS NOT. These scenarios assert that all four
  operations are present, that each states it does not delete, that a reversal
  is gated behind naming a subject, and that the bundle declares its signature
  algorithm and its per-section contents. They do NOT assert a computed blast
  radius or a real signature, because both need sdk-audit, sdk-evidence and
  sdk-data-rights and this environment has no gateway credential.

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:2e99fd0a-a815-4d65-a2fe-b325ce42fd71
  Scenario: All four reversible operations are on screen
    When I navigate to "/app/audit"
    Then I should see "Reversible Actions"
    And I should see "Retract identity link"
    And I should see "End relationship"
    And I should see "Withdraw consent"
    And I should see "Start privacy erasure"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:b8a97e64-84d8-48a6-878a-8bd04c92fcd2
  Scenario: Nothing in the panel deletes a row
    # AC2. A system that deletes cannot answer what it looked like before, which
    # is precisely the question a reversal provokes.
    When I navigate to "/app/audit"
    Then I should see "Nothing here deletes a row"
    And I should see "Closes the relationship with a valid_to date rather than deleting the row"
    And I should see "preserving the evidence that consent was once given"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:eec428be-8037-498d-92cf-1ac2aab63716
  Scenario: Each reversal is itself recorded with an actor and a reason
    # AC4. An unexplained reversal in the chain is indistinguishable from the
    # incident it was meant to correct.
    When I navigate to "/app/audit"
    Then I should see "each is itself recorded in the chain with the actor and the reason"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:aa6171c7-9cb8-4c02-accc-082537031829
  Scenario: A reversal cannot be previewed without a subject
    # AC1 depends on it: a reversal with no subject has no blast radius to
    # compute, so offering the preview would produce a confident empty list.
    When I navigate to "/app/audit"
    Then I should see "Name a subject above before previewing a reversal"
    And I should see "A reversal with no subject has no blast radius to compute"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:8a52188d-7b2b-4f67-bd4e-f6724ccbf93c
  Scenario: The evidence bundle names what a recipient needs to verify it
    # AC3. A signature with no named algorithm can only be verified by somebody
    # who already knew how, which is nobody outside.
    When I navigate to "/app/audit"
    And I click "export_evidence_bundle"
    Then I should see "verifies independently, without trusting this system"
    And I should see "Audit chain segment"
    And I should see "Referenced evidence blobs"
    And I should see "Policy bundle versions in force"
    And I should see "Consent receipts"
    And I should see "Trace spans"
