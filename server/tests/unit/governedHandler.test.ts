import { Response } from 'express';
import { AUDIT_EVENTS } from '../../src/platform/audit/vocabulary';
import { governed, GovernedRequest } from '../../src/platform/policy/governed';
import * as auditLog from '../../src/platform/audit/auditLog';
import { PERMISSIONS } from '../../src/config/roles';

/**
 * The `governed` wrapper.
 *
 * Everything asserted here is something that fails SILENTLY if it regresses: a
 * write that skips the PDP still returns 200, an audit entry appended before the
 * write still looks like a full ledger, and a permit that ignores its own
 * obligation is indistinguishable from one that had none.
 */

function fakeRes(): Response & { statusCode: number; body: unknown } {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

function reqWithRoles(roles: string[], extra: Record<string, unknown> = {}): GovernedRequest {
  return {
    params: {},
    body: {},
    query: {},
    platformSession: {
      tenantId: 't1',
      personId: 'person-1',
      personaId: 'persona-1',
      roles,
      businessUnitId: null,
      subject: 'person-1',
      expiresAt: 0,
    },
    ...extra,
  } as unknown as GovernedRequest;
}

let appendSpy: jest.SpyInstance;

beforeEach(() => {
  appendSpy = jest
    .spyOn(auditLog, 'appendAuditEntry')
    .mockResolvedValue({ delivered: true, entryRef: 'aud_test' });
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** A spec whose action a revenue_operations persona holds outright. */
const CONFIGURE_SPEC = {
  action: PERMISSIONS.ROUTING_CONFIGURE,
  event: AUDIT_EVENTS.ROUTING_RULE_CREATED,
  purpose: 'service_operation',
  resourceType: 'routing_rule',
};

describe('governed', () => {
  it('runs the handler and appends an entry on a clean permit', async () => {
    let ran = false;
    const handler = governed(CONFIGURE_SPEC, async (_req, res) => {
      ran = true;
      res.status(201).json({ success: true });
    });

    const res = fakeRes();
    await handler(reqWithRoles(['revenue_operations']), res);

    expect(ran).toBe(true);
    expect(res.statusCode).toBe(201);
    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy.mock.calls[0][0]).toMatchObject({
      event: 'routing.rule.created',
      // The PERSONA, not the person: which hat the human wore is the thing the
      // entry has to be able to state.
      actor: 'persona-1',
      personaRole: 'revenue_operations',
    });
  });

  it('quotes the SAME decisionRef it evaluated, joining the write to its authorisation', async () => {
    let seenRef = '';
    const handler = governed(CONFIGURE_SPEC, async (_req, res, decision) => {
      seenRef = decision.decisionRef;
      res.status(201).json({});
    });

    await handler(reqWithRoles(['revenue_operations']), fakeRes());

    // A fresh ref in the audit entry would mean the ledger points at a decision
    // that authorised nothing.
    expect(appendSpy.mock.calls[0][0].decisionRef).toBe(seenRef);
    expect(seenRef).toMatch(/^pdp_/);
  });

  it('REFUSES before the handler runs, not after', async () => {
    let ran = false;
    const handler = governed(CONFIGURE_SPEC, async (_req, res) => {
      ran = true;
      res.status(201).json({});
    });

    // A rep holds no routing.configure grant.
    await expect(handler(reqWithRoles(['sales_rep']), fakeRes())).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
    });

    // The whole point. A check after the write is not a check — the row exists.
    expect(ran).toBe(false);
  });

  it('records the refusal, because a refused attempt is what an auditor looks for', async () => {
    const handler = governed(CONFIGURE_SPEC, async (_req, res) => {
      res.status(201).json({});
    });

    await expect(handler(reqWithRoles(['sales_rep']), fakeRes())).rejects.toThrow();

    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy.mock.calls[0][0].metadata).toMatchObject({ outcome: 'denied' });
  });

  it('answers APPROVAL_REQUIRED rather than FORBIDDEN when a second party is needed', async () => {
    const handler = governed(
      {
        action: PERMISSIONS.SLA_CONFIGURE,
        event: AUDIT_EVENTS.SLA_POLICY_UPDATED,
        purpose: 'service_operation',
        resourceType: 'sla_policy',
      },
      async (_req, res) => res.status(200).json({}) as unknown as void
    );

    // A manager may change an SLA target — but not alone.
    await expect(handler(reqWithRoles(['sales_manager']), fakeRes())).rejects.toMatchObject({
      statusCode: 403,
      code: 'APPROVAL_REQUIRED',
    });

    // Telling them FORBIDDEN would say they may not do something they may in
    // fact do, and hide the escalation path the business runs on.
    expect(appendSpy.mock.calls[0][0].metadata).toMatchObject({ outcome: 'approval_required' });
  });

  it('appends NOTHING when the handler throws', async () => {
    const handler = governed(CONFIGURE_SPEC, async () => {
      throw new Error('database exploded');
    });

    await expect(handler(reqWithRoles(['revenue_operations']), fakeRes())).rejects.toThrow(
      'database exploded'
    );

    // There is no act to record. An entry for a write that failed is a false
    // statement in a tamper-evident chain.
    expect(appendSpy).not.toHaveBeenCalled();
  });

  describe('obligations', () => {
    const ACK_SPEC = {
      action: PERMISSIONS.SLA_ALERT_ACKNOWLEDGE,
      event: AUDIT_EVENTS.SLA_ALERT_ACKNOWLEDGED,
      purpose: 'service_operation',
      resourceType: 'sla_alert',
    };

    it('FAILS CLOSED when an obligation is undeclared', async () => {
      let ran = false;
      // No `obligations` entry, yet the rule attaches own_record_only.
      const handler = governed(ACK_SPEC, async (_req, res) => {
        ran = true;
        res.status(200).json({});
      });

      await expect(handler(reqWithRoles(['sales_rep']), fakeRes())).rejects.toMatchObject({
        statusCode: 403,
      });
      // Otherwise adding an obligation to policies.ts would WEAKEN the system.
      expect(ran).toBe(false);
    });

    it('refuses when a declared check fails', async () => {
      const handler = governed(
        {
          ...ACK_SPEC,
          obligations: {
            own_record_only: {
              kind: 'discharge' as const,
              check: (req: GovernedRequest) => Boolean(req.session?.userId),
              onFail: 'An acknowledgement must be made by an identified caller.',
            },
          },
        },
        async (_req, res) => res.status(200).json({}) as unknown as void
      );

      // No session.userId, so the check fails.
      await expect(handler(reqWithRoles(['sales_rep']), fakeRes())).rejects.toMatchObject({
        statusCode: 403,
      });
    });

    it('proceeds when a declared check passes', async () => {
      const handler = governed(
        {
          ...ACK_SPEC,
          obligations: {
            own_record_only: {
              kind: 'discharge' as const,
              check: (req: GovernedRequest) => Boolean(req.session?.userId),
              onFail: 'nope',
            },
          },
        },
        async (_req, res) => res.status(200).json({}) as unknown as void
      );

      const req = reqWithRoles(['sales_rep'], { session: { userId: 'u1', role: 'sales_rep' } });
      const res = fakeRes();
      await handler(req, res);

      expect(res.statusCode).toBe(200);
    });

    it('stamps a DEFERRED obligation into the ledger instead of hiding it', async () => {
      const handler = governed(
        {
          ...ACK_SPEC,
          obligations: {
            own_record_only: {
              kind: 'defer' as const,
              because: 'ownership is not modelled yet',
            },
          },
        },
        async (_req, res) => res.status(200).json({}) as unknown as void
      );

      await handler(reqWithRoles(['sales_rep']), fakeRes());

      // Discoverable by querying the ledger later, not only by reading the
      // source at the time the deferral was decided.
      expect(appendSpy.mock.calls[0][0].metadata).toMatchObject({
        deferred_obligations: ['own_record_only'],
      });
    });
  });

  it('fails closed for a caller with no roles at all', async () => {
    const handler = governed(CONFIGURE_SPEC, async (_req, res) =>
      res.status(201).json({}) as unknown as void
    );

    await expect(handler(reqWithRoles([]), fakeRes())).rejects.toMatchObject({ statusCode: 403 });
  });
});
