@feature_id:ddeaf926-beaf-4e2f-95f8-c4b0c317c8a4
@epic_id:f7ad7bf2-adea-4b22-b822-510caca24406
Feature: Consent and Preferences screen
  Purpose-specific permission and suppression, per mockup #view-consent.

  Control labels below are the real ones from
  client/src/pages/app/ConsentPreferences.tsx, not paraphrases.

  THE SCREEN IS PRIVACY-OFFICER ONLY, hence @login:privacy_officer.
  consent.purpose_manage is held by privacy_officer alone and the local role
  privacy bridges to it, so a data steward and an admin both receive 403 and
  would see an error toast rather than the screen. Verified: 200 as the privacy
  officer, 403 as both of the others.

  ALL ASSERTED STRINGS ARE ASCII. A non-ASCII byte anywhere in the posted body
  makes the Test MCP reject the feature with a 400 the caller swallows, so the
  run comes back empty rather than failed. The hero sentence continues past an
  em dash and the clause before it is asserted alone.

  ASSERTIONS AVOID THE SUBSTRING TRAPS. The runner dispatches on a substring
  search over the WHOLE step line, and "enter" inside a word routes an assertion
  to the fill rule. Nothing asserted here contains it.

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:privacy_officer
  @scenario_id:70204d37-1dd0-4f9e-8e1d-2bd853a885c2
  Scenario: The screen states that a receipt does not guarantee a send
    # The callout the mockup asks for, and the whole point of the screen: a
    # receipt permits a purpose, policy still decides at send time. A reader who
    # takes a green Active chip as permission to message has misread it.
    When I navigate to "/app/consent"
    Then I should see "Consent"
    And I should see "Purpose-specific permission and suppression."
    And I should see "Policy makes the final decision."
    And I should see "A receipt permits a purpose; it does not guarantee a send."

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:privacy_officer
  @scenario_id:fd77f639-1f8c-47b9-afe4-c2b2661b4026
  Scenario: The consent KPI rail carries all six tiles from the mockup
    # Titled distinctly on purpose. The generic form collided with the Identity
    # Review scenario of the same name, and sync resolves by title ACROSS the
    # project - a dry run showed it would have MOVED that scenario off the
    # identity feature and onto this one, silently stealing its coverage.
    When I navigate to "/app/consent"
    Then I should see "Active Receipts"
    And I should see "Expiring Soon"
    And I should see "Revoked"
    And I should see "SMS Permitted"
    And I should see "Campaign-specific eligibility varies"
    And I should see "Email Permitted"
    And I should see "DNC / Suppressed"
    And I should see "Tenant and purpose specific"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:privacy_officer
  @scenario_id:54ac5da2-b4b4-4d22-b319-6ec69d6a8fda
  Scenario: The expiring window defaults to 30 days and is configurable
    # AC1. The default is asserted through the tile caption, which reads the
    # value the SERVER echoed back rather than the local state, so this fails if
    # the two ever disagree.
    When I navigate to "/app/consent"
    Then I should see "Within 30 days"
    And I should see "Expiring window"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:privacy_officer
  @scenario_id:0d90c766-c34b-46d4-b138-5ff756c4868c
  Scenario: The purpose taxonomy says it cannot be listed rather than inventing one
    # AC4. sdk-consent exposes only a POST to register a purpose, so the
    # registry cannot be read back. Rendering the mockup's chips from a local
    # constant is exactly what this criterion forbids, and it would drift
    # silently the moment a tenant registered a purpose nobody anticipated.
    When I navigate to "/app/consent"
    Then I should see "Purpose Taxonomy"
    And I should see "The registered purpose taxonomy cannot be listed."

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:privacy_officer
  @scenario_id:2cb03d8d-a91b-4ed2-ba67-e49c76872237
  Scenario: Suppression controls report every channel and whether it reconciled
    # AC2. A count and its reconciliation state are shown together, because a
    # suppression list that has drifted from the provider is the condition under
    # which somebody gets messaged after opting out.
    When I navigate to "/app/consent"
    Then I should see "Suppression Controls"
    And I should see "Reconciled with provider"
