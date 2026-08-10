@feature_id:d62b7a8f-4de4-45c2-b59d-ee4baac4f73d
@epic_id:f7ad7bf2-adea-4b22-b822-510caca24406
Feature: Capture Consent modal with signature evidence
  #consentModal, opened from the Consent and Preferences screen.

  Control labels below are the real ones from
  client/src/components/app/CaptureConsentModal.tsx, not paraphrases.

  PRIVACY-OFFICER ONLY, hence @login:privacy_officer. consent.purpose_manage is
  held by privacy_officer alone and the local role privacy bridges to it, so a
  data steward and an admin both receive 403 on the screen behind this modal.

  SCENARIO TITLES ARE DELIBERATELY SPECIFIC. Sync resolves by title ACROSS the
  whole project, and a generic title has already tried to move a scenario off
  another feature once in this project. Every title here names this modal.

  ALL ASSERTED STRINGS ARE ASCII, and none contains a substring the runner
  dispatches on - "enter" inside a word routes an assertion to the fill rule.

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:privacy_officer
  @scenario_id:9c2ca6f0-e30c-451f-97bb-1ec3d5fdfd7f
  Scenario: The capture modal states that a receipt does not bypass suppression
    # The framing line from the mockup, and the honest limit of what a receipt
    # is. Consent permits a purpose; it does not override a suppression, and an
    # operator who believes otherwise will wonder why a send was blocked.
    When I navigate to "/app/consent"
    And I click "Capture Consent"
    Then I should see "Capture Consent"
    And I should see "it does not bypass authorization or suppression."
    And I should see "Final channel authorization is re-evaluated at use time."

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:privacy_officer
  @scenario_id:9fd890e3-cc2d-480d-9277-105cdc9b8d61
  Scenario: The capture modal allows exactly one processing purpose
    # AC1. The purposes are radio inputs, so two cannot be chosen - blanket
    # consent is not expressible on the screen rather than rejected afterwards.
    # sdk-consent's grant takes a singular purpose_id, so a multi-purpose
    # receipt cannot exist upstream either.
    When I navigate to "/app/consent"
    And I click "Capture Consent"
    Then I should see "Processing purpose"
    And I should see "One purpose per receipt."
    And I should see "A receipt covering several purposes is not a consent anyone gave."

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:privacy_officer
  @scenario_id:8844734c-a0ed-44a5-82b9-faed1e5331d1
  Scenario: The capture modal keeps promotional offers out of the channel list
    # AC4. Promotional offers is the permission people most often did not intend
    # to give. As a channel checkbox under a service purpose, somebody agrees to
    # job updates and lands on a marketing list; as its own purpose it needs its
    # own receipt and its own signature.
    When I navigate to "/app/consent"
    And I click "Capture Consent"
    Then I should see "Promotional offers"
    And I should see "Separate purpose"
    And I should see "Promotional offers is not listed here"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:privacy_officer
  @scenario_id:160c269c-c994-4f00-9c6a-142b9fe0eb0e
  Scenario: The capture modal records the notice as shown, not as named
    # AC3. The hash covers the displayed words and language rather than a
    # template id, because templates change and the one on file today may not be
    # what was on the screen that day.
    When I navigate to "/app/consent"
    And I click "Capture Consent"
    Then I should see "Notice"
    And I should see "The hash covers the words shown above, not a template name."
    And I should see "Reviewed and understood."

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:privacy_officer
  @scenario_id:2fa74eaf-db67-483d-9540-890a37b44e1d
  Scenario: The capture modal says the signature is evidence and not searchable
    # AC2. The guarantee is stated on the screen, not only enforced on the
    # server - a protection the operator cannot see is one they cannot rely on.
    When I navigate to "/app/consent"
    And I click "Capture Consent"
    Then I should see "Signature"
    And I should see "The signature image is evidence."
    And I should see "not included in ordinary contact search."
