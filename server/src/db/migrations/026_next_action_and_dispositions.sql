-- 026 — The NEXT action every open record must carry, the integrity exceptions a
-- blocked save raises, disposition automation, and the Closed-Lost capture.
-- SOP §01, §06, §07, §15, §28.
--
-- Checked `.projexlight/schema/current-schema.json` and the 34 existing
-- leadflow_* tables before adding: stage, disposition and close-reason CONFIG
-- already exist (015), and this migration adds the per-record STATE that hangs
-- off them, which nothing currently stores.

-- ---------------------------------------------------------------------------
-- NO BLANK NEXT. SOP §01's non-negotiable, as a row.

CREATE TABLE IF NOT EXISTS leadflow_next_action (
  next_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      TEXT,
  -- The record this NEXT belongs to. A ref rather than a lead FK because the
  -- gate governs deals and contacts too, and a foreign key to one of them would
  -- quietly exclude the others.
  subject_ref    TEXT NOT NULL,

  -- The five fields SOP §01 requires. All NOT NULL: the whole rule is that a
  -- NEXT is not a NEXT until it says what, who, when, why and what for, and a
  -- nullable column here would make a blank one representable.
  action_type      TEXT NOT NULL,
  owner_user_id    UUID NOT NULL,
  due_at           TIMESTAMPTZ NOT NULL,
  purpose          TEXT NOT NULL,
  intended_outcome TEXT NOT NULL,

  completed_at   TIMESTAMPTZ,
  created_by     UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT leadflow_next_action_fields_present CHECK (
    length(btrim(action_type)) > 0 AND length(btrim(purpose)) > 0
    AND length(btrim(intended_outcome)) > 0
  )
);

-- One OPEN next action per record. Two competing NEXTs is the same as none:
-- nobody can say which one the record is waiting on.
CREATE UNIQUE INDEX IF NOT EXISTS leadflow_next_action_one_open
  ON leadflow_next_action (tenant_id, subject_ref) WHERE completed_at IS NULL;

-- ---------------------------------------------------------------------------
-- A blocked save is VISIBLE, not silent. SOP §28.

CREATE TABLE IF NOT EXISTS leadflow_integrity_exception (
  exception_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    TEXT,
  subject_ref  TEXT NOT NULL,
  kind         TEXT NOT NULL,
  -- The fields that were missing, so a manager sees WHAT was skipped rather
  -- than only that something was.
  missing      JSONB NOT NULL DEFAULT '[]'::jsonb,
  attempted_by UUID,
  detail       TEXT,
  resolved_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT leadflow_integrity_exception_kind_known
    CHECK (kind IN ('blank_next','stage_guard','open_record_incomplete','terminal_without_onboarding'))
);

CREATE INDEX IF NOT EXISTS idx_integrity_exception_open
  ON leadflow_integrity_exception (resolved_at, created_at DESC);

-- ---------------------------------------------------------------------------
-- Dispositions driving automation. SOP §07.

CREATE TABLE IF NOT EXISTS leadflow_disposition_event (
  event_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    TEXT,
  subject_ref  TEXT NOT NULL,
  code_key     TEXT NOT NULL,

  -- What the disposition SET OFF. Recorded so "the no-answer follow-up never
  -- went" and "it went twice" are both answerable from one place.
  actions      JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- NO DUPLICATE SENDS. SOP §07 requires the no-answer follow-up within two
  -- minutes and exactly once; a second disposition of the same kind on the same
  -- record must not re-send. The partial unique index below is that guarantee —
  -- the automation claims its slot by INSERT and a refused insert means the
  -- follow-up already went.
  dedupe_key   TEXT NOT NULL,

  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   UUID
);

CREATE UNIQUE INDEX IF NOT EXISTS leadflow_disposition_event_once
  ON leadflow_disposition_event (tenant_id, subject_ref, dedupe_key);

-- ---------------------------------------------------------------------------
-- Closed-Lost capture. SOP §15.

CREATE TABLE IF NOT EXISTS leadflow_close_capture (
  capture_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      TEXT,
  subject_ref    TEXT NOT NULL,

  reason_code    TEXT NOT NULL,
  -- THE PROSPECT'S OWN WORDING, not the rep's paraphrase. A taxonomy tells you
  -- how often you lose on price; the sentence tells you what they actually
  -- said, and only one of those changes how the offer is written.
  prospect_wording TEXT NOT NULL,
  -- Which version of the offer was on the table. Without it a loss cannot be
  -- attributed to terms that have since changed.
  offer_version  TEXT NOT NULL,
  competing_option TEXT,
  learning_note  TEXT,

  -- A future date ONLY when one truly exists. Nullable on purpose: inventing a
  -- follow-up date to fill the field produces a nurture queue full of dates
  -- nobody agreed, which is how re-engagement earns its reputation.
  revisit_at     TIMESTAMPTZ,

  closed_by      UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT leadflow_close_capture_evidence_present CHECK (
    length(btrim(reason_code)) > 0 AND length(btrim(prospect_wording)) > 0
    AND length(btrim(offer_version)) > 0
  ),
  CONSTRAINT leadflow_close_capture_once UNIQUE (tenant_id, subject_ref)
);

-- ---------------------------------------------------------------------------
-- Feature dependency. SOP §06.

CREATE TABLE IF NOT EXISTS leadflow_feature_dependency (
  dependency_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT,
  subject_ref   TEXT NOT NULL,
  capability    TEXT NOT NULL,

  -- available | in_development | roadmap | not_planned.
  --
  -- A ROADMAP PROMISE MAY NEVER SUBSTITUTE FOR AN EXIT CRITERION, which is why
  -- the status is stored rather than a boolean "blocker": the stage guard reads
  -- it and refuses to count anything but `available` as satisfied. Recording
  -- "we said we would build it" as though the capability existed is how a deal
  -- reaches Closed Won on a feature nobody has written.
  status        TEXT NOT NULL,
  promised_date DATE,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT leadflow_feature_dependency_status_known
    CHECK (status IN ('available','in_development','roadmap','not_planned')),
  CONSTRAINT leadflow_feature_dependency_once UNIQUE (tenant_id, subject_ref, capability)
);

CREATE INDEX IF NOT EXISTS idx_feature_dependency_subject
  ON leadflow_feature_dependency (tenant_id, subject_ref);
