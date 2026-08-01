import { SlaMonitorService, AT_RISK_THRESHOLD } from '../../src/services/SlaMonitorService';
import { SLA_WINDOW_MINUTES } from '../../src/services/RoutingService';
import { DEFAULT_SWEEP_LIMIT } from '../../src/validators/slaValidators';
import { Fixtures } from '../fixtures';

/** Used to place a fixture decisively at the front of an unnamed sweep. */
const MINUTES_IN_A_YEAR = 365 * 24 * 60;

/**
 * Integration tests for SLA monitoring.
 *
 * Run against a REAL database, for the same reason the routing tests do: the
 * guarantees under test are enforced in SQL — the compare-and-set that makes
 * recording a response idempotent, the `sla_breached OR ...` expression that
 * refuses to clear a breach, and the ON CONFLICT upsert that keeps exactly one
 * observation per lead. A mocked data layer would assert the mock.
 *
 * These tests exercise the LOCAL WALL-CLOCK path, which is what runs when
 * `PROJEXCLOUD_GATEWAY_URL` is unset — the state every developer machine and CI
 * run is in. The `sdk-sla` path is the same code with `reconcile` preferring an
 * upstream verdict; it is covered by the contract tests that run against a
 * configured gateway.
 *
 * A clock cannot be made to expire by waiting, so `Fixtures.createClockedLead`
 * places `sla_due_at` in the past directly. That is deliberately something the
 * application itself cannot do.
 */

describe('SlaMonitorService.recordFirstResponse', () => {
  afterEach(async () => {
    await Fixtures.reactivateAllUsers();
  });

  it('stops the clock, measures from ARRIVAL, and logs the observation', async () => {
    const owner = await Fixtures.createUser('Responder');
    // Arrived 10 minutes ago with 20 minutes still to run.
    const lead = await Fixtures.createClockedLead('web_form', owner.id, 20, SLA_WINDOW_MINUTES);

    const result = await SlaMonitorService.recordFirstResponse(
      lead.id,
      { channel: 'email', note: 'Called back and booked a demo' },
      owner.id
    );

    expect(result.already_recorded).toBe(false);
    expect(result.sla.state).toBe('met');
    expect(result.sla.breach_reason).toBeNull();
    expect(result.sla.first_response_at).not.toBeNull();
    expect(result.sla.clock_source).toBe('local_wallclock');

    // Measured from arrival, not assignment: the prospect has been waiting since
    // they submitted, so ~10 minutes have elapsed, not ~0.
    expect(result.sla.response_seconds).toBeGreaterThanOrEqual(9 * 60);
    expect(result.sla.response_seconds).toBeLessThanOrEqual(11 * 60);
    expect(result.sla.target_minutes).toBe(SLA_WINDOW_MINUTES);

    const observation = await Fixtures.observationOf(lead.id);
    expect(observation).not.toBeNull();
    expect(observation?.state).toBe('met');
    // Always written explicitly — the column's schema default is TRUE, so an
    // omitted value would record a violation for a lead that met its deadline.
    expect(observation?.violation).toBe(false);
    expect(observation?.response_channel).toBe('email');
    expect(observation?.responded_by_user_id).toBe(owner.id);
    expect(observation?.note).toBe('Called back and booked a demo');
    expect(observation?.response_time).toBe(`PT${result.sla.response_seconds}S`);
  });

  it('is idempotent — a retry keeps the ORIGINAL response time', async () => {
    const owner = await Fixtures.createUser('Retrier');
    const lead = await Fixtures.createClockedLead('phone', owner.id, 20, SLA_WINDOW_MINUTES);

    const first = await SlaMonitorService.recordFirstResponse(
      lead.id,
      { channel: 'phone' },
      owner.id
    );
    const repeat = await SlaMonitorService.recordFirstResponse(
      lead.id,
      { channel: 'email' },
      owner.id
    );

    expect(repeat.already_recorded).toBe(true);
    // The anti-gaming guarantee: overwriting first_response_at with a later one
    // would silently turn a breach into a pass.
    expect(repeat.sla.first_response_at).toBe(first.sla.first_response_at);
    expect(repeat.sla.response_seconds).toBe(first.sla.response_seconds);

    const observation = await Fixtures.observationOf(lead.id);
    // One row per lead, so the retry did not add a second observation that would
    // drag every average toward whichever leads were retried most.
    expect(observation?.response_channel).toBe('phone');
  });

  it('records a LATE response without clearing the breach', async () => {
    const owner = await Fixtures.createUser('Latecomer');
    // Deadline passed 5 minutes ago.
    const lead = await Fixtures.createClockedLead('email', owner.id, -5, SLA_WINDOW_MINUTES);

    const result = await SlaMonitorService.recordFirstResponse(
      lead.id,
      { channel: 'email' },
      owner.id
    );

    expect(result.sla.state).toBe('breached');
    expect(result.sla.breach_reason).toBe('responded_after_due');

    const clock = await Fixtures.clockOf(lead.id);
    // A missed deadline is a historical fact. Acting late stops the clock and is
    // worth measuring, but it never converts the breach into compliance.
    expect(clock?.sla_breached).toBe(true);
    expect(clock?.sla_breach_reason).toBe('responded_after_due');
    expect(clock?.first_response_at).not.toBeNull();

    const observation = await Fixtures.observationOf(lead.id);
    expect(observation?.violation).toBe(true);
  });

  it('credits the calling user when no responder is named', async () => {
    const owner = await Fixtures.createUser('Selfcredit');
    const lead = await Fixtures.createClockedLead('live_chat', owner.id, 25, SLA_WINDOW_MINUTES);

    await SlaMonitorService.recordFirstResponse(lead.id, { channel: 'live_chat' }, owner.id);

    const observation = await Fixtures.observationOf(lead.id);
    expect(observation?.responded_by_user_id).toBe(owner.id);
  });

  it('records a response on an unrouted lead with no breach verdict', async () => {
    const actor = await Fixtures.createUser('Earlybird');
    const lead = await Fixtures.createUnownedLead('referral');

    const result = await SlaMonitorService.recordFirstResponse(
      lead.id,
      { channel: 'phone' },
      actor.id
    );

    // The response genuinely happened, so it is logged rather than rejected —
    // but with no deadline there is nothing to be late against.
    expect(result.sla.state).toBe('met');
    expect(result.sla.target_minutes).toBeNull();
    expect(result.sla.breach_reason).toBeNull();
    expect(result.sla.response_seconds).not.toBeNull();
  });

  it('rejects an unknown lead with NOT_FOUND', async () => {
    const actor = await Fixtures.createUser('Ghosthunter');
    await expect(
      SlaMonitorService.recordFirstResponse(
        '44444444-4444-4444-8444-444444444444',
        { channel: 'email' },
        actor.id
      )
    ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
  });

  it('rejects an unknown responder with NOT_FOUND', async () => {
    const owner = await Fixtures.createUser('Realowner');
    const lead = await Fixtures.createClockedLead('csv_import', owner.id, 20, SLA_WINDOW_MINUTES);

    await expect(
      SlaMonitorService.recordFirstResponse(
        lead.id,
        { channel: 'email', responded_by_user_id: '55555555-5555-4555-8555-555555555555' },
        owner.id
      )
    ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
  });
});

describe('SlaMonitorService.evaluate', () => {
  afterEach(async () => {
    await Fixtures.reactivateAllUsers();
  });

  it('marks an expired clock as breached and reports it once', async () => {
    const owner = await Fixtures.createUser('Breachfinder');
    const lead = await Fixtures.createClockedLead('facebook', owner.id, -10, SLA_WINDOW_MINUTES);

    const first = await SlaMonitorService.evaluate({ lead_id: lead.id, limit: DEFAULT_SWEEP_LIMIT });

    expect(first.evaluated).toBe(1);
    expect(first.breached).toBe(1);
    expect(first.newly_breached).toEqual([lead.id]);
    expect(first.clock_source).toBe('local_wallclock');

    const clock = await Fixtures.clockOf(lead.id);
    expect(clock?.sla_breached).toBe(true);
    expect(clock?.sla_breach_reason).toBe('no_response_in_window');

    const second = await SlaMonitorService.evaluate({
      lead_id: lead.id,
      limit: DEFAULT_SWEEP_LIMIT,
    });

    // Still breached, but NOT newly. An alerting job driven off this list must
    // not re-notify the manager on every sweep.
    expect(second.breached).toBe(1);
    expect(second.newly_breached).toEqual([]);
  });

  it('flags a clock past the at-risk threshold without changing any column', async () => {
    const owner = await Fixtures.createUser('Atrisk');
    // 90% elapsed of a 30-minute window: 3 minutes left.
    const remaining = Math.ceil(SLA_WINDOW_MINUTES * (1 - AT_RISK_THRESHOLD)) - 1;
    const lead = await Fixtures.createClockedLead(
      'instagram',
      owner.id,
      remaining,
      SLA_WINDOW_MINUTES
    );

    const result = await SlaMonitorService.evaluate({
      lead_id: lead.id,
      limit: DEFAULT_SWEEP_LIMIT,
    });

    expect(result.at_risk).toBe(1);
    expect(result.breached).toBe(0);

    const clock = await Fixtures.clockOf(lead.id);
    // Advisory only: the warning exists so somebody can act BEFORE the deadline,
    // and marking the lead breached early would be a false record.
    expect(clock?.sla_breached).toBe(false);
    expect(clock?.sla_breach_reason).toBeNull();
  });

  it('leaves a comfortable clock on track', async () => {
    const owner = await Fixtures.createUser('Ontrack');
    const lead = await Fixtures.createClockedLead('linkedin', owner.id, 28, SLA_WINDOW_MINUTES);

    const result = await SlaMonitorService.evaluate({
      lead_id: lead.id,
      limit: DEFAULT_SWEEP_LIMIT,
    });

    expect(result.on_track).toBe(1);
    expect(result.newly_breached).toEqual([]);
  });

  it('reports a responded lead as met', async () => {
    const owner = await Fixtures.createUser('Metowner');
    const lead = await Fixtures.createClockedLead('google_ads', owner.id, 20, SLA_WINDOW_MINUTES);
    await SlaMonitorService.recordFirstResponse(lead.id, { channel: 'email' }, owner.id);

    const result = await SlaMonitorService.evaluate({
      lead_id: lead.id,
      limit: DEFAULT_SWEEP_LIMIT,
    });

    expect(result.met).toBe(1);
    expect(result.breached).toBe(0);
  });

  it('sweeps every open clock when no lead is named', async () => {
    const owner = await Fixtures.createUser('Sweepowner');
    // Deliberately the MOST overdue clock in the database, by a wide margin.
    //
    // An unnamed sweep takes the `limit` most overdue open clocks
    // (ORDER BY sla_due_at ASC), so a lead that is merely twenty minutes late
    // sorts behind every older one. Once the database holds more open clocks
    // than the limit — which any environment reaches after a while — this
    // fixture fell outside the window and the assertion failed for a reason
    // that had nothing to do with the sweep. Placing it a year in the past
    // makes it the first row the sweep sees regardless of how much history
    // has accumulated around it.
    const overdue = await Fixtures.createClockedLead(
      'webhook',
      owner.id,
      -MINUTES_IN_A_YEAR,
      SLA_WINDOW_MINUTES
    );

    const result = await SlaMonitorService.evaluate({ limit: 500 });

    expect(result.evaluated).toBeGreaterThanOrEqual(1);
    expect(result.newly_breached).toContain(overdue.id);
  });

  it('rejects a named lead that does not exist with NOT_FOUND', async () => {
    await expect(
      SlaMonitorService.evaluate({
        lead_id: '66666666-6666-4666-8666-666666666666',
        limit: DEFAULT_SWEEP_LIMIT,
      })
    ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
  });
});

describe('SlaMonitorService.status', () => {
  afterEach(async () => {
    await Fixtures.reactivateAllUsers();
  });

  it('counts the states and computes compliance for one owner', async () => {
    const owner = await Fixtures.createUser('Snapshot');

    const met = await Fixtures.createClockedLead('web_form', owner.id, 20, SLA_WINDOW_MINUTES);
    await SlaMonitorService.recordFirstResponse(met.id, { channel: 'email' }, owner.id);
    await Fixtures.createClockedLead('phone', owner.id, -15, SLA_WINDOW_MINUTES);
    await Fixtures.createClockedLead('email', owner.id, 28, SLA_WINDOW_MINUTES);

    const snapshot = await SlaMonitorService.status({
      window_minutes: 1440,
      owner_user_id: owner.id,
    });

    expect(snapshot.window_minutes).toBe(1440);
    expect(snapshot.totals.tracked).toBe(3);
    expect(snapshot.totals.met).toBe(1);
    expect(snapshot.totals.breached).toBe(1);
    expect(snapshot.totals.on_track).toBe(1);

    // Measured over DECIDED clocks only — met plus breached — so the lead still
    // comfortably inside its window is excluded rather than counted as a pass.
    expect(snapshot.compliance_rate).toBeCloseTo(0.5, 4);
    expect(snapshot.average_response_seconds).not.toBeNull();
    expect(snapshot.clock_source).toBe('local_wallclock');
  });

  it('returns a null compliance rate rather than a fictional 100 percent', async () => {
    const owner = await Fixtures.createUser('Undecided');
    await Fixtures.createClockedLead('tiktok', owner.id, 29, SLA_WINDOW_MINUTES);

    const snapshot = await SlaMonitorService.status({
      window_minutes: 1440,
      owner_user_id: owner.id,
    });

    expect(snapshot.totals.on_track).toBe(1);
    // No clock has closed, so there is no rate. Reporting 100 percent here is a
    // number a manager would act on.
    expect(snapshot.compliance_rate).toBeNull();
    expect(snapshot.average_response_seconds).toBeNull();
  });

  it('lists only OPEN clocks needing attention, most overdue first', async () => {
    const owner = await Fixtures.createUser('Attention');

    const veryLate = await Fixtures.createClockedLead('api', owner.id, -40, SLA_WINDOW_MINUTES);
    const slightlyLate = await Fixtures.createClockedLead(
      'landing_page',
      owner.id,
      -5,
      SLA_WINDOW_MINUTES
    );
    // Breached but already answered: history, not work.
    const answered = await Fixtures.createClockedLead('referral', owner.id, -8, SLA_WINDOW_MINUTES);
    await SlaMonitorService.recordFirstResponse(answered.id, { channel: 'phone' }, owner.id);

    const snapshot = await SlaMonitorService.status({
      window_minutes: 1440,
      owner_user_id: owner.id,
    });

    const ids = snapshot.attention.map((item) => item.lead_id);
    expect(ids).toEqual([veryLate.id, slightlyLate.id]);
    expect(snapshot.attention[0].minutes_to_due).toBeLessThan(0);
    expect(snapshot.attention[0].owner_name).toBe(owner.displayName);
  });

  it('excludes leads that arrived outside the window', async () => {
    const owner = await Fixtures.createUser('Windowed');
    // Arrived ~25 hours ago (assigned_at = due - window, both far in the past).
    await Fixtures.createClockedLead('landing_page', owner.id, -1500, SLA_WINDOW_MINUTES);

    const snapshot = await SlaMonitorService.status({
      window_minutes: 60,
      owner_user_id: owner.id,
    });

    expect(snapshot.totals.tracked).toBe(0);
  });
});
