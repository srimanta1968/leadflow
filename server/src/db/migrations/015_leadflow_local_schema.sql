-- 015 — LeadFlow's own tables, and only LeadFlow's own tables.
--
-- WHAT THIS MIGRATION IS FOR. LeadFlow holds no horizontal capability: contact,
-- consent, assignment, SLA evaluation, sequences, appointments, payments and the
-- audit ledger all live in ProjexCloud SDKs, and duplicating any of them locally
-- would create a second system of record that drifts silently. What is left is
-- genuinely LeadFlow's: the operator-facing configuration that describes THIS
-- vertical, the projections a screen reads so it does not fan out into per-row
-- SDK calls, and the outbox that makes a cross-system write recoverable.
--
-- Every table here is prefixed `leadflow_` so the boundary is visible in a
-- `\dt` listing rather than needing a document to explain it, and so
-- tests/unit/verticalNeutrality.test.ts can assert it mechanically.
--
-- ADDITIVE AND IDEMPOTENT. Every statement is IF NOT EXISTS; the file is safe to
-- re-run, which the migration runner does not need but a partially-applied
-- environment does. An applied migration is never edited — a correction ships as
-- a new file.
--
-- THE VALUES ARE NOT HERE. Stage names, disposition codes, close reasons and KPI
-- targets are seeded from src/config/verticalProfile.ts at boot, not written
-- into this DDL. Putting them in the migration would make the next vertical a
-- schema change instead of a config change, which is the whole point of the
-- split.

-- ---------------------------------------------------------------- stages
-- The ten SOP §06 stages, with the guardrails the incumbent system had none of:
-- entry and exit evidence, a staleness window, and an explicit list of onward
-- stages so an invalid move can be refused rather than recorded.
CREATE TABLE IF NOT EXISTS leadflow_stage_config (
  stage_key                 TEXT PRIMARY KEY,
  position                  INTEGER NOT NULL,
  label                     TEXT NOT NULL,
  entry_evidence            JSONB NOT NULL DEFAULT '[]'::jsonb,
  exit_evidence             JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- NULL means ageing is meaningless here, not "never stale by oversight".
  -- Nurture and the closed stages are the deliberate cases.
  stale_after_business_days INTEGER,
  allowed_next              JSONB NOT NULL DEFAULT '[]'::jsonb,
  terminal                  BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS leadflow_stage_config_position_idx
  ON leadflow_stage_config (position);

-- ---------------------------------------------------------- dispositions
CREATE TABLE IF NOT EXISTS leadflow_disposition_code (
  code_key              TEXT PRIMARY KEY,
  label                 TEXT NOT NULL,
  channel               TEXT NOT NULL,
  -- The two booleans are what stage entry evidence is computed from: an attempt
  -- is not a connection, and only a connection lets a record start qualifying.
  counts_as_attempt     BOOLEAN NOT NULL DEFAULT TRUE,
  counts_as_connection  BOOLEAN NOT NULL DEFAULT FALSE,
  retired_at            TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------- close reasons
CREATE TABLE IF NOT EXISTS leadflow_close_reason (
  reason_key   TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  outcome      TEXT NOT NULL,
  -- Whether the record may come back through Nurture. "Price" can; "asked not
  -- to be contacted" must not, and encoding that here keeps the re-engagement
  -- query from having to know which is which.
  revisitable  BOOLEAN NOT NULL DEFAULT FALSE,
  retired_at   TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -------------------------------------------------------- template library
-- Message templates LeadFlow OWNS. The SENDING is sdk-notification's and the
-- consent check is sdk-consent's; what is local is the wording an operator
-- edits without a deploy, and the approval state that says it may be used.
CREATE TABLE IF NOT EXISTS leadflow_template_library (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_key  TEXT NOT NULL,
  channel       TEXT NOT NULL,
  subject       TEXT,
  body          TEXT NOT NULL,
  -- The purpose this template may be sent under. A template with no purpose
  -- cannot be consent-checked, so it cannot be sent.
  purpose_key   TEXT NOT NULL,
  locale        TEXT NOT NULL DEFAULT 'en-US',
  approved_at   TIMESTAMPTZ,
  approved_by   TEXT,
  retired_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS leadflow_template_library_key_idx
  ON leadflow_template_library (template_key, channel, locale)
  WHERE retired_at IS NULL;

-- ------------------------------------------------------------ saved views
-- A saved view stores a QUESTION, never an answer. The filter definition is
-- re-run on open; a stored result set says "5" forever while the queue moves on.
CREATE TABLE IF NOT EXISTS leadflow_saved_view (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    UUID,
  name        TEXT NOT NULL,
  subject     TEXT NOT NULL,
  filters     JSONB NOT NULL DEFAULT '[]'::jsonb,
  sort        JSONB,
  -- NULL owner means it ships with the product and everybody gets it, which is
  -- why built-ins are not written per user.
  shared      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS leadflow_saved_view_owner_idx
  ON leadflow_saved_view (owner_id);

-- ------------------------------------------------------ dashboard rollups
-- Precomputed dashboard numbers. A ROLLUP, not a source: every row records the
-- window it covers and when it was computed, so a stale panel can say so instead
-- of presenting yesterday's number as today's.
CREATE TABLE IF NOT EXISTS leadflow_dashboard_rollup (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kpi_key       TEXT NOT NULL,
  scope         TEXT NOT NULL,
  scope_id      TEXT,
  window_start  TIMESTAMPTZ NOT NULL,
  window_end    TIMESTAMPTZ NOT NULL,
  value         NUMERIC,
  sample_size   INTEGER NOT NULL DEFAULT 0,
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS leadflow_dashboard_rollup_slot_idx
  ON leadflow_dashboard_rollup (
    kpi_key, scope, COALESCE(scope_id, ''), window_start, window_end
  );

-- ---------------------------------------------------------- KPI definitions
CREATE TABLE IF NOT EXISTS leadflow_kpi_definition (
  kpi_key           TEXT PRIMARY KEY,
  label             TEXT NOT NULL,
  unit              TEXT NOT NULL,
  -- Meaning, not colour. Response time going UP is bad; captures going up is
  -- good. Without this the arrow is green on half the tiles.
  higher_is_better  BOOLEAN NOT NULL DEFAULT TRUE,
  target            NUMERIC,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------ certification scores
-- Whether a representative is signed off to work a given lead type. LOCAL
-- because it is this customer's competency model, not a platform concept.
CREATE TABLE IF NOT EXISTS leadflow_certification_score (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id     UUID NOT NULL,
  competency_key TEXT NOT NULL,
  score          NUMERIC NOT NULL,
  assessed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  assessed_by    TEXT,
  -- An expiry rather than a boolean: a certification that never lapses stops
  -- meaning anything, and routing needs to know whether it is current TODAY.
  expires_at     TIMESTAMPTZ,
  evidence_ref   TEXT
);

CREATE INDEX IF NOT EXISTS leadflow_certification_score_subject_idx
  ON leadflow_certification_score (subject_id, competency_key);

-- --------------------------------------------------- operating rhythm digest
-- The daily/weekly management digest SOP §22 requires. Stored rather than only
-- emailed, because "was the Monday review actually produced?" is a question the
-- customer asks and an outbound message cannot answer.
CREATE TABLE IF NOT EXISTS leadflow_operating_rhythm_digest (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cadence       TEXT NOT NULL,
  period_start  TIMESTAMPTZ NOT NULL,
  period_end    TIMESTAMPTZ NOT NULL,
  audience      TEXT NOT NULL,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at  TIMESTAMPTZ,
  delivery_ref  TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS leadflow_operating_rhythm_digest_period_idx
  ON leadflow_operating_rhythm_digest (cadence, audience, period_start, period_end);

-- ------------------------------------------------- purpose taxonomy mapping
-- Maps LeadFlow's vertical wording onto the consent purpose keys ProjexCloud
-- governs. The KEY is shared and must never be rewritten — a stored consent
-- record refers to it — so re-wording for a new vertical changes the LABEL here
-- and nothing else.
CREATE TABLE IF NOT EXISTS leadflow_purpose_taxonomy_map (
  purpose_key   TEXT PRIMARY KEY,
  display_label TEXT NOT NULL,
  elective      BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------- routing config
-- The knobs an operator turns. The ROUTING DECISION is sdk-assignment's; what
-- is local is the tenant's preference about how it should decide.
CREATE TABLE IF NOT EXISTS leadflow_routing_config (
  config_key   TEXT PRIMARY KEY,
  value        JSONB NOT NULL,
  description  TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by   TEXT
);

-- ----------------------------------------------------------------- outbox
-- The transactional outbox for cross-system writes.
--
-- WHY IT EXISTS. A local write and a ProjexCloud write cannot share a
-- transaction, so a crash between them loses one of the two — silently, and in
-- the direction that matters most (we recorded a lead nobody upstream knows
-- about). Writing the INTENT locally in the same transaction as the local change
-- makes the pair recoverable: the dispatcher retries until the SDK acknowledges.
--
-- idempotency_key is NOT NULL because a retry that presents a new key is not a
-- retry, it is a second write. The gateway reuses whatever is stored here.
CREATE TABLE IF NOT EXISTS leadflow_outbox (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sdk              TEXT NOT NULL,
  method           TEXT NOT NULL,
  path             TEXT NOT NULL,
  payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key  TEXT NOT NULL,
  correlation_id   TEXT,
  causation_id     TEXT,
  status           TEXT NOT NULL DEFAULT 'pending',
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  -- When the dispatcher may next try. Backoff lives in the row so a restart
  -- does not reset every pending entry to "try immediately" at once.
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dispatched_at    TIMESTAMPTZ
);

-- One row per intention. A duplicate key is the same intention arriving twice
-- and must not become a second dispatch.
CREATE UNIQUE INDEX IF NOT EXISTS leadflow_outbox_idempotency_idx
  ON leadflow_outbox (idempotency_key);

-- The dispatcher's only query: what is due, oldest first. Partial so the index
-- stays small as dispatched rows accumulate.
CREATE INDEX IF NOT EXISTS leadflow_outbox_due_idx
  ON leadflow_outbox (next_attempt_at)
  WHERE status = 'pending';
