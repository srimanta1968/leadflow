-- 031 — Audience segments over the governed dimensions, and the KPI definition
-- registry. SOP §20, §22, §29.
--
-- Checked the existing leadflow_* tables first. sdk-campaign owns the CANONICAL
-- segment and sdk-analytics owns the dataset; what is local is the GOVERNANCE
-- LeadFlow must be able to answer from even when those are unreachable — which
-- purposes a segment claims, who may be in it, and what the number on a
-- dashboard is supposed to mean.

CREATE TABLE IF NOT EXISTS leadflow_segment_definition (
  segment_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT,
  segment_key   TEXT NOT NULL,
  version       INTEGER NOT NULL,

  name          TEXT NOT NULL,
  -- THE PURPOSE AND CHANNEL ARE PART OF THE DEFINITION, not of the send. A
  -- segment built for project operations and later reused for marketing SMS is
  -- how a licensed record ends up in an audience its source rights forbid; if
  -- the purpose is a property of the segment, that reuse is a NEW segment which
  -- gets its own eligibility pass.
  purpose_key   TEXT NOT NULL,
  channel       TEXT NOT NULL,

  -- The governed dimensions this segment filters on: trust state, origin class,
  -- permitted uses, consent, suppression, engagement recency, score, stage.
  criteria      JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_by    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_at TIMESTAMPTZ,

  CONSTRAINT leadflow_segment_version_once UNIQUE (tenant_id, segment_key, version),
  CONSTRAINT leadflow_segment_channel_known
    CHECK (channel IN ('email','sms','voice','in_app','any'))
);

-- One current version per segment key. A definition is IMMUTABLE once written
-- and an edit produces a new version, because an audience computed last week
-- must stay explainable against the definition that produced it.
CREATE UNIQUE INDEX IF NOT EXISTS leadflow_segment_one_current
  ON leadflow_segment_definition (tenant_id, segment_key) WHERE superseded_at IS NULL;

-- ---------------------------------------------------------------------------
-- The audience snapshot, captured at RUN START.

CREATE TABLE IF NOT EXISTS leadflow_audience_snapshot (
  snapshot_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT,
  segment_id    UUID NOT NULL,
  -- The version that produced it, denormalised. The join would give the same
  -- answer today; it would give a DIFFERENT answer after the segment is
  -- superseded, and "who was in this audience and under what rule" must not
  -- change retroactively.
  segment_key   TEXT NOT NULL,
  segment_version INTEGER NOT NULL,
  purpose_key   TEXT NOT NULL,
  channel       TEXT NOT NULL,

  captured_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The members, and the ones who were CONSIDERED AND REFUSED with the reason.
  -- Storing only the members answers "who did we message"; storing the refusals
  -- answers "why was this person not messaged", which is the question a consent
  -- complaint or a rights audit actually asks.
  eligible_count   INTEGER NOT NULL DEFAULT 0,
  excluded_count   INTEGER NOT NULL DEFAULT 0,
  members       JSONB NOT NULL DEFAULT '[]'::jsonb,
  exclusions    JSONB NOT NULL DEFAULT '[]'::jsonb,
  breakdown     JSONB NOT NULL DEFAULT '{}'::jsonb,
  computed_by   UUID
);

CREATE INDEX IF NOT EXISTS idx_audience_snapshot_segment
  ON leadflow_audience_snapshot (segment_id, captured_at DESC);

-- ---------------------------------------------------------------------------
-- The KPI definition registry. SOP §22 "Metrics disagree across dashboards".

-- NOT leadflow_kpi_definition. That name is already taken by the DISPLAY table
-- in migration 015 — kpi_key, label, unit, higher_is_better, target — which
-- answers "how do I render this tile", a different question from "what does this
-- number mean and who owns the answer".
--
-- Extending 015's table would have meant adding six NOT NULL columns to rows
-- that are legitimately display-only, and superseding a row would take its
-- LABEL out of circulation along with its definition. So this is a separate
-- table joined on the key, and 015's stays what it is.
CREATE TABLE IF NOT EXISTS leadflow_kpi_registry (
  kpi_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT,
  metric_key    TEXT NOT NULL,
  version       INTEGER NOT NULL,

  -- EVERY ONE OF THESE IS MANDATORY, and that is the whole point. Two dashboards
  -- disagree because one counts leads by created_at and the other by
  -- first_response_at, or because one divides by all leads and the other by
  -- contactable ones. A registry that records only a name and a number records
  -- exactly the fields on which they already agreed.
  plain_language TEXT NOT NULL,
  event_timestamps TEXT NOT NULL,
  source_of_truth  TEXT NOT NULL,
  filter_clause    TEXT NOT NULL,
  denominator      TEXT NOT NULL,

  owner_user_id UUID NOT NULL,
  lineage_ref   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    UUID,
  change_reason TEXT,
  superseded_at TIMESTAMPTZ,

  CONSTRAINT leadflow_kpi_version_once UNIQUE (tenant_id, metric_key, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS leadflow_kpi_one_current
  ON leadflow_kpi_registry (tenant_id, metric_key) WHERE superseded_at IS NULL;

-- Dashboard tiles, and the definition each one claims. The registry is only
-- enforceable if the tiles are declared somewhere a gate can read them.
CREATE TABLE IF NOT EXISTS leadflow_kpi_tile (
  tile_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT,
  dashboard_key TEXT NOT NULL,
  tile_key      TEXT NOT NULL,
  -- NOT NULL, deliberately. A tile with no registered definition is precisely
  -- the thing the build gate refuses, and allowing the row to exist without one
  -- would move the check from the schema to whoever remembers to run it.
  metric_key    TEXT NOT NULL,
  displayed_value NUMERIC,
  displayed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT leadflow_kpi_tile_once UNIQUE (tenant_id, dashboard_key, tile_key)
);

CREATE INDEX IF NOT EXISTS idx_kpi_tile_metric ON leadflow_kpi_tile (metric_key);
