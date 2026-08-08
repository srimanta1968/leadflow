import { dataService } from '../../services/DataService';
import {
  apply,
  emptyState,
  type DomainEvent,
  type PipelineState,
} from './projections';

/**
 * The at-least-once consumer.
 *
 * TWO SEPARATE STEPS, and the separation is the design:
 *
 *   1. RECORD. The event is written to leadflow_event_log keyed by the
 *      producer's own event id. A redelivery conflicts and writes nothing, so
 *      duplicate suppression is the database's job rather than a handler's
 *      good intentions.
 *   2. ADVANCE. Projections are folded forward from their checkpoint. This is
 *      restartable by construction: it reads the log, and the log does not
 *      care whether the process that wrote it is still alive.
 *
 * Doing them in one step is the obvious shortcut and it breaks the acceptance
 * criterion. A crash between "applied the handler" and "acknowledged" would
 * either lose the event or apply it twice, depending which order you picked,
 * and no amount of care in the handler can fix a design that asks it to be
 * atomic with a network acknowledgement.
 */

export const PIPELINE_PROJECTION = 'pipeline';

export interface IngestInput {
  eventId: string;
  eventType: string;
  tenantId: string | null;
  occurredAt: string | null;
  subjectType: string | null;
  subjectId: string | null;
  payload: Record<string, unknown>;
  signatureVerified: boolean;
}

export interface IngestResult {
  /** False when this exact event had already been recorded. */
  accepted: boolean;
  duplicate: boolean;
  sequence: number | null;
}

/**
 * Record one delivery. Idempotent on the producer's event id.
 *
 * Returns `duplicate` rather than throwing, because a redelivery is NORMAL —
 * it is what at-least-once means — and treating the routine case as an error
 * fills the log with noise that hides the real ones.
 */
export async function ingest(input: IngestInput): Promise<IngestResult> {
  const rows = await dataService.query<{ sequence: string }>(
    `INSERT INTO leadflow_event_log
       (event_id, event_type, tenant_id, occurred_at, subject_type, subject_id,
        payload, signature_verified)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING sequence`,
    [
      input.eventId,
      input.eventType,
      input.tenantId,
      input.occurredAt ? new Date(input.occurredAt) : null,
      input.subjectType,
      input.subjectId,
      JSON.stringify(input.payload ?? {}),
      input.signatureVerified,
    ],
  );

  if (rows.length === 0) {
    return { accepted: false, duplicate: true, sequence: null };
  }
  return { accepted: true, duplicate: false, sequence: Number(rows[0].sequence) };
}

/** Where a projection has reached. */
export async function checkpoint(projection: string): Promise<number> {
  const rows = await dataService.query<{ last_sequence: string }>(
    `INSERT INTO leadflow_projection_checkpoint (projection_name, last_sequence)
     VALUES ($1, 0)
     ON CONFLICT (projection_name) DO UPDATE SET projection_name = EXCLUDED.projection_name
     RETURNING last_sequence`,
    [projection],
  );
  return Number(rows[0].last_sequence);
}

function toDomainEvent(row: {
  event_id: string;
  event_type: string;
  sequence: string;
  occurred_at: Date | null;
  subject_type: string | null;
  subject_id: string | null;
  tenant_id: string | null;
  payload: Record<string, unknown>;
}): DomainEvent {
  return {
    eventId: row.event_id,
    eventType: row.event_type,
    sequence: Number(row.sequence),
    // ISO, not a Date. The fold is pure and its output is compared byte for
    // byte; a Date would serialise differently depending on the driver.
    occurredAt: row.occurred_at ? new Date(row.occurred_at).toISOString() : null,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    tenantId: row.tenant_id,
    payload: row.payload ?? {},
  };
}

/** Events after `from`, oldest first. */
async function readLog(from: number, limit: number): Promise<DomainEvent[]> {
  const rows = await dataService.query<Parameters<typeof toDomainEvent>[0]>(
    `SELECT event_id, event_type, sequence, occurred_at, subject_type, subject_id,
            tenant_id, payload
       FROM leadflow_event_log
      WHERE sequence > $1
        -- An unverified delivery is RECORDED but never projected. It is
        -- evidence that something tried to reach us, not a fact about a lead.
        AND signature_verified = TRUE
      ORDER BY sequence ASC
      LIMIT $2`,
    [from, limit],
  );
  return rows.map(toDomainEvent);
}

async function loadState(subjectId: string): Promise<PipelineState | null> {
  const rows = await dataService.query<Record<string, unknown>>(
    `SELECT * FROM leadflow_pipeline_projection WHERE subject_id = $1`,
    [subjectId],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);
  return {
    subjectId: r.subject_id as string,
    subjectType: r.subject_type as string,
    tenantId: (r.tenant_id as string) ?? null,
    stageKey: (r.stage_key as string) ?? null,
    stageEnteredAt: iso(r.stage_entered_at),
    ownerId: (r.owner_id as string) ?? null,
    backupOwnerId: (r.backup_owner_id as string) ?? null,
    slaState: (r.sla_state as string) ?? null,
    slaDueAt: iso(r.sla_due_at),
    nextAction: (r.next_action as string) ?? null,
    nextActionDueAt: iso(r.next_action_due_at),
    bookingState: (r.booking_state as string) ?? null,
    bookingAt: iso(r.booking_at),
    paymentState: (r.payment_state as string) ?? null,
    lastReplyAt: iso(r.last_reply_at),
    lastReplyChannel: (r.last_reply_channel as string) ?? null,
    closeReasonKey: (r.close_reason_key as string) ?? null,
    lastEventId: (r.last_event_id as string) ?? null,
    lastSequence: Number(r.last_sequence ?? 0),
  };
}

async function writeState(state: PipelineState): Promise<void> {
  await dataService.query(
    `INSERT INTO leadflow_pipeline_projection
       (subject_id, subject_type, tenant_id, stage_key, stage_entered_at, owner_id,
        backup_owner_id, sla_state, sla_due_at, next_action, next_action_due_at,
        booking_state, booking_at, payment_state, last_reply_at, last_reply_channel,
        close_reason_key, last_event_id, last_sequence, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19, NOW())
     ON CONFLICT (subject_id) DO UPDATE SET
       subject_type = EXCLUDED.subject_type,
       tenant_id = EXCLUDED.tenant_id,
       stage_key = EXCLUDED.stage_key,
       stage_entered_at = EXCLUDED.stage_entered_at,
       owner_id = EXCLUDED.owner_id,
       backup_owner_id = EXCLUDED.backup_owner_id,
       sla_state = EXCLUDED.sla_state,
       sla_due_at = EXCLUDED.sla_due_at,
       next_action = EXCLUDED.next_action,
       next_action_due_at = EXCLUDED.next_action_due_at,
       booking_state = EXCLUDED.booking_state,
       booking_at = EXCLUDED.booking_at,
       payment_state = EXCLUDED.payment_state,
       last_reply_at = EXCLUDED.last_reply_at,
       last_reply_channel = EXCLUDED.last_reply_channel,
       close_reason_key = EXCLUDED.close_reason_key,
       last_event_id = EXCLUDED.last_event_id,
       last_sequence = EXCLUDED.last_sequence,
       updated_at = NOW()`,
    [
      state.subjectId, state.subjectType, state.tenantId, state.stageKey,
      state.stageEnteredAt, state.ownerId, state.backupOwnerId, state.slaState,
      state.slaDueAt, state.nextAction, state.nextActionDueAt, state.bookingState,
      state.bookingAt, state.paymentState, state.lastReplyAt, state.lastReplyChannel,
      state.closeReasonKey, state.lastEventId, state.lastSequence,
    ],
  );
}

async function deadLetter(event: DomainEvent, projection: string, error: string): Promise<void> {
  await dataService.query(
    `INSERT INTO leadflow_event_dead_letter
       (event_id, event_type, projection, sequence, payload, error)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     ON CONFLICT (event_id) DO UPDATE SET
       attempts = leadflow_event_dead_letter.attempts + 1,
       last_failed_at = NOW(),
       error = EXCLUDED.error`,
    [event.eventId, event.eventType, projection, event.sequence, JSON.stringify(event.payload), error],
  );
}

export interface AdvanceResult {
  applied: number;
  deadLettered: number;
  from: number;
  to: number;
}

/**
 * Fold the log forward into the pipeline projection.
 *
 * THE CHECKPOINT MOVES PAST A POISON EVENT. That looks wrong for about a second
 * and is the only workable answer: an event that throws on every attempt would
 * otherwise block every event behind it forever, so one malformed payload takes
 * the whole stream down. It is parked in the dead letter, where it is countable
 * and recoverable, and the stream keeps moving — which is the trade every real
 * queue makes and the reason a dead-letter table exists at all.
 *
 * Safe to call concurrently with itself only in the sense that it is safe to
 * call twice: the fold is idempotent per sequence, so a second pass over the
 * same events changes nothing.
 */
export async function advancePipeline(batchSize = 500): Promise<AdvanceResult> {
  const from = await checkpoint(PIPELINE_PROJECTION);
  const events = await readLog(from, batchSize);
  const result: AdvanceResult = { applied: 0, deadLettered: 0, from, to: from };

  for (const event of events) {
    result.to = event.sequence;
    if (!event.subjectId) {
      // Nothing to project onto. Not an error — plenty of platform events are
      // about a tenant rather than a subject.
      continue;
    }
    try {
      const current =
        (await loadState(event.subjectId))
        ?? emptyState(event.subjectId, event.subjectType ?? 'lead', event.tenantId);
      const next = apply(current, event);
      if (next !== current) {
        await writeState(next);
        result.applied += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await deadLetter(event, PIPELINE_PROJECTION, message);
      result.deadLettered += 1;
    }
  }

  if (result.to > from) {
    await dataService.query(
      `UPDATE leadflow_projection_checkpoint
          SET last_sequence = $2, updated_at = NOW()
        WHERE projection_name = $1
          -- GREATEST, not assignment: two consumers running at once must not
          -- move the checkpoint BACKWARDS, which would re-apply events the
          -- other one had already folded.
          AND last_sequence < $2`,
      [PIPELINE_PROJECTION, result.to],
    );
  }

  return result;
}

/**
 * Rebuild the projection from the log, from scratch.
 *
 * The honest fix for a projection bug. Hand-patching a derived table leaves it
 * agreeing with nothing — not the log, not the next rebuild — and the patch is
 * invisible to everyone who comes later.
 *
 * The checkpoint is marked `rebuilding` for the duration so a restart mid-way
 * does not present a half-built projection as current.
 */
export async function rebuildPipeline(batchSize = 1000): Promise<AdvanceResult> {
  await dataService.query(
    `INSERT INTO leadflow_projection_checkpoint (projection_name, last_sequence, rebuilding)
     VALUES ($1, 0, TRUE)
     ON CONFLICT (projection_name) DO UPDATE SET last_sequence = 0, rebuilding = TRUE, updated_at = NOW()`,
    [PIPELINE_PROJECTION],
  );
  await dataService.query(`DELETE FROM leadflow_pipeline_projection`);

  const total: AdvanceResult = { applied: 0, deadLettered: 0, from: 0, to: 0 };
  for (;;) {
    const pass = await advancePipeline(batchSize);
    total.applied += pass.applied;
    total.deadLettered += pass.deadLettered;
    total.to = pass.to;
    if (pass.to <= pass.from) break;
  }

  await dataService.query(
    `UPDATE leadflow_projection_checkpoint SET rebuilding = FALSE, updated_at = NOW()
      WHERE projection_name = $1`,
    [PIPELINE_PROJECTION],
  );
  return total;
}

/**
 * A stable fingerprint of the whole projection.
 *
 * This is what the acceptance criterion is checked with: kill the consumer
 * mid-stream, restart, and compare. Ordered by subject_id and built from the
 * columns rather than from a row-to-JSON, so it does not depend on physical row
 * order or on how the driver happens to serialise a timestamp.
 */
export async function projectionFingerprint(): Promise<string> {
  const rows = await dataService.query<{ fingerprint: string | null }>(
    `SELECT md5(string_agg(line, '|' ORDER BY line)) AS fingerprint
       FROM (
         SELECT concat_ws(':', subject_id, subject_type, stage_key, owner_id,
                          backup_owner_id, sla_state, next_action, booking_state,
                          payment_state, last_reply_channel, close_reason_key,
                          last_sequence::text) AS line
           FROM leadflow_pipeline_projection
       ) s`,
  );
  return rows[0]?.fingerprint ?? 'empty';
}
