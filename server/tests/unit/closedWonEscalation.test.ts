import crypto from 'crypto';
import { dataService } from '../../src/services/DataService';
import { SdkGatewayClient } from '../../src/platform/sdkGateway';
import { closedWonSteps, runSaga, sagaSteps, type SagaStep, type StepContext } from '../../src/orchestration';
import { ESCALATION_RULES, handleRung, type Rung } from '../../src/orchestration';

/**
 * The four criteria for the closed-won saga and the escalation glue.
 *
 * The crash-and-resume test is the headline and is run for real: a saga is
 * driven until a step throws, the process is ABANDONED mid-run exactly as a
 * crash would leave it, and a second call with the same key continues from the
 * ledger. The counters prove nothing before the crash point ran twice.
 */

const RUN = crypto.randomUUID().slice(0, 8);

beforeAll(async () => {
  // On the way in — tests/setup.ts closes the pool in a root afterAll that runs
  // before this file's would, and this also clears a killed run's leftovers.
  await dataService.query(`DELETE FROM leadflow_saga_run WHERE idempotency_key LIKE 'cw:%'`);
  await dataService.query(`DELETE FROM leadflow_escalation_event WHERE event_id LIKE 'esc-%'`);
  await dataService.query(`DELETE FROM leadflow_escalation_incident WHERE episode_key LIKE 'sla-systemic:%'`);
});

/* ------------------- AC1: a mid-saga crash resumes without duplicating */

describe('a crashed saga resumes from the last completed step', () => {
  /**
   * Steps that count their own executions and can be made to fail on demand.
   * `customer` and `welcome` are the two the criterion names explicitly.
   */
  function steps(counts: Record<string, number>, failAt: string | null): SagaStep[] {
    const mk = (name: string): SagaStep => ({
      name,
      run: async () => {
        if (name === failAt) throw new Error(`${name} crashed`);
        counts[name] = (counts[name] ?? 0) + 1;
        return { id: `${name}-id` };
      },
      // Optional so a failure abandons the run rather than rolling it back —
      // which is what a CRASH looks like: the process is gone, so nothing
      // compensates and the run row is left claimed and 'running'.
      compensate: async () => undefined,
    });
    return ['transition_deal', 'stop_presale', 'customer', 'welcome', 'handoff'].map(mk);
  }

  it('resumes mid-stream with NO duplicate customer, welcome or handoff', async () => {
    const counts: Record<string, number> = {};
    const key = `cw:${RUN}:crash`;

    /*
     * The crash. `welcome` throws, and because every step here is required the
     * runner compensates and marks the run 'compensated' — which is NOT what a
     * process death looks like. So the run is forced back to 'running'
     * afterwards, reproducing the state a killed process actually leaves: a
     * claimed row and a half-written ledger with nobody coming back to it.
     */
    await runSaga('closed_won', key, steps(counts, 'welcome'), {});
    await dataService.query(
      `UPDATE leadflow_saga_run SET status = 'running', finished_at = NULL WHERE idempotency_key = $1`,
      [key],
    );

    expect(counts).toEqual({ transition_deal: 1, stop_presale: 1, customer: 1 });

    // The restart: same key, nothing failing this time.
    const resumed = await runSaga('closed_won', key, steps(counts, null), {});

    expect(resumed.status).toBe('completed');
    expect(resumed.resumed).toBe(true);
    // THE CRITERION. The three steps that already ran are still at 1 — the
    // customer is not created twice — and only the two that never finished ran.
    expect(counts).toEqual({
      transition_deal: 1, stop_presale: 1, customer: 1, welcome: 1, handoff: 1,
    });
  });

  it('keeps the ORIGINAL correlation id across the resume', async () => {
    // The chain has to survive the crash, or the two halves of one saga appear
    // in the trace as unrelated runs.
    const key = `cw:${RUN}:corr`;
    const first = await runSaga('closed_won', key, steps({}, 'welcome'), {});
    await dataService.query(
      `UPDATE leadflow_saga_run SET status = 'running' WHERE idempotency_key = $1`, [key]);
    const second = await runSaga('closed_won', key, steps({}, null), {});
    expect(second.correlationId).toBe(first.correlationId);
  });

  it('still compensates work an EARLIER process did, if the resume then fails', async () => {
    const undone: string[] = [];
    const mk = (name: string, fail = false): SagaStep => ({
      name,
      run: async () => { if (fail) throw new Error(`${name} failed`); return { id: name }; },
      compensate: async () => { undone.push(name); },
    });
    const key = `cw:${RUN}:resume-rollback`;

    await runSaga('cw', key, [mk('a'), mk('b'), mk('c', true)], {});
    await dataService.query(
      `UPDATE leadflow_saga_run SET status = 'running' WHERE idempotency_key = $1`, [key]);
    undone.length = 0;

    await runSaga('cw', key, [mk('a'), mk('b'), mk('c', true)], {});

    // 'a' and 'b' were completed by the DEAD process, not this one. A resumed
    // run that rolls back must undo everything that exists, not merely what it
    // personally did — otherwise the crash leaves orphans forever.
    expect(undone).toEqual(['b', 'a']);
  });

  it('does not re-run a settled saga at all', async () => {
    const counts: Record<string, number> = {};
    const key = `cw:${RUN}:settled`;
    await runSaga('cw', key, steps(counts, null), {});
    const again = await runSaga('cw', key, steps(counts, null), {});
    expect(again.replayed).toBe(true);
    expect(counts.handoff).toBe(1);
  });
});

/* ----------------------------- AC2 + AC3: compensations, and the ordering */

describe('the closed-won chain compensates and stops presale first', () => {
  const input = {
    dealId: 'deal-1', chargeId: 'charge-1', subjectRef: 'subj-1', tenantId: null,
    enrollmentIds: ['enr-1'], campaignIds: ['camp-1'],
  };

  it('declares a compensation for every step', () => {
    for (const step of closedWonSteps(input)) {
      expect(typeof step.compensate).toBe('function');
    }
  });

  it('STOPS PRESALE BEFORE THE WELCOME, which is the whole ordering', () => {
    const names = closedWonSteps(input).map((s) => s.name);
    const stop = names.indexOf('stop_presale');
    const welcome = names.indexOf('welcome');
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(welcome).toBeGreaterThan(stop);
    // And before the handoff and the onboarding link too — everything that
    // signals "you are a customer now" comes after the presale machinery stops.
    expect(names.indexOf('create_handoff')).toBeGreaterThan(stop);
    expect(names.indexOf('onboarding_link')).toBeGreaterThan(stop);
  });

  it('makes stop_presale REQUIRED, so a failure rolls back rather than continuing', () => {
    const stop = closedWonSteps(input).find((s) => s.name === 'stop_presale')!;
    // The one step where carrying on would actively harm the relationship the
    // rest of the saga exists to start: a customer who has just paid receiving
    // "still thinking it over?" the next morning.
    expect(stop.optional).toBeFalsy();
  });

  it('refuses to start with no payment evidence', async () => {
    const noCharge = closedWonSteps({ ...input, chargeId: '' });
    const verify = noCharge.find((s) => s.name === 'verify_payment')!;
    await expect(
      verify.run({ correlationId: 'c', stepKey: 'k', results: {}, input: {} }),
    ).rejects.toThrow(/chargeId is required/);
  });

  /*
   * "Every step has a TESTED compensation" — asserting that `compensate` is a
   * function only proves it was typed, and the type already forced that. So
   * every compensation is RUN here against a stubbed gateway, and the call it
   * makes (or deliberately does not make) is asserted.
   *
   * The six no-ops are asserted as loudly as the two that act. Each is a
   * decision, not an omission: an un-sent welcome cannot be unsent, and
   * re-entering a customer into a presale sequence after a failed close is how
   * somebody gets "still thinking?" an hour after their payment failed. A test
   * that only checked the two acting compensations would let a later edit turn
   * one of those decisions into a real call without anything failing.
   */
  describe('every compensation runs, and does what it says', () => {
    const ctx = (name: string): StepContext =>
      ({ correlationId: 'corr-1', stepKey: `k:${name}`, results: {}, input: {} });

    /** The forward-undo calls each compensation issues, in order. */
    async function undoCallsFor(
      stepName: string,
      result: unknown,
    ): Promise<{ sdk: string; path: string; method?: string; body?: unknown }[]> {
      jest.spyOn(SdkGatewayClient, 'isConfigured').mockReturnValue(true);
      const call = jest
        .spyOn(SdkGatewayClient, 'call')
        .mockResolvedValue({ delivered: true, status: 200, data: { data: {} } });

      const step = closedWonSteps(input).find((s) => s.name === stepName)!;
      await step.compensate(ctx(stepName), result);

      return call.mock.calls.map((c) => c[0] as { sdk: string; path: string; method?: string; body?: unknown });
    }

    afterEach(() => jest.restoreAllMocks());

    it('moves the deal BACK rather than pretending the transition never happened', async () => {
      const calls = await undoCallsFor('transition_deal', { deal_id: 'deal-1' });
      expect(calls).toHaveLength(1);
      expect(calls[0].sdk).toBe('sdk-crm');
      expect(calls[0].path).toBe('/api/crm/deals/deal-1/transition');
      // A forward action: the stage history keeps BOTH moves, which is correct.
      // A deal that briefly reached Closed Won and was rolled back is a fact.
      expect(calls[0].body).toMatchObject({ to_stage: 'COMMERCIAL_REVIEW' });
    });

    it('cancels the handoff it created, addressing it by the returned id', async () => {
      const calls = await undoCallsFor('create_handoff', { handoff_id: 'ho-9' });
      expect(calls).toHaveLength(1);
      expect(calls[0].sdk).toBe('sdk-handoff');
      expect(calls[0].path).toBe('/api/handoffs/ho-9');
      expect(calls[0].method).toBe('PATCH');
      expect(calls[0].body).toMatchObject({ status: 'cancelled' });
    });

    it.each([
      ['verify_payment', 'reading evidence created nothing to undo'],
      ['stop_presale', 'restarting outreach after a failed close is a human decision'],
      ['provision_customer', 'the step could not run, so there is nothing provisioned'],
      ['welcome', 'a sent welcome cannot be unsent'],
      ['alert_stakeholders', 'an internal alert that already landed cannot be recalled'],
      ['onboarding_link', 'an issued link is harmless once the handoff is cancelled'],
    ])('leaves %s alone on rollback — %s', async (stepName) => {
      expect(await undoCallsFor(stepName, { id: 'x' })).toEqual([]);
    });

    it('covers EVERY step — no compensation is left unexercised', () => {
      // The guard against this describe block going stale: add a step to the
      // saga without a case here and this fails, rather than the new step
      // silently shipping an untested compensation.
      const exercised = [
        'verify_payment', 'transition_deal', 'stop_presale', 'provision_customer',
        'welcome', 'alert_stakeholders', 'create_handoff', 'onboarding_link',
      ];
      expect(closedWonSteps(input).map((s) => s.name).sort()).toEqual([...exercised].sort());
    });
  });

  it('records the billing gap instead of faking a customer', async () => {
    const provision = closedWonSteps(input).find((s) => s.name === 'provision_customer')!;
    // sdk-billing exposes invoices, showback and repricing — no customer, no
    // licence. Marked optional so the gap is recorded per run rather than
    // failing every closed-won deal over something LeadFlow cannot fix.
    expect(provision.optional).toBe(true);
    await expect(
      provision.run({ correlationId: 'c', stepKey: 'k', results: {}, input: {} }),
    ).rejects.toThrow(/sdk-billing does not expose/);
  });
});

/* -------------------- AC4: one incident per episode, not one per rung */

describe('systemic breaches open exactly one incident', () => {
  const rung = async (n: number, r: Rung, subject: string, minutesLate = 60) =>
    handleRung({
      eventId: `esc-${RUN}-${n}`,
      subjectRef: subject,
      rung: r,
      minutesLate,
      tenantId: null,
    });

  it('widens the audience with the rung rather than moving it', () => {
    const a = ESCALATION_RULES.AUDIENCE_BY_RUNG;
    // Telling the manager INSTEAD of the rep teaches the rep that ignoring the
    // first alert costs nothing. Each rung must CONTAIN the previous one.
    expect(a.first_warning).toEqual(['owner']);
    for (const [lower, higher] of [
      ['first_warning', 'second_warning'], ['second_warning', 'reassign'], ['reassign', 'breach'],
    ] as [Rung, Rung][]) {
      for (const audience of a[lower]) expect(a[higher]).toContain(audience);
    }
  });

  it('ignores a redelivered rung entirely', async () => {
    const first = await rung(1, 'first_warning', `s-${RUN}-a`, 10);
    const again = await handleRung({
      eventId: `esc-${RUN}-1`, subjectRef: `s-${RUN}-a`, rung: 'first_warning',
      minutesLate: 10, tenantId: null,
    });
    expect(first.duplicate).toBe(false);
    // An escalation arriving in duplicate is how people learn to ignore
    // escalations.
    expect(again.duplicate).toBe(true);
    expect(again.notified).toEqual([]);
  });

  it('opens ONE incident for many breaches, not one per breach', async () => {
    const results = [];
    // Six distinct subjects, over the threshold of five.
    for (let i = 0; i < 6; i += 1) {
      results.push(await rung(100 + i, 'breach', `s-${RUN}-${i}`, 90));
    }

    const systemic = results.filter((r) => r.systemic);
    const created = results.filter((r) => r.incidentCreated);
    expect(systemic.length).toBeGreaterThan(0);
    // THE CRITERION. Forty incidents is indistinguishable from none — the one
    // that matters is buried under thirty-nine duplicates.
    expect(created).toHaveLength(1);

    const rows = await dataService.query<{ n: string }>(
      `SELECT count(*)::int AS n FROM leadflow_escalation_incident WHERE episode_key LIKE 'sla-systemic:%'`);
    expect(Number(rows[0].n)).toBe(1);
  });

  it('does NOT call a single breach systemic', async () => {
    await dataService.query(`DELETE FROM leadflow_escalation_event WHERE event_id LIKE 'esc-%'`);
    await dataService.query(`DELETE FROM leadflow_escalation_incident WHERE episode_key LIKE 'sla-systemic:%'`);
    const one = await rung(200, 'breach', `s-${RUN}-solo`, 90);
    // One breach is somebody having a busy afternoon. A threshold of one would
    // open an incident for every late lead and make the queue useless.
    expect(one.systemic).toBe(false);
    expect(one.incidentCreated).toBe(false);
  });

  it('counts distinct SUBJECTS, not events', async () => {
    await dataService.query(`DELETE FROM leadflow_escalation_event WHERE event_id LIKE 'esc-%'`);
    await dataService.query(`DELETE FROM leadflow_escalation_incident WHERE episode_key LIKE 'sla-systemic:%'`);
    // One lead breaching six times is one unhappy lead, not an outage.
    for (let i = 0; i < 6; i += 1) await rung(300 + i, 'breach', `s-${RUN}-same`, 90);
    const rows = await dataService.query<{ n: string }>(
      `SELECT count(*)::int AS n FROM leadflow_escalation_incident WHERE episode_key LIKE 'sla-systemic:%'`);
    expect(Number(rows[0].n)).toBe(0);
  });

  it('reassigns at the SOP threshold, and not before', () => {
    expect(ESCALATION_RULES.REASSIGN_AT_MINUTES).toBe(45);
    expect(ESCALATION_RULES.SYSTEMIC_SUBJECT_THRESHOLD).toBeGreaterThan(1);
  });
});
