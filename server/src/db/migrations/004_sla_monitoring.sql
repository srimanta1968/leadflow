-- 004 — SLA monitoring observations.
--
-- STRICTLY ADDITIVE. `sla_metrics` is declared in
-- .projexlight/schemas/user-defined-schemas.sql, so this migration must not
-- recreate or redefine it (MUSTNOT-04) — it only adds the columns the SLA
-- monitor needs to record an observation that can be analysed and audited.
--
-- Note on the two pre-existing columns this migration deliberately leaves
-- untouched, following the precedent set by 003 for
-- `routing_rules.assigned_representative`:
--
--   * `sla_metrics.lead_id` is INTEGER, while `leads.id` is UUID, so it cannot
--     reference a lead. `subject_lead_id UUID` is added alongside as the column
--     the application actually uses. Retyping the original would be a
--     destructive change to a schema this project does not own.
--   * `sla_metrics.response_time` is VARCHAR and its meaning is unstated.
--     `response_seconds INTEGER` is added as the numeric field every rollup and
--     average reads. The application still writes `response_time` as an
--     ISO-8601 duration so anything already reading that column keeps working.
--   * `sla_metrics.violation` defaults to TRUE — a default that would record a
--     violation for any row inserted without the column. The default is left
--     as-is rather than altered, and the application ALWAYS writes `violation`
--     explicitly so the default is never what decides a compliance number.

ALTER TABLE sla_metrics ADD COLUMN IF NOT EXISTS subject_lead_id UUID REFERENCES leads (id);

-- What the monitor measured. Response time is measured from the lead's
-- created_at — the moment the prospect submitted — not from assignment.
ALTER TABLE sla_metrics ADD COLUMN IF NOT EXISTS response_seconds INTEGER;
ALTER TABLE sla_metrics ADD COLUMN IF NOT EXISTS target_minutes INTEGER;
ALTER TABLE sla_metrics ADD COLUMN IF NOT EXISTS state VARCHAR(20);
ALTER TABLE sla_metrics ADD COLUMN IF NOT EXISTS breach_reason VARCHAR(60);
ALTER TABLE sla_metrics ADD COLUMN IF NOT EXISTS responded_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE sla_metrics ADD COLUMN IF NOT EXISTS response_channel VARCHAR(40);
ALTER TABLE sla_metrics ADD COLUMN IF NOT EXISTS responded_by_user_id UUID REFERENCES users (id);
ALTER TABLE sla_metrics ADD COLUMN IF NOT EXISTS note TEXT;

-- Provenance of the verdict: which clock produced it, when, and under which
-- correlation id upstream. Without this a compliance number cannot be defended,
-- because a wall-clock verdict and a business-calendar verdict are not the same
-- measurement and must never be averaged together silently.
ALTER TABLE sla_metrics ADD COLUMN IF NOT EXISTS clock_source VARCHAR(20);
ALTER TABLE sla_metrics ADD COLUMN IF NOT EXISTS observed_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE sla_metrics ADD COLUMN IF NOT EXISTS correlation_id UUID;

COMMENT ON COLUMN sla_metrics.subject_lead_id IS
  'The lead this observation is about. Added because the pre-existing lead_id column is INTEGER and cannot reference leads.id (UUID); that column is retained untouched.';
COMMENT ON COLUMN sla_metrics.response_seconds IS
  'Seconds from lead arrival (leads.created_at) to the first human response. Measured from arrival, not assignment: the prospect has been waiting since they submitted.';
COMMENT ON COLUMN sla_metrics.state IS
  'Clock outcome: on_track, at_risk, breached or met.';
COMMENT ON COLUMN sla_metrics.clock_source IS
  'Which clock produced the verdict: sdk_sla (the ProjexCloud business-calendar clock) or local_wallclock (LeadFlow''s fallback during a gateway outage).';

-- One observation row per lead, so the monitor upserts rather than accumulating
-- a row per sweep. Compliance is a property of the lead's clock, not of how many
-- times the sweep happened to run — without this the average response time
-- would drift every time a sweep re-observed the same lead.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sla_metrics_subject_lead
  ON sla_metrics (subject_lead_id) WHERE subject_lead_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sla_metrics_state ON sla_metrics (state);
CREATE INDEX IF NOT EXISTS idx_sla_metrics_observed_at ON sla_metrics (observed_at DESC);
