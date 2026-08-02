import { generateKeyPairSync, KeyObject } from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from '../../src/config/env';
import { JwksCache } from '../../src/platform/auth/jwksCache';
import { OidcDiscovery } from '../../src/platform/auth/oidcDiscovery';
import { verifyPlatformToken } from '../../src/platform/auth/sessionMiddleware';
import { toPlatformSession } from '../../src/platform/auth/sessionContext';
import { AppError } from '../../src/utils/errors';

/**
 * Session verification against ProjexCloud sdk-identity.
 *
 * Unit tests rather than api_definition cases on purpose: every rule here is
 * decided BEFORE any route runs, and most of them cannot be provoked from the
 * client side at all. An expired token can be waited for but not requested; a
 * key rotation is something the issuer does, not something a caller can ask
 * for. Per MUST-67 this is the "no HTTP surface" case where a unit test is the
 * only artifact that can make the assertion.
 *
 * Real RSA keys and real signatures throughout — nothing about jsonwebtoken is
 * stubbed. Only the network is replaced, because the two things under test are
 * exactly what we do with what the network returns.
 */

const ISSUER = 'https://identity.projexcloud.test';
const AUDIENCE = 'leadflow-app';

/** One RSA keypair plus the JWKS entry describing its public half. */
function makeKey(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  return { kid, privateKey, publicKey, jwk: { ...jwk, kid, use: 'sig', alg: 'RS256' } };
}

const KEY_A = makeKey('key-a');
const KEY_B = makeKey('key-b');

/** Claims a healthy sdk-identity token carries. */
function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: 'person:abc',
    iss: ISSUER,
    aud: AUDIENCE,
    iat: now,
    exp: now + 3600,
    tenant_id: 'tenant-1',
    person_id: 'person:abc',
    persona_id: 'persona:rep',
    roles: ['operator', 'rep'],
    business_unit_id: 'bu-north',
    ...overrides,
  };
}

function sign(
  payload: Record<string, unknown>,
  key: { privateKey: KeyObject; kid: string },
  options: jwt.SignOptions = {}
): string {
  return jwt.sign(payload, key.privateKey, {
    algorithm: 'RS256',
    keyid: key.kid,
    ...options,
  });
}

/** Counts of each URL fetched, so cache behaviour is observable. */
let fetchCounts: Record<string, number>;
/** Which keys the fake issuer currently publishes. */
let publishedKeys: Array<Record<string, unknown>>;

beforeEach(() => {
  config.projexCloud.identity.issuerUrl = ISSUER;
  config.projexCloud.identity.audience = AUDIENCE;
  config.projexCloud.identity.jwksTtlMs = 600_000;
  config.projexCloud.identity.clockToleranceSec = 5;

  fetchCounts = {};
  publishedKeys = [KEY_A.jwk];
  JwksCache.reset();
  OidcDiscovery.reset();

  global.fetch = jest.fn(async (input: unknown) => {
    const url = String(input);
    fetchCounts[url] = (fetchCounts[url] ?? 0) + 1;

    if (url.endsWith('/.well-known/openid-configuration')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ issuer: ISSUER, jwks_uri: `${ISSUER}/.well-known/jwks.json` }),
      } as unknown as Response;
    }
    if (url.endsWith('/.well-known/jwks.json')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ keys: publishedKeys }),
      } as unknown as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
});

afterEach(() => {
  config.projexCloud.identity.issuerUrl = '';
  jest.restoreAllMocks();
});

const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;

describe('platform session verification', () => {
  it('accepts a well-formed token and exposes tenant, person, persona and roles', async () => {
    const session = await verifyPlatformToken(sign(claims(), KEY_A));

    expect(session).toMatchObject({
      tenantId: 'tenant-1',
      personId: 'person:abc',
      personaId: 'persona:rep',
      roles: ['operator', 'rep'],
      businessUnitId: 'bu-north',
    });
  });

  it('rejects an expired token', async () => {
    const past = Math.floor(Date.now() / 1000) - 120;
    const token = sign(claims({ iat: past - 60, exp: past }), KEY_A);

    await expect(verifyPlatformToken(token)).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('rejects a token from a different issuer', async () => {
    const token = sign(claims({ iss: 'https://evil.example' }), KEY_A);

    await expect(verifyPlatformToken(token)).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('rejects a token minted for a different audience', async () => {
    // The subtle one: correctly signed by the real issuer, but issued for
    // ANOTHER application. Without an audience check, every sibling app's
    // tokens would be accepted here.
    const token = sign(claims({ aud: 'some-other-app' }), KEY_A);

    await expect(verifyPlatformToken(token)).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('refuses an unsigned token even though its claims are perfect', async () => {
    const token = jwt.sign(claims(), '', { algorithm: 'none' });

    await expect(verifyPlatformToken(token)).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('refuses an HS256 token signed with the published public key', async () => {
    // The alg-confusion attack. The RSA public key is published for anyone to
    // read, so if HS256 were accepted an attacker could use that public key as
    // an HMAC secret and mint whatever they liked. The algorithm allowlist is
    // what stops it.
    const publicPem = KEY_A.publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const forged = jwt.sign(claims(), publicPem, { algorithm: 'HS256', keyid: KEY_A.kid });

    await expect(verifyPlatformToken(forged)).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('does not say WHY it rejected a token', async () => {
    // The distinction between "expired" and "wrong audience" tells an attacker
    // which knob to turn. Operators get it from the log instead.
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const token = sign(claims({ aud: 'other' }), KEY_A);

    await expect(verifyPlatformToken(token)).rejects.toMatchObject({
      message: 'Session token is invalid or expired',
    });
  });

  it('rejects a verified token that names no tenant, rather than running unscoped', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { tenant_id: _dropped, ...withoutTenant } = claims();
    const token = sign(withoutTenant, KEY_A);

    await expect(verifyPlatformToken(token)).rejects.toBeInstanceOf(AppError);
  });
});

describe('JWKS caching and rotation', () => {
  it('reads the key set once and serves later requests from cache', async () => {
    await verifyPlatformToken(sign(claims(), KEY_A));
    await verifyPlatformToken(sign(claims(), KEY_A));
    await verifyPlatformToken(sign(claims(), KEY_A));

    expect(fetchCounts[JWKS_URL]).toBe(1);
  });

  it('picks up a rotated key without waiting for the TTL to lapse', async () => {
    await verifyPlatformToken(sign(claims(), KEY_A));
    expect(fetchCounts[JWKS_URL]).toBe(1);

    // The issuer rotates: it now signs with B and still publishes A for tokens
    // already in flight.
    publishedKeys = [KEY_A.jwk, KEY_B.jwk];
    const session = await verifyPlatformToken(sign(claims(), KEY_B));

    expect(session.tenantId).toBe('tenant-1');
    expect(fetchCounts[JWKS_URL]).toBe(2);
  });

  it('still accepts the outgoing key during a rotation window', async () => {
    publishedKeys = [KEY_A.jwk, KEY_B.jwk];

    await expect(verifyPlatformToken(sign(claims(), KEY_A))).resolves.toBeTruthy();
    await expect(verifyPlatformToken(sign(claims(), KEY_B))).resolves.toBeTruthy();
  });

  it('does not re-read the key set for every forged key id', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await verifyPlatformToken(sign(claims(), KEY_A));
    expect(fetchCounts[JWKS_URL]).toBe(1);

    // A stream of junk kids must not become a stream of requests to the
    // issuer — that is free amplification against our own IdP.
    for (let i = 0; i < 5; i += 1) {
      const forged = sign(claims(), { privateKey: KEY_B.privateKey, kid: `made-up-${i}` });
      await expect(verifyPlatformToken(forged)).rejects.toBeInstanceOf(AppError);
    }

    expect(fetchCounts[JWKS_URL]).toBe(2);
  });

  it('re-reads the key set once the TTL has lapsed', async () => {
    config.projexCloud.identity.jwksTtlMs = 0;

    await verifyPlatformToken(sign(claims(), KEY_A));
    await verifyPlatformToken(sign(claims(), KEY_A));

    expect(fetchCounts[JWKS_URL]).toBe(2);
  });

  it('reads the discovery document once, not per request', async () => {
    await verifyPlatformToken(sign(claims(), KEY_A));
    await verifyPlatformToken(sign(claims(), KEY_A));

    expect(fetchCounts[`${ISSUER}/.well-known/openid-configuration`]).toBe(1);
  });

  it('fails closed when the issuer is unreachable', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    JwksCache.reset();
    OidcDiscovery.reset();
    global.fetch = jest.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;

    // An outage must not become an authentication bypass.
    await expect(verifyPlatformToken(sign(claims(), KEY_A))).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });
  });

  it('survives a rotation that published one malformed key', async () => {
    // One bad entry must not lock every user out.
    publishedKeys = [{ kid: 'broken', kty: 'RSA', use: 'sig', n: 'not-base64!!', e: 'AQAB' }, KEY_A.jwk];

    await expect(verifyPlatformToken(sign(claims(), KEY_A))).resolves.toBeTruthy();
  });

  it('will not verify a signature with a key published for encryption', async () => {
    // Using an encryption key to check a signature is a category error, so an
    // `enc` entry is skipped entirely and asking for it is a miss.
    publishedKeys = [{ ...KEY_B.jwk, kid: 'enc-key', use: 'enc' }, KEY_A.jwk];

    await expect(JwksCache.getKey('enc-key', JWKS_URL)).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
    });
  });
});

describe('claim mapping', () => {
  it('reads space-delimited roles as well as an array', () => {
    const result = toPlatformSession({ ...claims(), roles: 'operator manager' });

    expect('session' in result && result.session.roles).toEqual(['operator', 'manager']);
  });

  it('falls back to sub when the token names no person', () => {
    const { person_id: _dropped, ...rest } = claims();
    const result = toPlatformSession(rest);

    expect('session' in result && result.session.personId).toBe('person:abc');
  });

  it('reports no roles as an empty list, never as unrestricted', () => {
    const { roles: _dropped, ...rest } = claims();
    const result = toPlatformSession(rest);

    expect('session' in result && result.session.roles).toEqual([]);
  });

  it('refuses to build a session with no tenant', () => {
    const { tenant_id: _dropped, ...rest } = claims();

    expect(toPlatformSession(rest)).toEqual({ error: 'Session token names no tenant' });
  });
});
