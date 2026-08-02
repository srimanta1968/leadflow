import { describe, expect, it } from 'vitest';
import { decisionFor, isAllowed, PermissionState, PolicyDecision } from '../../src/platform/permissions/usePermissions';
import { toMatrixRows } from '../../src/features/admin/PermissionMatrix';

/**
 * Permission gating decisions.
 *
 * The hook's fetching is not tested here — that is the endpoint's api_definition
 * and a browser scenario. What IS tested is the part a runner cannot reach: what
 * the UI concludes when it has no answer, a partial answer, or a conditional one.
 */

function decision(overrides: Partial<PolicyDecision> = {}): PolicyDecision {
  return {
    action: 'stage.update',
    effect: 'permit',
    reason: '',
    obligations: [],
    decision_ref: 'pdp_1',
    ...overrides,
  };
}

function stateWith(decisions: PolicyDecision[], extra: Partial<PermissionState> = {}): PermissionState {
  return {
    loading: false,
    error: null,
    decisions: new Map(decisions.map((d) => [d.action, d])),
    ...extra,
  };
}

describe('failing closed', () => {
  it('denies an action the PDP said nothing about', () => {
    // A missing verdict is not consent.
    expect(isAllowed(stateWith([]), 'stage.update')).toBe(false);
  });

  it('denies everything while the answer is still in flight', () => {
    // Assuming permit until told otherwise flashes an enabled control that then
    // refuses — worse than a brief disabled state.
    const state = stateWith([], { loading: true });

    expect(isAllowed(state, 'stage.update')).toBe(false);
    expect(decisionFor(state, 'stage.update').reason).toMatch(/checking/i);
  });

  it('denies everything when the permission check failed', () => {
    const state = stateWith([], { error: 'Your permissions could not be checked.' });

    expect(isAllowed(state, 'stage.update')).toBe(false);
    // The person is told why rather than shown a dead control.
    expect(decisionFor(state, 'stage.update').reason).toBe('Your permissions could not be checked.');
  });
});

describe('verdict handling', () => {
  it('allows an unconditional permit', () => {
    expect(isAllowed(stateWith([decision()]), 'stage.update')).toBe(true);
  });

  it('does not treat requires_approval as allowed', () => {
    const state = stateWith([
      decision({ action: 'offer.change_terms', effect: 'requires_approval', reason: 'Needs a second party.' }),
    ]);

    expect(isAllowed(state, 'offer.change_terms')).toBe(false);
    // But it keeps the reason, so the UI can offer to request approval rather
    // than just refusing.
    expect(decisionFor(state, 'offer.change_terms').effect).toBe('requires_approval');
  });

  it('carries the obligation detail through to the caller', () => {
    const state = stateWith([
      decision({
        action: 'lead.work_assigned',
        obligations: [{ type: 'own_record_only', detail: 'Caller must be the owner or backup.' }],
      }),
    ]);

    expect(decisionFor(state, 'lead.work_assigned').obligations[0].detail).toContain('owner');
  });
});

describe('permission matrix', () => {
  const roles = [
    { key: 'sales_rep', label: 'Sales Rep / SDR' },
    { key: 'privacy_officer', label: 'Privacy Officer' },
  ];

  it('splits permits from approval-gated actions into separate columns', () => {
    const rows = toMatrixRows(
      roles,
      new Map([
        [
          'sales_rep',
          [
            decision({ action: 'stage.update', effect: 'permit' }),
            decision({ action: 'offer.change_terms', effect: 'requires_approval' }),
            decision({ action: 'audit.delete_event', effect: 'deny' }),
          ],
        ],
      ])
    );

    expect(rows[0].canDo).toEqual(['stage.update']);
    // The SOP distinction is the point of the screen: an approval-gated action
    // must not be folded in with a flat denial.
    expect(rows[0].requiresApproval).toEqual(['offer.change_terms']);
    expect(rows[0].canDo).not.toContain('audit.delete_event');
  });

  it('renders a role with no decisions as empty rather than dropping it', () => {
    const rows = toMatrixRows(roles, new Map());

    // A role missing from the grid reads as "this role does not exist".
    expect(rows).toHaveLength(2);
    expect(rows[1].canDo).toEqual([]);
  });
});
