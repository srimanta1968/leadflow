import fs from 'fs';
import path from 'path';
import { CONSENT_PURPOSES, isKnownPurpose, serviceNecessaryPurposes } from '../../src/config/consentPurposes';
import { AUDIT_EVENTS, allAuditEventNames, isAuditEventName } from '../../src/platform/audit/vocabulary';
import { appendAuditEntry, verifyAuditChain, AuditEntry } from '../../src/platform/audit/auditLog';
import { provisionConsentPurposes } from '../../src/platform/consent/purposeProvisioner';
import { SdkGatewayClient } from '../../src/services/projexcloud/SdkGatewayClient';
import { AppError, ErrorCodes } from '../../src/utils/errors';

afterEach(() => {
  jest.restoreAllMocks();
});

/** A complete entry, so a test can vary one field at a time. */
function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    event: AUDIT_EVENTS.CAPTURE_CREATED,
    actor: 'person:ada',
    personaRole: 'sales_rep',
    purpose: 'inspection_estimate',
    decisionRef: 'pdp_1',
    evidenceRef: 'evidence:1',
    causationId: 'cause-1',
    idempotencyRef: 'idem-1',
    ...overrides,
  };
}

describe('the audit vocabulary', () => {
  it('holds every governed event from the Audit Timeline', () => {
    // Hardcoded so that EXTENDING the vocabulary is a deliberate act: adding a
    // name fails this until someone updates the count, which is the moment to
    // ask whether the new name duplicates one already here.
    //
    // 19 originally; 13 added when the routing and SLA handlers were brought
    // under `governed` — the ledger could describe what happened to a lead's
    // data but not who decided who would work it.
    //
    // 6 more for the AI agent modules. The SOP allows AI to suggest and
    // requires a qualified human to review consequential outputs, so the ledger
    // has to separate the two: `ai.draft.proposed` is a machine act and
    // `ai.draft.accepted` is a person taking responsibility for it. One
    // combined name would leave the only question anybody asks after a bad
    // send — did a human read this — unanswerable.
    //
    // 6 more for the AI foundation. `ai.draft.*` names a DRAFT, which was right
    // while the only consequential output was a message; the review gate takes
    // scores, summaries, next actions and offer-term changes too, and it names
    // the REJECTION, which the draft pair never did.
    //
    // 2 more for the Manager and RevOps modules. Two names rather than one
    // `ai.analysis.run`: "who was watching the team's queue" and "where did this
    // routing proposal come from" are asked separately, and one combined name
    // would make each query return the other's rows.
    expect(allAuditEventNames()).toHaveLength(46);
    expect(isAuditEventName('capture.created')).toBe(true);
    expect(isAuditEventName('sla.breached')).toBe(true);
    expect(isAuditEventName('lead.routed')).toBe(true);
    expect(isAuditEventName('sla.policy.updated')).toBe(true);
    expect(isAuditEventName('ai.draft.proposed')).toBe(true);
    // A refusal is an event too: an absent entry cannot distinguish "we
    // declined to process this call" from "nobody ever asked", and only the
    // first is evidence the consent gate is working.
    expect(isAuditEventName('ai.coach.refused_no_consent')).toBe(true);
    // A rejection and an acceptance are the same event name with a different
    // outcome in the metadata; pulling the kill switch is its own.
    expect(isAuditEventName('ai.proposal.decided')).toBe(true);
    expect(isAuditEventName('ai.kill_switch.engaged')).toBe(true);
  });

  it('rejects a plausible-looking name that is not canonical', () => {
    // The failure this vocabulary exists to prevent: three spellings of one
    // event, none of them queryable together. Each of these is a near-miss for a
    // name that IS canonical.
    expect(isAuditEventName('lead.route')).toBe(false);
    expect(isAuditEventName('routing.applied')).toBe(false);
    expect(isAuditEventName('sla.policy.update')).toBe(false);
    expect(isAuditEventName('capture.create')).toBe(false);
    expect(isAuditEventName('Capture.Created')).toBe(false);
  });

  it('uses dot-delimited lower snake case throughout, with no duplicates', () => {
    const names = allAuditEventNames();

    for (const name of names) {
      expect(name).toMatch(/^[a-z]+(\.[a-z_]+)+$/);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  /**
   * The lint rule the acceptance criterion asks for, in executable form.
   *
   * A grep over the platform source for an audit append whose event is a string
   * literal rather than a vocabulary constant. Written as a test rather than an
   * ESLint rule because it runs in the same command everything else does, and a
   * lint rule nobody runs is not enforcement.
   */
  it('is the only source of event names used in the codebase', () => {
    const auditDir = path.join(__dirname, '..', '..', 'src', 'platform');
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) {
          walk(full);
          continue;
        }
        if (!item.name.endsWith('.ts') || item.name === 'vocabulary.ts') {
          continue;
        }
        const source = fs.readFileSync(full, 'utf8');
        // `event:` assigned a raw quoted string instead of AUDIT_EVENTS.X
        const rawLiteral = /\bevent:\s*['"][^'"]+['"]/.exec(source);
        if (rawLiteral) {
          offenders.push(`${item.name}: ${rawLiteral[0]}`);
        }
      }
    };

    walk(auditDir);

    expect(offenders).toEqual([]);
  });
});

describe('appending an entry', () => {
  it('stamps all seven required fields on the outbound entry', () => {
    // Enforced by the type system first — an entry missing any of these does
    // not compile — and asserted here so the wire shape cannot drift.
    const required: (keyof AuditEntry)[] = [
      'actor',
      'personaRole',
      'purpose',
      'decisionRef',
      'evidenceRef',
      'causationId',
      'idempotencyRef',
    ];

    for (const field of required) {
      expect(entry()[field]).toBeTruthy();
    }
  });

  it('sends the act key as the idempotency key, so a retry lands once', async () => {
    jest.spyOn(SdkGatewayClient, 'isConfigured').mockReturnValue(true);
    const call = jest
      .spyOn(SdkGatewayClient, 'call')
      .mockResolvedValue({ delivered: true, status: 201, data: null });

    await appendAuditEntry(entry({ idempotencyRef: 'act-42' }));

    expect(call.mock.calls[0][0]).toMatchObject({ sdk: 'sdk-audit', idempotencyKey: 'act-42' });
    const body = call.mock.calls[0][0].body as Record<string, unknown>;
    // event_type and pool_index are sdk-audit's envelope; the seven stamps
    // travel inside `payload`. Which envelope carries them was never the point
    // — the point is that a governed action cannot omit any of them.
    expect(body.event_type).toBe('capture.created');
    expect(body.pool_index).toBeTruthy();
    const payload = body.payload as Record<string, unknown>;
    expect(payload.decision_ref).toBe('pdp_1');
    expect(payload.causation_id).toBe('cause-1');
  });

  it('never throws when the ledger is unreachable', async () => {
    jest.spyOn(SdkGatewayClient, 'isConfigured').mockReturnValue(true);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest
      .spyOn(SdkGatewayClient, 'call')
      .mockRejectedValue(new AppError(502, ErrorCodes.UPSTREAM_UNAVAILABLE, 'down'));

    // The write already happened; failing it afterwards would leave the system
    // in a state the caller was told did not occur.
    const result = await appendAuditEntry(entry());

    expect(result.delivered).toBe(false);
    expect(result.entryRef).toMatch(/^aud_/);
  });
});

describe('nightly chain verification', () => {
  it('reports an intact chain', async () => {
    jest.spyOn(SdkGatewayClient, 'isConfigured').mockReturnValue(true);
    jest
      .spyOn(SdkGatewayClient, 'call')
      .mockResolvedValue({ delivered: true, status: 200, data: { data: { intact: true } } });

    await expect(verifyAuditChain()).resolves.toMatchObject({ intact: true });
  });

  it('opens an incident when the chain does not verify', async () => {
    jest.spyOn(SdkGatewayClient, 'isConfigured').mockReturnValue(true);
    const call = jest.spyOn(SdkGatewayClient, 'call').mockImplementation(async (options) => {
      if (options.sdk === 'sdk-audit') {
        return {
          delivered: true,
          status: 200,
          data: { data: { intact: false, detail: 'hash mismatch at seq 41' } },
        } as never;
      }
      return { delivered: true, status: 201, data: { data: { incident_id: 'inc-7' } } } as never;
    });

    const result = await verifyAuditChain();

    expect(result.intact).toBe(false);
    expect(result.incidentRef).toBe('inc-7');
    // A broken hash chain needs a person, not a log line among the successes.
    expect(call.mock.calls.some((args) => args[0].sdk === 'sdk-incident')).toBe(true);
  });

  it('treats an unreachable verifier as NOT verified', async () => {
    jest.spyOn(SdkGatewayClient, 'isConfigured').mockReturnValue(true);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(SdkGatewayClient, 'call').mockRejectedValue(new Error('timeout'));

    // A silent outage must not masquerade as a clean bill of health.
    await expect(verifyAuditChain()).resolves.toMatchObject({ intact: false });
  });
});

describe('the consent purpose registry', () => {
  it('defines exactly the six LeadFlow purposes', () => {
    expect(CONSENT_PURPOSES.map((p) => p.key)).toEqual([
      'inspection_estimate',
      'appointment_updates',
      'project_operations',
      'claim_assistance',
      'seasonal_promotions',
      'referral_program',
    ]);
  });

  it('keeps promotions and referrals elective', () => {
    // Someone who asked for an estimate has not asked for marketing, so these
    // two must never be defaulted on with the service purposes.
    const necessary = serviceNecessaryPurposes().map((p) => p.key);

    expect(necessary).not.toContain('seasonal_promotions');
    expect(necessary).not.toContain('referral_program');
    expect(necessary).toHaveLength(4);
  });

  it('rejects a purpose outside the registry', () => {
    expect(isKnownPurpose('marketing')).toBe(false);
    expect(isKnownPurpose('inspection_estimate')).toBe(true);
  });

  it('registers every purpose at boot and is idempotent on restart', async () => {
    jest.spyOn(SdkGatewayClient, 'isConfigured').mockReturnValue(true);
    jest
      .spyOn(SdkGatewayClient, 'call')
      .mockRejectedValue(
        new AppError(502, ErrorCodes.UPSTREAM_UNAVAILABLE, 'ProjexCloud sdk-consent returned 409')
      );

    const summary = await provisionConsentPurposes();

    expect(summary.alreadyPresent).toBe(6);
    expect(summary.created).toBe(0);
    expect(summary.failed).toBe(0);
  });

  it('skips cleanly when no gateway is configured', async () => {
    jest.spyOn(SdkGatewayClient, 'isConfigured').mockReturnValue(false);

    const summary = await provisionConsentPurposes();

    expect(summary.attempted).toBe(false);
    expect(summary.results.every((r) => r.outcome === 'skipped')).toBe(true);
  });
});
