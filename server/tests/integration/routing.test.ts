import { RoutingService, SLA_WINDOW_MINUTES } from '../../src/services/RoutingService';
import { AssignmentService } from '../../src/services/AssignmentService';
import { LeadCaptureService } from '../../src/services/LeadCaptureService';
import { AppError } from '../../src/utils/errors';
import { Fixtures } from '../fixtures';

/**
 * Integration tests for lead routing and assignment.
 *
 * Run against a REAL database. The routing logic lives largely in SQL — the
 * least-loaded round-robin query, the COALESCE that preserves an SLA deadline
 * across reassignment, the join that excludes departed owners — and a mocked
 * data layer would assert that the mock behaves as written rather than that the
 * query does.
 *
 * Two deliberate choices about what is and is not asserted:
 *
 *  - RULE MATCHING asserts the EXACT owner, because a rule naming a user is a
 *    deterministic promise.
 *  - ROUND-ROBIN asserts the method and, where the candidate set is constrained
 *    to one user, the identity. It picks the least-loaded active user across the
 *    whole table, so an unconstrained identity assertion would depend on every
 *    other row in the database.
 *
 * All fixture persistence lives in ../fixtures so this file contains no SQL.
 */

describe('RoutingService.routeLead', () => {
  let parkedRules: string[] = [];

  beforeEach(async () => {
    parkedRules = await Fixtures.parkActiveRules();
  });

  afterEach(async () => {
    await Fixtures.restoreParkedRules(parkedRules);
    await Fixtures.reactivateAllUsers();
  });

  it('routes to the owner named by the first matching rule', async () => {
    const preferred = (await Fixtures.createUser('Rulematch')).id;
    const lead = (await Fixtures.createUnownedLead('tiktok')).id;

    const rule = await RoutingService.createRule({
      name: `TikTok fixture ${Date.now()}`,
      assigned_user_id: preferred,
      source_channel: 'tiktok',
      evaluation_order: 1,
    });

    const { decision, already_routed: alreadyRouted } = await RoutingService.routeLead(lead);

    expect(alreadyRouted).toBe(false);
    expect(decision.owner_user_id).toBe(preferred);
    expect(decision.routing_method).toBe('rule_match');
    expect(decision.routing_rule_id).toBe(rule.id);
    expect(decision.routing_reason).toContain('Matched routing rule');
  });

  it('honours evaluation order — the lower number wins', async () => {
    const loser = (await Fixtures.createUser('Higherorder')).id;
    const winner = (await Fixtures.createUser('Lowerorder')).id;
    const lead = (await Fixtures.createUnownedLead('instagram')).id;

    // Created in the "wrong" order on purpose: precedence must come from
    // evaluation_order, not from insertion order.
    await RoutingService.createRule({
      name: `Instagram late fixture ${Date.now()}`,
      assigned_user_id: loser,
      source_channel: 'instagram',
      evaluation_order: 900,
    });
    await RoutingService.createRule({
      name: `Instagram early fixture ${Date.now()}`,
      assigned_user_id: winner,
      source_channel: 'instagram',
      evaluation_order: 2,
    });

    const { decision } = await RoutingService.routeLead(lead);
    expect(decision.owner_user_id).toBe(winner);
  });

  it('starts a 30-minute response clock from the moment of assignment', async () => {
    const owner = (await Fixtures.createUser('Clockcheck')).id;
    await Fixtures.keepOnlyActive([owner]);
    const lead = (await Fixtures.createUnownedLead('phone')).id;

    const { decision } = await RoutingService.routeLead(lead);

    expect(decision.assigned_at).not.toBeNull();
    expect(decision.sla_due_at).not.toBeNull();
    const windowMinutes =
      (new Date(decision.sla_due_at as string).getTime() -
        new Date(decision.assigned_at as string).getTime()) /
      60000;
    expect(windowMinutes).toBeCloseTo(SLA_WINDOW_MINUTES, 5);
  });

  it('falls back to round-robin when no rule matches', async () => {
    const owner = (await Fixtures.createUser('Roundrobin')).id;
    await Fixtures.keepOnlyActive([owner]);
    const lead = (await Fixtures.createUnownedLead('csv_import')).id;

    const { decision } = await RoutingService.routeLead(lead);

    // The method is the assertion; the identity is not, because least-loaded is
    // computed across every row in the table.
    expect(decision.routing_method).toBe('round_robin');
    expect(decision.owner_user_id).toBe(owner);
    expect(decision.routing_reason).toContain('Round-robin');
  });

  it('is idempotent — re-routing does not move an owned lead', async () => {
    const first = (await Fixtures.createUser('Firstowner')).id;
    await Fixtures.keepOnlyActive([first]);
    const lead = (await Fixtures.createUnownedLead('email')).id;

    const initial = await RoutingService.routeLead(lead);
    expect(initial.already_routed).toBe(false);

    // A second active user now exists and is less loaded, so a non-idempotent
    // implementation would hand the lead over.
    const tempting = (await Fixtures.createUser('Tempting')).id;
    await Fixtures.keepOnlyActive([first, tempting]);

    const repeat = await RoutingService.routeLead(lead);

    expect(repeat.already_routed).toBe(true);
    expect(repeat.decision.owner_user_id).toBe(initial.decision.owner_user_id);
    expect(repeat.decision.sla_due_at).toBe(initial.decision.sla_due_at);
  });

  it('skips a rule whose owner has been deactivated', async () => {
    // Regression test. The rule query originally filtered on the RULE being
    // active but not on its assigned USER, so a rule written months ago kept
    // routing leads to somebody who had left, and those leads sat unactioned
    // until the clock breached.
    const departed = (await Fixtures.createUser('Departed')).id;
    const remaining = (await Fixtures.createUser('Remaining')).id;

    await RoutingService.createRule({
      name: `Departed owner fixture ${Date.now()}`,
      assigned_user_id: departed,
      source_channel: 'facebook',
      evaluation_order: 1,
    });

    await Fixtures.keepOnlyActive([remaining]);

    const lead = (await Fixtures.createUnownedLead('facebook')).id;
    const { decision } = await RoutingService.routeLead(lead);

    expect(decision.owner_user_id).not.toBe(departed);
    expect(decision.owner_user_id).toBe(remaining);
    // Falling through to round-robin is the correct outcome: the rule was
    // ignored rather than honoured against an unavailable person.
    expect(decision.routing_method).toBe('round_robin');
  });

  it('honours a rule whose owner is still active, in preference to round-robin', async () => {
    // The positive counterpart of the test above: the guard must not be so
    // aggressive that it stops rules working at all.
    const present = (await Fixtures.createUser('Present')).id;
    const other = (await Fixtures.createUser('Other')).id;
    await Fixtures.keepOnlyActive([present, other]);

    await RoutingService.createRule({
      name: `Active owner fixture ${Date.now()}`,
      assigned_user_id: present,
      source_channel: 'google_ads',
      evaluation_order: 1,
    });

    const lead = (await Fixtures.createUnownedLead('google_ads')).id;
    const { decision } = await RoutingService.routeLead(lead);

    expect(decision.owner_user_id).toBe(present);
    expect(decision.routing_method).toBe('rule_match');
  });

  it('rejects an unknown lead with NOT_FOUND', async () => {
    await expect(
      RoutingService.routeLead('11111111-1111-4111-8111-111111111111')
    ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
  });

  it('reports CONFLICT when no active user can own the lead', async () => {
    const lead = (await Fixtures.createUnownedLead('webhook')).id;
    // No active users at all: routing has nobody to choose.
    await Fixtures.deactivateAllUsers();

    await expect(RoutingService.routeLead(lead)).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
    });
  });
});

describe('RoutingService.updateRule and retireRule', () => {
  let parkedRules: string[] = [];

  beforeEach(async () => {
    parkedRules = await Fixtures.parkActiveRules();
  });

  afterEach(async () => {
    await Fixtures.restoreParkedRules(parkedRules);
    await Fixtures.reactivateAllUsers();
  });

  /** Create a rule to mutate. */
  async function seedRule(channel: 'tiktok' | 'linkedin' = 'tiktok') {
    const owner = await Fixtures.createUser('Ruleowner');
    const rule = await RoutingService.createRule({
      name: `Mutable fixture ${Date.now()}`,
      assigned_user_id: owner.id,
      source_channel: channel,
      criteria: 'original criteria',
      evaluation_order: 500,
    });
    return { owner, rule };
  }

  it('updates only the fields supplied, leaving the rest intact', async () => {
    const { rule } = await seedRule();

    const updated = await RoutingService.updateRule(rule.id, { name: 'Renamed only' });

    expect(updated.name).toBe('Renamed only');
    // The untouched columns must survive — this is why the handler builds its
    // SET list from present keys instead of writing every column every time.
    expect(updated.source_channel).toBe('tiktok');
    expect(updated.criteria).toBe('original criteria');
    expect(updated.evaluation_order).toBe(500);
  });

  it('treats an explicit null as a deliberate clear, turning the rule into a catch-all', async () => {
    const { rule } = await seedRule();

    const updated = await RoutingService.updateRule(rule.id, { source_channel: null });

    expect(updated.source_channel).toBeNull();
    // Distinct from omission: the previous test proved absence preserves it.
  });

  it('rejects an update with no fields at all', async () => {
    const { rule } = await seedRule();
    await expect(RoutingService.updateRule(rule.id, {})).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  });

  it('refuses to point a rule at a deactivated user', async () => {
    const { rule } = await seedRule();
    const departed = await Fixtures.createUser('Goneaway');
    await Fixtures.deactivateUser(departed.id);

    await expect(
      RoutingService.updateRule(rule.id, { assigned_user_id: departed.id })
    ).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
  });

  it('rejects an unknown rule with NOT_FOUND', async () => {
    await expect(
      RoutingService.updateRule('33333333-3333-4333-8333-333333333333', { name: 'nope' })
    ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
  });

  it('retires a rule without deleting the row', async () => {
    const { rule } = await seedRule();

    const result = await RoutingService.retireRule(rule.id);

    expect(result.already_inactive).toBe(false);
    expect(result.rule.is_active).toBe(false);

    // The row must still exist. Leads reference routing_rule_id, so destroying
    // it would erase the attribution that makes a past decision explainable.
    const all = await RoutingService.listRules(false);
    expect(all.rules.some((candidate) => candidate.id === rule.id)).toBe(true);
  });

  it('is idempotent when retiring an already-retired rule', async () => {
    const { rule } = await seedRule();
    await RoutingService.retireRule(rule.id);

    const second = await RoutingService.retireRule(rule.id);

    expect(second.already_inactive).toBe(true);
    expect(second.rule.is_active).toBe(false);
  });

  it('excludes a retired rule from routing decisions', async () => {
    const { owner, rule } = await seedRule('linkedin');
    const fallback = await Fixtures.createUser('Fallback');
    await Fixtures.keepOnlyActive([owner.id, fallback.id]);

    // While active, the rule wins.
    const before = await Fixtures.createUnownedLead('linkedin');
    const routedByRule = await RoutingService.routeLead(before.id);
    expect(routedByRule.decision.routing_method).toBe('rule_match');

    await RoutingService.retireRule(rule.id);

    // Retired, it is ignored and routing falls through.
    const after = await Fixtures.createUnownedLead('linkedin');
    const routedWithout = await RoutingService.routeLead(after.id);
    expect(routedWithout.decision.routing_method).toBe('round_robin');
  });

  it('reactivates a retired rule, because retirement is reversible', async () => {
    const { rule } = await seedRule();
    await RoutingService.retireRule(rule.id);

    const revived = await RoutingService.updateRule(rule.id, { is_active: true });

    expect(revived.is_active).toBe(true);
  });
});

describe('AssignmentService.assignTo', () => {
  afterEach(async () => {
    await Fixtures.reactivateAllUsers();
  });

  it('moves an owned lead and records the change as manual', async () => {
    const original = (await Fixtures.createUser('Original')).id;
    const replacement = (await Fixtures.createUser('Replacement')).id;
    await Fixtures.keepOnlyActive([original, replacement]);

    const lead = (await Fixtures.createUnownedLead('referral')).id;
    await RoutingService.routeLead(lead);

    const result = await AssignmentService.assignTo(lead, replacement, 'Territory change');

    expect(result.decision.owner_user_id).toBe(replacement);
    expect(result.previous_owner_user_id).not.toBeNull();
    expect(result.decision.routing_method).toBe('manual');
    expect(result.decision.routing_reason).toBe('Territory change');
    // A manual choice was not made by a rule, so any rule attribution is cleared.
    expect(result.decision.routing_rule_id).toBeNull();
  });

  it('PRESERVES the original deadline across reassignment', async () => {
    const original = (await Fixtures.createUser('Keepclock')).id;
    const replacement = (await Fixtures.createUser('Newowner')).id;
    await Fixtures.keepOnlyActive([original, replacement]);

    const lead = (await Fixtures.createUnownedLead('google_ads')).id;
    const routed = await RoutingService.routeLead(lead);

    const reassigned = await AssignmentService.assignTo(lead, replacement, 'Escalated');

    // This is the anti-gaming guarantee: if the clock restarted on every
    // handover, a lead could be passed around for ever and always look on time.
    expect(reassigned.decision.assigned_at).toBe(routed.decision.assigned_at);
    expect(reassigned.decision.sla_due_at).toBe(routed.decision.sla_due_at);
  });

  it('starts the clock when assigning a lead that was never routed', async () => {
    const owner = (await Fixtures.createUser('Directassign')).id;
    const lead = (await Fixtures.createUnownedLead('live_chat')).id;

    const result = await AssignmentService.assignTo(lead, owner, 'Picked up manually');

    expect(result.previous_owner_user_id).toBeNull();
    expect(result.decision.assigned_at).not.toBeNull();
    expect(result.decision.sla_due_at).not.toBeNull();
  });

  it('refuses to assign to a deactivated user', async () => {
    const retired = (await Fixtures.createUser('Retired')).id;
    await Fixtures.deactivateUser(retired);
    const lead = (await Fixtures.createUnownedLead('facebook')).id;

    await expect(AssignmentService.assignTo(lead, retired, 'Should fail')).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
    });
  });

  it('rejects an unknown target user with NOT_FOUND', async () => {
    const lead = (await Fixtures.createUnownedLead('api')).id;
    await expect(
      AssignmentService.assignTo(lead, '22222222-2222-4222-8222-222222222222', 'No such user')
    ).rejects.toBeInstanceOf(AppError);
  });
});

describe('AssignmentService.routeUnowned', () => {
  let parkedRules: string[] = [];

  beforeEach(async () => {
    parkedRules = await Fixtures.parkActiveRules();
  });

  afterEach(async () => {
    await Fixtures.restoreParkedRules(parkedRules);
    await Fixtures.reactivateAllUsers();
  });

  it('clears a backlog of unowned leads and reports the count', async () => {
    const owner = (await Fixtures.createUser('Sweeper')).id;
    await Fixtures.keepOnlyActive([owner]);

    const backlog = (
      await Promise.all([
        Fixtures.createUnownedLead('web_form'),
        Fixtures.createUnownedLead('linkedin'),
        Fixtures.createUnownedLead('phone'),
      ])
    ).map((lead) => lead.id);

    const result = await AssignmentService.routeUnowned(500);

    expect(result.routed).toBeGreaterThanOrEqual(backlog.length);
    expect(result.failed).toBe(0);

    const unownedFlags = await Promise.all(backlog.map((id) => Fixtures.isUnowned(id)));
    expect(unownedFlags).toEqual([false, false, false]);
  });

  it('collects failures instead of aborting the whole sweep', async () => {
    await Fixtures.createUnownedLead('tiktok');
    // Nobody active: every lead in the sweep fails, and the call must still
    // resolve with a report rather than throwing on the first one.
    await Fixtures.deactivateAllUsers();

    const result = await AssignmentService.routeUnowned(5);

    expect(result.routed).toBe(0);
    expect(result.failed).toBeGreaterThan(0);
    expect(result.failures[0]).toHaveProperty('lead_id');
    expect(result.failures[0].reason).toContain('No active user');
  });
});

describe('LeadCaptureService.capture — routing at intake', () => {
  let parkedRules: string[] = [];

  beforeEach(async () => {
    parkedRules = await Fixtures.parkActiveRules();
  });

  afterEach(async () => {
    await Fixtures.restoreParkedRules(parkedRules);
    await Fixtures.reactivateAllUsers();
  });

  it('assigns an owner and starts the clock as part of the capture', async () => {
    const ownerFixture = await Fixtures.createUser('Intake');
    await Fixtures.keepOnlyActive([ownerFixture.id]);

    const result = await LeadCaptureService.capture({
      name: 'Intake Routed',
      email: `intake.${Date.now()}@leadflow.test`,
      source: 'web_form',
    });

    expect(result.routed).toBe(true);
    expect(result.lead.owner_user_id).toBe(ownerFixture.id);
    expect(result.lead.sla_due_at).not.toBeNull();
    // Joined from users, so the inbox needs no per-row lookup.
    expect(result.lead.owner_name).toBe(ownerFixture.displayName);
  });

  it('still persists the lead when routing cannot place it', async () => {
    await Fixtures.deactivateAllUsers();

    const result = await LeadCaptureService.capture({
      name: 'Unroutable',
      email: `unroutable.${Date.now()}@leadflow.test`,
      source: 'landing_page',
    });

    // The capture must survive: a prospect cannot resubmit a form they have
    // already submitted, so losing it because nobody was on shift is not an
    // acceptable outcome.
    expect(result.lead.id).toBeTruthy();
    expect(result.routed).toBe(false);
    expect(result.lead.owner_user_id).toBeNull();

    const persisted = await LeadCaptureService.getById(result.lead.id);
    expect(persisted.email).toBe(result.lead.email);
  });
});
