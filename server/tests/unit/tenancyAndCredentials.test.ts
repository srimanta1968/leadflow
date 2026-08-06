import { config } from '../../src/config/env';
import { SdkGatewayClient } from '../../src/services/projexcloud/SdkGatewayClient';
import {
  resolveTenantContext,
  tenantIdFor,
  isHierarchySplit,
} from '../../src/platform/tenancy/tenantHierarchy';

/**
 * Tenancy scoping and machine-credential exchange.
 *
 * Both encode rules stated in ProjexCloud's own agent guide, and both fail
 * silently if got wrong — a mis-scoped tenant leaks between a customer's apps,
 * and an unexchanged API key looks exactly like an unconfigured gateway.
 */

const ORIGINAL_KEY = config.projexCloud.apiKey;
const ORIGINAL_URL = config.projexCloud.gatewayUrl;
const ORIGINAL_APP = config.projexCloud.appId;

afterEach(() => {
  config.projexCloud.apiKey = ORIGINAL_KEY;
  config.projexCloud.gatewayUrl = ORIGINAL_URL;
  config.projexCloud.appId = ORIGINAL_APP;
  SdkGatewayClient.resetCredential();
  jest.restoreAllMocks();
});

describe('tenant hierarchy', () => {
  it('collapses root and app while a customer owns one app', () => {
    const context = resolveTenantContext('tenant-1', 'app-1');

    expect(context.rootTenantId).toBe('tenant-1');
    expect(isHierarchySplit(context)).toBe(false);
  });

  it('keeps them distinct once the customer is split', () => {
    const context = resolveTenantContext('tenant-leadflow', 'app-leadflow', 'tenant-customer');

    expect(isHierarchySplit(context)).toBe(true);
  });

  it('scopes operational records to the APP, so sibling apps cannot see them', () => {
    const context = resolveTenantContext('tenant-leadflow', 'app-leadflow', 'tenant-customer');

    // A lead captured in LeadFlow must not be visible to the customer's other
    // product; that isolation is the reason for the split.
    for (const concern of ['lead', 'routing', 'sla', 'consent', 'audit'] as const) {
      expect(tenantIdFor(context, concern)).toBe('tenant-leadflow');
    }
  });

  it('scopes billing and the org chart to the CUSTOMER', () => {
    const context = resolveTenantContext('tenant-leadflow', 'app-leadflow', 'tenant-customer');

    // Otherwise one customer becomes several payers and gets an invoice per app.
    for (const concern of ['billing', 'org_chart', 'cross_app_report'] as const) {
      expect(tenantIdFor(context, concern)).toBe('tenant-customer');
    }
  });

  it('keeps the audit chain app-scoped, not customer-scoped', () => {
    const context = resolveTenantContext('tenant-leadflow', 'app-leadflow', 'tenant-customer');

    // A cross-app ledger would let one app's operator read another's activity.
    expect(tenantIdFor(context, 'audit')).not.toBe('tenant-customer');
  });

  it('falls back NARROW for an unrecognised concern', () => {
    const context = resolveTenantContext('tenant-leadflow', 'app-leadflow', 'tenant-customer');

    // Guessing wide leaks between apps; guessing narrow merely fails to find.
    expect(tenantIdFor(context, 'something_new' as never)).toBe('tenant-leadflow');
  });
});

describe('machine credential exchange', () => {
  it('passes a JWT straight through without exchanging', async () => {
    config.projexCloud.gatewayUrl = 'https://gateway.test';
    config.projexCloud.apiKey = 'eyJhbGciOiJIUzI1NiJ9.body.sig';
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: {} }),
    })) as unknown as typeof fetch;
    global.fetch = fetchMock;

    await SdkGatewayClient.call({ sdk: 'sdk-x', path: '/api/thing', method: 'GET' });

    // One call: the endpoint. No exchange, because a JWT is already a bearer.
    expect((fetchMock as unknown as jest.Mock).mock.calls).toHaveLength(1);
  });

  it('exchanges a pk_ key for a token before calling', async () => {
    config.projexCloud.gatewayUrl = 'https://gateway.test';
    config.projexCloud.apiKey = 'pk_test_abc123';
    config.projexCloud.appId = 'app-1';

    const calls: string[] = [];
    global.fetch = jest.fn(async (url: unknown, init?: unknown) => {
      calls.push(String(url));
      if (String(url).endsWith('/api/auth/token')) {
        const body = JSON.parse(String((init as { body?: string })?.body ?? '{}'));
        // The APPLICATION owns the key, so the application id is the client.
        expect(body.grant_type).toBe('client_credentials');
        expect(body.client_id).toBe('app-1');
        expect(body.client_secret).toBe('pk_test_abc123');
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'machine-token', expires_in: 3600 }),
        } as never;
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: {} }) } as never;
    }) as unknown as typeof fetch;

    await SdkGatewayClient.call({ sdk: 'sdk-x', path: '/api/thing', method: 'GET' });

    // A bare pk_ key sent as a bearer is refused with 403 by the real gateway,
    // so the exchange is not optional.
    expect(calls[0]).toContain('/api/auth/token');
    expect(calls[1]).toContain('/api/thing');
  });

  it('reuses the exchanged token across calls rather than trading every time', async () => {
    config.projexCloud.gatewayUrl = 'https://gateway.test';
    config.projexCloud.apiKey = 'pk_live_abc123';
    config.projexCloud.appId = 'app-1';

    let exchanges = 0;
    global.fetch = jest.fn(async (url: unknown) => {
      if (String(url).endsWith('/api/auth/token')) {
        exchanges += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'machine-token', expires_in: 3600 }),
        } as never;
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: {} }) } as never;
    }) as unknown as typeof fetch;

    await SdkGatewayClient.call({ sdk: 'sdk-x', path: '/api/a', method: 'GET' });
    await SdkGatewayClient.call({ sdk: 'sdk-x', path: '/api/b', method: 'GET' });
    await SdkGatewayClient.call({ sdk: 'sdk-x', path: '/api/c', method: 'GET' });

    expect(exchanges).toBe(1);
  });

  it('re-exchanges once the token is inside the expiry skew', async () => {
    config.projexCloud.gatewayUrl = 'https://gateway.test';
    config.projexCloud.apiKey = 'pk_live_abc123';
    config.projexCloud.appId = 'app-1';

    let exchanges = 0;
    global.fetch = jest.fn(async (url: unknown) => {
      if (String(url).endsWith('/api/auth/token')) {
        exchanges += 1;
        // Expires inside the skew window, so it is already treated as stale.
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: `t${exchanges}`, expires_in: 10 }),
        } as never;
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: {} }) } as never;
    }) as unknown as typeof fetch;

    await SdkGatewayClient.call({ sdk: 'sdk-x', path: '/api/a', method: 'GET' });
    await SdkGatewayClient.call({ sdk: 'sdk-x', path: '/api/b', method: 'GET' });

    // Refreshing exactly at expiry loses the race against a request in flight.
    expect(exchanges).toBe(2);
  });

  it('fails the call when the exchange cannot produce a credential', async () => {
    config.projexCloud.gatewayUrl = 'https://gateway.test';
    config.projexCloud.apiKey = 'pk_live_abc123';
    config.projexCloud.appId = 'app-1';
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    global.fetch = jest.fn(async () => ({ ok: false, status: 401 })) as unknown as typeof fetch;

    // Better to refuse than to send a credential the gateway will reject and
    // have the caller read a 403 as "no data".
    await expect(
      SdkGatewayClient.call({ sdk: 'sdk-x', path: '/api/thing', method: 'GET' })
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  });
});

/**
 * A non-ok response used to collapse to a bare `returned <status>`, discarding a
 * body that said exactly what was wrong. Callers branch on the reason —
 * eventTypeProvisioner distinguishes a benign baseline collision from a real
 * validation failure, and both arrive as 400 — so the reason has to survive.
 */
describe('an upstream refusal', () => {
  const gatewayReturns = (status: number, body: unknown, asText?: string) => {
    config.projexCloud.gatewayUrl = 'https://gateway.test';
    config.projexCloud.apiKey = 'eyJhbGciOiJIUzI1NiJ9.body.sig';
    global.fetch = jest.fn(async () => ({
      ok: false,
      status,
      text: async () => asText ?? JSON.stringify(body),
    })) as unknown as typeof fetch;
  };

  const callIt = () =>
    SdkGatewayClient.call({ sdk: 'sdk-audit', path: '/api/events/types', method: 'POST' });

  /** The message of the refusal, or a marker if the call unexpectedly resolved. */
  const refusalMessage = async (): Promise<string> => {
    try {
      await callIt();
      return '<resolved, but a refusal was expected>';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  it('carries the reason the gateway gave, not just the status', async () => {
    // The real shape from POST /api/events/types.
    gatewayReturns(400, {
      error: 'ValidationError',
      details: [
        "event_type 'handoff.accepted.v1' is a platform baseline type and cannot be redefined by a tenant. It is already usable as-is.",
      ],
    });

    await expect(callIt()).rejects.toThrow(/returned 400: .*platform baseline type/);
  });

  it('joins several details rather than reporting only the first', async () => {
    gatewayReturns(400, {
      error: 'ValidationError',
      details: ['retention_class must be one of transient, operational, regulated', 'schema_version must be an integer >= 1'],
    });

    const message = await refusalMessage();

    expect(message).toContain('retention_class must be one of');
    expect(message).toContain('schema_version must be an integer');
  });

  it('reads the other envelopes the gateway emits', async () => {
    gatewayReturns(500, { error: 'InternalError' });
    await expect(callIt()).rejects.toThrow('returned 500: InternalError');

    gatewayReturns(404, { error: { code: 'NotFound', message: 'no such route' } });
    await expect(callIt()).rejects.toThrow('returned 404: no such route');

    gatewayReturns(409, { message: 'already registered' });
    await expect(callIt()).rejects.toThrow('returned 409: already registered');
  });

  it('keeps the STATUS when the body is not JSON at all', async () => {
    // An nginx error page used to throw inside JSON.parse, get caught as a
    // transport failure, and report "is unavailable" — losing the one fact
    // worth keeping. `returned <status>` is what isAlreadyExists matches on.
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    gatewayReturns(502, null, '<html><body>502 Bad Gateway</body></html>');

    await expect(callIt()).rejects.toThrow(/returned 502/);
  });

  it('clamps a runaway body so one refusal cannot flood the log', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    gatewayReturns(500, null, 'x'.repeat(5000));

    const message = await refusalMessage();

    expect(message.length).toBeLessThan(700);
    expect(message).toContain('…');
  });

  it('still says `returned <status>` in the form the provisioners match', async () => {
    // roleProvisioner and purposeProvisioner both test /returned (409|422)\b/.
    // Appending `: <detail>` must not break that word boundary.
    gatewayReturns(409, { error: 'Conflict', details: ['role template exists'] });

    const message = await refusalMessage();

    expect(/returned (409|422)\b/.test(message)).toBe(true);
  });
});
