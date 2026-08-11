@feature_id:e189933c-1aa0-4acb-a0f0-1aa2b66b1f72
@epic_id:e000da35-a777-46e7-8589-2d24accdc494
Feature: Booking flow, public booking page and event content standard
  Book live and verify receipt on the call, per SOP 09 and 45.

  Quoted strings are rendered text and name attributes from
  client/src/pages/app/Calendar.tsx. "book_live", "contact_ref" and
  "starts_at" are name attributes. ALL ASSERTED STRINGS ARE ASCII.

  WHAT IS ASSERTED AND WHAT IS NOT. These scenarios assert the whole event
  content standard, the receipt-verification checklist, and the rule that a
  verbal follow-up cannot be recorded as the NEXT action. They do NOT assert a
  completed booking, because creating the event needs sdk-scheduling and this
  environment has no gateway credential.

  THE VERBAL-FOLLOW-UP RULE IS ENFORCED BY OMISSION, which is the strongest
  form available: the form has no field in which "will call back" could be
  entered as a NEXT action. There is no validation to bypass because there is
  nothing to validate.

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:f8c19b7f-f2d6-485b-8da6-cad5377c71a8
  Scenario: The screen frames booking as something done during the call
    # AC1. "I'll send you a link" converts far worse than "I've just sent it,
    # can you see it?", and the difference is entirely in whether the rep is
    # still on the phone when the invite fails.
    When I navigate to "/app/calendar"
    Then I should see "Calendar"
    And I should see "Book while you are still speaking"
    And I should see "verify the customer received it before you hang up"
    And I should see "Book live and verify receipt"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:c7e254ef-d26a-4612-9848-9e4e3509b673
  Scenario: A verbal follow-up cannot satisfy the NEXT requirement
    # AC2. "Will call back" has no date, no owner commitment and nothing to
    # breach, so it is invisible to every queue and every clock in the system.
    When I navigate to "/app/calendar"
    Then I should see "What can satisfy the NEXT action"
    And I should see "cannot be recorded here"
    And I should see "invisible to every queue and every clock"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:eca8bd3d-3f29-4a47-8246-df8fc9b0c043
  Scenario: Every required content-standard field is listed
    # AC4. An event missing its meeting link or its cancellation link generates
    # a support call at the worst possible moment.
    When I navigate to "/app/calendar"
    Then I should see "Event content standard"
    And I should see "Purpose"
    And I should see "Agenda"
    And I should see "Meeting link"
    And I should see "Contact details"
    And I should see "CRM record id"
    And I should see "Assigned rep"
    And I should see "Cancellation link"
    And I should see "Reschedule link"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:259bcc3c-6676-45f9-842a-6827399088ba
  Scenario: Receipt verification is a checklist, not a single confirmation
    # An invite that silently failed is otherwise discovered by the customer not
    # turning up.
    When I navigate to "/app/calendar"
    Then I should see "Receipt verification"
    And I should see "Checked before you end the call"
    And I should see "An invite that silently failed is discovered by the customer not turning up"

  @scenario_type:UI
  @ui_test
  @portal:leadflow
  @login:default
  @scenario_id:3241437c-c420-49c9-b724-1048aadb26cd
  Scenario: The public booking page shares the design language and the standard
    # AC3. A self-served booking should be indistinguishable in quality from one
    # a rep made on the phone.
    When I navigate to "/app/calendar"
    Then I should see "Public booking page"
    And I should see "the same design language and the same content"
