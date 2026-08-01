import { SlaAlertService, MAX_DELIVERY_ATTEMPTS } from '../../src/services/SlaAlertService';
import { SlaMonitorService } from '../../src/services/SlaMonitorService';
import { SLA_WINDOW_MINUTES } from '../../src/services/RoutingService';
import { DEFAULT_SWEEP_LIMIT, DEFAULT_ALERT_PAGE } from '../../src/validators/slaValidators';
import { Fixtures } from '../fixtures';

/**
 * Integration tests for SLA escalation alerts.
 *
 * Run against a REAL database, because the guarantees under test are enforced in
 * SQL: the unique index that makes the repeating sweep raise each escalation
 * exactly once, the guarded UPDATE that stops a second acknowledgement
 * overwriting the first one's timestamp, and the attempt counter that retires a
 * permanently undeliverable alert.
 *
 * These tests exercise the UNCONFIGURED-GATEWAY path, which is the state every
 * developer machine and CI run is in. That is the important case to pin down:
 * with no notification service reachable, an alert must stay `pending` and
 * visible rather than being marked delivered, because claiming a delivery that
 * never happened is the one failure the audit trail could not detect.
 *
 * Managers are parked in `beforeEach` because breach escalation fans out to
 * EVERY active manager — admins left by an earlier run would receive the alerts
 * under test and make the recipient assertions depend on the whole users table.
 */

describe('SlaAlertService escalation tiers', () => {
  let parkedManagers: string[] = [];

  beforeEach(async () => {
    parkedManagers = await Fixtures.parkManagers();
  });

  afterEach(async () => {
    await Fixtures.restoreParkedManagers(parkedManagers);
    await Fixtures.reactivateAllUsers();
  });

  it('warns the OWNER when a clock goes at risk, and does not tell managers', async () => {
    const owner = await Fixtures.createUser('Warnowner');
    const manager = await Fixtures.createUserWithRole('Quietmanager', 'admin');
    // 90% elapsed: at risk, deadline not yet passed.
    const lead = await Fixtures.createClockedLead('live_chat', owner.id, 2, SLA_WINDOW_MINUTES);

    const sweep = await SlaMonitorService.evaluate({
      lead_id: lead.id,
      limit: DEFAULT_SWEEP_LIMIT,
    });

    expect(sweep.at_risk).toBe(1);
    expect(sweep.alerts_raised).toBe(1);

    const alerts = await Fixtures.alertsForLead(lead.id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe('owner_warning');
    expect(alerts[0].recipient_user_id).toBe(owner.id);
    // The point of the first tier is that the person who can still act is told.
    // Escalating to a manager before the deadline has even passed would train
    // managers to ignore the alerts.
    expect(alerts.some((a) => a.recipient_user_id === manager.id)).toBe(false);
  });

  it('escalates a breach to EVERY active manager, and still warns the owner', async () => {
    const owner = await Fixtures.createUser('Breachowner');
    const first = await Fixtures.createUserWithRole('Managerone', 'admin');
    const second = await Fixtures.createUserWithRole('Managertwo', 'admin');
    const lead = await Fixtures.createClockedLead('web_form', owner.id, -10, SLA_WINDOW_MINUTES);

    const sweep = await SlaMonitorService.evaluate({
      lead_id: lead.id,
      limit: DEFAULT_SWEEP_LIMIT,
    });

    expect(sweep.breached).toBe(1);
    // One owner_warning plus one manager_breach per manager.
    expect(sweep.alerts_raised).toBe(3);

    const alerts = await Fixtures.alertsForLead(lead.id);
    const managerAlerts = alerts.filter((a) => a.kind === 'manager_breach');
    expect(managerAlerts.map((a) => a.recipient_user_id).sort()).toEqual(
      [first.id, second.id].sort()
    );

    // The owner is warned too. A lead that ran from on_track straight past its
    // deadline between two sweeps would otherwise never warn its owner at all.
    const ownerAlerts = alerts.filter((a) => a.kind === 'owner_warning');
    expect(ownerAlerts).toHaveLength(1);
    expect(ownerAlerts[0].recipient_user_id).toBe(owner.id);
  });

  it('raises each escalation exactly ONCE across repeated sweeps', async () => {
    const owner = await Fixtures.createUser('Nospam');
    await Fixtures.createUserWithRole('Spamcheck', 'admin');
    const lead = await Fixtures.createClockedLead('phone', owner.id, -30, SLA_WINDOW_MINUTES);

    const first = await SlaMonitorService.evaluate({
      lead_id: lead.id,
      limit: DEFAULT_SWEEP_LIMIT,
    });
    expect(first.alerts_raised).toBe(2);

    const second = await SlaMonitorService.evaluate({
      lead_id: lead.id,
      limit: DEFAULT_SWEEP_LIMIT,
    });
    const third = await SlaMonitorService.evaluate({
      lead_id: lead.id,
      limit: DEFAULT_SWEEP_LIMIT,
    });

    // Still breached on every pass, but nobody is re-notified. This is the
    // anti-spam invariant — without it managers learn to ignore the alerts.
    expect(second.breached).toBe(1);
    expect(second.alerts_raised).toBe(0);
    expect(third.alerts_raised).toBe(0);
    expect(await Fixtures.alertsForLead(lead.id)).toHaveLength(2);
  });

  it('leaves an alert PENDING when no notification gateway is configured', async () => {
    const owner = await Fixtures.createUser('Nogateway');
    const lead = await Fixtures.createClockedLead('email', owner.id, 1, SLA_WINDOW_MINUTES);

    const sweep = await SlaMonitorService.evaluate({
      lead_id: lead.id,
      limit: DEFAULT_SWEEP_LIMIT,
    });

    expect(sweep.alerts_raised).toBe(1);
    expect(sweep.alerts_delivered).toBe(0);

    const [alert] = await Fixtures.alertsForLead(lead.id);
    // Claiming delivery that no notification service ever saw is the one failure
    // the audit trail could not detect, so the row stays pending and visible.
    expect(alert.state).toBe('pending');
    // The retry budget must NOT be burned by an absent gateway, or connecting
    // ProjexCloud later would find every historical alert already failed.
    expect(alert.attempts).toBe(0);
  });

  it('records the minutes-to-due at the moment the alert was raised', async () => {
    const owner = await Fixtures.createUser('Evidence');
    const lead = await Fixtures.createClockedLead('linkedin', owner.id, -12, SLA_WINDOW_MINUTES);

    await SlaMonitorService.evaluate({ lead_id: lead.id, limit: DEFAULT_SWEEP_LIMIT });

    const [alert] = await Fixtures.alertsForLead(lead.id);
    // Negative because already overdue. A snapshot, so the ledger still explains
    // itself after the lead's clock has moved on.
    expect(alert.minutes_to_due).not.toBeNull();
    expect(alert.minutes_to_due as number).toBeLessThan(0);
  });

  it('does not escalate a lead that is on track or already answered', async () => {
    const owner = await Fixtures.createUser('Calm');
    await Fixtures.createUserWithRole('Calmmanager', 'admin');

    const onTrack = await Fixtures.createClockedLead('facebook', owner.id, 28, SLA_WINDOW_MINUTES);
    const sweepA = await SlaMonitorService.evaluate({
      lead_id: onTrack.id,
      limit: DEFAULT_SWEEP_LIMIT,
    });
    expect(sweepA.alerts_raised).toBe(0);

    const answered = await Fixtures.createClockedLead('referral', owner.id, 20, SLA_WINDOW_MINUTES);
    await SlaMonitorService.recordFirstResponse(answered.id, { channel: 'email' }, owner.id);
    const sweepB = await SlaMonitorService.evaluate({
      lead_id: answered.id,
      limit: DEFAULT_SWEEP_LIMIT,
    });
    expect(sweepB.met).toBe(1);
    expect(sweepB.alerts_raised).toBe(0);
  });

  it('skips a deactivated owner rather than raising an undeliverable warning', async () => {
    const owner = await Fixtures.createUser('Departed');
    const lead = await Fixtures.createClockedLead('tiktok', owner.id, 1, SLA_WINDOW_MINUTES);
    await Fixtures.deactivateUser(owner.id);

    const sweep = await SlaMonitorService.evaluate({
      lead_id: lead.id,
      limit: DEFAULT_SWEEP_LIMIT,
    });

    // Nobody active to warn. The sweep still records the at-risk verdict.
    expect(sweep.at_risk).toBe(1);
    expect(sweep.alerts_raised).toBe(0);
  });
});

describe('SlaAlertService.acknowledgeForLead', () => {
  let parkedManagers: string[] = [];

  beforeEach(async () => {
    parkedManagers = await Fixtures.parkManagers();
  });

  afterEach(async () => {
    await Fixtures.restoreParkedManagers(parkedManagers);
    await Fixtures.reactivateAllUsers();
  });

  it('acknowledges only the caller OWN alerts and is idempotent', async () => {
    const owner = await Fixtures.createUser('Ackowner');
    const manager = await Fixtures.createUserWithRole('Ackmanager', 'admin');
    const other = await Fixtures.createUserWithRole('Othermanager', 'admin');
    const lead = await Fixtures.createClockedLead('google_ads', owner.id, -15, SLA_WINDOW_MINUTES);

    await SlaMonitorService.evaluate({ lead_id: lead.id, limit: DEFAULT_SWEEP_LIMIT });

    const first = await SlaAlertService.acknowledgeForLead(lead.id, manager.id);
    expect(first.acknowledged).toBe(1);
    expect(first.already_acknowledged).toBe(false);

    const alerts = await Fixtures.alertsForLead(lead.id);
    const mine = alerts.find((a) => a.recipient_user_id === manager.id);
    expect(mine?.state).toBe('acknowledged');
    expect(mine?.acknowledged_by_user_id).toBe(manager.id);

    // One manager must not be able to silence another's escalation.
    const theirs = alerts.find((a) => a.recipient_user_id === other.id);
    expect(theirs?.state).toBe('pending');

    const repeat = await SlaAlertService.acknowledgeForLead(lead.id, manager.id);
    expect(repeat.acknowledged).toBe(0);
    expect(repeat.already_acknowledged).toBe(true);
  });

  it('does NOT clear the breach on the lead', async () => {
    const owner = await Fixtures.createUser('Stillbreached');
    const manager = await Fixtures.createUserWithRole('Ackbreach', 'admin');
    const lead = await Fixtures.createClockedLead('webhook', owner.id, -20, SLA_WINDOW_MINUTES);

    await SlaMonitorService.evaluate({ lead_id: lead.id, limit: DEFAULT_SWEEP_LIMIT });
    await SlaAlertService.acknowledgeForLead(lead.id, manager.id);

    const clock = await Fixtures.clockOf(lead.id);
    // Acknowledgement means "I have seen this", not "this did not happen".
    // Letting it clear the breach would make the compliance number meaningless.
    expect(clock?.sla_breached).toBe(true);
  });

  it('reports nothing to acknowledge distinctly from already acknowledged', async () => {
    const owner = await Fixtures.createUser('Nothing');
    const bystander = await Fixtures.createUser('Bystander');
    const lead = await Fixtures.createClockedLead('api', owner.id, 25, SLA_WINDOW_MINUTES);

    const result = await SlaAlertService.acknowledgeForLead(lead.id, bystander.id);

    // No alerts exist for this person at all — which is NOT the same as having
    // already acknowledged one, and the caller needs to tell those apart.
    expect(result.acknowledged).toBe(0);
    expect(result.already_acknowledged).toBe(false);
    expect(result.alerts).toEqual([]);
  });

  it('rejects an unknown lead with NOT_FOUND', async () => {
    const actor = await Fixtures.createUser('Ackghost');
    await expect(
      SlaAlertService.acknowledgeForLead('12121212-1212-4121-8121-121212121212', actor.id)
    ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
  });
});

describe('SlaAlertService.list and dispatchPending', () => {
  let parkedManagers: string[] = [];

  beforeEach(async () => {
    parkedManagers = await Fixtures.parkManagers();
  });

  afterEach(async () => {
    await Fixtures.restoreParkedManagers(parkedManagers);
    await Fixtures.reactivateAllUsers();
  });

  it('lists a lead alerts with the joined lead and recipient names', async () => {
    const owner = await Fixtures.createUser('Listowner');
    const lead = await Fixtures.createClockedLead('instagram', owner.id, 1, SLA_WINDOW_MINUTES);
    await SlaMonitorService.evaluate({ lead_id: lead.id, limit: DEFAULT_SWEEP_LIMIT });

    const listed = await SlaAlertService.list({
      lead_id: lead.id,
      limit: DEFAULT_ALERT_PAGE,
      offset: 0,
    });

    expect(listed.total).toBe(1);
    expect(listed.alerts[0].kind).toBe('owner_warning');
    // Joined, so a ledger view issues no per-row lookup.
    expect(listed.alerts[0].recipient_name).toBe(owner.displayName);
    expect(listed.alerts[0].lead_name).toBe('SLA Fixture');
  });

  it('filters by state and by kind', async () => {
    const owner = await Fixtures.createUser('Filterowner');
    await Fixtures.createUserWithRole('Filtermanager', 'admin');
    const lead = await Fixtures.createClockedLead('csv_import', owner.id, -25, SLA_WINDOW_MINUTES);
    await SlaMonitorService.evaluate({ lead_id: lead.id, limit: DEFAULT_SWEEP_LIMIT });

    const managerOnly = await SlaAlertService.list({
      lead_id: lead.id,
      kind: 'manager_breach',
      limit: DEFAULT_ALERT_PAGE,
      offset: 0,
    });
    expect(managerOnly.total).toBe(1);
    expect(managerOnly.alerts[0].kind).toBe('manager_breach');

    const pending = await SlaAlertService.list({
      lead_id: lead.id,
      state: 'pending',
      limit: DEFAULT_ALERT_PAGE,
      offset: 0,
    });
    expect(pending.total).toBe(2);

    const delivered = await SlaAlertService.list({
      lead_id: lead.id,
      state: 'delivered',
      limit: DEFAULT_ALERT_PAGE,
      offset: 0,
    });
    expect(delivered.total).toBe(0);
  });

  it('is a deliberate no-op when the gateway is unconfigured', async () => {
    const owner = await Fixtures.createUser('Dispatchowner');
    const lead = await Fixtures.createClockedLead('landing_page', owner.id, 1, SLA_WINDOW_MINUTES);
    await SlaMonitorService.evaluate({ lead_id: lead.id, limit: DEFAULT_SWEEP_LIMIT });

    const result = await SlaAlertService.dispatchPending(100);

    expect(result.gateway_configured).toBe(false);
    // Pending alerts ARE picked up — the sweep found work — but none is marked
    // delivered or failed, and no attempt is burned.
    expect(result.attempted).toBeGreaterThanOrEqual(1);
    expect(result.delivered).toBe(0);
    expect(result.failed).toBe(0);

    const [alert] = await Fixtures.alertsForLead(lead.id);
    expect(alert.state).toBe('pending');
    expect(alert.attempts).toBe(0);
    // A retry budget that is never consumed means the backlog survives until the
    // gateway is connected, which is the whole reason the row is written first.
    expect(alert.attempts).toBeLessThan(MAX_DELIVERY_ATTEMPTS);
  });
});
