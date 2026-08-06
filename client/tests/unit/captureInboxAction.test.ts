import { describe, expect, it } from 'vitest';
import { actionFor } from '../../src/pages/app/CaptureInbox';
import { CaptureAction, CaptureInboxItem, TrustState } from '../../src/services/api';

/**
 * Which action a capture row offers.
 *
 * A unit test because it is pure branching with no HTTP and no UI surface: an
 * api_definition asserts what the server RETURNS in `availableActions`, and a
 * Gherkin step can click one button on one row, but neither can walk every
 * combination of trust state, origin class and caller authority. That walk is
 * the whole of AC3.
 *
 * ONE `it` HOLDING A TABLE, not one `it` per row — MUST-67 caps the whole task
 * at three unit tests and asks for related cases grouped rather than split one
 * assertion at a time. The table still names each rule, so a failure reports
 * which combination broke rather than only a line number; what it gives up is
 * that the first failing row stops the rest, which is the trade the rule makes.
 */
function item(
  trustState: TrustState,
  availableActions: CaptureAction[],
  originClass = 'USER_PROVIDED'
): CaptureInboxItem {
  return {
    sourceRecordId: 'cap-1',
    trustState,
    originClass,
    primaryEvidence: '(972) 555-0188',
    explanation: 'Captured as received.',
    ageMinutes: 3,
    captureSource: 'quick_add',
    availableActions,
  };
}

const CASES: Array<{
  rule: string;
  trustState: TrustState;
  actions: CaptureAction[];
  originClass?: string;
  expected: string;
}> = [
  {
    rule: 'P0 can only be parsed, so the row offers the parse',
    trustState: 'P0_CAPTURED',
    actions: ['source_record.normalize', 'suppression.apply'],
    expected: 'Resolve',
  },
  {
    rule: 'P1 without direct evidence wants a human to check the parse first',
    trustState: 'P1_NORMALIZED',
    actions: ['source_record.promote', 'suppression.apply'],
    expected: 'Review',
  },
  {
    // The origin class, not the trust state, is what separates this from the
    // row above — same rung, same permissions, different evidence.
    rule: 'P1 resting on first-party direct evidence promotes outright',
    trustState: 'P1_NORMALIZED',
    actions: ['source_record.promote', 'suppression.apply'],
    originClass: 'FIRST_PARTY_DIRECT',
    expected: 'Promote',
  },
  {
    rule: 'P3 follows the same origin-class split as P1, one rung further up',
    trustState: 'P3_LINKED',
    actions: ['source_record.promote', 'suppression.apply'],
    originClass: 'FIRST_PARTY_DIRECT',
    expected: 'Promote',
  },
  {
    // Comparison outranks promotion even though the server offers both: linking
    // two records is the harder thing to undo, so it is the one to look at.
    rule: 'A candidate has its two records compared before anything is linked',
    trustState: 'P2_CANDIDATE',
    actions: ['source_record.promote', 'identity.link.verify', 'suppression.apply'],
    expected: 'Compare',
  },
  {
    rule: 'Nothing is left to advance at the top of the ladder',
    trustState: 'P4_DIRECT',
    actions: ['suppression.apply'],
    expected: 'Dismiss',
  },
  {
    // The row never renders a button that would be refused on click — the
    // operator learns their authority from the screen, not from a 403.
    rule: 'A caller the policy permits nothing gets no advancing action',
    trustState: 'P0_CAPTURED',
    actions: [],
    expected: 'Dismiss',
  },
];

describe('the contextual action on a capture row', () => {
  it('varies by trust state, by origin class, and by what the caller may do', () => {
    for (const { rule, trustState, actions, originClass, expected } of CASES) {
      expect(actionFor(item(trustState, actions, originClass)).label, rule).toBe(expected);
    }
  });
});
