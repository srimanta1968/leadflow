-- 017 — Saga runs, their steps, and the channel-decision ledger.
--
-- TWO THINGS THAT MUST SURVIVE A CRASH.
--
-- A saga spans nine ProjexCloud calls that cannot share a transaction. If the
-- process dies after step five, the only way to know what already happened —
-- and what must therefore be compensated rather than repeated — is to have
-- written each step down as it completed. In-memory state is exactly the thing
-- that is gone when you need it.
--
-- A channel decision is the record that somebody was ALLOWED to be contacted,
-- and on what basis. It has to outlive the send: six months later "why did we
-- text this person?" is answered by this row or by nothing at all. It is also
-- what makes the no-bypass rule enforceable rather than aspirational — a send
-- carries a decision id, and a decision id exists only if the composer made one.

-- ------------------------------------------------------------- saga runs
CREATE TABLE IF NOT EXISTS leadflow_saga_run (
  -- The CALLER's idempotency key, not ours. A replayed intake event presents the
  -- same key, finds this row already complete, and is handed the original result
  -- instead of running nine steps again. That is the whole of AC1.
  idempotency_key  TEXT PRIMARY KEY,
  saga_name        TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'running',
  -- The chain every downstream call is tagged with, so a trace joins end to end.
  correlation_id   TEXT NOT NULL,
  causation_id     TEXT,
  input            JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- The artefacts produced, keyed by step. Returned verbatim on a replay so the
  -- caller sees the SAME ids rather than a second set.
  output           JSONB NOT NULL DEFAULT '{}'::jsonb,
  failed_step      TEXT,
  error            TEXT,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS leadflow_saga_run_status_idx
  ON leadflow_saga_run (saga_name, status, started_at);

-- ------------------------------------------------------------ saga steps
-- One row per step ATTEMPT, in order. This is the compensation ledger: rolling
-- back means walking these in reverse and undoing only what actually succeeded.
-- Compensating a step that never ran is how a rollback creates the damage it was
-- supposed to prevent.
CREATE TABLE IF NOT EXISTS leadflow_saga_step (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key  TEXT NOT NULL REFERENCES leadflow_saga_run(idempotency_key) ON DELETE CASCADE,
  step_name        TEXT NOT NULL,
  position         INTEGER NOT NULL,
  status           TEXT NOT NULL,
  -- Derived deterministically as `${runKey}:${stepName}`, so a retry of ONE step
  -- presents the same key upstream and cannot create a second artefact.
  step_key         TEXT NOT NULL,
  result           JSONB,
  error            TEXT,
  compensated_at   TIMESTAMPTZ,
  compensation_error TEXT,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at      TIMESTAMPTZ
);

-- One row per step per run. A second attempt UPDATES rather than inserting, so
-- the ledger says what happened to each step rather than how many times it was
-- tried in a loop nobody can now reconstruct.
CREATE UNIQUE INDEX IF NOT EXISTS leadflow_saga_step_unique_idx
  ON leadflow_saga_step (idempotency_key, step_name);

CREATE INDEX IF NOT EXISTS leadflow_saga_step_order_idx
  ON leadflow_saga_step (idempotency_key, position);

-- -------------------------------------------------- channel decision ledger
-- Every allow / review / deny, with the ordered reasons that produced it.
--
-- THE REASONS ARE STORED AS GIVEN, in the order the checks ran, because the UI
-- renders them verbatim. Re-deriving wording at display time means the sentence
-- an operator reads today is not the sentence that was actually decided on, and
-- the two drift the moment either side is edited.
CREATE TABLE IF NOT EXISTS leadflow_channel_decision (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_ref      TEXT NOT NULL,
  channel          TEXT NOT NULL,
  purpose_key      TEXT,
  audience         TEXT NOT NULL DEFAULT 'prospect',
  verdict          TEXT NOT NULL,
  -- [{ code, text, source, effect }], ordered. Ordered-ness is asserted in the
  -- tests: the FIRST blocking reason is the one an operator acts on, so a set
  -- would lose the only part of the answer that tells them what to do.
  reasons          JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Which checks actually ran. A decision made while sdk-consent was unreachable
  -- is a different fact from one made with every input present, and the panel
  -- must be able to tell them apart.
  checks_ran       JSONB NOT NULL DEFAULT '[]'::jsonb,
  degraded         BOOLEAN NOT NULL DEFAULT FALSE,
  correlation_id   TEXT,
  decided_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_by       TEXT
);

CREATE INDEX IF NOT EXISTS leadflow_channel_decision_subject_idx
  ON leadflow_channel_decision (subject_ref, channel, decided_at DESC);

CREATE INDEX IF NOT EXISTS leadflow_channel_decision_verdict_idx
  ON leadflow_channel_decision (verdict, decided_at DESC);
