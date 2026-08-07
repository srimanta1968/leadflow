import fs from 'fs';
import path from 'path';

/**
 * The gateway boundary gate — acceptance criterion 3.
 *
 * "A lint rule fails any raw fetch or axios call to a ProjexCloud host outside
 * this client." This is that rule, written as a test rather than as an ESLint
 * rule, because `npm run lint` in this package runs `eslint src --ext .ts` and
 * ESLint IS NOT INSTALLED — the script fails with "'eslint' is not recognized".
 * A rule added to a linter that never executes is a green gate guarding nothing,
 * which is the exact failure mode this task is about. Here it runs on every
 * commit and in CI, and it moves across unchanged if ESLint is adopted.
 *
 * WHY THE BOUNDARY IS WORTH ENFORCING AT ALL. Everything that makes an outbound
 * call safe lives in platform/sdkGateway and nowhere else: the credential and its
 * refresh, the idempotency key that is minted once and reused across retries, the
 * per-SDK circuit breaker, redaction before logging, and the mapping from an
 * upstream status to a LeadFlow error code. A bare `fetch` written "just for this
 * one call" silently opts out of all six — and the sixth is the one that hurts,
 * because an unredacted log line of a ProjexCloud response is a disclosure of
 * whatever personal data that SDK returned.
 */

const SRC = path.resolve(__dirname, '../../src');
const GATEWAY = path.join(SRC, 'platform', 'sdkGateway');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

const rel = (f: string) => path.relative(SRC, f).replace(/\\/g, '/');

/**
 * Files allowed to open their own HTTP connection, with the reason.
 *
 * Typing the reason out is the mechanism. Adding to this list is a visible
 * decision in a diff; forgetting to route a call through the gateway is not.
 */
const ALLOWED_RAW_HTTP = new Map([
  [
    'platform/auth/oidcDiscovery.ts',
    'Reads the identity issuer\'s public discovery document. It cannot go through '
    + 'the gateway: the gateway call needs a verified token, and verifying a token '
    + 'needs this document — routing it would be a cycle. The endpoint is '
    + 'unauthenticated and returns no personal data.',
  ],
  [
    'platform/auth/jwksCache.ts',
    'Reads the issuer\'s public signing keys, for the same reason and with the '
    + 'same cycle. Public keys, by definition.',
  ],
]);

describe('every ProjexCloud call goes through the gateway', () => {
  const files = sourceFiles(SRC).filter((f) => !f.startsWith(GATEWAY));

  it('has no raw fetch or axios outside platform/sdkGateway', () => {
    const offenders = files
      .filter((f) => {
        const text = fs.readFileSync(f, 'utf8');
        // `await fetch(` / `fetch(` as a call, not `SomeClass.fetch(` — the
        // private helper named `fetch` inside JwksCache is matched by the
        // allowlist anyway, but a method call on an object is not the global.
        const rawFetch = /(?<![.\w])fetch\s*\(/.test(text);
        const axios = /\bfrom ['"]axios['"]|\baxios\s*\./.test(text);
        return rawFetch || axios;
      })
      .map(rel)
      .filter((r) => !ALLOWED_RAW_HTTP.has(r));

    // The offending paths ARE the asserted value. Jest's expect takes no message
    // argument, so the only way a failure names the files is to assert on a
    // string built from them.
    expect(offenders.join('\n')).toBe('');
  });

  it('keeps the exception list honest', () => {
    // A stale exception is how a list like this stops meaning anything.
    const stale = [...ALLOWED_RAW_HTTP.keys()].filter((r) => {
      const full = path.join(SRC, r);
      if (!fs.existsSync(full)) return true;
      const text = fs.readFileSync(full, 'utf8');
      return !/(?<![.\w])fetch\s*\(/.test(text) && !/\baxios\b/.test(text);
    });
    expect(stale.join('\n')).toBe('');
  });

  it('lets nothing else read the ProjexCloud credential', () => {
    // Even without a fetch, a module that reads the API key can hand it to
    // something that does. The credential belongs to the gateway alone.
    const offenders = files
      .filter((f) => /config\.projexCloud\.apiKey|PROJEXCLOUD_API_KEY/.test(fs.readFileSync(f, 'utf8')))
      .map(rel)
      // env.ts is where the value is READ FROM THE ENVIRONMENT — it has to name it.
      .filter((r) => r !== 'config/env.ts');

    expect(offenders.join('\n')).toBe('');
  });

  it('points every caller at the gateway package', () => {
    // The old path (services/projexcloud/SdkGatewayClient) is gone. A lingering
    // import of it would be a compile error today, but this states the intent so
    // a re-creation of that module is caught as a policy break rather than
    // quietly becoming a second front door.
    const offenders = files
      .filter((f) => /services\/projexcloud/.test(fs.readFileSync(f, 'utf8')))
      .map(rel);
    expect(offenders.join('\n')).toBe('');
  });

  it('CAN fail — a deliberate violation is caught', () => {
    // Proves the detector matches the thing it claims to. Without this the suite
    // could pass because the regex is broken rather than because the code is clean.
    const violation = 'const r = await fetch(`${base}/api/source-records`);';
    expect(/(?<![.\w])fetch\s*\(/.test(violation)).toBe(true);
    expect(/(?<![.\w])fetch\s*\(/.test('await SdkGatewayClient.call({ sdk })')).toBe(false);
    // A method named fetch on an object is NOT the global, and must not be flagged.
    expect(/(?<![.\w])fetch\s*\(/.test('JwksCache.fetch(uri)')).toBe(false);
  });
});
