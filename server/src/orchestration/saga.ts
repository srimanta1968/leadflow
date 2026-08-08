import { randomUUID } from 'crypto';
import { dataService } from '../services/DataService';

/**
 * A saga: ordered steps under ONE idempotency key and ONE causation chain, each
 * with an explicit compensation.
 *
 * WHY NOT A TRANSACTION. The nine steps are calls to nine different services.
 * Nothing can roll them back together, so "undo" has to be a forward action —
 * you do not un-create a CRM contact, you retire it. That is what a compensation
 * is, and why every step must declare one at the type level rather than as a
 * convention somebody remembers.
 *
 * WHY THE LEDGER IS IN POSTGRES. If the process dies after step five, the only
 * way to know which five happened — and therefore which five to compensate — is
 * to have written each down as it completed. In-memory state is precisely what
 * is gone at the moment you need it.
 *
 * COMPENSATION RUNS IN REVERSE, AND ONLY OVER STEPS THAT SUCCEEDED. Undoing a
 * step that never ran is how a rollback causes the damage it exists to prevent:
 * "retire the deal" against a deal id that was never created either errors or,
 * worse, matches something else.
 */

export interface StepContext {
  /** Stable for the whole saga. Every downstream call is tagged with it. */
  correlationId: string;
  /**
   * Deterministic per step: `${runKey}:${stepName}`. A retry of ONE step
   * presents the same key upstream, so it cannot produce a second artefact.
   */
  stepKey: string;
  /** What earlier steps produced, keyed by step name. */
  results: Record<string, unknown>;
  input: Record<string, unknown>;
}

export interface SagaStep<T = unknown> {
  name: string;
  run: (ctx: StepContext) => Promise<T>;
  /**
   * Undo this step. REQUIRED — a step with nothing to undo says so explicitly
   * by returning, which is a decision in the diff rather than an omission.
   */
  compensate: (ctx: StepContext, result: T) => Promise<void>;
  /**
   * True when a failure here should NOT roll the saga back.
   *
   * The acknowledgement is the real case: the lead exists, is assigned and has a
   * clock running, and the only thing that failed is telling them so. Tearing
   * all of that down because a text message bounced would destroy work that is
   * perfectly good, over the least consequential step in the chain.
   */
  optional?: boolean;
}

export interface SagaResult {
  idempotencyKey: string;
  status: 'completed' | 'failed' | 'compensated';
  replayed: boolean;
  correlationId: string;
  results: Record<string, unknown>;
  failedStep: string | null;
  error: string | null;
  /** Steps whose compensation ran, newest first. */
  compensated: string[];
  /** True when this attempt picked up a run a dead process had left part-done. */
  resumed?: boolean;
}

interface RunRow {
  idempotency_key: string;
  status: string;
  correlation_id: string;
  output: Record<string, unknown>;
  failed_step: string | null;
  error: string | null;
}

/**
 * Execute a saga, or return what an earlier run of the same key produced.
 *
 * THE REPLAY BRANCH IS THE ACCEPTANCE CRITERION. A second call with the same key
 * does not re-run anything and returns the ORIGINAL ids — so a redelivered
 * intake event yields one lead, one clock, one task and one acknowledgement,
 * because the second attempt performs no work at all.
 */
export async function runSaga(
  sagaName: string,
  idempotencyKey: string,
  steps: SagaStep[],
  input: Record<string, unknown>,
  options: { causationId?: string | null } = {},
): Promise<SagaResult> {
  const correlationId: string = randomUUID();

  const claimed = await dataService.query<RunRow>(
    `INSERT INTO leadflow_saga_run
       (idempotency_key, saga_name, status, correlation_id, causation_id, input)
     VALUES ($1, $2, 'running', $3, $4, $5::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING idempotency_key, status, correlation_id, output, failed_step, error`,
    [idempotencyKey, sagaName, correlationId, options.causationId ?? null, JSON.stringify(input)],
  );

  let runCorrelationId: string = correlationId;
  const results: Record<string, unknown> = {};
  /** Steps already done by an earlier attempt. Never re-run, never compensated twice. */
  const alreadyDone = new Set<string>();

  if (claimed.length === 0) {
    const existing = await dataService.query<RunRow>(
      `SELECT idempotency_key, status, correlation_id, output, failed_step, error
         FROM leadflow_saga_run WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    const row = existing[0];
    runCorrelationId = row?.correlation_id ?? correlationId;

    if (row && (row.status === 'completed' || row.status === 'compensated')) {
      // SETTLED. Hand back what the first attempt produced rather than doing it
      // again — the caller sees the SAME ids, not a second set.
      return {
        idempotencyKey,
        status: row.status as SagaResult['status'],
        replayed: true,
        correlationId: runCorrelationId,
        results: row.output ?? {},
        failedStep: row.failed_step ?? null,
        error: row.error ?? null,
        compensated: [],
      };
    }

    /*
     * STILL 'running' — this is a RESUME, and it is the acceptance criterion.
     *
     * A process that died mid-saga leaves the run row claimed and its ledger
     * half-written. Treating that as a completed replay would return partial
     * output as though it were the whole answer; treating it as a fresh run
     * would re-execute steps that already created a customer and a licence.
     * Neither is acceptable, so the ledger is read back and the completed steps
     * are skipped: execution continues at the first one that did not finish.
     *
     * This is why every step result is persisted as it lands rather than kept in
     * memory — in-memory state is exactly what is gone when the process dies.
     */
    const ledger = await dataService.query<{ step_name: string; result: unknown }>(
      `SELECT step_name, result FROM leadflow_saga_step
        WHERE idempotency_key = $1 AND status = 'completed'
        ORDER BY position ASC`,
      [idempotencyKey],
    );
    for (const row2 of ledger) {
      alreadyDone.add(row2.step_name);
      results[row2.step_name] = row2.result;
    }
  }

  const completed: { step: SagaStep; result: unknown; ctx: StepContext }[] = [];
  const compensated: string[] = [];

  for (const [index, step] of steps.entries()) {
    const ctx: StepContext = {
      correlationId: runCorrelationId,
      stepKey: `${idempotencyKey}:${step.name}`,
      results,
      input,
    };

    if (alreadyDone.has(step.name)) {
      /*
       * Done by the attempt that died. NOT re-run — that is the whole point —
       * but it IS pushed onto `completed`, because if a LATER step now fails
       * this one still has to be compensated. A resumed run that rolls back
       * must undo everything that exists, not merely what this process did.
       */
      completed.push({ step, result: results[step.name], ctx });
      continue;
    }

    await dataService.query(
      `INSERT INTO leadflow_saga_step (idempotency_key, step_name, position, status, step_key)
       VALUES ($1, $2, $3, 'running', $4)
       ON CONFLICT (idempotency_key, step_name) DO UPDATE SET status = 'running', started_at = NOW()`,
      [idempotencyKey, step.name, index, ctx.stepKey],
    );

    try {
      const result = await step.run(ctx);
      results[step.name] = result;
      completed.push({ step, result, ctx });
      await dataService.query(
        `UPDATE leadflow_saga_step
            SET status = 'completed', result = $3::jsonb, finished_at = NOW()
          WHERE idempotency_key = $1 AND step_name = $2`,
        [idempotencyKey, step.name, JSON.stringify(result ?? null)],
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await dataService.query(
        `UPDATE leadflow_saga_step
            SET status = $3, error = $4, finished_at = NOW()
          WHERE idempotency_key = $1 AND step_name = $2`,
        [idempotencyKey, step.name, step.optional ? 'skipped' : 'failed', message],
      );

      if (step.optional) {
        // Recorded and stepped over. The saga's whole point survives.
        results[step.name] = { skipped: true, error: message };
        continue;
      }

      // REVERSE ORDER, COMPLETED STEPS ONLY.
      for (const done of [...completed].reverse()) {
        try {
          await done.step.compensate(done.ctx, done.result);
          compensated.push(done.step.name);
          await dataService.query(
            `UPDATE leadflow_saga_step SET compensated_at = NOW()
              WHERE idempotency_key = $1 AND step_name = $2`,
            [idempotencyKey, done.step.name],
          );
        } catch (compError) {
          // A FAILED COMPENSATION IS RECORDED AND THE ROLLBACK CONTINUES. Stopping
          // here would leave every earlier step un-compensated because a later one
          // could not be undone, which is strictly worse: it turns one orphan into
          // a whole chain of them. The row is what an operator reconciles from.
          const cm = compError instanceof Error ? compError.message : String(compError);
          console.error(`[saga] ${sagaName}/${done.step.name} compensation failed:`, cm);
          await dataService.query(
            `UPDATE leadflow_saga_step SET compensation_error = $3 WHERE idempotency_key = $1 AND step_name = $2`,
            [idempotencyKey, done.step.name, cm],
          );
        }
      }

      await dataService.query(
        `UPDATE leadflow_saga_run
            SET status = 'compensated', failed_step = $2, error = $3,
                output = $4::jsonb, finished_at = NOW()
          WHERE idempotency_key = $1`,
        [idempotencyKey, step.name, message, JSON.stringify(results)],
      );

      return {
        idempotencyKey, status: 'compensated', replayed: false,
        correlationId: runCorrelationId,
        results, failedStep: step.name, error: message, compensated,
      };
    }
  }

  await dataService.query(
    `UPDATE leadflow_saga_run
        SET status = 'completed', output = $2::jsonb, finished_at = NOW()
      WHERE idempotency_key = $1`,
    [idempotencyKey, JSON.stringify(results)],
  );

  return {
    idempotencyKey, status: 'completed',
    // `replayed` false, but `resumed` says whether this attempt inherited work.
    replayed: false, resumed: alreadyDone.size > 0,
    correlationId: runCorrelationId,
    results, failedStep: null, error: null, compensated: [],
  };
}

/** The step ledger for one run, in order. For the operator panel and the tests. */
export async function sagaSteps(idempotencyKey: string): Promise<Record<string, unknown>[]> {
  return dataService.query<Record<string, unknown>>(
    `SELECT step_name, position, status, step_key, error, compensated_at, compensation_error
       FROM leadflow_saga_step WHERE idempotency_key = $1 ORDER BY position ASC`,
    [idempotencyKey],
  );
}
