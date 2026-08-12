-- 032 — The operating rhythm (digests and their required outputs), workflow
-- versioning with dry runs, and the failure runbook with its dead-letter queue.
-- SOP §20, §21, §26, §29; PRD §12.

-- REUSING migration 015's leadflow_operating_rhythm_digest rather than creating
-- a second digest table. 015 already holds cadence, audience, period, payload
-- and the delivery stamp, and the task instruction names that table by name.
-- What it lacks is the RHYTHM IDENTITY (which of the nine reviews this is), the
-- business date in the named zone, and the template version — so those are
-- added here and the columns already there are left alone.
ALTER TABLE leadflow_operating_rhythm_digest ADD COLUMN IF NOT EXISTS tenant_id        TEXT;
ALTER TABLE leadflow_operating_rhythm_digest ADD COLUMN IF NOT EXISTS rhythm_key       TEXT;
-- The America/Chicago local date the digest is FOR, not when the row was
-- written. A run that fires late must still be the 8:45am huddle pack.
ALTER TABLE leadflow_operating_rhythm_digest ADD COLUMN IF NOT EXISTS business_date    DATE;
ALTER TABLE leadflow_operating_rhythm_digest ADD COLUMN IF NOT EXISTS scheduled_local  TEXT;
ALTER TABLE leadflow_operating_rhythm_digest ADD COLUMN IF NOT EXISTS template_key     TEXT;
ALTER TABLE leadflow_operating_rhythm_digest ADD COLUMN IF NOT EXISTS template_version INTEGER NOT NULL DEFAULT 1;

-- ONE DIGEST PER RHYTHM PER BUSINESS DAY. The generator runs on a timer and two
-- ticks inside the same window would otherwise produce two huddle packs with
-- different numbers, which is worse than one late pack because now nobody knows
-- which one the meeting is working from.
--
-- PARTIAL, so it constrains only rows this feature writes. 015's existing rows
-- have no rhythm_key and must stay valid — a NOT NULL or a total unique index
-- would fail the migration against any database that already has digests in it.
CREATE UNIQUE INDEX IF NOT EXISTS leadflow_rhythm_digest_once
  ON leadflow_operating_rhythm_digest (tenant_id, rhythm_key, business_date)
  WHERE rhythm_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_digest_recent
  ON leadflow_operating_rhythm_digest (tenant_id, business_date DESC);

-- The REQUIRED OUTPUT of each review, tracked to completion.
--
-- This is the difference between a reminder and a rhythm. "Send the 11:30 sweep"
-- is a notification; "the 11:30 sweep produces reassignments, capacity fixes and
-- coaching moments, and somebody is accountable for each" is the SOP. A digest
-- with no tracked output is a message people learn to skim.
CREATE TABLE IF NOT EXISTS leadflow_digest_output (
  output_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT,
  -- References leadflow_operating_rhythm_digest.id.
  digest_id     UUID NOT NULL,
  output_key    TEXT NOT NULL,
  description   TEXT NOT NULL,

  owner_user_id UUID,
  due_at        TIMESTAMPTZ NOT NULL,
  completed_at  TIMESTAMPTZ,
  completed_by  UUID,
  completion_note TEXT,

  -- Set when the output was still open past its due time and the manager was
  -- told. Stamped once, by an UPDATE ... WHERE escalated_at IS NULL: a manager
  -- who gets the same escalation on every sweep stops reading them.
  escalated_at  TIMESTAMPTZ,

  CONSTRAINT leadflow_digest_output_once UNIQUE (digest_id, output_key)
);

CREATE INDEX IF NOT EXISTS idx_digest_output_open
  ON leadflow_digest_output (tenant_id, completed_at, due_at);

-- ---------------------------------------------------------------------------
-- Workflow versions, dry runs and publishes. PRD §12.

CREATE TABLE IF NOT EXISTS leadflow_workflow_version (
  workflow_version_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT,
  workflow_key  TEXT NOT NULL,
  version       INTEGER NOT NULL,
  definition    JSONB NOT NULL,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    UUID,

  -- A version reaches production only with BOTH a passing dry run and a
  -- recorded approval. Two separate columns rather than one published flag,
  -- because "published without a dry run" and "published without an approval"
  -- are different failures with different owners, and one flag cannot tell an
  -- auditor which happened.
  dry_run_id    UUID,
  approval_ref  TEXT,
  published_at  TIMESTAMPTZ,
  published_by  UUID,
  rolled_back_at TIMESTAMPTZ,
  rollback_of   UUID,

  CONSTRAINT leadflow_workflow_version_once UNIQUE (tenant_id, workflow_key, version),
  -- The gate, at the row level. A publish with no dry run cannot be recorded
  -- even by a writer that forgets to check.
  CONSTRAINT leadflow_workflow_publish_is_gated
    CHECK (published_at IS NULL OR (dry_run_id IS NOT NULL AND approval_ref IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS leadflow_workflow_one_live
  ON leadflow_workflow_version (tenant_id, workflow_key)
  WHERE published_at IS NOT NULL AND rolled_back_at IS NULL;

CREATE TABLE IF NOT EXISTS leadflow_workflow_dry_run (
  dry_run_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT,
  workflow_key  TEXT NOT NULL,
  candidate_version INTEGER NOT NULL,

  window_from   TIMESTAMPTZ NOT NULL,
  window_to     TIMESTAMPTZ NOT NULL,
  records_replayed INTEGER NOT NULL DEFAULT 0,

  -- What WOULD have happened. Counted per effect class rather than as one total,
  -- because "412 things would have happened" tells a reviewer nothing and
  -- "308 messages would have sent" stops the publish.
  would_send    INTEGER NOT NULL DEFAULT 0,
  would_create_task INTEGER NOT NULL DEFAULT 0,
  would_change_stage INTEGER NOT NULL DEFAULT 0,
  would_suppress INTEGER NOT NULL DEFAULT 0,
  sla_outcomes  JSONB NOT NULL DEFAULT '{}'::jsonb,
  sample        JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Proof of the zero-side-effect property, asserted by the runner itself: any
  -- attempt to leave the simulation is counted here and fails the run.
  side_effects_attempted INTEGER NOT NULL DEFAULT 0,
  passed        BOOLEAN NOT NULL DEFAULT FALSE,
  ran_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  ran_by        UUID
);

CREATE INDEX IF NOT EXISTS idx_dry_run_workflow
  ON leadflow_workflow_dry_run (tenant_id, workflow_key, ran_at DESC);

-- ---------------------------------------------------------------------------
-- The failure runbook. SOP §21, §29.

CREATE TABLE IF NOT EXISTS leadflow_failure_event (
  failure_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT,
  -- One of the six documented modes. A free string would let a new failure be
  -- logged under a name nothing has a fallback for, which is the same as not
  -- logging it.
  failure_mode  TEXT NOT NULL,
  source_ref    TEXT,
  -- THE ORIGINAL EVENT ID IS RETAINED, always. A connector outage that loses it
  -- makes the backfill produce duplicates, because nothing can tell which events
  -- already landed.
  original_event_id TEXT,
  payload       JSONB,

  detected_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Exactly one retry for a provider failure, counted here rather than inferred.
  retry_count   INTEGER NOT NULL DEFAULT 0,
  fallback_taken TEXT,
  fallback_ref  TEXT,
  owner_role    TEXT NOT NULL,
  resolved_at   TIMESTAMPTZ,
  resolution    TEXT,

  CONSTRAINT leadflow_failure_mode_known CHECK (failure_mode IN (
    'connector_down','provider_send_failure','calendar_sync_failure',
    'payment_webhook_missing','duplicate_send_loop','timezone_or_holiday_rule'
  )),
  -- The replay key. A DLQ item replayed twice must produce one outcome, and the
  -- only way to guarantee that across concurrent replays is to let the database
  -- refuse the second insert.
  CONSTRAINT leadflow_failure_once UNIQUE (tenant_id, failure_mode, original_event_id)
);

CREATE INDEX IF NOT EXISTS idx_failure_open
  ON leadflow_failure_event (tenant_id, resolved_at, detected_at DESC);

CREATE TABLE IF NOT EXISTS leadflow_kill_switch (
  switch_key    TEXT NOT NULL,
  tenant_id     TEXT,
  engaged       BOOLEAN NOT NULL DEFAULT FALSE,
  engaged_at    TIMESTAMPTZ,
  engaged_by    UUID,
  reason        TEXT,
  released_at   TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, switch_key)
);

-- ---------------------------------------------------------------------------
-- Attribution: the LATEST source alongside the original. SOP §20.
--
-- Two columns, not one. `leads.source` is the ORIGINAL and must never move —
-- overwriting it on a later touch is how a paid channel quietly takes credit for
-- an organic lead. The latest touch is a separate fact and a separate column,
-- so both survive to closed-won and the report can show either.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS latest_source     VARCHAR(255);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS latest_source_at  TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS latest_campaign_id VARCHAR(255);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS touch_count       INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS leads_latest_source_idx
  ON leads (latest_source, created_at DESC) WHERE latest_source IS NOT NULL;

COMMENT ON COLUMN leads.latest_source IS
  'The most recent touch. Separate from leads.source, which is the ORIGINAL and never moves — overwriting it is how a paid channel takes credit for an organic lead.';
