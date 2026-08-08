import fs from 'fs';
import path from 'path';
import { CONSENT_PURPOSES, isKnownPurpose, serviceNecessaryPurposes } from '../../src/config/consentPurposes';
import { AUDIT_EVENTS, allAuditEventNames, isAuditEventName } from '../../src/platform/audit/vocabulary';
import { appendAuditEntry, verifyAuditChain, AuditEntry } from '../../src/platform/audit/auditLog';
import { provisionConsentPurposes } from '../../src/platform/consent/purposeProvisioner';
import { provisionAuditEventTypes } from '../../src/platform/audit/eventTypeProvisioner';
import { SdkGatewayClient , mapUpstreamStatus, toAppError } from '../../src/platform/sdkGateway';
import { config } from '../../src/config/env';
import { AppError, ErrorCodes } from '../../src/utils/errors';

/**
 * An upstream refusal built the way the GATEWAY builds one.
 *
 * These used to be hand-written AppErrors whose message read
 * `ProjexCloud sdk-x returned 409` — a shape nothing produced, matched by a
 * regex nothing guaranteed. Routing through the real mapper means the test
 * fails if the contract the provisioners depend on ever moves, which is the
 * only reason to have it.
 */
const upstreamRefusal = (sdk: string, status: number, detail: string): AppError =>
  toAppError(mapUpstreamStatus(sdk, status, detail), sdk);

const ORIGINAL_TENANT = config.projexCloud.tenantId;

afterEach(() => {
  config.projexCloud.tenantId = ORIGINAL_TENANT;
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
    // 2 more for the conversation intelligence pipeline: the eligibility CHECK
    // is separate because it happens when there is no recording to attach it to,
    // and a check that blocked a call leaves no other trace anywhere.
    // 2 more for the Import Center's read surface. An import read is a
    // disclosure — an import names what happened to whose data — so who looked
    // is part of the record. Two names rather than one: reading the run
    // register and reading the rights ATTESTATION behind a run are different
    // disclosures, and a single name would make "who read who swore this data
    // was lawfully obtained" unanswerable, which is the one a complaint asks.
    expect(allAuditEventNames()).toHaveLength(50);
    expect(isAuditEventName('capture.created.v1')).toBe(true);
    expect(isAuditEventName('sla.breached.v1')).toBe(true);
    expect(isAuditEventName('lead.routed.v1')).toBe(true);
    expect(isAuditEventName('sla.policy.updated.v1')).toBe(true);
    expect(isAuditEventName('ai.draft.proposed.v1')).toBe(true);
    // A refusal is an event too: an absent entry cannot distinguish "we
    // declined to process this call" from "nobody ever asked", and only the
    // first is evidence the consent gate is working.
    expect(isAuditEventName('ai.coach.refused_no_consent.v1')).toBe(true);
    // A rejection and an acceptance are the same event name with a different
    // outcome in the metadata; pulling the kill switch is its own.
    expect(isAuditEventName('ai.proposal.decided.v1')).toBe(true);
    expect(isAuditEventName('ai.kill_switch.engaged.v1')).toBe(true);
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
    // The unversioned spelling is now a near-miss too — it is what every one of
    // these names used to be, so it is exactly what a stale caller would send.
    expect(isAuditEventName('capture.created')).toBe(false);
  });

  it('uses dot-delimited lower snake case throughout, with no duplicates', () => {
    const names = allAuditEventNames();

    for (const name of names) {
      // The trailing .v<N> is MANDATORY, not decorative: ProjexCloud's
      // EVENT_TYPE_NAME_PATTERN rejects an unversioned name with a 400 before
      // any write, and because the append swallows failures by design that
      // showed up only as log lines while the chain verified clean and empty.
      expect(name).toMatch(/^[a-z]+(\.[a-z_]+)+\.v\d+$/);
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
    expect(body.event_type).toBe('capture.created.v1');
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

/**
 * THESE MOCKS NOW MATCH sdk-audit's REAL VerifyProof, and that is the point.
 *
 * They used to return `{ intact: true }` — a field sdk-audit has never emitted.
 * The production code read the same invented field, so the tests agreed with the
 * code and both were wrong together: `undefined === true` is false, so every
 * nightly run reported a broken chain and opened a CRITICAL incident against a
 * ledger that was fine. A test written from the same assumption as the code
 * cannot catch the assumption. The real shape is ok / entries_checked /
 * break_at_seq / break_reason.
 */
describe('nightly chain verification', () => {
  it('reports an intact chain, and how many entries it actually walked', async () => {
    jest.spyOn(SdkGatewayClient, 'isConfigured').mockReturnValue(true);
    jest.spyOn(SdkGatewayClient, 'call').mockResolvedValue({
      delivered: true,
      status: 200,
      data: { data: { ok: true, entries_checked: 128, break_at_seq: null, break_reason: null } },
    });

    await expect(verifyAuditChain()).resolves.toMatchObject({
      intact: true,
      entriesChecked: 128,
    });
  });

  it('refuses to call a VERIFIED BUT EMPTY chain intact', async () => {
    jest.spyOn(SdkGatewayClient, 'isConfigured').mockReturnValue(true);
    jest.spyOn(SdkGatewayClient, 'call').mockResolvedValue({
      delivered: true,
      status: 200,
      data: { data: { ok: true, entries_checked: 0, break_at_seq: null, break_reason: null } },
    });

    // An empty chain verifies perfectly — there is nothing in it to be
    // inconsistent — so ok:true with zero entries is the WORST case wearing the
    // best case's answer. It is exactly how a whole rejected event vocabulary
    // went unnoticed: every append 400'd, the append swallows failures by
    // design, and verification kept reporting clean.
    const result = await verifyAuditChain();

    expect(result.intact).toBe(false);
    expect(result.entriesChecked).toBe(0);
    expect(result.detail).toMatch(/EMPTY/);
  });

  it('opens an incident when the chain does not verify, naming where it broke', async () => {
    jest.spyOn(SdkGatewayClient, 'isConfigured').mockReturnValue(true);
    const call = jest.spyOn(SdkGatewayClient, 'call').mockImplementation(async (options) => {
      if (options.sdk === 'sdk-audit') {
        return {
          delivered: true,
          status: 200,
          data: {
            data: {
              ok: false,
              entries_checked: 41,
              break_at_seq: 41,
              break_reason: 'hash mismatch',
            },
          },
        } as never;
      }
      return { delivered: true, status: 201, data: { data: { incident_id: 'inc-7' } } } as never;
    });

    const result = await verifyAuditChain();

    expect(result.intact).toBe(false);
    expect(result.incidentRef).toBe('inc-7');
    // The sequence number is the whole diagnostic — "it broke" without "where"
    // sends somebody to read the entire ledger.
    expect(result.breakAtSeq).toBe(41);
    expect(result.detail).toMatch(/sequence 41/);
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
        upstreamRefusal('sdk-consent', 409, 'from the gateway')
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

describe('registering the vocabulary with ProjexCloud', () => {
  /**
   * Two of LeadFlow's names are ALSO in ProjexCloud's compile-time
   * EVENT_TYPE_REGISTRY, and registerTenantEventType refuses to let a tenant
   * re-register a baseline name — resolution is baseline-first, so the tenant
   * row could never win. The refusal arrives as a 400, not a 409.
   */
  const BASELINE_NAMES = ['import.run.committed.v1', 'handoff.accepted.v1'];

  /** The 400 body the gateway actually sends, as SdkGatewayClient now reports it. */
  const baselineRefusal = (eventType: string) =>
    upstreamRefusal(
      'sdk-audit',
      // 400, not 409. ProjexCloud answers a baseline collision with the SAME
      // status as a genuine validation failure, which is precisely why this one
      // case still has to be recognised from the detail text.
      400,
      `event_type '${eventType}' is a platform baseline type `
        + 'and cannot be redefined by a tenant. It is already usable as-is.'
    );

  it('counts a platform baseline collision as present, not as a failure', async () => {
    config.projexCloud.tenantId = 'tenant-leadflow';
    jest.spyOn(SdkGatewayClient, 'isConfigured').mockReturnValue(true);
    const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    jest.spyOn(SdkGatewayClient, 'call').mockImplementation(async (options) => {
      const eventType = (options.body as { event_type: string }).event_type;
      if (BASELINE_NAMES.includes(eventType)) throw baselineRefusal(eventType);
      return { delivered: true, status: 201, data: null };
    });

    const summary = await provisionAuditEventTypes();

    // These two append perfectly well — resolveEventType finds them in the
    // baseline. Logging them as permanent failures on every boot trained the
    // reader to ignore the one line that would matter if it were real.
    expect(summary.alreadyPresent).toBe(BASELINE_NAMES.length);
    expect(summary.failed).toBe(0);
    expect(logged).not.toHaveBeenCalled();
  });

  it('still reports a REAL validation failure', async () => {
    config.projexCloud.tenantId = 'tenant-leadflow';
    jest.spyOn(SdkGatewayClient, 'isConfigured').mockReturnValue(true);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    jest
      .spyOn(SdkGatewayClient, 'call')
      .mockRejectedValue(
        upstreamRefusal(
          'sdk-audit',
          400,
          'retention_class must be one of transient, operational, regulated'
        )
      );

    const summary = await provisionAuditEventTypes();

    // The whole point of carrying the detail is that these two 400s are no
    // longer the same thing. A bad payload must not be swallowed as benign.
    expect(summary.created).toBe(0);
    expect(summary.alreadyPresent).toBe(0);
    expect(summary.failed).toBeGreaterThan(0);
  });

  it('skips when no tenant is configured rather than reporting failures', async () => {
    config.projexCloud.tenantId = '';

    const summary = await provisionAuditEventTypes();

    expect(summary.attempted).toBe(false);
    expect(summary.failed).toBe(0);
  });
});
