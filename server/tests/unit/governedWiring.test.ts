import { Response } from 'express';
import { RoutingController } from '../../src/controllers/RoutingController';
import { SlaController } from '../../src/controllers/SlaController';
import { rolesFor, GovernedRequest } from '../../src/platform/policy/governed';
import * as auditLog from '../../src/platform/audit/auditLog';

/**
 * That the handlers are actually WIRED, using their real specs.
 *
 * `governedHandler.test.ts` proves the wrapper behaves; this proves the
 * controllers use it, and that each one names an action the intended role
 * actually holds. A spec naming the wrong permission passes every wrapper test
 * and denies the right people in production.
 *
 * These assert the REFUSAL side. A permit would run the real service against the
 * database, which the integration suites already cover — the refusal is the part
 * that is new, and the part that fails silently if a wrapper is dropped during a
 * later edit.
 */

function fakeRes(): Response {
  const res = {
    status() {
      return res;
    },
    json() {
      return res;
    },
  };
  return res as unknown as Response;
}

function asRole(role: string): GovernedRequest {
  return {
    params: { id: '11111111-1111-1111-1111-111111111111' },
    body: {},
    query: {},
    session: { userId: 'u1', role },
  } as unknown as GovernedRequest;
}

beforeEach(() => {
  jest.spyOn(auditLog, 'appendAuditEntry').mockResolvedValue({
    delivered: true,
    entryRef: 'aud_test',
  });
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('the local role bridge', () => {
  it('maps local roles onto SOP roles, since the two vocabularies do not overlap', () => {
    // Without this, every locally-authenticated caller matches no rule and is
    // denied — default-deny firing on a vocabulary mismatch rather than on a
    // real absence of authority.
    expect(rolesFor(asRole('admin'))).toEqual([
      'revenue_operations',
      'sales_manager',
      // The local admin worked leads too, and recording a first response is
      // lead.work_assigned — which only a Rep holds.
      'sales_rep',
      // Added with the closed-won saga. client_success holds handoff.accept,
      // onboarding.manage and escalation.receive — the entire post-sale half of
      // the product — and NO local role bridged to it, so every onboarding
      // endpoint was unreachable by every user in the system. An endpoint nobody
      // can call is dead code wearing a permission check.
      'client_success',
    ]);
    expect(rolesFor(asRole('manager'))).toEqual(['sales_manager']);
    expect(rolesFor(asRole('user'))).toEqual(['sales_rep']);
  });

  it('yields NOTHING for an unmapped local role', () => {
    // Passing the value through would make an unrecognised role
    // indistinguishable from a real SOP role that holds no grants.
    expect(rolesFor(asRole('wizard'))).toEqual([]);
  });

  it('prefers the platform session, which carries real persona grants', () => {
    const req = {
      session: { userId: 'u1', role: 'admin' },
      platformSession: { roles: ['data_steward'] },
    } as unknown as GovernedRequest;

    expect(rolesFor(req)).toEqual(['data_steward']);
  });
});

describe('routing handlers are gated', () => {
  it('refuses rule configuration to a rep', async () => {
    await expect(RoutingController.createRule(asRole('user'), fakeRes())).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('refuses rule retirement to a rep', async () => {
    await expect(RoutingController.retireRule(asRole('user'), fakeRes())).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('refuses reassignment to a rep', async () => {
    // Reassigning is the Manager's act under SOP §28, not the Rep's.
    await expect(RoutingController.assignLead(asRole('user'), fakeRes())).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('refuses the bulk sweep to a rep', async () => {
    await expect(RoutingController.routeUnowned(asRole('user'), fakeRes())).rejects.toMatchObject({
      statusCode: 403,
    });
  });
});

describe('SLA handlers are gated', () => {
  it('requires a SECOND PARTY for a manager changing an SLA target', async () => {
    // Not a refusal — an escalation. Loosening the target you are measured
    // against is the change nobody should make alone.
    await expect(
      SlaController.updatePolicy(asRole('manager'), fakeRes())
    ).rejects.toMatchObject({ statusCode: 403, code: 'APPROVAL_REQUIRED' });
  });

  it('refuses SLA target changes to a rep outright', async () => {
    await expect(SlaController.createPolicy(asRole('user'), fakeRes())).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
    });
  });

  it('refuses alert dispatch to a rep', async () => {
    await expect(SlaController.dispatchAlerts(asRole('user'), fakeRes())).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('refuses an unidentified caller acknowledging an alert', async () => {
    const anonymous = { params: {}, body: {}, query: {} } as unknown as GovernedRequest;

    await expect(SlaController.acknowledgeAlerts(anonymous, fakeRes())).rejects.toMatchObject({
      statusCode: 403,
    });
  });
});
