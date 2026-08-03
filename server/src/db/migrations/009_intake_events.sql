-- Migration 009: the raw intake archive and the outage queue.
--
-- TWO TABLES DOING TWO DIFFERENT JOBS, deliberately not one.
--
-- `intake_event` is the ARCHIVE and the idempotency ledger. Every signal that
-- arrives is written here BEFORE it is validated, judged or processed — which
-- is the opposite of the ordering used for the offline sync ledger (008), and
-- the difference is the point. There, the ledger recorded an OUTCOME, so
-- writing it before the work risked claiming something that never happened.
-- Here the row records ARRIVAL, which is a fact the moment the bytes land.
-- Writing it after validation would mean a rejected signal leaves no trace, and
-- "the webhook never arrived" and "the webhook arrived and we threw it away"
-- would be indistinguishable during an incident.
--
-- `intake_outage_queue` holds signals accepted while a downstream SDK was
-- unreachable. Separate from the archive because they answer different
-- questions: the archive asks "what did this platform ever send us", the queue
-- asks "what do we still owe processing to". Merging them would mean draining
-- the queue either mutates the archive or requires a status column that every
-- archive read then has to filter on.

CREATE TABLE IF NOT EXISTS intake_event (
  -- Which platform sent it, and that platform's own id for the event. TOGETHER
  -- these are the idempotency key: a source event id is only unique within the
  -- platform that minted it, and two providers will eventually both use "1".
  platform          VARCHAR(64)  NOT NULL,
  source_event_id   VARCHAR(255) NOT NULL,
  tenant_id         UUID,
  -- The payload EXACTLY as received, before any parsing. This is the archive.
  raw_payload       JSONB        NOT NULL,
  -- Verified / unsigned / bad_signature. Recorded rather than inferred: an
  -- unsigned event that was archived and refused is a different security fact
  -- from one that verified, and the archive has to be able to say which.
  signature_state   VARCHAR(32)  NOT NULL,
  -- accepted / rejected / deferred. `rejected` rows are the whole reason this
  -- table is written before validation.
  outcome           VARCHAR(32)  NOT NULL,
  -- Why, when rejected. Free text: it is read by a human during an incident,
  -- not branched on.
  rejection_reason  TEXT,
  -- What the signal became, when it became anything.
  lead_id           UUID,
  -- When the PLATFORM says it happened, which is not when it reached us. A
  -- retried webhook arrives late and still describes the original moment.
  occurred_at       TIMESTAMPTZ,
  received_at       TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- THE REPLAY GUARANTEE. One row per (platform, source_event_id) per tenant, so
-- a webhook delivered five times creates one lead, one task, one message and
-- one payment. Partial on tenant via COALESCE for the same reason as 008: while
-- tenancy is still staged, NULL tenant rows must share one bucket rather than
-- each counting as distinct and defeating the constraint exactly when it
-- matters.
CREATE UNIQUE INDEX IF NOT EXISTS intake_event_replay_key
  ON intake_event (
    COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid),
    platform,
    source_event_id
  );

-- Incident queries read by arrival, usually for one platform.
CREATE INDEX IF NOT EXISTS intake_event_platform_received_idx
  ON intake_event (platform, received_at DESC);

-- Finding what was refused, which is the first question after a provider
-- complains that their events are missing.
CREATE INDEX IF NOT EXISTS intake_event_rejected_idx
  ON intake_event (received_at DESC)
  WHERE outcome = 'rejected';

CREATE TABLE IF NOT EXISTS intake_outage_queue (
  platform         VARCHAR(64)  NOT NULL,
  source_event_id  VARCHAR(255) NOT NULL,
  tenant_id        UUID,
  -- Which downstream was unavailable, so a targeted backfill can drain only the
  -- events that were waiting on the thing that has just recovered.
  blocked_on       VARCHAR(64)  NOT NULL,
  attempts         INTEGER      NOT NULL DEFAULT 0,
  last_error       TEXT,
  queued_at        TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Set when the backfill finally processes it. Kept rather than deleted: "this
  -- event was delayed four hours by an outage" is exactly what someone asks
  -- after the fact, and a deleted row cannot answer it.
  drained_at       TIMESTAMPTZ
);

-- One queue entry per event. A retry during an outage must not queue it twice.
CREATE UNIQUE INDEX IF NOT EXISTS intake_outage_queue_key
  ON intake_outage_queue (
    COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid),
    platform,
    source_event_id
  );

-- The backfill scan: everything still owed, oldest first.
CREATE INDEX IF NOT EXISTS intake_outage_queue_pending_idx
  ON intake_outage_queue (blocked_on, queued_at)
  WHERE drained_at IS NULL;

COMMENT ON TABLE intake_event IS
  'Raw intake archive AND replay ledger. Written on arrival, before validation, so a rejected signal still leaves evidence — "never arrived" and "arrived and was discarded" must not look alike.';
COMMENT ON TABLE intake_outage_queue IS
  'Signals accepted while a downstream SDK was unreachable, drained by backfill-by-event-id once it recovers.';
