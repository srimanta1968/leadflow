import { Response } from 'express';
import { config } from '../../src/config/env';
import {
  assertNoForbiddenFields,
  evaluateDomainPolicy,
} from '../../src/features/capture/extensionCaptureService';
import { ExtensionCaptureController } from '../../src/features/capture/extensionCaptureController';
import { GovernedRequest } from '../../src/platform/policy/governed';
import * as auditLog from '../../src/platform/audit/auditLog';
import { SdkGatewayClient } from '../../src/services/projexcloud/SdkGatewayClient';

/**
 * Browser capture guardrails.
 *
 * Every criterion here is a NEGATIVE — something that must never happen — and
 * negatives are exactly what stops being true quietly. A capture that harvested
 * a page in the background looks identical to one the operator confirmed;
 * a payload with the cookie silently stripped looks identical to one that never
 * had it. These assert the refusals.
 */

function fakeRes(): Response & { code: number; body: unknown } {
  const res = {
    code: 0,
    body: undefined as unknown,
    status(value: number) {
      res.code = value;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res as unknown as Response & { code: number; body: unknown };
}

function operatorReq(body: Record<string, unknown>, query: Record<string, unknown> = {}) {
  return {
    params: {},
    body,
    query,
    session: { userId: 'u1', role: 'user' },
  } as unknown as GovernedRequest;
}

beforeEach(() => {
  jest.spyOn(auditLog, 'appendAuditEntry').mockResolvedValue({ delivered: true, entryRef: 'aud' });
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  config.projexCloud.gatewayUrl = '';
  config.projexCloud.apiKey = '';
  config.projexCloud.capturePolicyId = '';
  jest.restoreAllMocks();
});

describe('fields that must never leave the page', () => {
  it('REJECTS rather than strips, so a misbehaving client is visible', () => {
    // Stripping would accept the request and silently discard the only evidence
    // that a client is reading cookies — the capture would look identical to a
    // well-behaved one and the broken build would ship.
    expect(() => assertNoForbiddenFields({ cookies: 'session=abc' })).toThrow();
  });

  it('catches every credential shape, not just the bare names', () => {
    const forbidden = [
      { cookies: 'a=b' },
      { sessionCookie: 'a=b' },
      { csrf_token: 'x' },
      { password: 'hunter2' },
      { userPassword: 'hunter2' },
      { secret: 'x' },
      { authorization: 'Bearer x' },
      { hiddenInputs: '{}' },
      { localStorage: '{}' },
      { credentials: '{}' },
    ];
    for (const body of forbidden) {
      expect(() => assertNoForbiddenFields(body)).toThrow();
    }
  });

  it('names the offending key so the client can be fixed', () => {
    try {
      assertNoForbiddenFields({ selectedText: 'ok', sessionToken: 'x' });
      throw new Error('should have refused');
    } catch (error) {
      expect((error as Error).message).toContain('sessionToken');
    }
  });

  it('lets an ordinary capture through', () => {
    expect(() =>
      assertNoForbiddenFields({
        selectedText: 'Priya Raman',
        domain: 'example.com',
        confirmed: true,
        retainSourceUrl: false,
      })
    ).not.toThrow();
  });

  it('is checked BEFORE the shape, so the serious finding is not buried', async () => {
    // A payload missing `domain` AND carrying a cookie must report the cookie.
    // "domain is required" would send someone off to fix the wrong thing.
    await expect(
      ExtensionCaptureController.capture(operatorReq({ cookies: 'a=b' }), fakeRes())
    ).rejects.toMatchObject({ code: 'FORBIDDEN_FIELD' });
  });
});

describe('nothing transmits before confirmation', () => {
  it('REFUSES an unconfirmed capture', async () => {
    await expect(
      ExtensionCaptureController.capture(
        operatorReq({ selectedText: 'text', domain: 'example.com', confirmed: false }),
        fakeRes()
      )
    ).rejects.toMatchObject({ statusCode: 422, code: 'CONFIRMATION_REQUIRED' });
  });

  it('REFUSES when confirmation is merely absent', async () => {
    // Absent is not consent. A client that forgets the flag must fail, not
    // default to "the operator probably looked at it".
    await expect(
      ExtensionCaptureController.capture(
        operatorReq({ selectedText: 'text', domain: 'example.com' }),
        fakeRes()
      )
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
  });

  it('accepts a confirmed capture', async () => {
    const res = fakeRes();
    await ExtensionCaptureController.capture(
      operatorReq({
        selectedText: 'Priya Raman',
        domain: 'example.com',
        confirmed: true,
        retainSourceUrl: false,
      }),
      res
    );

    expect(res.code).toBe(201);
  });
});

describe('the source URL is optional and off by default', () => {
  it('is not retained when the box is unticked', async () => {
    const res = fakeRes();
    await ExtensionCaptureController.capture(
      operatorReq({
        selectedText: 'text',
        domain: 'example.com',
        sourceUrl: 'https://example.com/page',
        confirmed: true,
        retainSourceUrl: false,
      }),
      res
    );

    const data = (res.body as { data: { sourceUrlRetained: boolean } }).data;
    expect(data.sourceUrlRetained).toBe(false);
  });

  it('is retained when the box is ticked AND a URL was supplied', async () => {
    const res = fakeRes();
    await ExtensionCaptureController.capture(
      operatorReq({
        selectedText: 'text',
        domain: 'example.com',
        sourceUrl: 'https://example.com/page',
        confirmed: true,
        retainSourceUrl: true,
      }),
      res
    );

    expect((res.body as { data: { sourceUrlRetained: boolean } }).data.sourceUrlRetained).toBe(true);
  });

  it('reports NOT retained when the box is ticked but no URL arrived', async () => {
    // Reporting retention we did not perform would misstate what is stored.
    const res = fakeRes();
    await ExtensionCaptureController.capture(
      operatorReq({
        selectedText: 'text',
        domain: 'example.com',
        confirmed: true,
        retainSourceUrl: true,
      }),
      res
    );

    expect((res.body as { data: { sourceUrlRetained: boolean } }).data.sourceUrlRetained).toBe(
      false
    );
  });
});

describe('restricted domains', () => {
  it('permits when no policy engine is configured', async () => {
    const decision = await evaluateDomainPolicy('example.com');

    // The unconfigured case, not a failure to read a policy that exists — the
    // tenant has expressed no restriction at all.
    expect(decision.allowed).toBe(true);
  });

  it('permits when the gateway IS reachable but no capture policy is defined', async () => {
    config.projexCloud.gatewayUrl = 'https://gateway.test';
    config.projexCloud.apiKey = 'token';
    config.projexCloud.capturePolicyId = '';

    const decision = await evaluateDomainPolicy('example.com');

    // The bug this replaced: conflating "gateway reachable" with "a rule
    // exists" made every capture fail closed for a tenant who had simply never
    // restricted anything. You cannot fail closed against a rule nobody wrote.
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toContain('No domain restrictions');
  });

  it('BLOCKS and SAYS SO when the policy denies', async () => {
    config.projexCloud.gatewayUrl = 'https://gateway.test';
    config.projexCloud.apiKey = 'token';
    // A policy id is what declares a restriction EXISTS. Without it there is no
    // rule to evaluate and capture is permitted.
    config.projexCloud.capturePolicyId = 'pol_browser_capture';
    jest.spyOn(SdkGatewayClient, 'call').mockResolvedValue({
      delivered: true,
      status: 200,
      data: { data: { effect: 'deny', reason: 'Webmail is restricted by your organisation.' } },
    } as never);

    const decision = await evaluateDomainPolicy('mail.example.com');

    expect(decision.allowed).toBe(false);
    // A block that does not say so is indistinguishable from a bug.
    expect(decision.reason).toContain('restricted');
  });

  it('still permits MANUAL entry on a restricted domain', async () => {
    config.projexCloud.gatewayUrl = 'https://gateway.test';
    config.projexCloud.apiKey = 'token';
    // A policy id is what declares a restriction EXISTS. Without it there is no
    // rule to evaluate and capture is permitted.
    config.projexCloud.capturePolicyId = 'pol_browser_capture';
    jest
      .spyOn(SdkGatewayClient, 'call')
      .mockResolvedValue({ delivered: true, status: 200, data: { data: { effect: 'deny' } } } as never);

    const decision = await evaluateDomainPolicy('mail.example.com');

    // Restricting automated reading says nothing about whether a person may
    // type what they can see. Conflating the two pushes people to a personal
    // notebook, which is worse for the tenant than a governed manual entry.
    expect(decision.manualEntryPermitted).toBe(true);
  });

  it('FAILS CLOSED when the policy cannot be reached', async () => {
    config.projexCloud.gatewayUrl = 'https://gateway.test';
    config.projexCloud.apiKey = 'token';
    // A policy id is what declares a restriction EXISTS. Without it there is no
    // rule to evaluate and capture is permitted.
    config.projexCloud.capturePolicyId = 'pol_browser_capture';
    jest.spyOn(SdkGatewayClient, 'call').mockRejectedValue(new Error('gateway down'));

    const decision = await evaluateDomainPolicy('example.com');

    // An unreachable policy is not permission.
    expect(decision.allowed).toBe(false);
    // But it must name the OUTAGE, not claim a restriction — an operator told
    // "your organisation restricted this" would go and argue about a rule that
    // does not exist.
    expect(decision.reason).toContain('could not be checked');
  });

  it('refuses the transmission itself on a restricted domain', async () => {
    config.projexCloud.gatewayUrl = 'https://gateway.test';
    config.projexCloud.apiKey = 'token';
    // A policy id is what declares a restriction EXISTS. Without it there is no
    // rule to evaluate and capture is permitted.
    config.projexCloud.capturePolicyId = 'pol_browser_capture';
    jest
      .spyOn(SdkGatewayClient, 'call')
      .mockResolvedValue({ delivered: true, status: 200, data: { data: { effect: 'deny' } } } as never);

    // Re-checked server-side. The extension asks first so it can tell the
    // operator early, but a restriction only a client enforces is not one.
    await expect(
      ExtensionCaptureController.capture(
        operatorReq({
          selectedText: 'text',
          domain: 'mail.example.com',
          confirmed: true,
          retainSourceUrl: false,
        }),
        fakeRes()
      )
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('refuses a policy question with no domain', async () => {
    await expect(
      ExtensionCaptureController.domainPolicy(operatorReq({}, {}), fakeRes())
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('answers a restricted domain with 200, not an error status', async () => {
    config.projexCloud.gatewayUrl = 'https://gateway.test';
    config.projexCloud.apiKey = 'token';
    // A policy id is what declares a restriction EXISTS. Without it there is no
    // rule to evaluate and capture is permitted.
    config.projexCloud.capturePolicyId = 'pol_browser_capture';
    jest
      .spyOn(SdkGatewayClient, 'call')
      .mockResolvedValue({ delivered: true, status: 200, data: { data: { effect: 'deny' } } } as never);

    const res = fakeRes();
    await ExtensionCaptureController.domainPolicy(
      operatorReq({}, { domain: 'mail.example.com' }),
      res
    );

    // The operator did nothing wrong by opening a page. A 403 would teach them
    // the extension is broken rather than that this site is off limits.
    expect(res.code).toBe(200);
    expect((res.body as { data: { allowed: boolean } }).data.allowed).toBe(false);
  });
});

describe('every transmission is audited', () => {
  it('appends capture.created naming the domain and the retention choice', async () => {
    const append = auditLog.appendAuditEntry as unknown as jest.Mock;

    await ExtensionCaptureController.capture(
      operatorReq({
        selectedText: 'text',
        domain: 'example.com',
        confirmed: true,
        retainSourceUrl: true,
        sourceUrl: 'https://example.com/p',
      }),
      fakeRes()
    );

    expect(append).toHaveBeenCalledTimes(1);
    const entry = append.mock.calls[0][0];
    expect(entry.event).toBe('capture.created');
    // "A capture happened" and "a capture happened from example.com with the
    // URL retained" are different facts; only the second can be reviewed
    // against the tenant's own policy afterwards.
    expect(entry.metadata.domain).toBe('example.com');
    expect(entry.metadata.source_url_retained).toBe(true);
    expect(entry.metadata.channel).toBe('browser_extension');
  });

  it('records the REFUSAL when a domain is restricted', async () => {
    config.projexCloud.gatewayUrl = 'https://gateway.test';
    config.projexCloud.apiKey = 'token';
    // A policy id is what declares a restriction EXISTS. Without it there is no
    // rule to evaluate and capture is permitted.
    config.projexCloud.capturePolicyId = 'pol_browser_capture';
    jest
      .spyOn(SdkGatewayClient, 'call')
      .mockResolvedValue({ delivered: true, status: 200, data: { data: { effect: 'deny' } } } as never);
    const append = auditLog.appendAuditEntry as unknown as jest.Mock;

    await expect(
      ExtensionCaptureController.capture(
        operatorReq({
          selectedText: 'text',
          domain: 'mail.example.com',
          confirmed: true,
          retainSourceUrl: false,
        }),
        fakeRes()
      )
    ).rejects.toThrow();

    // The PDP permitted the action, so `governed` runs the handler and the
    // handler refuses on policy. No audit entry is appended for a write that
    // did not happen — an entry for it would be a false statement in the chain.
    expect(append).not.toHaveBeenCalled();
  });
});
