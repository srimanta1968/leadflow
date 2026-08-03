import fs from 'fs';
import path from 'path';
import {
  PROVIDER_CREDENTIALS,
  providerRegistryView,
  secretRefFor,
} from '../../src/config/providers';
import { revealPii } from '../../src/platform/secrets/piiVault';
import { SdkGatewayClient } from '../../src/services/projexcloud/SdkGatewayClient';

afterEach(() => {
  jest.restoreAllMocks();
  for (const provider of PROVIDER_CREDENTIALS) {
    delete process.env[provider.refEnvVar];
  }
});

/** Every TypeScript source file under server/src. */
function sourceFiles(): { file: string; content: string }[] {
  const root = path.join(__dirname, '..', '..', 'src');
  const out: { file: string; content: string }[] = [];
  const walk = (dir: string): void => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        walk(full);
      } else if (item.name.endsWith('.ts')) {
        out.push({ file: full, content: fs.readFileSync(full, 'utf8') });
      }
    }
  };
  walk(root);
  return out;
}

describe('credential custody', () => {
  /**
   * The repository scan the acceptance criterion asks for.
   *
   * Patterns are the vendors' own documented key prefixes, so a real key
   * matches and a variable NAMED like a key does not. Matching on names would
   * fire on every mention of SENDGRID_SECRET_REF and train people to ignore it.
   */
  it('finds no raw provider secret anywhere in the source', () => {
    const secretShapes: [string, RegExp][] = [
      ['SendGrid API key', /\bSG\.[A-Za-z0-9_-]{20,}/],
      ['Stripe live key', /\bsk_live_[A-Za-z0-9]{20,}/],
      ['Stripe test key', /\bsk_test_[A-Za-z0-9]{20,}/],
      ['Twilio account SID', /\bAC[a-f0-9]{32}\b/],
      ['Google API key', /\bAIza[A-Za-z0-9_-]{35}/],
      ['Private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
      ['AWS access key', /\bAKIA[A-Z0-9]{16}\b/],
    ];

    const findings: string[] = [];
    for (const { file, content } of sourceFiles()) {
      for (const [label, pattern] of secretShapes) {
        if (pattern.test(content)) {
          findings.push(`${label} in ${path.basename(file)}`);
        }
      }
    }

    expect(findings).toEqual([]);
  });

  it('names every credential variable as a REF, so a pointer is distinguishable from a key', () => {
    // A variable called SENDGRID_API_KEY invites somebody to paste the real key.
    for (const provider of PROVIDER_CREDENTIALS) {
      expect(provider.refEnvVar).toMatch(/_SECRET_REF$/);
    }
  });

  it('reports only whether a provider is configured, never any part of the value', () => {
    process.env.SENDGRID_SECRET_REF = 'ref_abc123secretpointer';

    const view = providerRegistryView();
    const sendgrid = view.find((entry) => entry.key === 'sendgrid');

    expect(sendgrid?.configured).toBe(true);
    // Not even a masked form: a mask leaks the prefix and the last four, which
    // is enough to confirm a guess.
    expect(JSON.stringify(view)).not.toContain('ref_abc123secretpointer');
  });

  it('treats an unset reference as not configured rather than throwing', () => {
    expect(secretRefFor('sendgrid')).toBeNull();
    expect(secretRefFor('no_such_provider')).toBeNull();
  });
});

describe('revealing PII', () => {
  it('writes the audit entry BEFORE returning the plaintext', async () => {
    jest.spyOn(SdkGatewayClient, 'isConfigured').mockReturnValue(true);
    const order: string[] = [];
    jest.spyOn(SdkGatewayClient, 'call').mockImplementation(async (options) => {
      order.push(options.sdk);
      if (options.sdk === 'sdk-vault') {
        return {
          delivered: true,
          status: 200,
          data: { data: { plaintext: '+15551234567' } },
        } as never;
      }
      return { delivered: true, status: 201, data: null } as never;
    });

    const result = await revealPii('cipher-abc', {
      actor: 'person:ada',
      personaRole: 'sales_rep',
      purpose: 'project_operations',
      decisionRef: 'pdp_9',
      subjectId: 'person:bob',
      causationId: 'cause-9',
    });

    expect(result.value).toBe('+15551234567');
    // A crash between the two must not leave a value on somebody's screen with
    // no record that they saw it.
    expect(order[0]).toBe('sdk-audit');
    expect(order[1]).toBe('sdk-vault');
  });

  it('never puts the plaintext in the audit entry', async () => {
    jest.spyOn(SdkGatewayClient, 'isConfigured').mockReturnValue(true);
    const call = jest.spyOn(SdkGatewayClient, 'call').mockImplementation(async (options) => {
      if (options.sdk === 'sdk-vault') {
        return {
          delivered: true,
          status: 200,
          data: { data: { plaintext: 'SENSITIVE-VALUE' } },
        } as never;
      }
      return { delivered: true, status: 201, data: null } as never;
    });

    await revealPii('cipher-abc', {
      actor: 'person:ada',
      personaRole: 'privacy_officer',
      purpose: 'claim_assistance',
      decisionRef: 'pdp_10',
      subjectId: 'person:bob',
      causationId: 'cause-10',
    });

    const auditCall = call.mock.calls.find((args) => args[0].sdk === 'sdk-audit');
    // An audit trail that quotes the value it protects is a second copy of it.
    expect(JSON.stringify(auditCall?.[0].body)).not.toContain('SENSITIVE-VALUE');
  });

  it('names the actor, the role and the purpose on the entry', async () => {
    jest.spyOn(SdkGatewayClient, 'isConfigured').mockReturnValue(true);
    const call = jest
      .spyOn(SdkGatewayClient, 'call')
      .mockResolvedValue({ delivered: true, status: 200, data: null });

    await revealPii('cipher-abc', {
      actor: 'person:ada',
      personaRole: 'data_steward',
      purpose: 'inspection_estimate',
      decisionRef: 'pdp_11',
      subjectId: 'person:bob',
      causationId: 'cause-11',
    });

    const body = call.mock.calls.find((args) => args[0].sdk === 'sdk-audit')?.[0].body as Record<
      string,
      unknown
    >;
    expect(body.event_type).toBe('pii.revealed');
    // The stamps sit inside sdk-audit's `payload` envelope.
    const payload = body.payload as Record<string, unknown>;
    expect(payload.actor_id).toBe('person:ada');
    expect(payload.purpose).toBe('inspection_estimate');
    expect(payload.persona_role).toBe('data_steward');
  });

  it('still records the look when decryption then fails', async () => {
    jest.spyOn(SdkGatewayClient, 'isConfigured').mockReturnValue(true);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(SdkGatewayClient, 'call').mockImplementation(async (options) => {
      if (options.sdk === 'sdk-vault') {
        throw new Error('vault down');
      }
      return { delivered: true, status: 201, data: null } as never;
    });

    const result = await revealPii('cipher-abc', {
      actor: 'person:ada',
      personaRole: 'sales_rep',
      purpose: 'project_operations',
      decisionRef: 'pdp_12',
      subjectId: 'person:bob',
      causationId: 'cause-12',
    });

    // Over-recording an attempted look is the harmless direction.
    expect(result.value).toBeNull();
    expect(result.auditRef).toMatch(/^aud_/);
  });
});
