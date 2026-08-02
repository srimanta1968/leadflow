import { buildPolicyBundle } from '../../src/config/policies';
import { PERMISSIONS, ROLE_DEFINITIONS } from '../../src/config/roles';
import { evaluate, evaluateBatch, isKnownAction } from '../../src/platform/policy/policyEngine';
import { validateActions, MAX_BATCH } from '../../src/platform/policy/authzController';

/**
 * The ABAC bundle and its decision point.
 *
 * Every SOP §28 "cannot do without approval" rule is asserted here rather than
 * through the endpoint, because the endpoint only forwards what the engine
 * decides — and these are the claims that matter if the matrix is ever wrong.
 */

describe('SOP §28 cannot-without-approval rules', () => {
  it('lets a Rep update a stage but not change offer terms unaided', () => {
    expect(evaluate({ action: PERMISSIONS.STAGE_UPDATE, resourceType: 'lead' }, ['sales_rep']).effect).toBe(
      'permit'
    );

    const terms = evaluate({ action: PERMISSIONS.OFFER_CHANGE_TERMS, resourceType: 'lead' }, [
      'sales_rep',
    ]);
    // requires_approval, NOT deny. §28 says a Rep may not do this WITHOUT
    // approval, which is an escalation path rather than a prohibition.
    expect(terms.effect).toBe('requires_approval');
    expect(terms.obligations.map((o) => o.type)).toContain('second_party_approval');
  });

  it.each([
    PERMISSIONS.OFFER_CHANGE_TERMS,
    PERMISSIONS.SUPPRESSION_OVERRIDE,
    PERMISSIONS.LEAD_BULK_EXPORT,
    PERMISSIONS.MESSAGE_PUBLISH_TEMPLATE,
  ])('gates %s behind approval for a Rep', (action) => {
    expect(evaluate({ action, resourceType: 'lead' }, ['sales_rep']).effect).toBe(
      'requires_approval'
    );
  });

  it.each([
    PERMISSIONS.COMPLIANCE_RULE_CHANGE,
    PERMISSIONS.PAYMENT_STATE_CHANGE,
    PERMISSIONS.AUTOMATION_PUBLISH,
  ])('gates %s behind approval for a Manager', (action) => {
    expect(evaluate({ action, resourceType: 'tenant' }, ['sales_manager']).effect).toBe(
      'requires_approval'
    );
  });

  it.each([
    PERMISSIONS.PRODUCT_CLAIM_APPROVE,
    PERMISSIONS.COMMERCIAL_EXCEPTION_APPROVE,
    PERMISSIONS.LEGAL_POLICY_APPROVE,
  ])('gates %s behind approval for RevOps', (action) => {
    expect(evaluate({ action, resourceType: 'tenant' }, ['revenue_operations']).effect).toBe(
      'requires_approval'
    );
  });

  it('denies deleting an audit event to EVERY role, approval or not', () => {
    // The one hard deny. An audit trail a senior enough person can erase is not
    // an audit trail, and approval cannot rescue it — the approver would be
    // recorded in the log being deleted.
    for (const role of ROLE_DEFINITIONS) {
      const decision = evaluate({ action: PERMISSIONS.AUDIT_DELETE_EVENT, resourceType: 'audit' }, [
        role.key,
      ]);
      expect(decision.effect).toBe('deny');
    }
  });

  it('lets only the Privacy Officer override suppression unaided', () => {
    expect(
      evaluate({ action: PERMISSIONS.SUPPRESSION_OVERRIDE, resourceType: 'contact' }, [
        'privacy_officer',
      ]).effect
    ).toBe('permit');
    expect(
      evaluate({ action: PERMISSIONS.SUPPRESSION_OVERRIDE, resourceType: 'contact' }, [
        'marketing_ops',
      ]).effect
    ).toBe('requires_approval');
  });
});

describe('decision shape', () => {
  it('denies an action no rule mentions, rather than failing open', () => {
    const decision = evaluate({ action: PERMISSIONS.IMPORT_COMMIT, resourceType: 'import' }, [
      'sales_rep',
    ]);

    expect(decision.effect).toBe('deny');
  });

  it('denies everything to a caller with no roles', () => {
    const decision = evaluate({ action: PERMISSIONS.STAGE_UPDATE, resourceType: 'lead' }, []);

    expect(decision.effect).toBe('deny');
  });

  it('carries a unique decision reference on every verdict', () => {
    const first = evaluate({ action: PERMISSIONS.STAGE_UPDATE, resourceType: 'lead' }, ['sales_rep']);
    const second = evaluate({ action: PERMISSIONS.STAGE_UPDATE, resourceType: 'lead' }, ['sales_rep']);

    expect(first.decisionRef).toMatch(/^pdp_/);
    // Two identical requests are two separate authorisations made at different
    // moments; one reference must never appear to justify a second write.
    expect(first.decisionRef).not.toBe(second.decisionRef);
  });

  it('surfaces the resource condition a role grant cannot express', () => {
    const decision = evaluate({ action: PERMISSIONS.LEAD_WORK_ASSIGNED, resourceType: 'lead' }, [
      'sales_rep',
    ]);

    // "Works ASSIGNED leads" — without this obligation the grant would let a
    // Rep work every lead in the tenant.
    expect(decision.effect).toBe('permit');
    expect(decision.obligations.map((o) => o.type)).toContain('own_record_only');
  });

  it('puts overrides ahead of the plain role grant they refine', () => {
    const bundle = buildPolicyBundle();
    const firstWorkAssigned = bundle.rules.findIndex(
      (rule) => rule.action === PERMISSIONS.LEAD_WORK_ASSIGNED
    );

    // If the generic permit came first it would shadow the conditional rule and
    // the bundle would look right while enforcing nothing.
    expect(bundle.rules[firstWorkAssigned].obligations?.length).toBeGreaterThan(0);
  });
});

describe('batched evaluation', () => {
  it('returns one verdict per action, in the order asked', () => {
    const decisions = evaluateBatch(
      [
        { action: PERMISSIONS.STAGE_UPDATE, resourceType: 'lead' },
        { action: PERMISSIONS.OFFER_CHANGE_TERMS, resourceType: 'lead' },
        { action: PERMISSIONS.AUDIT_DELETE_EVENT, resourceType: 'audit' },
      ],
      ['sales_rep']
    );

    expect(decisions.map((d) => d.effect)).toEqual(['permit', 'requires_approval', 'deny']);
    expect(decisions.map((d) => d.action)).toEqual([
      PERMISSIONS.STAGE_UPDATE,
      PERMISSIONS.OFFER_CHANGE_TERMS,
      PERMISSIONS.AUDIT_DELETE_EVENT,
    ]);
  });
});

describe('request validation', () => {
  it('rejects an empty action set instead of answering nothing', () => {
    expect(() => validateActions({ actions: [] })).toThrow();
  });

  it('rejects a batch above the cap', () => {
    const oversized = Array.from({ length: MAX_BATCH + 1 }, () => ({
      action: PERMISSIONS.STAGE_UPDATE,
      resource_type: 'lead',
    }));

    expect(() => validateActions({ actions: oversized })).toThrow();
  });

  it('rejects an unknown action as a caller error, not as a deny', () => {
    // A typo must not masquerade as a policy decision.
    expect(() => validateActions({ actions: [{ action: 'lead.do_whatever', resource_type: 'lead' }] })
    ).toThrow();
  });

  it('requires a resource type on every entry', () => {
    expect(() => validateActions({ actions: [{ action: PERMISSIONS.STAGE_UPDATE }] })).toThrow();
  });

  it('accepts a well-formed batch and normalises it', () => {
    const parsed = validateActions({
      actions: [
        { action: PERMISSIONS.STAGE_UPDATE, resource_type: 'lead', resource_id: 'lead-1' },
      ],
    });

    expect(parsed).toEqual([
      { action: PERMISSIONS.STAGE_UPDATE, resourceType: 'lead', resourceId: 'lead-1' },
    ]);
  });

  it('knows every action the bundle governs, including approval-gated ones', () => {
    // offer.change_terms is held unaided by nobody, so a naive "is it granted
    // to anyone" check would call it unknown and reject it as a typo.
    expect(isKnownAction(PERMISSIONS.OFFER_CHANGE_TERMS)).toBe(true);
    expect(isKnownAction(PERMISSIONS.STAGE_UPDATE)).toBe(true);
    expect(isKnownAction('lead.do_whatever')).toBe(false);
  });
});
