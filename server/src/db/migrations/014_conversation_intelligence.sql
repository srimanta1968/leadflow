-- Migration 014: the conversation intelligence pipeline.
--
-- Recording capture under a verified basis, then transcription, diarization,
-- summary, sentiment, objections, action items, deal risk and coaching input.
-- Three tables, and each one enforces a criterion in the SCHEMA rather than
-- leaving it to the code above it — because every one of these guarantees is
-- about evidence, and evidence that depends on a service layer remembering is
-- evidence with a hole in it.

-- ---------------------------------------------------------------------------
-- The recording.
-- ---------------------------------------------------------------------------
--
-- THE MEDIA IS NOT HERE, and that is the same call migration 012 made about
-- transcripts. This row holds the POINTER (sdk-media blob id), the basis it was
-- captured under, and the hash — never the audio. A recording whose consent is
-- later revoked has no media in this database to purge, which is the strongest
-- possible answer to "are you sure it is gone".
CREATE TABLE IF NOT EXISTS call_recording (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The coaching call this recording belongs to. Reuses migration 012's table
  -- rather than inventing a second notion of "a call".
  call_id                UUID REFERENCES ai_coach_call (id) ON DELETE CASCADE,
  external_call_id       VARCHAR(255) NOT NULL,
  -- sdk-media blob. NULL until the upload completes.
  media_blob_id          VARCHAR(255),

  -- WHY THIS RECORDING WAS ALLOWED TO EXIST. NOT NULL, deliberately: a
  -- recording row with a blank basis is indistinguishable a month later from
  -- one where consent was genuinely obtained and simply not written down, and
  -- the whole pipeline downstream of it inherits that ambiguity.
  consent_basis_ref      VARCHAR(255) NOT NULL,
  consent_verified_at    TIMESTAMPTZ  NOT NULL,
  consent_method         VARCHAR(32)  NOT NULL,
  -- The jurisdiction rule applied, so a later question about two-party consent
  -- is answered from what was decided AT THE TIME rather than from the registry
  -- as it stands today.
  jurisdiction           VARCHAR(16)  NOT NULL,
  jurisdiction_rule      VARCHAR(32)  NOT NULL,

  duration_ms            INTEGER,
  -- Content hash of the media as sdk-media reported it. The anchor the chain of
  -- custody is verified against: without it "the recording was not altered" is
  -- a claim rather than a check.
  content_hash           VARCHAR(128),
  status                 VARCHAR(24)  NOT NULL DEFAULT 'captured',
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT call_recording_status_ck CHECK (status IN (
    'captured', 'stored', 'transcribed', 'analysed', 'failed', 'purged'
  )),
  CONSTRAINT call_recording_duration_ck CHECK (duration_ms IS NULL OR duration_ms >= 0)
);

-- One recording per external call. A redelivered Twilio webhook must not create
-- a second recording of the same conversation, which would double every
-- downstream artifact and make the coaching numbers quietly wrong.
CREATE UNIQUE INDEX IF NOT EXISTS call_recording_external_key
  ON call_recording (external_call_id);
CREATE INDEX IF NOT EXISTS call_recording_call_idx ON call_recording (call_id);

-- ---------------------------------------------------------------------------
-- Chain of custody.
-- ---------------------------------------------------------------------------
--
-- APPEND ONLY, and enforced by a trigger below rather than by everyone
-- remembering. A custody chain that can be updated is not a custody chain: the
-- entire value of the record is that nobody could have changed it afterwards,
-- and "we only ever insert" is a property of today's code rather than of the
-- data.
--
-- Every stage of the pipeline writes one row: captured, stored, transcribed,
-- redacted, analysed, accessed, purged. The chain is what answers "who touched
-- this recording, when, and what did they do with it".
CREATE TABLE IF NOT EXISTS call_custody_event (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ON DELETE RESTRICT, NOT CASCADE, and the two are not interchangeable here.
  -- A cascade would be a contradiction the database could never honour: the
  -- trigger below refuses DELETE on this table, so a cascading delete of a
  -- recording fails with "append-only" — an error about the wrong thing, at the
  -- wrong layer, for someone who was only trying to remove a recording.
  -- RESTRICT says the real rule out loud: A RECORDING WITH A CUSTODY CHAIN
  -- CANNOT BE DELETED. That is the intent, not a limitation — the record of who
  -- handled a recording must outlive the recording, or the purge itself becomes
  -- unprovable. Media is removed upstream in sdk-media and recorded here as a
  -- `purged` link; the row stays.
  recording_id  UUID         NOT NULL REFERENCES call_recording (id) ON DELETE RESTRICT,
  stage         VARCHAR(24)  NOT NULL,
  -- WHO. A person, a service, or a named agent — never blank, because an
  -- unattributed custody entry cannot answer the question it exists for.
  actor         VARCHAR(255) NOT NULL,
  actor_kind    VARCHAR(16)  NOT NULL DEFAULT 'service',
  -- What the stage did, in the operator's terms.
  detail        TEXT         NOT NULL,
  -- Hash of the artefact this stage produced, so a later stage's input can be
  -- shown to be the previous stage's output.
  content_hash  VARCHAR(128),
  -- Pointer into sdk-evidence when the chain is mirrored upstream.
  evidence_ref  VARCHAR(255),
  occurred_at   TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT call_custody_stage_ck CHECK (stage IN (
    'captured', 'stored', 'transcribed', 'redacted', 'analysed', 'accessed',
    'blocked', 'purged'
  )),
  CONSTRAINT call_custody_actor_ck CHECK (LENGTH(TRIM(actor)) > 0)
);

CREATE INDEX IF NOT EXISTS call_custody_recording_idx
  ON call_custody_event (recording_id, occurred_at);

-- The append-only guarantee, as a rule the database enforces.
--
-- A BEFORE trigger rather than a permission grant: revoking UPDATE from the
-- application role would work too, and would be invisible to anyone reading
-- this schema — which is where somebody looks when they ask whether the chain
-- can be rewritten.
CREATE OR REPLACE FUNCTION call_custody_event_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'call_custody_event is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS call_custody_event_no_update ON call_custody_event;
CREATE TRIGGER call_custody_event_no_update
  BEFORE UPDATE OR DELETE ON call_custody_event
  FOR EACH ROW EXECUTE FUNCTION call_custody_event_immutable();

-- ---------------------------------------------------------------------------
-- Derived artifacts.
-- ---------------------------------------------------------------------------
--
-- EVERY ARTIFACT CARRIES ITS OFFSET INTO THE SOURCE RECORDING, and both columns
-- are NOT NULL. That is the acceptance criterion expressed as a constraint: an
-- artifact that cannot say where in the call it came from cannot be INSERTED,
-- so the guarantee holds even for a future caller that bypasses the pipeline.
--
-- Offsets are MILLISECONDS FROM THE START OF THE RECORDING rather than wall
-- clock timestamps. A wall clock time has to be reconciled against when the
-- recording started, which is exactly the reconciliation that goes wrong when
-- somebody asks "play me the bit where they said that".
CREATE TABLE IF NOT EXISTS call_artifact (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id     UUID        NOT NULL REFERENCES call_recording (id) ON DELETE CASCADE,
  kind             VARCHAR(24) NOT NULL,
  -- Which pipeline stage produced it, so a bad artifact is traceable to the
  -- stage that made it rather than to "the pipeline".
  produced_by      VARCHAR(32) NOT NULL,
  speaker          VARCHAR(16),
  content          JSONB       NOT NULL,
  source_start_ms  INTEGER     NOT NULL,
  source_end_ms    INTEGER     NOT NULL,
  -- Which redaction rules fired on the text before it left for analysis, and
  -- how many spans each removed. COUNTS ONLY — storing what was redacted would
  -- make this the one table holding the personal data the redaction removed.
  redaction_applied JSONB      NOT NULL DEFAULT '[]'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT call_artifact_kind_ck CHECK (kind IN (
    'transcript_segment', 'summary', 'sentiment', 'objection', 'action_item',
    'deal_risk', 'coaching_input'
  )),
  -- An interval that ends before it starts is not a citation, it is a bug that
  -- would silently produce an unplayable "jump to this moment" link.
  CONSTRAINT call_artifact_span_ck CHECK (
    source_start_ms >= 0 AND source_end_ms >= source_start_ms
  )
);

CREATE INDEX IF NOT EXISTS call_artifact_recording_idx
  ON call_artifact (recording_id, source_start_ms);
CREATE INDEX IF NOT EXISTS call_artifact_kind_idx
  ON call_artifact (recording_id, kind);

COMMENT ON TABLE call_recording IS
  'A recording captured under a verified consent basis. Holds the sdk-media POINTER and the basis, never the audio, so a revoked consent has no media here to purge.';
COMMENT ON TABLE call_custody_event IS
  'Append-only chain of custody. The trigger is the guarantee: a chain that can be updated is not a chain, and "we only ever insert" is a property of code rather than of data.';
COMMENT ON TABLE call_artifact IS
  'Every derived artifact, each carrying its millisecond offset into the source recording. Both offset columns are NOT NULL so an untraceable artifact cannot be inserted at all.';
COMMENT ON COLUMN call_artifact.redaction_applied IS
  'Which redaction rules fired and how many spans each removed. Counts only — never the removed values.';
