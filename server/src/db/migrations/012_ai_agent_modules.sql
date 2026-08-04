-- Migration 012: AI SDR proposals, research provenance, and coach scorecards.
--
-- THE CENTRAL DESIGN FACT: there is no `sent` state anywhere in this schema.
-- The SOP permits AI to 'suggest messages, scores, summaries, and next actions'
-- with 'a qualified human reviews consequential outputs', so a draft is a
-- PROPOSAL and sending is a separate, human, separately-permissioned act. A
-- status enum containing 'sent' would be an invitation to write the code that
-- sets it.

CREATE TABLE IF NOT EXISTS ai_sdr_proposal (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id            UUID        NOT NULL,
  -- 'proposed' is the ONLY state a machine may write. A rep moves it to
  -- accepted or rejected; nothing moves it anywhere else.
  status             VARCHAR(16) NOT NULL DEFAULT 'proposed',
  channel            VARCHAR(8)  NOT NULL,
  -- The deterministic qualification score and the per-criterion attribution
  -- that produced it. Stored TOGETHER because a score without its attribution
  -- is a number a rep can only over-trust or ignore.
  score              INTEGER     NOT NULL,
  score_attribution  JSONB       NOT NULL,
  draft_subject      TEXT,
  draft_body         TEXT,
  -- The rep's edit, kept ALONGSIDE the original rather than over it.
  -- Overwriting would destroy the only evidence of what the model actually
  -- produced — exactly the record needed to tell whether drafts are improving.
  edited_body        TEXT,
  booking_options    JSONB,
  -- Which template version the draft was rendered from, so a later complaint
  -- about wording can be traced to the copy that was approved at the time.
  template_version   VARCHAR(32) NOT NULL,
  proposed_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_by_user_id UUID,
  decided_at         TIMESTAMPTZ,
  CONSTRAINT ai_sdr_proposal_status_ck
    CHECK (status IN ('proposed', 'accepted', 'rejected')),
  CONSTRAINT ai_sdr_proposal_channel_ck
    CHECK (channel IN ('email', 'sms'))
);

CREATE INDEX IF NOT EXISTS ai_sdr_proposal_lead_idx
  ON ai_sdr_proposal (lead_id, proposed_at DESC);
-- The rep's queue: what is waiting on a human. Partial, because an accepted
-- proposal leaves the queue forever and indexing it would cost space on every
-- row to answer a question nobody asks.
CREATE INDEX IF NOT EXISTS ai_sdr_proposal_awaiting_idx
  ON ai_sdr_proposal (proposed_at DESC) WHERE status = 'proposed';

-- Every fact the research step used, with where it came from.
--
-- A SEPARATE ROW PER FACT, not a blob on the proposal. The criterion is that
-- research uses only permitted sources WITH PROVENANCE RECORDED, and provenance
-- that cannot be queried per fact cannot answer the only question that matters:
-- "where did this specific claim about the prospect come from?"
CREATE TABLE IF NOT EXISTS ai_research_fact (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id   UUID        NOT NULL REFERENCES ai_sdr_proposal (id) ON DELETE CASCADE,
  -- The registry key of the permitted source. Not free text: a source name
  -- typed at the call site cannot be checked against the registry later.
  source_key    VARCHAR(64) NOT NULL,
  fact_key      VARCHAR(64) NOT NULL,
  fact_value    TEXT,
  -- WHEN it was retrieved. A fact about a company is perishable, and a draft
  -- citing a two-year-old headcount is worse than one citing none.
  retrieved_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Whether obtaining it spent a data credit, so the cost of a proposal is
  -- attributable rather than appearing as an unexplained line on a bill.
  cost_credits  INTEGER     NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS ai_research_fact_proposal_idx
  ON ai_research_fact (proposal_id);

-- A call registered for coaching, and the basis on which it was recorded.
--
-- NO TRANSCRIPT CONTENT LIVES HERE. Only identifiers, the basis, and a pointer
-- to sdk-conversation. A call whose consent is later revoked therefore has no
-- content in this database to purge — the safest place to keep call content is
-- somewhere it never was.
CREATE TABLE IF NOT EXISTS ai_coach_call (
  id                             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_call_id               VARCHAR(255) NOT NULL,
  rep_email                      VARCHAR(320),
  lead_id                        UUID,
  occurred_at                    TIMESTAMPTZ NOT NULL,
  -- NOT NULL, deliberately. A call registered without a basis would be
  -- indistinguishable a month later from one where consent was genuinely
  -- obtained and simply not written down, so the schema refuses to hold that
  -- ambiguity at all.
  recording_consent_basis_ref    VARCHAR(255) NOT NULL,
  recording_consent_captured_at  TIMESTAMPTZ  NOT NULL,
  registered_at                  TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One row per external call. A redelivered conversation webhook must not
-- register the same call twice.
CREATE UNIQUE INDEX IF NOT EXISTS ai_coach_call_external_key
  ON ai_coach_call (external_call_id);

CREATE TABLE IF NOT EXISTS ai_coach_scorecard (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id            UUID        NOT NULL REFERENCES ai_coach_call (id) ON DELETE CASCADE,
  -- Scores for the ten SOP dimensions, keyed by the registry key so a renamed
  -- dimension is a lookup failure rather than a silently orphaned score.
  dimension_scores   JSONB       NOT NULL,
  missed_questions   JSONB       NOT NULL DEFAULT '[]'::jsonb,
  -- Objections detected, each mapped to an APPROVED LACE response or flagged
  -- unmapped. Never an invented rebuttal.
  objections         JSONB       NOT NULL DEFAULT '[]'::jsonb,
  keep_behaviour     TEXT,
  change_behaviour   TEXT,
  practice_assignment TEXT,
  -- How the recording basis was verified when this scorecard was produced.
  -- Stamped onto the artefact because "was this call lawfully processed" is
  -- asked about the OUTPUT, long after the check itself has scrolled out of any
  -- log.
  consent_verification JSONB     NOT NULL,
  scored_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_coach_scorecard_call_key
  ON ai_coach_scorecard (call_id);

COMMENT ON TABLE ai_sdr_proposal IS
  'AI SDR output awaiting human review. There is deliberately no sent state: sending is a separate human act, and a status enum containing it would invite the code that sets it.';
COMMENT ON COLUMN ai_sdr_proposal.edited_body IS
  'The rep edit, kept alongside the original draft rather than over it — the original is the only evidence of what the model actually produced.';
COMMENT ON TABLE ai_research_fact IS
  'Per-fact research provenance. One row per fact so the question "where did this specific claim come from" is answerable.';
COMMENT ON TABLE ai_coach_call IS
  'A call registered for coaching. Holds NO transcript content — only identifiers and the recording consent basis, so a revoked consent has no local content to purge.';
COMMENT ON COLUMN ai_coach_call.recording_consent_basis_ref IS
  'NOT NULL by design: a blank basis is indistinguishable later from consent obtained but unrecorded.';
