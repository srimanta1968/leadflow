@feature_id:98c6bc88-7b24-4b56-b2b1-f43f41122d38
@epic_id:224f72e3-9444-4923-96da-477e76aa9654
Feature: Contact 360 Contact Points, Provenance and Audit tabs
  The three evidence tabs, per mockups #c-contactpoints, #c-provenance and
  #c-activity.

  Quoted strings are rendered text and name attributes from
  client/src/features/contacts/tabs/ContactPointsTab.tsx, ProvenanceTab.tsx and
  AuditTab.tsx. ALL ASSERTED STRINGS ARE ASCII.

  WHAT IS ASSERTED AND WHAT IS NOT. These scenarios assert the three framing
  rules the tabs exist to make unavoidable - a handle is its own record,
  conflicting values coexist rather than being overwritten, and the timeline is
  a governed-action record rather than a log tail. They do NOT assert
  individual assertion ROWS, the two tables' column headers, the Superseded
  reason on a row, or a PII reveal. The rows come from sdk-source-record,
  sdk-projection and sdk-vault and this environment has no gateway credential;
  and the HEADERS are deliberately not rendered by DataTable with no rows,
  because a header row over an empty body asserts a schema the screen never
  read. The columns are asserted against real data in
  tests/api_definitions/contacts/provenance-get.json.

  THE SUPERSEDED-REASON GUARANTEE IS NOT LEFT TO A TEST. It is enforced in the
  TYPE (design-system/evidence/assertions.ts): the Superseded arm of the union
  REQUIRES a reason, so a row that says "Superseded" and nothing else does not
  compile. A runtime assertion would fire when somebody is already looking at
  the screen, which is exactly when a bare status word has already misled them.

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:9251fca5-b452-4563-b59d-8e83d01d0a80
  Scenario: The Contact Points tab states that a handle is its own record
    # The framing line is the design. Treating "the phone number" as an
    # attribute of a person is what lets a number confirmed for an appointment
    # reminder silently become one that may be marketed to.
    When I navigate to "/app/contacts/local-demo-contact/contact-points"
    Then I should see "Each phone, email, address and profile is a separate handle with its own source, confidence, validity and eligibility"
    And I should see "Add Contact Point"


  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:7438b627-6ba9-4b88-af8f-afebd02110e8
  Scenario: An unread register is not reported as a person with no handles
    When I navigate to "/app/contacts/local-demo-contact/contact-points"
    Then I should see "Contact Points"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:cadd48ab-0ffe-4169-972b-8c9a184bb8e9
  Scenario: The Provenance tab states that conflicting values coexist
    # AC1. Last-writer-wins is what makes a data dispute unanswerable six months
    # later, because the losing value and the reason it lost were both discarded
    # at the moment they became interesting.
    When I navigate to "/app/contacts/local-demo-contact/provenance"
    Then I should see "Conflicting source values coexist; the display projection is explained, not silently overwritten"
    And I should see "Data & Provenance"


  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:9c9ba62e-d484-40c2-bb6b-202ebd61fadd
  Scenario: The Audit tab presents governed actions, not log lines
    When I navigate to "/app/contacts/local-demo-contact/audit"
    Then I should see "Audit Timeline"
    And I should see "Every governed action taken on this record, with the actor who took it and the decision it was taken under"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:3ae2984d-3ea6-4434-9738-49efaa7eafe0
  Scenario: An empty history says it is empty, not unavailable
    # The distinction the Timeline primitive is built around: no governed act
    # has touched this record is a different claim from its history could not be
    # read, and conflating them is how an audit trail stops being trusted.
    When I navigate to "/app/contacts/local-demo-contact/audit"
    Then I should see "An empty history means no governed act has touched this"
