# LeadFlow — working agreement

## Autonomy: do not stop to ask

Run the work end to end without check-in prompts. When something is ambiguous,
pick the best option, state the assumption in passing, and keep going. Do not
use AskUserQuestion, do not present option menus, and do not pause for approval
between steps of a task the user has already asked for.

Only stop for something genuinely destructive or irreversible that the user has
not already authorised.

**Why:** the user drives long ProjexLight code-generation sessions and every
confirmation prompt is another click that interrupts a run they already said yes
to. Repeated check-ins cost them more than an occasional wrong-but-stated
assumption, which they can correct in one message.

## ProjexLight workflow

- Fetch the task instruction before writing code — never build a task from its
  title. The instruction carries the mockup, the criteria and the real upstream
  endpoints.
- Schema changes go through the migration runner; data goes through HTTP. Never
  psql.
- Author `tests/api_definitions/**` before the handler (MUST-02), and refresh the
  contract with `projexlight_get_api_definition_rules` first (MUST-41).
- Author `tests/features/*.feature` for screens, refreshing
  `projexlight_get_ui_feature_rules` first (MUST-55), then sync with
  `projexlight_sync_feature_file` (dryRun first).
- Default to NO unit tests. The api_definition testCase or the Gherkin step is
  the test artifact (MUST-67); a unit test is only for pure logic neither can
  reach, capped at 3 per task.
- Before every commit run `projexlight_pre_commit_regression_check` (MUST-32).
