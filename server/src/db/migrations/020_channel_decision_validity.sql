-- 020 — A channel decision now states when it stops being true.
--
-- The decision row already recorded WHAT was decided and WHEN. What it could not
-- say is how long that answer remains the answer, and without that the ledger
-- quietly becomes a cache: a send path holds a decision id from an hour ago,
-- presents it at dispatch, and the schema has no way to object. Consent revoked
-- since, a suppression added since, a quiet-hours window entered since — none of
-- it can be seen, because "there is a decision for this" was the whole test.
--
-- So validity is a COLUMN, not a convention. `expires_at` is written by the
-- composer at decide time from the shortest-lived input that went into the
-- verdict, and the dispatch check compares against it rather than trusting the
-- row's existence. A decision presented after that instant is not refused
-- outright — it is RE-EVALUATED, which is the only answer that is both safe and
-- useful: the caller asked a fair question and deserves a current answer rather
-- than an error telling them to ask again.
--
-- Backfill note: existing rows are given an expiry derived from their own
-- decided_at, so they age out on the same rule as new ones instead of being
-- either immortal or retroactively invalid.
--
-- Checked `.projexlight/schema/current-schema.json` before adding: no
-- channel-decision or send-authorisation table exists in the shared reference,
-- and this extends 017_orchestration's own table rather than introducing one.

ALTER TABLE leadflow_channel_decision
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- The window each verdict class is allowed to stand for.
--
-- These are DELIBERATELY unequal. An `allow` is the dangerous one to keep: it is
-- the only verdict that authorises a send, so it holds for the shortest time.
-- A `deny` can be cached far longer because acting on a stale deny costs a
-- message that was probably still refused; acting on a stale allow costs a
-- message to somebody who withdrew permission. `review` sits between them — it
-- authorises nothing on its own, but a person is looking at it and the answer
-- they were shown should not change under them mid-triage.
UPDATE leadflow_channel_decision
   SET expires_at = decided_at + CASE verdict
         WHEN 'allow'  THEN INTERVAL '5 minutes'
         WHEN 'review' THEN INTERVAL '30 minutes'
         ELSE               INTERVAL '24 hours'
       END
 WHERE expires_at IS NULL;

ALTER TABLE leadflow_channel_decision
  ALTER COLUMN expires_at SET NOT NULL;

-- A degraded decision was made without every input, so it must not enjoy the
-- full window: the check that could not be reached is exactly the one most
-- likely to have changed the answer.
ALTER TABLE leadflow_channel_decision
  ADD COLUMN IF NOT EXISTS superseded_by UUID REFERENCES leadflow_channel_decision (id);

-- Dispatch verification reads one row by id and asks only whether it is still
-- live, so the id is already the primary key and this index serves the other
-- direction: "show me the decisions about to lapse", which the guardrails panel
-- polls.
CREATE INDEX IF NOT EXISTS leadflow_channel_decision_expiry_idx
  ON leadflow_channel_decision (expires_at DESC)
  WHERE superseded_by IS NULL;
