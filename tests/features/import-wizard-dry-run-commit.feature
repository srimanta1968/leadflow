@feature_id:9d4bf61a-01d8-4ce2-8162-9507e7b16219
@epic_id:8eca7fd1-6541-4863-81ec-bf170938403d
Feature: Import wizard step 10 - Dry run, governance checks and commit
  The last of the ten steps: rehearse the whole import, show what it would do,
  then land it in one atomic batch - or refuse to.

  Control labels below are the real ones from
  client/src/components/app/ImportWizardModal.tsx and
  client/src/content/importGovernance.ts, not paraphrases.

  THE CENTRAL RULE IS THAT COMMIT IS A GATE, NOT A BUTTON. It is disabled until
  every governance check is Pass or an explicitly acknowledged Review - and a
  FAILED check cannot be acknowledged at all. The distinction is the point:
  "nobody attested to this data" is a missing prerequisite, not a risk somebody
  may accept on a checkbox. Acknowledgement is per check and by name, because a
  single "I have read the warnings" tick is a decision with no owner and no
  record of which warning was accepted.

  THE CHECKS ARE DERIVED FROM THE EARLIER STEPS, not asserted here - a check
  that cannot fail is decoration. Skipping the attestation on step 4 turns the
  first check red; leaving columns unconfirmed on step 5 turns the second amber.

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  Scenario: Commit is blocked while the attestation is missing
    # Reaching step 10 without signing step 4 must not be committable, and the
    # screen must say which check blocks it and that it cannot be waved through.
    When I navigate to "/app/import"
    And I click "Start Import"
    And I click "2. Connect"
    And I click "Load sample CSV"
    And I click "10. Commit"
    Then I should see "Dry Run & Commit"
    And I should see "Governance Checks"
    And I should see "Source attestation signed"
    And I should see "Nobody has attested to the origin of this data. Go back to step 4."
    And I should see "Commit is blocked"
    And I should see "A blocked check cannot be acknowledged"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  Scenario: The dry run states plainly that it writes nothing
    When I navigate to "/app/import"
    And I click "Start Import"
    And I click "2. Connect"
    And I click "Load sample CSV"
    And I click "10. Commit"
    Then I should see "A dry run performs ZERO writes."
    And I should see "Nothing is created, linked, suppressed or sent"
    When I click "Run dry run"
    Then I should see "Dry run complete. 0 writes observed."

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  Scenario: The exception file is available before the commit, not after
    # The operator has to be able to see what would be dropped while they can
    # still change it. Offering it only after the commit is offering a receipt
    # for a decision already taken.
    When I navigate to "/app/import"
    And I click "Start Import"
    And I click "2. Connect"
    And I click "Load sample CSV"
    And I click "10. Commit"
    And I click "Run dry run"
    Then I should see "Download dry-run exceptions"
    And I should see "Invalid Rows"
    And I should see "to the exception file"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  Scenario: The impact grid and commit plan are stated before committing
    When I navigate to "/app/import"
    And I click "Start Import"
    And I click "2. Connect"
    And I click "Load sample CSV"
    And I click "10. Commit"
    Then I should see "New Contacts"
    And I should see "Exact Links"
    And I should see "Review Cases"
    And I should see "Rollback Window"
    # Em dash in the tile caption; the clause after it is the assertion that
    # actually matters and is ASCII.
    And I should see "an import never spends one"
    And I should see "Commit Plan"
    And I should see "It lands whole or not at all"
    And I should see "Idempotent on run id + file fingerprint + source crosswalk"
    # AC4 - the rollback closes on a downstream action, not only on the clock.
    And I should see "the moment a downstream governed action occurs"
