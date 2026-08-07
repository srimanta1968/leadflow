import { randomUUID } from 'crypto';
import { AI_CAPABILITIES, agentByKey } from '../../src/config/aiAgents';
import {
  GOVERNED_SEGMENTS,
  allSegmentKeys,
  assertSegmentsWellFormed,
  partitionRequestedSegments,
  promotionalSegments,
} from '../../src/config/governedSegments';
import { isKnownPurpose } from '../../src/config/consentPurposes';
import { dataService } from '../../src/services/DataService';
import { SdkGatewayClient } from '../../src/platform/sdkGateway';
import { AT_RISK_THRESHOLD } from '../../src/services/SlaMonitorService';
import {
  INTERVENTION_LEAD_MINUTES,
  huddleBrief,
  riskSignals,
} from '../../src/features/ai/managerRiskService';
import { routingRepairs, sequenceFindings } from '../../src/features/ai/revopsProposalService';
import { recommendCampaign, segmentSizes } from '../../src/features/ai/marketingService';
import { proposalById, propose } from '../../src/platform/ai/reviewGate';
import { KIND_REQUIRES_PERMISSION } from '../../src/config/aiAgents';

/**
 * The AI Manager, RevOps and Marketing modules.
 *
 * INTEGRATION, because three of the four criteria are claims about what the
 * modules REFUSE to do, and a refusal asserted against a mock is a claim about
 * the mock. The prediction in particular is only meaningful against real rows
 * with real timestamps: the whole point of AC1 is WHEN the signal appears
 * relative to a deadline, and a stubbed clock proves nothing about that.
 *
 * The suite runs with no gateway configured (tests/setup.ts), which is exactly
 * the state AC2 needs: sdk-assignment is unreachable, so a routing proposal
 * MUST NOT appear.
 */

const MARK = 'AIOPS-TEST';
let ownerId: string;

/** Insert a lead whose clock started `elapsedMinutes` ago against a 30m target. */
async function openLead(input: {
  elapsedMinutes: number;
  targetMinutes?: number;
  owner?: string | null;
  name?: string;
}): Promise<string> {
  const target = input.targetMinutes ?? 30;
  const row = await dataService.queryOne<{ id: string }>(
    `INSERT INTO leads (name, email, source, activation_state, owner_user_id,
                        created_at, assigned_at, sla_due_at, sla_breached)
     VALUES ($1, $2, 'web_form', 'active', $3,
             NOW() - ($4 || ' minutes')::interval,
             NOW() - ($4 || ' minutes')::interval,
             NOW() - ($4 || ' minutes')::interval + ($5 || ' minutes')::interval,
             FALSE)
     RETURNING id`,
    [
      input.name ?? `${MARK} lead`,
      `aiops-${randomUUID()}@example.test`,
      input.owner === undefined ? ownerId : input.owner,
      String(input.elapsedMinutes),
      String(target),
    ]
  );
  return row!.id;
}

/**
 * Cleanup happens on the way IN, not on the way out.
 *
 * Two reasons, both learned here rather than assumed. `tests/setup.ts` registers
 * its pool close as a root-level afterAll BEFORE this file is loaded, and jest
 * runs root afterAll hooks in registration order — so any afterAll here runs
 * against a closed pool. And deleting the owner while its leads still exist
 * violates leads_owner_user_id_fkey, because the per-test lead cleanup has not
 * run yet at that point. Cleaning up first sidesteps both.
 */
beforeAll(async () => {
  await dataService.query(`DELETE FROM leads WHERE name LIKE '${MARK}%'`, []);
  await dataService.query("DELETE FROM users WHERE email LIKE 'aiops-%@example.test'", []);

  const user = await dataService.queryOne<{ id: string }>(
    `INSERT INTO users (email, username, password_hash, first_name, last_name, role, is_active)
     VALUES ($1, $2, 'x', 'Aiops', 'Owner', 'user', TRUE)
     RETURNING id`,
    [`aiops-owner-${randomUUID()}@example.test`, `aiops${Date.now()}`]
  );
  ownerId = user!.id;
});

afterEach(async () => {
  await dataService.query(`DELETE FROM leads WHERE name LIKE '${MARK}%'`, []);
});

// ---------------------------------------------------------------------------
// AC1 — breach prediction fires early enough for a T+15 intervention
// ---------------------------------------------------------------------------

describe('breach prediction lead time (AC1)', () => {
  it('raises a signal at T+15 of a 30-minute clock, with 15 minutes still to act', async () => {
    // Eight open leads on one owner: a deep queue is what the elapsed-time rule
    // cannot see and what actually decides whether anybody gets to this one.
    for (let index = 0; index < 7; index += 1) {
      await openLead({ elapsedMinutes: 5 });
    }
    const subject = await openLead({ elapsedMinutes: 15, name: `${MARK} subject` });

    const report = await riskSignals();
    const signal = report.signals.find((entry) => entry.leadId === subject);

    expect(signal).toBeDefined();
    // THE CRITERION, as a number: fifteen minutes of warning left.
    expect(signal!.minutesRemaining).toBeGreaterThanOrEqual(INTERVENTION_LEAD_MINUTES);
    expect(signal!.interventionWindowOpen).toBe(true);
  });

  it('fires while the deterministic at-risk rule still says on_track', async () => {
    for (let index = 0; index < 7; index += 1) {
      await openLead({ elapsedMinutes: 5 });
    }
    const subject = await openLead({ elapsedMinutes: 15, name: `${MARK} subject` });

    const signal = (await riskSignals()).signals.find((entry) => entry.leadId === subject);

    // 15 of 30 minutes is 0.5, below the 0.8 elapsed-time threshold. If this
    // ever reports at_risk, the module has stopped predicting and started
    // repeating the amber flag a few minutes early.
    expect(15 / 30).toBeLessThan(AT_RISK_THRESHOLD);
    expect(signal!.deterministicState).toBe('on_track');
  });

  it('excludes a lead with less warning left than the intervention window', async () => {
    for (let index = 0; index < 7; index += 1) {
      await openLead({ elapsedMinutes: 5 });
    }
    const late = await openLead({ elapsedMinutes: 25, name: `${MARK} late` });

    const report = await riskSignals();

    // A prediction with five minutes left is accurate and useless. Filtered out
    // rather than greyed: a list mixing "act now" with "too late" trains a
    // manager to skim it.
    expect(report.signals.map((entry) => entry.leadId)).not.toContain(late);
  });

  it('never reports an already-breached clock as a prediction', async () => {
    const past = await openLead({ elapsedMinutes: 45, name: `${MARK} past` });

    const report = await riskSignals();

    // History, not a forecast. Reporting it would inflate the module's apparent
    // hit rate with facts.
    expect(report.signals.map((entry) => entry.leadId)).not.toContain(past);
  });

  it('carries per-signal evidence and a confidence band on every prediction', async () => {
    const unowned = await openLead({ elapsedMinutes: 5, owner: null, name: `${MARK} unowned` });

    const signal = (await riskSignals()).signals.find((entry) => entry.leadId === unowned);

    expect(signal).toBeDefined();
    // A risk score a manager cannot interrogate is one they will over-trust or
    // ignore, and the second happens the first time it is wrong.
    expect(signal!.evidence.map((item) => item.signal).sort()).toEqual([
      'coverage',
      'elapsed_fraction',
      'queue_depth',
      'rep_activity',
    ]);
    for (const item of signal!.evidence) {
      expect(item.observed.length).toBeGreaterThan(0);
      expect(item.because.length).toBeGreaterThan(0);
    }
    expect(signal!.confidence.low).toBeLessThanOrEqual(signal!.risk);
    expect(signal!.confidence.high).toBeGreaterThanOrEqual(signal!.risk);
  });

  it('does not double-count an unowned lead through the activity signal', async () => {
    const unowned = await openLead({ elapsedMinutes: 5, owner: null, name: `${MARK} unowned` });

    const signal = (await riskSignals()).signals.find((entry) => entry.leadId === unowned);
    const activity = signal!.evidence.find((item) => item.signal === 'rep_activity');

    // Coverage already charges for having no owner; charging again through
    // "this owner has been quiet" would double the weight of one fact.
    expect(activity!.contribution).toBe(0);
  });

  it('distinguishes an empty queue from a quiet one in the brief', async () => {
    const empty = huddleBrief({
      signals: [],
      signalsSuppressed: 0,
      candidatesTruncated: false,
      interventionLeadMinutes: 15,
      openClocksExamined: 0,
      openClocksPastDue: 0,
      deterministicAtRiskFraction: AT_RISK_THRESHOLD,
      generatedAt: new Date().toISOString(),
    });
    const quiet = huddleBrief({
      signals: [],
      signalsSuppressed: 0,
      candidatesTruncated: false,
      interventionLeadMinutes: 15,
      openClocksExamined: 12,
      openClocksPastDue: 0,
      deterministicAtRiskFraction: AT_RISK_THRESHOLD,
      generatedAt: new Date().toISOString(),
    });

    // "Nothing is at risk" and "nothing is being measured" look identical in an
    // empty list, and only one of them is good news.
    expect(empty.headline).toMatch(/Nothing is being measured/);
    expect(quiet.headline).toMatch(/none predicted to breach/);
  });

  it('never reports a quiet forecast while leads sit past their deadline', async () => {
    // THE REGRESSION THIS LOCKS DOWN. Predictions are drawn only from future-due
    // clocks, which is right — but that filter made openClocksExamined stop
    // counting most of the queue. Measured on the development database at the
    // time: 2 clocks future-due, 2,652 unanswered past their deadline. The brief
    // would have said "2 clocks running, none predicted to breach", which reads
    // as all-clear and is the exact false reassurance the count exists to stop.
    const brief = huddleBrief({
      signals: [],
      signalsSuppressed: 0,
      candidatesTruncated: false,
      interventionLeadMinutes: 15,
      openClocksExamined: 2,
      openClocksPastDue: 2652,
      deterministicAtRiskFraction: AT_RISK_THRESHOLD,
      generatedAt: new Date().toISOString(),
    });

    expect(brief.lines.join(' ')).toMatch(/2652 unanswered leads are ALREADY past their deadline/);
    // And the headline no longer claims the whole queue is inside its window.
    expect(brief.headline).toMatch(/still inside their windows/);
  });

  it('counts the past-due backlog on the report itself', async () => {
    const report = await riskSignals();

    // Reported alongside the predictions rather than left to the caller to go
    // and find, because the caller that forgets is the one showing a manager an
    // empty risk list.
    expect(Number.isInteger(report.openClocksPastDue)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC2 — routing proposals are backed by simulation evidence
// ---------------------------------------------------------------------------

describe('routing proposals require simulation evidence (AC2)', () => {
  it('emits NO routing repair when the simulator is unreachable', async () => {
    // The suite runs with no gateway, so this is the real unreachable case
    // rather than a mocked one.
    expect(SdkGatewayClient.isConfigured()).toBe(false);

    // The leads no longer establish skew — sdk-assignment computes that over its
    // own replay and returns it as `skew`. They are here so the tenant is not
    // trivially empty, and the assertion below is now the sharper one: with the
    // simulator unreachable there is no skew audit AT ALL, so nothing can be
    // proposed however the work is distributed.
    for (let index = 0; index < 8; index += 1) {
      await openLead({ elapsedMinutes: 5 });
    }

    const result = await routingRepairs();

    // The skew is real and the repair is unproven. Shipping the second because
    // of the first is exactly what this criterion forbids.
    expect(result.repairs).toEqual([]);
    // And the caller is TOLD why, so "routing is healthy" and "we could not
    // check" are distinguishable without inspecting array lengths.
    expect(result.unavailableReason).toBe('assignment_simulation_unavailable');
  });

  // NOTE: there is deliberately no test for the healthy branch (skew absent, so
  // unavailableReason stays null). It is real logic and it is unreachable here:
  // the suite runs against the shared development database, which holds ~2,969
  // owners and ~3,494 open leads, so some owner is always over twice their
  // share. Asserting it would mean asserting the database is empty, and a test
  // that only passes on a fresh machine is worse than no test.

  it('types the simulation as required, so a repair cannot exist without one', () => {
    // The guarantee is structural rather than a runtime check: RoutingRepair
    // declares `simulation: RoutingSimulation`, not optional, so the only way to
    // construct one is to have the evidence. This test documents that the
    // compiler is the enforcement — it passes by the file compiling at all.
    const agent = agentByKey('revops_analyst');
    expect(agent?.capabilities).toContain(AI_CAPABILITIES.ASSIGNMENT_SIMULATE);
    // SIMULATE, never apply. There is no assignment.apply capability anywhere in
    // the vocabulary, so no agent can be granted one.
    expect(Object.values(AI_CAPABILITIES)).not.toContain('assignment.apply');
  });

  it('flags a sequence step whose misses outweigh its replies', async () => {
    await dataService.query(
      `INSERT INTO leads (name, email, source, activation_state, created_at, sla_breached)
       SELECT $1, 'seq-' || g || '-' || $2 || '@example.test', 'aiops_channel', 'active',
              NOW() - INTERVAL '2 days', TRUE
         FROM generate_series(1, 6) g`,
      [`${MARK} seq`, randomUUID()]
    );

    const findings = await sequenceFindings();
    const finding = findings.find((entry) => entry.stepKey === 'aiops_channel');

    expect(finding).toBeDefined();
    // Six sent, none replied, six missed. The ratio is what makes this legible:
    // a raw reply count would call a busy bad step a good one.
    expect(finding!.replyToAnnoyance).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// AC3 — campaign recommendations only reference governed eligible segments
// ---------------------------------------------------------------------------

describe('governed segments (AC3)', () => {
  it('refuses an audience outside the registry, and names every refusal at once', async () => {
    await expect(
      recommendCampaign({ segmentKeys: ['everyone_with_an_email', 'lapsed_last_year'] })
    ).rejects.toMatchObject({ code: 'SEGMENT_NOT_GOVERNED' });

    const { governed, refused } = partitionRequestedSegments([
      'promotions_opted_in',
      'everyone_with_an_email',
      'lapsed_last_year',
    ]);
    expect(governed).toEqual(['promotions_opted_in']);
    // A caller naming two bad audiences is told about two, not asked to discover
    // them one request at a time.
    expect(refused).toHaveLength(2);
  });

  it('refuses a PROMOTION to a service-necessary audience', async () => {
    // The audience is perfectly governed — it is simply not one that consented
    // to be marketed to, which is the distinction the elective flag carries.
    await expect(
      recommendCampaign({ segmentKeys: ['awaiting_first_response'], promotional: true })
    ).rejects.toMatchObject({ code: 'SEGMENT_NOT_GOVERNED' });

    // The same audience is fine for service communication.
    await expect(
      recommendCampaign({ segmentKeys: ['awaiting_first_response'], promotional: false })
    ).resolves.toBeDefined();
  });

  it('defaults a promotional recommendation to elective audiences only', () => {
    const elective = promotionalSegments().map((segment) => segment.key);

    expect(elective).toContain('promotions_opted_in');
    expect(elective).not.toContain('awaiting_first_response');
  });

  it('requires a positive opt-in marker rather than an absent suppression', () => {
    const promotions = GOVERNED_SEGMENTS.find((s) => s.key === 'promotions_opted_in');

    // "Not unsubscribed" is the condition every person who has never been asked
    // is also in, so a predicate built on absence is not consent.
    expect(promotions!.predicate).not.toMatch(/NOT EXISTS|IS NULL|NOT IN/i);
    expect(promotions!.predicate).toMatch(/opt_in/);
  });

  it('names a real consent purpose on every segment', () => {
    // A segment naming an unregistered purpose is worse than a missing one: it
    // looks governed, passes every membership check, and the basis it claims
    // does not exist. Enforced at module load, asserted here.
    for (const segment of GOVERNED_SEGMENTS) {
      expect(isKnownPurpose(segment.purpose)).toBe(true);
    }
    expect(() => assertSegmentsWellFormed()).not.toThrow();
  });

  it('computes membership from the segment predicate rather than a description', async () => {
    const sizes = await segmentSizes();

    // Every registered segment is counted, so an audience nobody can count
    // cannot slip into the registry.
    expect(sizes.map((size) => size.key).sort()).toEqual([...allSegmentKeys()].sort());
    for (const size of sizes) {
      expect(Number.isInteger(size.members)).toBe(true);
    }
  });

  it('gives the marketing planner no capability to read a person', () => {
    const planner = agentByKey('marketing_planner');

    // It works on audience COUNTS. Reading a name is not needed to choose a
    // governed segment, and the narrower capability makes that structural
    // rather than a matter of discipline.
    expect(planner!.capabilities).toContain(AI_CAPABILITIES.SEGMENT_READ);
    expect(planner!.capabilities).not.toContain(AI_CAPABILITIES.LEAD_READ);
  });
});

// ---------------------------------------------------------------------------
// AC4 — every proposal is human-reviewable and audited
// ---------------------------------------------------------------------------

describe('every module output is reviewable and audited (AC4)', () => {
  it('routes all three agents through the shared review gate', async () => {
    for (const agentKey of ['manager_risk', 'revops_analyst', 'marketing_planner']) {
      const agent = agentByKey(agentKey);
      expect(agent).toBeDefined();
      // Cannot propose without it, so the gate is not optional for any of them.
      expect(agent!.capabilities).toContain(AI_CAPABILITIES.PROPOSAL_CREATE);
    }
  });

  it('opens each finding as a proposal awaiting a qualified human', async () => {
    const proposal = await propose({
      agentKey: 'revops_analyst',
      kind: 'next_action',
      content: { finding: 'routing_skew', action: 'Rebalance.' },
    });

    const stored = await proposalById(proposal.id);

    expect(stored!.status).toBe('proposed');
    expect(stored!.delivered).toBe(false);
    // The authority a reviewer needs is stamped at proposal time, so a later
    // edit to the kind map cannot change who was qualified to approve it.
    expect(stored!.requiredPermission).toBe(KIND_REQUIRES_PERMISSION.next_action);
  });

  it('refuses a kind an agent is not registered to propose', async () => {
    // The manager may propose a score and a summary. It may not draft a message
    // and have it reviewed under the message authority.
    await expect(
      propose({ agentKey: 'manager_risk', kind: 'message', content: { body: 'Hello' } })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('keeps every new agent within a reviewable capability count', () => {
    for (const agentKey of ['manager_risk', 'revops_analyst', 'marketing_planner']) {
      const agent = agentByKey(agentKey)!;
      expect(agent.capabilities.length).toBeLessThanOrEqual(4);
      expect(new Set(agent.capabilities).size).toBe(agent.capabilities.length);
    }
  });
});
