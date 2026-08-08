-- 016 — The event log, its projections, and the dead letter.
--
-- WHY A LOG AND NOT JUST HANDLERS. ProjexCloud delivers at-least-once: the same
-- event arrives twice whenever an acknowledgement is lost, which during an
-- outage is routine rather than exotic. Handlers alone cannot survive that —
-- "increment a counter" applied twice is wrong, and there is no way to tell
-- afterwards whether it happened once or twice.
--
-- Recording every event first, keyed by the producer's own event id, turns the
-- problem into one the database solves: the second delivery conflicts, writes
-- nothing, and the handler is never invoked. It also makes REPLAY possible,
-- which is the only honest way to fix a projection bug — recompute from what
-- actually happened rather than hand-patch a derived table and hope.
--
-- THE ACCEPTANCE CRITERION FALLS OUT OF THE SHAPE. "Killing the consumer
-- mid-stream and restarting produces byte-identical projection state" is true
-- when, and only when, projections are a pure function of the log up to a
-- recorded position. That is what the checkpoint table is for.

-- --------------------------------------------------------------- event log
CREATE TABLE IF NOT EXISTS leadflow_event_log (
  -- The PRODUCER's id, not ours. This is the whole idempotency mechanism: a
  -- redelivery presents the same id and the unique constraint refuses it.
  event_id          TEXT PRIMARY KEY,
  event_type        TEXT NOT NULL,
  tenant_id         UUID,
  -- Monotonic arrival order. Projections advance through this, never through
  -- occurred_at: producers disagree about clocks, and an out-of-order timestamp
  -- would make a checkpoint skip events it had not actually applied.
  sequence          BIGSERIAL NOT NULL,
  -- When the PRODUCER says it happened, which is what business logic reads.
  occurred_at       TIMESTAMPTZ,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- The subject the event is about, extracted on ingest so a projection can
  -- find its row without parsing JSON on every read.
  subject_type      TEXT,
  subject_id        TEXT,
  payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- FALSE is recorded rather than refused. An event whose signature did not
  -- verify is still evidence that something tried to talk to us, and the
  -- difference between "never arrived" and "arrived and was rejected" is the
  -- whole investigation during an incident.
  signature_verified BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE UNIQUE INDEX IF NOT EXISTS leadflow_event_log_sequence_idx
  ON leadflow_event_log (sequence);

-- The consumer's only scan: everything after my checkpoint, in order.
CREATE INDEX IF NOT EXISTS leadflow_event_log_type_sequence_idx
  ON leadflow_event_log (event_type, sequence);

CREATE INDEX IF NOT EXISTS leadflow_event_log_subject_idx
  ON leadflow_event_log (subject_type, subject_id, sequence);

-- ------------------------------------------------------------- checkpoints
-- How far each projection has been advanced. One row per projection, so a
-- rebuild of one does not disturb the others.
CREATE TABLE IF NOT EXISTS leadflow_projection_checkpoint (
  projection_name  TEXT PRIMARY KEY,
  last_sequence    BIGINT NOT NULL DEFAULT 0,
  -- Set while a rebuild is running so a restart mid-rebuild does not present
  -- a half-built projection as current.
  rebuilding       BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------------ dead letter
-- Events a handler could not process. POISON EVENTS ARE PARKED, NOT RETRIED
-- FOREVER: a payload that throws on every attempt would otherwise stall the
-- whole stream behind it, and one malformed event must not stop the queue for
-- everything after it.
CREATE TABLE IF NOT EXISTS leadflow_event_dead_letter (
  event_id       TEXT PRIMARY KEY,
  event_type     TEXT NOT NULL,
  projection     TEXT NOT NULL,
  sequence       BIGINT NOT NULL,
  payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  error          TEXT NOT NULL,
  attempts       INTEGER NOT NULL DEFAULT 1,
  first_failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_failed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Set when an operator has decided what to do. A dead letter nobody ever
  -- looks at is a silent data-loss channel, so this column exists to make the
  -- unresolved ones countable.
  resolved_at    TIMESTAMPTZ,
  resolution     TEXT
);

CREATE INDEX IF NOT EXISTS leadflow_event_dead_letter_open_idx
  ON leadflow_event_dead_letter (last_failed_at)
  WHERE resolved_at IS NULL;

-- ------------------------------------------------------ pipeline projection
-- The read model the dashboards and the queue screens serve from.
--
-- ONE ROW PER SUBJECT, holding the current answer to every question a screen
-- asks — stage, owner, SLA state, booking, payment, last reply — so a hundred-row
-- queue is one query rather than a hundred SDK reads. That N+1 is the reason
-- this table exists; it is not a cache of an SDK response, it is the fold of
-- every event that has been received about the subject.
--
-- DERIVED, AND NOTHING ELSE WRITES HERE. Every column is a function of the log,
-- which is what makes a rebuild safe and what makes "byte-identical after a
-- restart" a property rather than a hope.
CREATE TABLE IF NOT EXISTS leadflow_pipeline_projection (
  subject_id          TEXT PRIMARY KEY,
  subject_type        TEXT NOT NULL,
  tenant_id           UUID,
  stage_key           TEXT,
  stage_entered_at    TIMESTAMPTZ,
  owner_id            TEXT,
  backup_owner_id     TEXT,
  sla_state           TEXT,
  sla_due_at          TIMESTAMPTZ,
  next_action         TEXT,
  next_action_due_at  TIMESTAMPTZ,
  booking_state       TEXT,
  booking_at          TIMESTAMPTZ,
  payment_state       TEXT,
  last_reply_at       TIMESTAMPTZ,
  last_reply_channel  TEXT,
  close_reason_key    TEXT,
  -- The event that last touched this row. Makes a stale projection diagnosable
  -- ("we stopped at sequence 4,120") instead of merely wrong.
  last_event_id       TEXT,
  last_sequence       BIGINT NOT NULL DEFAULT 0,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS leadflow_pipeline_projection_stage_idx
  ON leadflow_pipeline_projection (stage_key, sla_due_at);

CREATE INDEX IF NOT EXISTS leadflow_pipeline_projection_owner_idx
  ON leadflow_pipeline_projection (owner_id, stage_key);
