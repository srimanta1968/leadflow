import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { dataService } from '../../src/services/DataService';
import { intakeSteps, runSaga, sagaSteps, type SagaStep } from '../../src/orchestration';

/**
 * The four criteria, in order.
 *
 * The saga tests use SYNTHETIC steps rather than the real nine, deliberately.
 * What is under test is the runner's guarantees — replay collapses, compensation
 * runs in reverse over completed steps only, an optional step does not roll the
 * world back — and driving those through nine mocked SDK calls would test the
 * mocks. The real nine are checked structurally: every one declares a
 * compensation, and the shape of the chain is asserted.
 */

const RUN = crypto.randomUUID().slice(0, 8);
const SRC = path.resolve(__dirname, '../../src');

beforeAll(async () => {
  // Cleaning on the way IN, not out: tests/setup.ts closes the pool in a
  // root afterAll that runs before this file's would, and deleting here also
  // clears rows a previously killed run left behind.
  await dataService.query(`DELETE FROM leadflow_saga_run WHERE idempotency_key LIKE 'test:%'`);
  await dataService.query(`DELETE FROM leadflow_channel_decision WHERE subject_ref LIKE 'test-%'`);
});

/* ------------------------ AC1: a replay produces exactly one of everything */

describe('a replayed intake produces exactly one of each artifact', () => {
  /** Counts how many times each step actually executed. */
  function countingSteps(counts: Record<string, number>): SagaStep[] {
    const mk = (name: string): SagaStep => ({
      name,
      run: async () => {
        counts[name] = (counts[name] ?? 0) + 1;
        return { id: `${name}-id` };
      },
      compensate: async () => undefined,
    });
    return ['crm_contact', 'crm_deal', 'sla_clock', 'next_action'].map(mk);
  }

  it('runs the steps once and returns the ORIGINAL ids on replay', async () => {
    const counts: Record<string, number> = {};
    const key = `test:${RUN}:replay`;

    const first = await runSaga('t', key, countingSteps(counts), {});
    const second = await runSaga('t', key, countingSteps(counts), {});
    const third = await runSaga('t', key, countingSteps(counts), {});

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(third.replayed).toBe(true);

    // THE CRITERION. One lead, one clock, one task — because the second and
    // third attempts perform no work at all rather than being deduplicated
    // afterwards.
    expect(counts).toEqual({ crm_contact: 1, crm_deal: 1, sla_clock: 1, next_action: 1 });
    // And the caller sees the SAME artefacts, not a second set.
    expect(second.results).toEqual(first.results);
    expect(second.correlationId).toBe(first.correlationId);
  });

  it('gives each step a DETERMINISTIC key, so retrying one cannot duplicate upstream', async () => {
    const key = `test:${RUN}:keys`;
    await runSaga('t', key, countingSteps({}), {});
    const ledger = await sagaSteps(key);
    for (const row of ledger) {
      // `${runKey}:${stepName}` — a retry of one step presents the same key to
      // the SDK, so at-least-once at the step level is safe too.
      expect(row.step_key).toBe(`${key}:${row.step_name}`);
    }
    expect(ledger).toHaveLength(4);
  });
});

/* ---------------------------- AC2: every step has a tested compensation */

describe('every step has a compensation, and rollback is ordered', () => {
  it('declares a compensation for all nine real steps', () => {
    const steps = intakeSteps({
      sourceEventId: 'e1', platform: 'web_form', rawPayload: {}, tenantId: null,
    });
    expect(steps).toHaveLength(10);
    for (const step of steps) {
      // Required at the type level AND asserted here: a step with nothing to
      // undo says so by returning, which is a decision visible in a diff rather
      // than an omission nobody notices.
      expect(typeof step.compensate).toBe('function');
      expect(step.name).toMatch(/^[a-z_]+$/);
    }
    // The chain, in the order the task specifies.
    expect(steps.map((s) => s.name)).toEqual([
      'source_record', 'parse_contact', 'resolve_identity', 'crm_contact', 'crm_deal',
      'score', 'assign', 'sla_clock', 'next_action', 'acknowledge',
    ]);
    // Only the acknowledgement is optional — see the test below for why.
    expect(steps.filter((s) => s.optional).map((s) => s.name)).toEqual(['acknowledge']);
  });

  it('compensates in REVERSE, and only steps that actually succeeded', async () => {
    const order: string[] = [];
    const steps: SagaStep[] = [
      { name: 'a', run: async () => ({ id: 'a' }), compensate: async () => { order.push('a'); } },
      { name: 'b', run: async () => ({ id: 'b' }), compensate: async () => { order.push('b'); } },
      { name: 'c', run: async () => { throw new Error('c blew up'); }, compensate: async () => { order.push('c'); } },
      { name: 'd', run: async () => ({ id: 'd' }), compensate: async () => { order.push('d'); } },
    ];

    const result = await runSaga('t', `test:${RUN}:rollback`, steps, {});

    expect(result.status).toBe('compensated');
    expect(result.failedStep).toBe('c');
    // Reverse, and NOT 'c' — undoing a step that never ran is how a rollback
    // causes the damage it exists to prevent. 'd' never started at all.
    expect(order).toEqual(['b', 'a']);
    expect(result.compensated).toEqual(['b', 'a']);
  });

  it('keeps rolling back when ONE compensation fails, and records it', async () => {
    const order: string[] = [];
    const steps: SagaStep[] = [
      { name: 'a', run: async () => ({ id: 'a' }), compensate: async () => { order.push('a'); } },
      { name: 'b', run: async () => ({ id: 'b' }), compensate: async () => { throw new Error('undo failed'); } },
      { name: 'c', run: async () => { throw new Error('boom'); }, compensate: async () => undefined },
    ];
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const key = `test:${RUN}:partial-rollback`;
    const result = await runSaga('t', key, steps, {});

    // 'a' still gets undone. Stopping at b's failure would leave every EARLIER
    // step orphaned because a later one could not be undone — one orphan becomes
    // a chain of them.
    expect(order).toEqual(['a']);
    expect(result.status).toBe('compensated');

    const ledger = await sagaSteps(key);
    const b = ledger.find((r) => r.step_name === 'b');
    // The row is what an operator reconciles from.
    expect(b?.compensation_error).toContain('undo failed');
  });

  it('does NOT roll the world back when an optional step fails', async () => {
    const order: string[] = [];
    const steps: SagaStep[] = [
      { name: 'lead', run: async () => ({ id: 'lead' }), compensate: async () => { order.push('lead'); } },
      { name: 'acknowledge', optional: true, run: async () => { throw new Error('sms bounced'); }, compensate: async () => undefined },
    ];

    const result = await runSaga('t', `test:${RUN}:optional`, steps, {});

    // The lead exists, is assigned and has a clock; only telling them failed.
    // Tearing that down over an undelivered message destroys good work over the
    // least consequential step in the chain.
    expect(result.status).toBe('completed');
    expect(order).toEqual([]);
    expect(result.results.acknowledge).toMatchObject({ skipped: true });
  });
});

/* ------------------- AC3: no send path bypasses the channel decision */

describe('no send path can execute without a channel decision', () => {
  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return sourceFiles(full);
      return e.name.endsWith('.ts') ? [full] : [];
    });
  }

  const rel = (f: string) => path.relative(SRC, f).replace(/\\/g, '/');

  it('routes every notifications/send through the composer', () => {
    // The rule is only worth having if it is checked. A send path that forgets
    // is exactly the one that delivers the message it should not have, and
    // nothing records that the decision was skipped rather than made permissive.
    // The negative lookahead matters: `/api/notifications/send-window` is the
    // quiet-hours CHECK the composer itself calls, not a send. A prefix match
    // flagged the composer as bypassing itself, which is the detector being
    // wrong rather than the code - so the detector was tightened instead of the
    // file being added to an exception list.
    const SEND_PATH = /notifications\/send(?!-)/;
    const senders = sourceFiles(SRC).filter((f) => SEND_PATH.test(fs.readFileSync(f, 'utf8')));
    // Guards against the detector silently matching nothing.
    expect(senders.length).toBeGreaterThan(0);

    const offenders = senders
      .filter((f) => {
        const text = fs.readFileSync(f, 'utf8');
        const composes = /\bcompose\s*\(/.test(text) || /channelDecision/.test(text);
        const carriesRef = /channel_decision_id/.test(text);
        return !(composes && carriesRef);
      })
      .map(rel);

    expect(offenders.join('\n')).toBe('');
  });

  it('CAN fail — a send with no decision is caught', () => {
    const bad = "await SdkGatewayClient.call({ sdk: 'sdk-notification', path: '/api/notifications/send' });";
    expect(/notifications\/send(?!-)/.test(bad)).toBe(true);
    expect(/channel_decision_id/.test(bad)).toBe(false);
    // And the quiet-hours check is NOT a send, or the composer would be flagged
    // for consulting the very SDK it is gating.
    const check = "path: '/api/notifications/send-window'";
    expect(/notifications\/send(?!-)/.test(check)).toBe(false);
  });
});

/* ------------------ AC4: the reason list is ordered and renderable */

describe('the reason list is ordered and renderable verbatim', () => {
  /**
   * The composer talks to four SDKs, so these drive it with the gateway
   * unconfigured — which is the DEGRADED path and the one worth pinning: every
   * unreachable check must land on `review`, never `allow`.
   */
  it('treats an unreachable check as REVIEW, never as permission', async () => {
    const { compose } = await import('../../src/orchestration/channelDecision');
    const decision = await compose({
      subjectRef: `test-${RUN}-1`,
      channel: 'email',
      purposeKey: 'inspection_estimate',
    });
    // "We could not ask" is not "they said yes". It is not deny either: a
    // blanket outage would otherwise stop every legitimate message with nobody
    // ever seeing it.
    expect(decision.verdict).toBe('review');
    expect(decision.reasons.length).toBeGreaterThan(0);
  });

  it('DENIES a prospect message with no stated purpose', async () => {
    const { compose } = await import('../../src/orchestration/channelDecision');
    const decision = await compose({ subjectRef: `test-${RUN}-2`, channel: 'sms' });
    // Defaulting a purpose would invent the basis on which somebody agreed to be
    // contacted, so the absence is refused rather than filled in.
    expect(decision.verdict).toBe('deny');
    expect(decision.reasons[0]).toMatchObject({ code: 'PURPOSE_MISSING' });
  });

  it('states the internal exemption instead of silently skipping the checks', async () => {
    const { compose } = await import('../../src/orchestration/channelDecision');
    const decision = await compose({ subjectRef: `test-${RUN}-3`, channel: 'email', audience: 'internal' });
    // An audit must see a decision that was taken, not a check that vanished.
    expect(decision.reasons[0]).toMatchObject({ code: 'INTERNAL_RECIPIENT' });
    expect(decision.checksRan).toContain('audience');
    expect(decision.checksRan).not.toContain('consent');
  });

  it('renders every reason as a sentence, with no ids or codes leaking', async () => {
    const { compose } = await import('../../src/orchestration/channelDecision');
    const decision = await compose({
      subjectRef: `test-${RUN}-4`, channel: 'email', purposeKey: 'appointment_updates',
    });
    for (const reason of decision.reasons) {
      expect(reason.code).toMatch(/^[A-Z0-9_]+$/);
      // The UI renders `text` verbatim, so it has to read like a sentence.
      expect(reason.text.length).toBeGreaterThan(15);
      expect(reason.text).toMatch(/[.!]$/);
      // No raw identifiers or SCREAMING_SNAKE codes in the human sentence.
      expect(reason.text).not.toMatch(/\b[A-Z]{3,}_[A-Z_]+\b/);
      expect(reason.text).not.toContain(`test-${RUN}`);
      expect(reason.source).toMatch(/^(sdk-[a-z-]+|leadflow)$/);
    }
  });

  it('keeps the order stable, because the FIRST blocking reason is the answer', async () => {
    const { compose } = await import('../../src/orchestration/channelDecision');
    const a = await compose({ subjectRef: `test-${RUN}-5`, channel: 'email', purposeKey: 'project_operations' });
    const b = await compose({ subjectRef: `test-${RUN}-6`, channel: 'email', purposeKey: 'project_operations' });
    // Same inputs, same order — a set would lose the only part of the answer
    // that tells an operator what to do about it.
    expect(a.reasons.map((r) => r.code)).toEqual(b.reasons.map((r) => r.code));
    // `suppression` leads because it is the only LOCAL check: a stop already
    // recorded must deny before anything that can be slow or unreachable.
    expect(a.checksRan).toEqual(['suppression', 'consent', 'policy', 'deliverability', 'timing']);
  });

  it('writes every decision to the ledger, which is what makes the rule enforceable', async () => {
    const { compose, decisionById } = await import('../../src/orchestration/channelDecision');
    const decision = await compose({ subjectRef: `test-${RUN}-7`, channel: 'sms', purposeKey: 'appointment_updates' });
    const row = await decisionById(decision.id);
    // A send carries a decision id; a decision id exists only because this ran.
    expect(row).toMatchObject({ subject_ref: `test-${RUN}-7`, channel: 'sms', verdict: decision.verdict });
    expect(JSON.parse(JSON.stringify(row?.reasons))).toHaveLength(decision.reasons.length);
  });
});
