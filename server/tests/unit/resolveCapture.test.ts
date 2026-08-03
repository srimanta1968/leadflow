import { config } from '../../src/config/env';
import { railNodeFor, ResolveCaptureService } from '../../src/features/capture/resolveCaptureService';
import { ResolveCaptureController } from '../../src/features/capture/resolveCaptureController';
import { GovernedRequest } from '../../src/platform/policy/governed';
import * as auditLog from '../../src/platform/audit/auditLog';
import { SdkGatewayClient } from '../../src/services/projexcloud/SdkGatewayClient';
import { Response } from 'express';

/**
 * Resolving a capture — the governed step up the trust ladder.
 *
 * Each of these guards a criterion that fails SILENTLY if it regresses: a rail
 * that advances optimistically still renders, a parse that ignores a
 * correction still returns fields, and a merge still produces one tidy record.
 * None of them looks wrong on screen.
 */

function fakeRes(): Response {
  const res = { status: () => res, json: () => res };
  return res as unknown as Response;
}

function stewardReq(body: Record<string, unknown>, id = '11111111-1111-1111-1111-111111111111') {
  return {
    params: { id },
    body,
    query: {},
    session: { userId: 'u1', role: 'admin' },
    platformSession: { roles: ['data_steward'], personaId: 'persona-1', personId: 'p1' },
  } as unknown as GovernedRequest;
}

beforeEach(() => {
  jest.spyOn(auditLog, 'appendAuditEntry').mockResolvedValue({ delivered: true, entryRef: 'aud' });
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('the four-node rail', () => {
  it('maps each trust state to the node the record has actually reached', () => {
    expect(railNodeFor('P0_CAPTURED')).toBe('P0');
    expect(railNodeFor('P1_NORMALIZED')).toBe('P1');
    expect(railNodeFor('P2_CANDIDATE')).toBe('P2');
    expect(railNodeFor('P3_LINKED')).toBe('P3');
  });

  it('shows P4 at the last node rather than inventing a fifth', () => {
    // The rail answers "how far has this got", and P4 has got at least that
    // far. A fifth node the mockup does not have would be worse than this.
    expect(railNodeFor('P4_DIRECT')).toBe('P3');
  });

  it('treats an unrecognised state as UNTRUSTED, not as advanced', () => {
    // Failing optimistic would show a steward a governed decision as further
    // along than it is, which is the one direction that matters.
    expect(railNodeFor('SOMETHING_NEW' as never)).toBe('P0');
  });

  it('reports the state READ BACK from upstream, not the one we hoped for', async () => {
    config.projexCloud.gatewayUrl = 'https://gateway.test';
    config.projexCloud.apiKey = 'token';
    jest.spyOn(SdkGatewayClient, 'call').mockResolvedValue({
      delivered: true,
      status: 200,
      // Upstream DECLINED to advance it — it is still P0.
      data: { data: { source_record: { trust_state: 'P0_CAPTURED', normalized: {} } } },
    } as never);

    const result = await ResolveCaptureService.resolve({
      captureId: 'c1',
      stage: 'normalize',
      corrections: {},
    });

    // A screen that advanced its own rail would show P1 here and the steward
    // would adjudicate against a picture that is not true.
    expect(result.trustState).toBe('P0_CAPTURED');
    expect(result.rail.reachedNode).toBe('P0');
    expect(result.rail.fromUpstream).toBe(true);

    config.projexCloud.gatewayUrl = '';
    config.projexCloud.apiKey = '';
  });

  it('says when the state came from the local fallback rather than upstream', async () => {
    const result = await ResolveCaptureService.resolve({
      captureId: 'c1',
      stage: 'normalize',
      corrections: {},
    });

    expect(result.rail.fromUpstream).toBe(false);
  });
});

describe('steward corrections', () => {
  it('overrides the assistant proposal for the corrected field', async () => {
    config.projexCloud.gatewayUrl = 'https://gateway.test';
    config.projexCloud.apiKey = 'token';
    jest.spyOn(SdkGatewayClient, 'call').mockResolvedValue({
      delivered: true,
      status: 200,
      data: {
        data: {
          source_record: {
            trust_state: 'P1_NORMALIZED',
            normalized: { full_name: 'P. Raman', email: 'parsed@example.test' },
          },
        },
      },
    } as never);

    const result = await ResolveCaptureService.resolve({
      captureId: 'c1',
      stage: 'normalize',
      corrections: { full_name: 'Priyanka Raman-Shah' },
    });

    // The parse is a suggestion; the steward is the authority.
    expect(result.normalized.full_name).toBe('Priyanka Raman-Shah');
    // An uncorrected field keeps the assistant's value.
    expect(result.normalized.email).toBe('parsed@example.test');

    config.projexCloud.gatewayUrl = '';
    config.projexCloud.apiKey = '';
  });

  it('records WHICH fields the human changed, separately from the parse', async () => {
    const result = await ResolveCaptureService.resolve({
      captureId: 'c1',
      stage: 'normalize',
      corrections: { full_name: 'Corrected', phone: '+44 7700 900999' },
    });

    // Collapsing the two would erase the reviewer's contribution — the only
    // part with accountability attached to it.
    expect(result.correctedFields.sort()).toEqual(['full_name', 'phone']);
  });

  it('keeps a cleared field as a correction rather than dropping it', async () => {
    // "The parser found a phone number and it is wrong" is a real instruction.
    const result = await ResolveCaptureService.resolve({
      captureId: 'c1',
      stage: 'normalize',
      corrections: { phone: '' },
    });

    expect(result.correctedFields).toContain('phone');
    expect(result.normalized.phone).toBe('');
  });
});

describe('organization candidates', () => {
  it('PROPOSES a relationship and never merges', async () => {
    config.projexCloud.gatewayUrl = 'https://gateway.test';
    config.projexCloud.apiKey = 'token';
    jest.spyOn(SdkGatewayClient, 'call').mockResolvedValue({
      delivered: true,
      status: 200,
      data: {
        data: {
          organizations: [
            {
              organization_id: 'org-1',
              name: 'Raman Roofing Ltd',
              shared_signals: ['the domain', 'the phone prefix'],
            },
          ],
        },
      },
    } as never);

    const result = await ResolveCaptureService.resolve({
      captureId: 'c1',
      stage: 'search',
      corrections: {},
    });

    const candidate = result.organizationCandidate;
    // Asserted as an explicit negative. Merging two records is far harder to
    // undo than proposing an edge, and a shared domain is evidence of
    // association, not of identity.
    expect(candidate?.merged).toBe(false);
    expect(candidate?.proposedRelationship).toBe('REPRESENTS');
    expect(candidate?.relationshipState).toBe('proposed');
    // The rationale is for the steward, so it must say what the match does NOT
    // imply, not just what matched.
    expect(candidate?.rationale).toContain('not');

    config.projexCloud.gatewayUrl = '';
    config.projexCloud.apiKey = '';
  });

  it('returns no candidate rather than a speculative one when nothing matched', async () => {
    config.projexCloud.gatewayUrl = 'https://gateway.test';
    config.projexCloud.apiKey = 'token';
    jest
      .spyOn(SdkGatewayClient, 'call')
      .mockResolvedValue({ delivered: true, status: 200, data: { data: { organizations: [] } } } as never);

    const result = await ResolveCaptureService.resolve({
      captureId: 'c1',
      stage: 'search',
      corrections: {},
    });

    expect(result.organizationCandidate).toBeNull();

    config.projexCloud.gatewayUrl = '';
    config.projexCloud.apiKey = '';
  });
});

describe('promotion is audited and reversible', () => {
  it('returns the handle a retraction would quote', async () => {
    const result = await ResolveCaptureService.resolve({
      captureId: 'c1',
      stage: 'normalize',
      corrections: {},
    });

    // Produced WITH the promotion rather than looked up later: a reference that
    // has to be reconstructed after the fact is one nobody will have when they
    // need it. A promotion with no way back is a merge in disguise.
    expect(result.reversible).toBe(true);
    expect(result.reversalRef).toMatch(/^rev_/);
  });

  it('appends capture.promoted naming the steward and the corrected fields', async () => {
    const append = auditLog.appendAuditEntry as unknown as jest.Mock;

    await ResolveCaptureController.resolve(
      stewardReq({ stage: 'normalize', corrections: { email: 'fixed@example.test' } }),
      fakeRes()
    );

    expect(append).toHaveBeenCalledTimes(1);
    const entry = append.mock.calls[0][0];
    expect(entry.event).toBe('capture.promoted');
    expect(entry.actor).toBe('persona-1');
    // "A record was promoted" and "a record was promoted after the steward
    // corrected the email" are different facts; only the second explains it.
    expect(entry.metadata.corrected_fields).toEqual(['email']);
  });

  it('REFUSES a rep — promoting is the steward\'s decision', async () => {
    const rep = {
      params: { id: '11111111-1111-1111-1111-111111111111' },
      body: { stage: 'normalize' },
      query: {},
      session: { userId: 'u2', role: 'user' },
    } as unknown as GovernedRequest;

    await expect(ResolveCaptureController.resolve(rep, fakeRes())).rejects.toMatchObject({
      statusCode: 403,
    });
  });
});

describe('stage validation', () => {
  it('refuses an unknown stage rather than guessing which was meant', async () => {
    await expect(
      ResolveCaptureController.resolve(stewardReq({ stage: 'promote_everything' }), fakeRes())
    ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
  });

  it('refuses a missing stage — there is no safe default', async () => {
    // "normalize" is the commoner call, but guessing which half of a governed
    // promotion was meant advances a record nobody asked to advance.
    await expect(
      ResolveCaptureController.resolve(stewardReq({}), fakeRes())
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('refuses a capture id that is not a UUID', async () => {
    await expect(
      ResolveCaptureController.resolve(
        stewardReq({ stage: 'normalize' }, 'not-a-uuid'),
        fakeRes()
      )
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
