import { randomUUID } from 'crypto';
import { dataService } from '../../services/DataService';
import { SdkGatewayClient } from '../sdkGateway';

/**
 * The transactional outbox, and the worker that drains it.
 *
 * WHY IT EXISTS. A local write and a ProjexCloud write cannot share a
 * transaction, so a crash between them loses one of the two — silently, and in
 * the direction that hurts most: we recorded a lead nobody upstream knows about.
 * Writing the INTENT locally, in the SAME transaction as the local change, makes
 * the pair recoverable. The dispatcher then retries until the SDK acknowledges,
 * which is at-least-once rather than best-effort.
 *
 * THE IDEMPOTENCY KEY IS STORED, NOT GENERATED AT SEND TIME. That single choice
 * is what makes at-least-once safe: every retry of a row presents the same key,
 * so the SDK recognises the second attempt as the same intention. A key minted
 * in the dispatcher would make each retry a fresh write, and the outbox would
 * become a duplicate generator with excellent uptime.
 */

export interface EnqueueInput {
  sdk: string;
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  payload: Record<string, unknown>;
  /**
   * Derive this from the caller's own event identity wherever one exists — a
   * capture id, a provider event id. Only then does a REPLAY of the thing that
   * enqueued it collapse to one row rather than two.
   */
  idempotencyKey?: string;
  correlationId?: string;
  causationId?: string | null;
}

/** Longest a row is retried before it is parked for a person to look at. */
const MAX_ATTEMPTS = 8;

/** Backoff in seconds by attempt number, capped. Roughly 2^n with a ceiling. */
function backoffSeconds(attempt: number): number {
  return Math.min(2 ** Math.max(0, attempt), 900);
}

/**
 * Record the intention. Call this INSIDE the caller's transaction.
 *
 * Returns the row id so a caller can correlate, and is idempotent on the key:
 * enqueuing the same intention twice leaves one row, which is what makes a
 * replayed webhook produce one outbound publish rather than two.
 */
export async function enqueue(input: EnqueueInput): Promise<{ id: string; duplicate: boolean }> {
  const key = input.idempotencyKey ?? randomUUID();
  const rows = await dataService.query<{ id: string }>(
    `INSERT INTO leadflow_outbox
       (sdk, method, path, payload, idempotency_key, correlation_id, causation_id)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      input.sdk,
      input.method,
      input.path,
      JSON.stringify(input.payload ?? {}),
      key,
      input.correlationId ?? null,
      input.causationId ?? null,
    ],
  );
  if (rows.length > 0) return { id: rows[0].id, duplicate: false };

  const existing = await dataService.query<{ id: string }>(
    `SELECT id FROM leadflow_outbox WHERE idempotency_key = $1`,
    [key],
  );
  return { id: existing[0]?.id ?? '', duplicate: true };
}

export interface DispatchResult {
  claimed: number;
  delivered: number;
  retried: number;
  deadLettered: number;
}

interface OutboxRow {
  id: string;
  sdk: string;
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  payload: Record<string, unknown>;
  idempotency_key: string;
  correlation_id: string | null;
  causation_id: string | null;
  attempts: number;
}

/**
 * Drain what is due.
 *
 * Rows are CLAIMED with `FOR UPDATE SKIP LOCKED` before being sent. Without it,
 * two dispatchers — or one process restarted while the previous is still
 * finishing — read the same rows and send them twice. The idempotency key means
 * the upstream would survive that, but the local attempt counters would not, and
 * a row would reach its dead-letter threshold in half the tries it should.
 */
export async function dispatchOutbox(batchSize = 50): Promise<DispatchResult> {
  const result: DispatchResult = { claimed: 0, delivered: 0, retried: 0, deadLettered: 0 };

  const rows = await dataService.query<OutboxRow>(
    `UPDATE leadflow_outbox
        SET status = 'in_flight', attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM leadflow_outbox
         WHERE status = 'pending' AND next_attempt_at <= NOW()
         ORDER BY next_attempt_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, sdk, method, path, payload, idempotency_key,
                correlation_id, causation_id, attempts`,
    [batchSize],
  );
  result.claimed = rows.length;

  for (const row of rows) {
    try {
      await SdkGatewayClient.call({
        sdk: row.sdk,
        path: row.path,
        method: row.method,
        body: row.payload,
        // THE STORED KEY. Not a new one — see the file docblock.
        idempotencyKey: row.idempotency_key,
        correlationId: row.correlation_id ?? undefined,
        causationId: row.causation_id,
        // The dispatcher IS the retry loop, so the gateway must not run its own
        // on top: two nested backoffs would multiply into a delay nobody chose,
        // and the row's attempt counter would no longer mean attempts.
        retry: { maxAttempts: 1 },
      });
      await dataService.query(
        `UPDATE leadflow_outbox
            SET status = 'delivered', dispatched_at = NOW(), last_error = NULL
          WHERE id = $1`,
        [row.id],
      );
      result.delivered += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (row.attempts >= MAX_ATTEMPTS) {
        // PARKED, NOT DROPPED, and not retried forever either. A row failing on
        // its ninth attempt is failing for a reason retrying will not fix, and
        // leaving it in the pending queue hides the working rows behind it.
        await dataService.query(
          `UPDATE leadflow_outbox SET status = 'dlq', last_error = $2 WHERE id = $1`,
          [row.id, message],
        );
        result.deadLettered += 1;
      } else {
        await dataService.query(
          `UPDATE leadflow_outbox
              SET status = 'pending',
                  last_error = $2,
                  next_attempt_at = NOW() + ($3 || ' seconds')::interval
            WHERE id = $1`,
          [row.id, message, String(backoffSeconds(row.attempts))],
        );
        result.retried += 1;
      }
    }
  }

  return result;
}

/** What is parked, for the operator panel. */
export async function listOutboxDlq(limit = 100): Promise<Record<string, unknown>[]> {
  return dataService.query<Record<string, unknown>>(
    `SELECT id, sdk, method, path, attempts, last_error, created_at
       FROM leadflow_outbox
      WHERE status = 'dlq'
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit],
  );
}

/**
 * Put a parked row back in the queue.
 *
 * Attempts reset to zero because an operator replaying a row has usually fixed
 * the cause, and carrying the old count would send it straight back to the dead
 * letter after one more failure. The row keeps its idempotency key, so a replay
 * of something that DID land upstream is still recognised as the same intention.
 */
export async function replayOutbox(id: string): Promise<boolean> {
  const rows = await dataService.query<{ id: string }>(
    `UPDATE leadflow_outbox
        SET status = 'pending', attempts = 0, next_attempt_at = NOW(), last_error = NULL
      WHERE id = $1 AND status = 'dlq'
      RETURNING id`,
    [id],
  );
  return rows.length > 0;
}
