-- 019 — Risk-tiered auto-link policy and the daily dedup audit.
--
-- Two tables, both APPEND-ONLY, and that is the whole design rather than a
-- stylistic preference.
--
-- A risk profile decides which pairs of records get linked to each other
-- WITHOUT a human ever looking. Raising a threshold retroactively changes what
-- the system was willing to do on its own, and the question an auditor asks is
-- never "what is the threshold" — it is "what was the threshold WHEN this link
-- was made, and who set it". An UPDATE in place cannot answer that: it destroys
-- the only evidence that the rule used to be different. So a change inserts a
-- new version and supersedes the old one, and reverting inserts another version
-- rather than deleting anything.
--
-- Checked `.projexlight/schema/current-schema.json` (345 tables) before adding:
-- no identity/risk/calibration/dedup table exists in the shared reference, and
-- 011_canonical_dedupe covers lead-level dedupe indexes, not resolver policy.

-- ---------------------------------------------------------------------------
-- The tenant's auto-link policy, one row per version.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leadflow_identity_risk_profile (
  version_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         TEXT        NOT NULL,

  -- The confidence at or above which a match may link with no human involved.
  -- Mirrors sdk-identity-resolver's own high band (0.9) by default so a tenant
  -- that never tunes anything behaves exactly as the resolver expects.
  auto_link_threshold        NUMERIC(4,3) NOT NULL DEFAULT 0.900,

  -- The floor below which a candidate is not even worth a steward's time.
  review_floor               NUMERIC(4,3) NOT NULL DEFAULT 0.700,

  -- Deterministic paths that bypass the threshold entirely. A source crosswalk
  -- is an EXTERNAL SYSTEM asserting these are the same record, which is a fact
  -- about the data rather than an inference about the person.
  crosswalk_auto_links       BOOLEAN NOT NULL DEFAULT TRUE,

  -- Exact validated E.164 phone AND exact property, together, with nothing
  -- conflicting. Two strong deterministic signals agreeing is a different claim
  -- from one probabilistic score being high, which is why it is its own switch
  -- rather than a lower threshold.
  phone_and_property_auto_links BOOLEAN NOT NULL DEFAULT TRUE,

  -- ANY of these forces a case regardless of score. Not tunable to false: a
  -- conflicting email means the evidence disagrees with itself, and a system
  -- that auto-links through its own contradiction has stopped being evidence
  -- based. Stored so the row is self-describing to a later reader.
  conflict_forces_case       BOOLEAN NOT NULL DEFAULT TRUE,

  -- Free-form per-feature weights handed to POST /api/resolver/resolve.
  weights                    JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- WHO and WHY. A threshold change with no named author and no stated reason
  -- is indistinguishable from a mistake, and it is the first thing asked about
  -- after a bad link.
  created_by_user_id         UUID        NOT NULL,
  reason                     TEXT        NOT NULL,

  -- The version this one replaced, so the chain reads backwards without a
  -- separate history table. NULL on the first version a tenant ever has.
  supersedes_version_id      UUID REFERENCES leadflow_identity_risk_profile(version_id),

  -- Set when a LATER version takes over. The active version is the one row per
  -- tenant with this NULL — enforced by the partial unique index below rather
  -- than by application code, because two active profiles is a state no amount
  -- of careful writing can be trusted to prevent forever.
  superseded_at              TIMESTAMPTZ,

  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A review floor above the auto-link threshold would make every case both
  -- auto-linkable and below review, which is not a policy anyone means.
  CONSTRAINT risk_profile_bands_ordered CHECK (review_floor <= auto_link_threshold),
  CONSTRAINT risk_profile_threshold_range CHECK (auto_link_threshold BETWEEN 0 AND 1),
  CONSTRAINT risk_profile_floor_range CHECK (review_floor BETWEEN 0 AND 1),
  CONSTRAINT risk_profile_reason_present CHECK (length(btrim(reason)) > 0)
);

-- Exactly one live profile per tenant. Partial unique index rather than a
-- status column: the invariant is "at most one row with superseded_at NULL",
-- and expressing it in the index means a concurrent second activation fails at
-- the database instead of racing through two request handlers.
CREATE UNIQUE INDEX IF NOT EXISTS leadflow_identity_risk_profile_active_idx
  ON leadflow_identity_risk_profile (tenant_id)
  WHERE superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS leadflow_identity_risk_profile_history_idx
  ON leadflow_identity_risk_profile (tenant_id, created_at DESC);

COMMENT ON TABLE leadflow_identity_risk_profile IS
  'Versioned tenant auto-link policy. Append-only: a change inserts a new version and supersedes the previous one, so "what was the threshold when this link was made" stays answerable.';

-- ---------------------------------------------------------------------------
-- The daily dedup audit required by SOP §22.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leadflow_dedup_audit_run (
  run_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         TEXT        NOT NULL,

  -- The profile version in force when the audit ran. Without it a drift reading
  -- cannot be compared against a later one — the rates would have moved because
  -- somebody changed the policy, not because the resolver drifted.
  profile_version_id UUID REFERENCES leadflow_identity_risk_profile(version_id),

  -- The four rates the calibration report exposes. NULL means NOT MEASURED —
  -- upstream could not be reached — and is deliberately distinct from 0, which
  -- would read as "nothing auto-linked today" and is a very different fact.
  auto_link_rate      NUMERIC(5,4),
  false_link_rate     NUMERIC(5,4),
  kept_separate_rate  NUMERIC(5,4),
  high_risk_precision NUMERIC(5,4),

  -- sdk-identity-resolver's expected calibration error, carried verbatim.
  calibration_ece     NUMERIC(6,5),

  drift_detected    BOOLEAN     NOT NULL DEFAULT FALSE,
  -- Names WHICH measure drifted and by how much, so the case a steward opens
  -- says something more useful than "drift".
  drift_detail      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- The steward case this audit opened, when it opened one.
  case_link_id      TEXT,

  upstream_available BOOLEAN    NOT NULL DEFAULT FALSE,
  ran_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- THE AUDIT DAY, STORED RATHER THAN DERIVED, and explicitly in UTC.
  --
  -- `ran_at::date` cannot be indexed: casting a timestamptz to a date reads the
  -- session TimeZone, so the expression is not IMMUTABLE and Postgres refuses
  -- it. That refusal is pointing at a real question rather than being a
  -- technicality — "one audit per day" is meaningless until somebody says whose
  -- midnight, and a server that silently changed timezone would start allowing
  -- two audits for what a reader would call the same day.
  --
  -- UTC is chosen so the boundary never moves: a tenant-local day would shift
  -- twice a year under daylight saving, producing one 23-hour day that can hold
  -- two audits and one 25-hour day that can hold none.
  ran_on            DATE NOT NULL DEFAULT ((now() AT TIME ZONE 'UTC')::date)
);

-- One audit per tenant per UTC day. The sweep is idempotent on that day, so a
-- retry after a crash cannot double-open a Data Review case for the same day.
CREATE UNIQUE INDEX IF NOT EXISTS leadflow_dedup_audit_run_daily_idx
  ON leadflow_dedup_audit_run (tenant_id, ran_on);

CREATE INDEX IF NOT EXISTS leadflow_dedup_audit_run_recent_idx
  ON leadflow_dedup_audit_run (tenant_id, ran_at DESC);

COMMENT ON TABLE leadflow_dedup_audit_run IS
  'Daily dedup audit per SOP 22. A NULL rate means not measured (upstream unreachable), never zero. Unique per tenant per day so a retry cannot double-open a drift case.';
