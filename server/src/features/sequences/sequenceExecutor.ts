import { dataService } from '../../services/DataService';
import { config } from '../../config/env';
import { sendsHalted } from '../failures/runbook';
import { SdkGatewayClient } from '../../platform/sdkGateway';
import { ACTIVE_CADENCE, stopRuleFor, type CadenceStep, type StopAction } from './cadence';
import { deferReason } from '../sla/businessCalendar';
import { checkSmsEligibility } from '../channels/smsEligibility';

/**
 * The sequence step executor. SOP §08, §33.
 *
 * A STEP IS CLAIMED, NOT CHECKED. Two ticks landing a millisecond apart both
 * read "step 4 has not run" and both send; so the executor INSERTs into
 * leadflow_sequence_execution, which carries UNIQUE (enrollment_id, step_number),
 * and a refused insert means another tick already owns that step. The acceptance
 * criterion — two ticks in the same minute produce exactly one send per due step
 * — is that constraint, not a lock and not a scheduler guarantee.
 *
 * CLAIMED IS NOT SENT. `dispatched` records whether the provider actually
 * accepted it, because a claimed step whose send failed must not look like a
 * message the prospect received.
 */

/** How many consecutive failures open the breaker. */
const CIRCUIT_THRESHOLD = 5;
/** How long it stays open before a probe is allowed. */
const CIRCUIT_COOLDOWN_MINUTES = 15;

export interface Enrollment {
  enrollment_id: string;
  subject_ref: string;
  sequence_key: string;
  owner_user_id: string | null;
  enrolled_at: string;
  status: string;
  next_step: number;
}

export interface StepOutcome {
  step: number;
  claimed: boolean;
  dispatched: boolean;
  /** Present when the step was claimed but deliberately not sent. */
  skipped: string | null;
  channels: string[];
}

/** Record a guard decision, so a refusal is explainable afterwards. */
async function logGuard(input: {
  enrollmentId: string | null; step: number | null; guard: string;
  outcome: 'allowed' | 'deferred' | 'refused'; detail: string;
}): Promise<void> {
  await dataService.query(
    `INSERT INTO leadflow_sequence_guard_log (tenant_id, enrollment_id, step_number, guard, outcome, detail)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [config.projexCloud.tenantId, input.enrollmentId, input.step, input.guard, input.outcome, input.detail]
  );
}

/** Whether the breaker for a channel is open. */
async function circuitOpen(channel: string): Promise<boolean> {
  const rows = await dataService.query<{ opened_at: string | null; retry_after: string | null }>(
    `SELECT opened_at, retry_after FROM leadflow_sequence_circuit WHERE circuit_key = $1`,
    [channel]
  );
  const row = rows[0];
  if (!row?.opened_at) return false;
  // Half-open once the cooldown passes: a breaker that never retries is an
  // outage that outlives the outage.
  if (row.retry_after && Date.parse(row.retry_after) <= Date.now()) return false;
  return true;
}

/** Record a provider result against the breaker. */
async function recordCircuit(channel: string, ok: boolean, error: string | null): Promise<void> {
  if (ok) {
    await dataService.query(
      `INSERT INTO leadflow_sequence_circuit (circuit_key, tenant_id, consecutive_failures, opened_at, retry_after, updated_at)
       VALUES ($1,$2,0,NULL,NULL,now())
       ON CONFLICT (circuit_key) DO UPDATE SET consecutive_failures = 0, opened_at = NULL, retry_after = NULL, updated_at = now()`,
      [channel, config.projexCloud.tenantId]
    );
    return;
  }
  await dataService.query(
    `INSERT INTO leadflow_sequence_circuit (circuit_key, tenant_id, consecutive_failures, last_error, updated_at)
     VALUES ($1,$2,1,$3,now())
     ON CONFLICT (circuit_key) DO UPDATE SET
       consecutive_failures = leadflow_sequence_circuit.consecutive_failures + 1,
       last_error = $3,
       opened_at = CASE WHEN leadflow_sequence_circuit.consecutive_failures + 1 >= $4 THEN now() ELSE leadflow_sequence_circuit.opened_at END,
       retry_after = CASE WHEN leadflow_sequence_circuit.consecutive_failures + 1 >= $4
                          THEN now() + ($5 || ' minutes')::interval ELSE leadflow_sequence_circuit.retry_after END,
       updated_at = now()`,
    [channel, config.projexCloud.tenantId, error, CIRCUIT_THRESHOLD, String(CIRCUIT_COOLDOWN_MINUTES)]
  );
}

/**
 * Whether a channel may send right now.
 *
 * CALLS ARE GATED ON BUSINESS HOURS, MESSAGES ON RECIPIENT QUIET HOURS. They are
 * different windows for different reasons: a call at 19:00 is an intrusion, an
 * email at 19:00 is ordinary, and treating them the same either blocks harmless
 * email or permits calls nobody wants.
 */
async function windowAllows(step: CadenceStep, channel: string, subjectRef: string, timezone: string | null): Promise<{ ok: boolean; detail: string }> {
  if (channel === 'call' || channel === 'voicemail') {
    const defer = deferReason(new Date());
    if (defer !== null) return { ok: false, detail: `Calls are gated on business hours; it is currently ${defer.replace('_', ' ')}.` };
    return { ok: true, detail: 'Inside business hours.' };
  }
  if (channel === 'sms') {
    const verdict = await checkSmsEligibility({
      subjectRef, purposeKey: 'inspection_estimate', recipientTimezone: timezone, automated: true,
    });
    return { ok: verdict.eligible, detail: verdict.explanation ?? 'Eligible.' };
  }
  return { ok: true, detail: 'Email has no send window beyond suppression.' };
}

/** Dispatch one channel of a step. */
async function dispatch(input: {
  subjectRef: string; channel: string; templateKey: string; enrollmentId: string; step: number;
}): Promise<boolean> {
  if (!SdkGatewayClient.isConfigured()) return false;
  try {
    const result = await SdkGatewayClient.call({
      sdk: 'sdk-notification',
      path: '/api/notifications/send',
      method: 'POST',
      // Keyed on the STEP, so a retried tick that somehow got past the claim
      // still cannot produce a second send at the provider.
      idempotencyKey: `seq:${input.enrollmentId}:${input.step}:${input.channel}`,
      body: {
        tenant_id: config.projexCloud.tenantId, subject_ref: input.subjectRef,
        channels: [input.channel], template: input.templateKey, require_eligibility: true,
      },
    });
    await recordCircuit(input.channel, result.delivered, result.delivered ? null : 'not delivered');
    return result.delivered;
  } catch (error) {
    await recordCircuit(input.channel, false, error instanceof Error ? error.message : 'unknown');
    return false;
  }
}

/** Write the NEXT a step is required to leave behind. */
async function writeStepNext(enrollment: Enrollment, step: CadenceStep): Promise<string | null> {
  if (!enrollment.owner_user_id) return null;
  const dueAt = new Date(Date.now() + step.requiredNext.dueOffsetMinutes * 60_000).toISOString();
  await dataService.query(
    `UPDATE leadflow_next_action SET completed_at = now()
      WHERE subject_ref = $1 AND completed_at IS NULL`,
    [enrollment.subject_ref]
  );
  const rows = await dataService.query<{ next_id: string }>(
    `INSERT INTO leadflow_next_action
       (tenant_id, subject_ref, action_type, owner_user_id, due_at, purpose, intended_outcome)
     VALUES ($1,$2,$3,$4,$5::timestamptz,$6,$7) RETURNING next_id`,
    [
      config.projexCloud.tenantId, enrollment.subject_ref, step.requiredNext.actionType,
      enrollment.owner_user_id, dueAt, step.requiredNext.purpose, step.requiredNext.intendedOutcome,
    ]
  );
  return rows[0]?.next_id ?? null;
}

/** Advance one enrolment by every step now due. */
export async function tickEnrollment(enrollment: Enrollment, now = Date.now()): Promise<StepOutcome[]> {
  if (enrollment.status !== 'active') return [];
  const elapsed = (now - Date.parse(enrollment.enrolled_at)) / 60_000;
  const outcomes: StepOutcome[] = [];

  for (const step of ACTIVE_CADENCE) {
    if (step.step < enrollment.next_step) continue;
    if (elapsed < step.offsetMinutes) break;

    /* THE CLAIM. A refused insert means another tick owns this step. */
    const claimed = await dataService.query<{ execution_id: string }>(
      `INSERT INTO leadflow_sequence_execution
         (tenant_id, enrollment_id, step_number, channel, template_key)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (enrollment_id, step_number) DO NOTHING
       RETURNING execution_id`,
      [config.projexCloud.tenantId, enrollment.enrollment_id, step.step, step.channels.join(','), step.templateKeys[0] ?? null]
    );
    if (claimed.length === 0) {
      outcomes.push({ step: step.step, claimed: false, dispatched: false, skipped: 'already executed by another tick', channels: step.channels });
      continue;
    }

    let anyDispatched = false;
    const skipped: string[] = [];

    for (let i = 0; i < step.channels.length; i += 1) {
      const channel = step.channels[i];
      const templateKey = step.templateKeys[i] ?? step.templateKeys[0] ?? '';

      if (await circuitOpen(channel)) {
        skipped.push(`${channel}: circuit open`);
        await logGuard({ enrollmentId: enrollment.enrollment_id, step: step.step, guard: 'circuit_open', outcome: 'refused', detail: `${channel} breaker is open` });
        continue;
      }
      const window = await windowAllows(step, channel, enrollment.subject_ref, null);
      if (!window.ok) {
        skipped.push(`${channel}: ${window.detail}`);
        await logGuard({ enrollmentId: enrollment.enrollment_id, step: step.step, guard: channel === 'call' || channel === 'voicemail' ? 'send_window' : 'eligibility', outcome: 'deferred', detail: window.detail });
        continue;
      }
      const sent = await dispatch({ subjectRef: enrollment.subject_ref, channel, templateKey, enrollmentId: enrollment.enrollment_id, step: step.step });
      if (sent) anyDispatched = true;
      else skipped.push(`${channel}: provider did not accept`);
      await logGuard({ enrollmentId: enrollment.enrollment_id, step: step.step, guard: 'send_window', outcome: sent ? 'allowed' : 'refused', detail: sent ? `${channel} dispatched` : `${channel} not dispatched` });
    }

    const nextId = await writeStepNext(enrollment, step);
    await dataService.query(
      `UPDATE leadflow_sequence_execution
          SET dispatched = $3, skipped_reason = $4, next_action_id = $5
        WHERE enrollment_id = $1 AND step_number = $2`,
      [enrollment.enrollment_id, step.step, anyDispatched, skipped.join('; ') || null, nextId]
    );
    await dataService.query(
      `UPDATE leadflow_sequence_enrollment SET next_step = $2 WHERE enrollment_id = $1`,
      [enrollment.enrollment_id, step.step + 1]
    );

    outcomes.push({ step: step.step, claimed: true, dispatched: anyDispatched, skipped: skipped.join('; ') || null, channels: step.channels });
  }

  // Past the last step, the enrolment is complete rather than left running.
  if (enrollment.next_step > ACTIVE_CADENCE.length) {
    await dataService.query(
      `UPDATE leadflow_sequence_enrollment SET status = 'completed', completed_at = now()
        WHERE enrollment_id = $1 AND status = 'active'`,
      [enrollment.enrollment_id]
    );
  }
  return outcomes;
}

/** Advance every active enrolment. */
export async function tickAll(now = Date.now()): Promise<{ enrollments: number; claimed: number; suppressed: number; dispatched: number; outcomes: { enrollmentId: string; steps: StepOutcome[] }[]; halted?: boolean; haltReason?: string }> {
  const enrollments = await dataService.query<Enrollment>(
    `SELECT enrollment_id, subject_ref, sequence_key, owner_user_id, enrolled_at, status, next_step
       FROM leadflow_sequence_enrollment
      WHERE tenant_id = $1 AND status = 'active'
      ORDER BY enrolled_at ASC LIMIT 500`,
    [config.projexCloud.tenantId]
  );
  /*
   * THE GLOBAL KILL SWITCH IS CHECKED ONCE PER TICK, before any enrolment is
   * touched. SOP §21 requires it to halt all automated sends within one tick,
   * and the cadence is the loudest sender in the product — a switch thrown
   * during a duplicate-send incident that still lets this loop run is not a
   * kill switch, it is a label.
   *
   * Checked here rather than per step: a switch engaged mid-tick should stop
   * the NEXT tick, and re-reading it five hundred times would let half a sweep
   * send and half not, which is the worst of both outcomes to reconstruct
   * afterwards.
   */
  if (await sendsHalted()) {
    return {
      enrollments: enrollments.length, claimed: 0, suppressed: enrollments.length,
      dispatched: 0, outcomes: [],
      halted: true,
      haltReason: 'The global send pause is engaged, so no cadence step was dispatched this tick.',
    };
  }

  const outcomes: { enrollmentId: string; steps: StepOutcome[] }[] = [];
  let claimed = 0; let suppressed = 0; let dispatched = 0;
  for (const e of enrollments) {
    const steps = await tickEnrollment(e, now);
    for (const s of steps) {
      if (s.claimed) claimed += 1; else suppressed += 1;
      if (s.dispatched) dispatched += 1;
    }
    if (steps.length) outcomes.push({ enrollmentId: e.enrollment_id, steps });
  }
  return { enrollments: enrollments.length, claimed, suppressed, dispatched, outcomes, halted: false };
}

/**
 * Apply a reactive stop rule. SOP §08, §33.
 *
 * STOP CANCELS, REPLACE REDIRECTS, PAUSE WAITS. Collapsing them would either
 * spam somebody who has just booked, or go silent on somebody expecting a
 * logistics reminder for the meeting they booked.
 */
export async function applyStop(input: {
  enrollmentId: string; signal: string; detail?: string | null; actorUserId: string | null;
}): Promise<{ found: boolean; action: StopAction | null; reason: string | null; taskCreated: boolean; cancelledSteps: number }> {
  const rule = stopRuleFor(input.signal);
  if (!rule) return { found: false, action: null, reason: null, taskCreated: false, cancelledSteps: 0 };

  const action = rule.action as StopAction;
  const status = action === 'pause' ? 'paused' : action === 'replace' ? 'active' : 'stopped';
  const reason = `${input.signal}: ${rule.because}${input.detail ? ` — ${input.detail}` : ''}`;

  const rows = await dataService.query<{ enrollment_id: string; subject_ref: string; owner_user_id: string | null; next_step: number }>(
    `UPDATE leadflow_sequence_enrollment
        SET status = $2,
            stop_reason = $3,
            stopped_at = CASE WHEN $2 = 'stopped' THEN now() ELSE stopped_at END
      WHERE enrollment_id = $1
      RETURNING enrollment_id, subject_ref, owner_user_id, next_step`,
    [input.enrollmentId, status, reason]
  );
  if (rows.length === 0) return { found: false, action, reason, taskCreated: false, cancelledSteps: 0 };
  const enrollment = rows[0];

  /*
   * QUEUED STEPS ARE CANCELLED BY CLAIMING THEM. Marking each remaining step as
   * executed-and-skipped means a tick that is already in flight cannot send one:
   * the claim is taken, so the executor sees it as owned.
   */
  let cancelled = 0;
  if (action !== 'pause') {
    for (const step of ACTIVE_CADENCE) {
      if (step.step < enrollment.next_step) continue;
      const claimed = await dataService.query<{ execution_id: string }>(
        `INSERT INTO leadflow_sequence_execution
           (tenant_id, enrollment_id, step_number, channel, dispatched, skipped_reason)
         VALUES ($1,$2,$3,$4,FALSE,$5)
         ON CONFLICT (enrollment_id, step_number) DO NOTHING
         RETURNING execution_id`,
        [config.projexCloud.tenantId, enrollment.enrollment_id, step.step, step.channels.join(','), `cancelled: ${input.signal}`]
      );
      if (claimed.length) cancelled += 1;
    }
  }

  await logGuard({ enrollmentId: enrollment.enrollment_id, step: null, guard: 'stop_rule', outcome: 'refused', detail: reason });

  /* AN URGENT OWNER TASK, because a stop means a human now owns what the
     automation was doing. A stop with nobody told is a silent handoff. */
  let taskCreated = false;
  if (enrollment.owner_user_id) {
    await dataService.query(
      `UPDATE leadflow_next_action SET completed_at = now() WHERE subject_ref = $1 AND completed_at IS NULL`,
      [enrollment.subject_ref]
    );
    await dataService.query(
      `INSERT INTO leadflow_next_action
         (tenant_id, subject_ref, action_type, owner_user_id, due_at, purpose, intended_outcome)
       VALUES ($1,$2,'call',$3, now() + interval '1 hour', $4, $5)`,
      [
        config.projexCloud.tenantId, enrollment.subject_ref, enrollment.owner_user_id,
        `Automation stopped: ${input.signal}`,
        action === 'replace' ? 'Confirm the booked commitment and take over the conversation' : 'Take over from the automation and respond personally',
      ]
    );
    taskCreated = true;
  }

  if (SdkGatewayClient.isConfigured()) {
    try {
      await SdkGatewayClient.call({
        sdk: 'sdk-sequence',
        path: `/api/sequences/enrollments/${encodeURIComponent(input.enrollmentId)}/control`,
        method: 'POST',
        idempotencyKey: `seq-stop:${input.enrollmentId}:${input.signal}`,
        body: { tenant_id: config.projexCloud.tenantId, action, reason },
      });
    } catch { /* the local stop already holds; upstream is a mirror */ }
  }

  return { found: true, action, reason, taskCreated, cancelledSteps: cancelled };
}
