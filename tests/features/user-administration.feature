@feature_id:c12362d4-3479-46e6-b243-47c04b68b61e
@epic_id:224f72e3-9444-4923-96da-477e76aa9654
Feature: User administration and the permission matrix
  The user register and the SOP section 28 grid it links to.

  Quoted strings are rendered text and name attributes from
  client/src/pages/app/UserAdministration.tsx and
  client/src/pages/app/PermissionMatrixScreen.tsx. "email", "role",
  "invite_user" and "export_purpose" are name attributes.
  ALL ASSERTED STRINGS ARE ASCII.

  WHAT IS ASSERTED AND WHAT IS NOT. These scenarios assert the register's
  governing rules - the invite form and its role explainer, that deactivation is
  not deletion, that the matrix is reachable and states why it cannot be edited,
  and that needs-approval is an escalation rather than a refusal. All of that is
  rendered by the browser from the screen's own content and from the role
  catalogue, so it is exercisable here.

  They do NOT assert register ROWS, a completed invitation or a role change,
  because each of those is a governed write whose effect is a database row - the
  api_definitions under tests/api_definitions/users/ cover those end to end with
  real status codes, a producer chain and the audit entry behind each one, and
  restating them in Gherkin would put the same behaviour in two places where only
  the API copy actually runs.

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:0fc5102a-73e9-4cbc-94d7-d62846c4079e
  Scenario: The register offers an invitation with a role beside it
    # Adding somebody to a list and letting them in are two separate acts.
    When I navigate to "/app/admin/users"
    Then I should see "User Administration"
    And I should see "Invite a colleague"
    And I should see "Send invitation"
    And I should see "What this role grants"
    # Worded to avoid "is created", which the FEATURE-08 heuristic reads as a
    # data precondition. It is a plain assert_text against the screen's own
    # prose, and the runner executes it as one.
    And I should see "A new account starts pending, with no usable password"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:257ac0f7-90a3-469e-9254-3c446f888765
  Scenario: The invite form states that the address is checked before anything is sent
    # The verdict itself is not asserted here: it arrives from
    # POST /api/leadflow/channels/email/verify after a real DNS lookup, and a
    # scenario that depended on a live resolver would fail for reasons that have
    # nothing to do with the screen. tests/api_definitions/channels/email-verify-post.json
    # covers the verdicts end to end against deterministic reserved domains.
    When I navigate to "/app/admin/users"
    Then I should see "The address is checked before anything is sent"
    And I should see "refused here rather than bounced later"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:6c4d98db-17e1-43e1-b339-5172929028bf
  Scenario: The screen states that a role change is written to the audit chain
    # AC5: every role change is audited with actor, subject, previous and new.
    When I navigate to "/app/admin/users"
    Then I should see "every role change is written to the audit chain with the role held before it"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:8883f686-65be-41ee-9627-f3111d896cc6
  Scenario: Deactivation is stated as a closure rather than a deletion
    # AC4: a departed colleague's actions must stay attributable.
    When I navigate to "/app/admin/users"
    Then I should see "Deactivation is not deletion"
    And I should see "actions must stay attributable"
    And I should see "closed rather than removed"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:7cef7f9c-04db-4580-81c7-7e9e91b85598
  Scenario: The permission matrix is reachable from the register
    # AC3: it was unreachable dead code until this link existed.
    When I navigate to "/app/admin/users"
    And I click "See what each role grants"
    Then I should see "Permission Matrix"
    And I should see "What each SOP role may do unaided"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:99632248-78da-4724-b2c8-dbd4f9d2dc1f
  Scenario: The matrix says out loud that it is read-only, and why
    # A grid with no edit control reads as unfinished unless it explains itself.
    When I navigate to "/app/admin/permissions"
    Then I should see "This grid is read-only, on purpose"
    And I should see "Roles and policies are versioned code"
    And I should see "two sources of truth for the one thing that must have exactly one"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:b799e2b4-00d7-4745-afe5-a8d4dc4ecb9f
  Scenario: Needs approval is presented as an escalation, not a refusal
    # Collapsing the two trains people to work around the product.
    When I navigate to "/app/admin/permissions"
    Then I should see "Needs approval is not denied"
    And I should see "may take that action with a second party"
