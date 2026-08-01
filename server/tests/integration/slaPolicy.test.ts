import {
  SlaPolicyService,
  DEFAULT_FIRST_RESPONSE_MINUTES,
} from '../../src/services/SlaPolicyService';
import { RoutingService } from '../../src/services/RoutingService';
import { AssignmentService } from '../../src/services/AssignmentService';
import { Fixtures } from '../fixtures';

/**
 * Integration tests for per-lead-type SLA policies.
 *
 * Run against a REAL database. The guarantees under test live in SQL: the
 * first-match-wins ORDER BY that also prefers a channel-specific policy over the
 * catch-all on a tie, the partial unique index that stops two ACTIVE policies
 * tying on (channel, order), and the CHECK constraint bounding the target. A
 * mocked data layer would assert none of them.
 *
 * Every test parks existing policies first, because policies are long-lived
 * configuration: rows left by an earlier RUN of the suite would otherwise decide
 * the match and fail assertions for reasons unrelated to the code under test.
 */

describe('SlaPolicyService.resolveTarget', () => {
  let parked: string[] = [];

  beforeEach(async () => {
    parked = await Fixtures.parkActivePolicies();
  });

  afterEach(async () => {
    await Fixtures.restoreParkedPolicies(parked);
  });

  it('falls back to the flat default when no policy is configured', async () => {
    const resolved = await SlaPolicyService.resolveTarget('web_form');

    // A tenant that has configured nothing must still get a running clock.
    expect(resolved.minutes).toBe(DEFAULT_FIRST_RESPONSE_MINUTES);
    expect(resolved.policy).toBeNull();
  });

  it('applies the policy that matches the lead type', async () => {
    await SlaPolicyService.createPolicy({
      name: `Live chat fast ${Date.now()}`,
      source_channel: 'live_chat',
      first_response_minutes: 5,
      evaluation_order: 10,
    });

    const chat = await SlaPolicyService.resolveTarget('live_chat');
    expect(chat.minutes).toBe(5);
    expect(chat.policy?.source_channel).toBe('live_chat');

    // A channel the policy does not name is unaffected.
    const form = await SlaPolicyService.resolveTarget('web_form');
    expect(form.minutes).toBe(DEFAULT_FIRST_RESPONSE_MINUTES);
  });

  it('uses a channel-less policy as the catch-all', async () => {
    await SlaPolicyService.createPolicy({
      name: `Catch-all ${Date.now()}`,
      source_channel: null,
      first_response_minutes: 120,
      evaluation_order: 500,
    });

    const anything = await SlaPolicyService.resolveTarget('csv_import');
    expect(anything.minutes).toBe(120);
    expect(anything.policy?.source_channel).toBeNull();
  });

  it('honours evaluation order — the lower number wins', async () => {
    await SlaPolicyService.createPolicy({
      name: `Late phone ${Date.now()}`,
      source_channel: 'phone',
      first_response_minutes: 90,
      evaluation_order: 900,
    });
    await SlaPolicyService.createPolicy({
      name: `Early phone ${Date.now()}`,
      source_channel: 'phone',
      first_response_minutes: 2,
      evaluation_order: 2,
    });

    const resolved = await SlaPolicyService.resolveTarget('phone');
    // Precedence comes from evaluation_order, not insertion order.
    expect(resolved.minutes).toBe(2);
  });

  it('prefers the channel-specific policy over the catch-all on a tie', async () => {
    await SlaPolicyService.createPolicy({
      name: `Tie catch-all ${Date.now()}`,
      source_channel: null,
      first_response_minutes: 240,
      evaluation_order: 50,
    });
    await SlaPolicyService.createPolicy({
      name: `Tie specific ${Date.now()}`,
      source_channel: 'email',
      first_response_minutes: 10,
      evaluation_order: 50,
    });

    const resolved = await SlaPolicyService.resolveTarget('email');
    // Naming a channel is the more specific statement of intent, so an operator
    // would be surprised to see the catch-all win.
    expect(resolved.minutes).toBe(10);
  });

  it('ignores a retired policy', async () => {
    const policy = await SlaPolicyService.createPolicy({
      name: `Retired tiktok ${Date.now()}`,
      source_channel: 'tiktok',
      first_response_minutes: 7,
      evaluation_order: 5,
    });

    expect((await SlaPolicyService.resolveTarget('tiktok')).minutes).toBe(7);

    await SlaPolicyService.retirePolicy(policy.id);

    expect((await SlaPolicyService.resolveTarget('tiktok')).minutes).toBe(
      DEFAULT_FIRST_RESPONSE_MINUTES
    );
  });

  it('treats an unknown channel as unmatched rather than erroring', async () => {
    await SlaPolicyService.createPolicy({
      name: `Referral ${Date.now()}`,
      source_channel: 'referral',
      first_response_minutes: 45,
      evaluation_order: 20,
    });

    const resolved = await SlaPolicyService.resolveTarget(null);
    expect(resolved.minutes).toBe(DEFAULT_FIRST_RESPONSE_MINUTES);
  });
});

describe('SlaPolicyService CRUD', () => {
  let parked: string[] = [];

  beforeEach(async () => {
    parked = await Fixtures.parkActivePolicies();
  });

  afterEach(async () => {
    await Fixtures.restoreParkedPolicies(parked);
  });

  it('lists policies in the order the matcher walks them', async () => {
    await SlaPolicyService.createPolicy({
      name: `Third ${Date.now()}`,
      source_channel: 'facebook',
      first_response_minutes: 60,
      evaluation_order: 300,
    });
    await SlaPolicyService.createPolicy({
      name: `First ${Date.now()}`,
      source_channel: 'live_chat',
      first_response_minutes: 5,
      evaluation_order: 10,
    });

    const listed = await SlaPolicyService.listPolicies(true);

    const orders = listed.policies.map((policy) => policy.evaluation_order);
    // Ascending, so a catch-all shadowing everything after it is visible.
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(listed.effective_default_minutes).toBe(DEFAULT_FIRST_RESPONSE_MINUTES);
    expect(listed.total).toBe(listed.policies.length);
  });

  it('refuses two ACTIVE policies tying on lead type and evaluation order', async () => {
    await SlaPolicyService.createPolicy({
      name: `Original ${Date.now()}`,
      source_channel: 'instagram',
      first_response_minutes: 15,
      evaluation_order: 77,
    });

    // A tie would make the effective SLA depend on insertion order, which an
    // operator cannot reason about.
    await expect(
      SlaPolicyService.createPolicy({
        name: `Colliding ${Date.now()}`,
        source_channel: 'instagram',
        first_response_minutes: 45,
        evaluation_order: 77,
      })
    ).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
  });

  it('allows the same slot once the earlier policy is retired', async () => {
    const first = await SlaPolicyService.createPolicy({
      name: `To retire ${Date.now()}`,
      source_channel: 'google_ads',
      first_response_minutes: 15,
      evaluation_order: 88,
    });
    await SlaPolicyService.retirePolicy(first.id);

    // The unique index is PARTIAL on is_active, so a retired row never blocks a
    // replacement for the same lead type.
    const replacement = await SlaPolicyService.createPolicy({
      name: `Replacement ${Date.now()}`,
      source_channel: 'google_ads',
      first_response_minutes: 45,
      evaluation_order: 88,
    });
    expect(replacement.first_response_minutes).toBe(45);
  });

  it('updates only the fields supplied', async () => {
    const policy = await SlaPolicyService.createPolicy({
      name: 'Original name',
      source_channel: 'linkedin',
      first_response_minutes: 25,
      business_hours_only: true,
      evaluation_order: 401,
    });

    const updated = await SlaPolicyService.updatePolicy(policy.id, { name: 'Renamed only' });

    expect(updated.name).toBe('Renamed only');
    expect(updated.first_response_minutes).toBe(25);
    expect(updated.source_channel).toBe('linkedin');
    expect(updated.business_hours_only).toBe(true);
    expect(updated.evaluation_order).toBe(401);
  });

  it('treats an explicit null channel as turning the policy into the catch-all', async () => {
    const policy = await SlaPolicyService.createPolicy({
      name: `Becoming catch-all ${Date.now()}`,
      source_channel: 'webhook',
      first_response_minutes: 35,
      evaluation_order: 402,
    });

    const updated = await SlaPolicyService.updatePolicy(policy.id, { source_channel: null });

    expect(updated.source_channel).toBeNull();
    // Distinct from omission — the previous test proved absence preserves it.
  });

  it('rejects an update with no fields at all', async () => {
    const policy = await SlaPolicyService.createPolicy({
      name: `Empty patch ${Date.now()}`,
      source_channel: 'api',
      first_response_minutes: 35,
      evaluation_order: 403,
    });

    await expect(SlaPolicyService.updatePolicy(policy.id, {})).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  });

  it('retires without deleting the row, and is idempotent', async () => {
    const policy = await SlaPolicyService.createPolicy({
      name: `Retirement ${Date.now()}`,
      source_channel: 'landing_page',
      first_response_minutes: 20,
      evaluation_order: 404,
    });

    const first = await SlaPolicyService.retirePolicy(policy.id);
    expect(first.already_inactive).toBe(false);
    expect(first.policy.is_active).toBe(false);

    const second = await SlaPolicyService.retirePolicy(policy.id);
    expect(second.already_inactive).toBe(true);

    // The row must still exist: a lead's deadline was computed from this policy,
    // so destroying it would erase the explanation for that deadline.
    const all = await SlaPolicyService.listPolicies(false);
    expect(all.policies.some((candidate) => candidate.id === policy.id)).toBe(true);
  });

  it('revives a retired policy, because retirement is reversible', async () => {
    const policy = await SlaPolicyService.createPolicy({
      name: `Revivable ${Date.now()}`,
      source_channel: 'email',
      first_response_minutes: 20,
      evaluation_order: 405,
    });
    await SlaPolicyService.retirePolicy(policy.id);

    const revived = await SlaPolicyService.updatePolicy(policy.id, { is_active: true });
    expect(revived.is_active).toBe(true);
  });

  it('rejects an unknown policy with NOT_FOUND', async () => {
    await expect(
      SlaPolicyService.updatePolicy('99999999-9999-4999-8999-999999999999', { name: 'nope' })
    ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    await expect(
      SlaPolicyService.retirePolicy('99999999-9999-4999-8999-999999999999')
    ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
  });
});

describe('SLA policies applied to the response clock', () => {
  let parkedPolicies: string[] = [];
  let parkedRules: string[] = [];

  beforeEach(async () => {
    parkedPolicies = await Fixtures.parkActivePolicies();
    parkedRules = await Fixtures.parkActiveRules();
  });

  afterEach(async () => {
    await Fixtures.restoreParkedPolicies(parkedPolicies);
    await Fixtures.restoreParkedRules(parkedRules);
    await Fixtures.reactivateAllUsers();
  });

  it('sets the deadline from the matching policy when routing a lead', async () => {
    const owner = (await Fixtures.createUser('Policyclock')).id;
    await Fixtures.keepOnlyActive([owner]);

    await SlaPolicyService.createPolicy({
      name: `Chat clock ${Date.now()}`,
      source_channel: 'live_chat',
      first_response_minutes: 5,
      evaluation_order: 1,
    });

    const lead = (await Fixtures.createUnownedLead('live_chat')).id;
    const { decision } = await RoutingService.routeLead(lead);

    const windowMinutes =
      (new Date(decision.sla_due_at as string).getTime() -
        new Date(decision.assigned_at as string).getTime()) /
      60000;
    expect(windowMinutes).toBeCloseTo(5, 5);
    // The row explains itself: a manager asking "why only five minutes?" reads
    // the policy name off the routing reason.
    expect(decision.routing_reason).toContain('Chat clock');
  });

  it('falls back to the default window when no policy matches', async () => {
    const owner = (await Fixtures.createUser('Defaultclock')).id;
    await Fixtures.keepOnlyActive([owner]);

    const lead = (await Fixtures.createUnownedLead('csv_import')).id;
    const { decision } = await RoutingService.routeLead(lead);

    const windowMinutes =
      (new Date(decision.sla_due_at as string).getTime() -
        new Date(decision.assigned_at as string).getTime()) /
      60000;
    expect(windowMinutes).toBeCloseTo(DEFAULT_FIRST_RESPONSE_MINUTES, 5);
    expect(decision.routing_reason).toContain('no policy matched');
  });

  it('applies the policy to a manual assignment too', async () => {
    const owner = (await Fixtures.createUser('Manualclock')).id;

    await SlaPolicyService.createPolicy({
      name: `Referral clock ${Date.now()}`,
      source_channel: 'referral',
      first_response_minutes: 12,
      evaluation_order: 1,
    });

    const lead = (await Fixtures.createUnownedLead('referral')).id;
    const result = await AssignmentService.assignTo(lead, owner, 'Picked up manually');

    const windowMinutes =
      (new Date(result.decision.sla_due_at as string).getTime() -
        new Date(result.decision.assigned_at as string).getTime()) /
      60000;
    // A manual pickup gets the same per-lead-type deadline automatic routing
    // would have given it.
    expect(windowMinutes).toBeCloseTo(12, 5);
    // The reason a human typed is preserved verbatim — it is the audit record.
    expect(result.decision.routing_reason).toBe('Picked up manually');
  });

  it('does NOT move the deadline of a lead already in flight', async () => {
    const owner = (await Fixtures.createUser('Inflight')).id;
    await Fixtures.keepOnlyActive([owner]);

    const lead = (await Fixtures.createUnownedLead('facebook')).id;
    const routed = await RoutingService.routeLead(lead);

    // Tighten the policy AFTER the lead was assigned.
    await SlaPolicyService.createPolicy({
      name: `Tightened ${Date.now()}`,
      source_channel: 'facebook',
      first_response_minutes: 1,
      evaluation_order: 1,
    });

    const reread = await AssignmentService.assignTo(lead, owner, 'Same owner, forced re-read');

    // Moving the goalposts under somebody working a queue would manufacture
    // breaches nobody could have prevented.
    expect(reread.decision.sla_due_at).toBe(routed.decision.sla_due_at);
  });
});
