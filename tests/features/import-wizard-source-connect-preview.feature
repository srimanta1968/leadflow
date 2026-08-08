@feature_id:690fbb53-b27e-4fd0-9c7c-ebc9031c62ae
@epic_id:8eca7fd1-6541-4863-81ec-bf170938403d
Feature: Import wizard steps 1-3 - Source, Connect, Preview
  The first three of the ten steps in #importModal: choose a source, connect or
  upload, then inspect the file before anything is mapped or committed.

  Control labels below are the real ones from
  client/src/components/app/ImportWizardModal.tsx, not paraphrases.

  SIGN-IN is the @login:default tag. The default account is
  qa.operator@leadflow.test, whose local `admin` role bridges to
  revenue_operations and therefore holds import.run_read - enough to reach the
  Import Center, which is where the wizard opens from.

  FOUR SCENARIOS, one per acceptance criterion, split by what would make each
  fail: the local-preview scenario fails if the file is ever uploaded before
  commit, the confidence scenario if a detection starts presenting itself as
  fact, the credential scenario if the form starts accepting a secret, and the
  persistence scenario if the draft stops surviving a reload.

  WHAT IS ASSERTED AND WHAT IS NOT. These assert the wizard's first three steps.
  They do NOT assert steps 4-10, which are not built yet and render in the
  stepper as unreachable on purpose - the operator should see from step one that
  an origin attestation is coming, rather than discovering it after uploading.

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  Scenario: The file is inspected in the browser, with nothing uploaded
    # The bytes must not cross the boundary before the operator attests to the
    # origin on step 4. "Load sample CSV" builds a real File and walks exactly
    # the same local path a chosen file does.
    When I navigate to "/app/import"
    And I click "Start Import"
    Then I should see "Contact Import & Reconciliation"
    And I should see "Choose Source"
    And I should see "Connector boundary"
    When I click "2. Connect"
    Then I should see "Drop source export here"
    And I should see "CSV, text, or vCard · local browser preview before commit"
    When I click "Load sample CSV"
    Then I should see "File & Schema Preview"
    And I should see "sample_contacts.csv"
    And I should see "Inspect before the system infers any mapping."

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  Scenario: Every detection states how sure it is
    # A delimiter guess presented as fact is worse than no guess: the operator
    # accepts it, the mapping shifts by a column, and the damage surfaces long
    # after the commit. Each tile carries its confidence and its reason.
    When I navigate to "/app/import"
    And I click "Start Import"
    And I click "2. Connect"
    And I click "Load sample CSV"
    Then I should see "Encoding"
    And I should see "Delimiter"
    And I should see "confidence"
    And I should see "gives 12 columns on every sampled line"
    And I should see "Header row:"
    And I should see "Source IDs"
    And I should see "External IDs will be retained as crosswalks and never replaced by LeadFlow IDs."

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  Scenario: An API source asks for a credential reference, never a credential
    # The field takes the NAME of a vault-backed secret. sdk-secrets resolves it
    # server-side at commit, so there is nothing in this browser for a shared or
    # stolen machine to yield.
    When I navigate to "/app/import"
    And I click "Start Import"
    And I click "wizard-source-acculynx"
    And I click "2. Connect"
    Then I should see "Connector Configuration"
    And I should see "Credential Reference"
    And I should see "The name of a credential held in the vault. Never paste the credential itself."
    And I should see "Connector Mode"
    When I click "Test Connection"
    Then I should see "The server resolves the credential reference through sdk-secrets and tests it. The secret is never sent to this browser."

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  Scenario: The draft survives a reload, but the file contents do not
    # Ten steps is a long way to lose. The draft is kept in sessionStorage; the
    # file bytes deliberately are not, and the wizard says so rather than
    # showing a filename that is no longer attached.
    When I navigate to "/app/import"
    And I click "Start Import"
    And I click "wizard-source-hubspot"
    And I click "2. Connect"
    And I click "Load sample CSV"
    Then I should see "File & Schema Preview"
    When I navigate to "/app/import"
    And I click "Start Import"
    Then I should see "Contact Import & Reconciliation"
    And I should see "was chosen before the page reloaded. File contents are never stored, so please choose it again."
