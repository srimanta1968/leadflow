-- 022 — The governed case register the eight detectors write into.
--
-- IDEMPOTENCE IS A CONSTRAINT, NOT A CODE PATH. The acceptance criterion is
-- that re-running every detector never duplicates an open case, and the obvious
-- implementation — SELECT for an existing case, INSERT if absent — is a race
-- with itself the moment the scheduled run and an event-driven run overlap,
-- which is exactly the arrangement the task asks for. Two detectors evaluating
-- the same conflict a millisecond apart both find nothing and both insert.
--
-- So the guarantee lives in a PARTIAL UNIQUE INDEX over (tenant, type,
-- dedupe_key) WHERE status = 'open'. A second detector run does not check
-- anything; it INSERTs and the database refuses. That also gives the property
-- the naive version cannot: a case that was RESOLVED can be opened again later
-- if the problem comes back, because a resolved row is outside the index. A
-- unique constraint over all rows would silently make every problem
-- once-per-lifetime.
--
-- Checked `.projexlight/schema/current-schema.json` before adding: it carries
-- 29 leadflow_* tables and none of them is a review, case or detector table.
-- sdk-incident owns PLATFORM incidents and the Data Review screen already reads
-- them; this register is the LOCAL detector state, which has to be writable and
-- deduplicable within one tick whether or not that upstream is reachable.

-- ---------------------------------------------------------------------------
-- One open question about one entity.

CREATE TABLE IF NOT EXISTS leadflow_review_case (
  case_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT NOT NULL,

  -- One of the eight keys in features/dataReview/caseTypes.ts. Not an enum
  -- type: the eight are a product decision that will change, and an ALTER TYPE
  -- to add a ninth locks the table on a system that is meant to keep detecting.
  case_type     TEXT NOT NULL,

  -- WHAT MAKES TWO FINDINGS THE SAME FINDING. Computed by the detector from the
  -- stable identity of the conflict — the pair of person ids, the handle whose
  -- values disagree, the attestation that expired — and never from anything
  -- that moves. A key that included a timestamp or a score would make every run
  -- produce a "new" case for a problem nobody fixed, which is the failure this
  -- whole table exists to prevent.
  dedupe_key    TEXT NOT NULL,

  risk          TEXT NOT NULL DEFAULT 'medium',

  -- The thing the case is ABOUT, and a human-readable label for the queue.
  entity_ref    TEXT NOT NULL,
  entity_label  TEXT,

  -- One sentence stating the problem. Written by the detector, in the language
  -- the queue displays, so the screen never has to compose prose from columns.
  issue         TEXT NOT NULL,

  -- WHERE THE CLAIM COMES FROM (AC2). An array of {kind, ref, detail} pointing
  -- at the assertions, receipts or attestations the detector actually read. A
  -- case with no evidence is an accusation, and a steward asked to act on one
  -- has nothing to check before they do.
  evidence      JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- WHAT TO DO, AND HOW TO UNDO IT (AC2). {action, description, reversible,
  -- reversal}. `reversible` is stored rather than inferred because a remediation
  -- nobody can walk back is a different kind of decision and the screen must be
  -- able to say so BEFORE the click, not after.
  remediation   JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- The ROLE, never a person (AC4). Who holds that role is resolved through the
  -- policy bundle at read time; a name written here would put a case on the
  -- desk of somebody who may have left.
  owner_role    TEXT NOT NULL,

  status        TEXT NOT NULL DEFAULT 'open',

  -- Which run produced this, so a detector that starts over-reporting can be
  -- traced to the run where the behaviour changed.
  detector_run_id UUID,

  opened_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ,
  resolution    TEXT,

  CONSTRAINT leadflow_review_case_status_known
    CHECK (status IN ('open', 'resolved', 'dismissed')),
  CONSTRAINT leadflow_review_case_risk_known
    CHECK (risk IN ('high', 'medium', 'low')),
  -- A resolved row must say WHEN. Without this a resolution with a null
  -- timestamp reads as still open to every query that filters on resolved_at.
  CONSTRAINT leadflow_review_case_resolved_is_stamped
    CHECK ((status = 'open') = (resolved_at IS NULL))
);

-- AC1, and the whole point of this migration. Partial on status='open' so a
-- recurrence after a resolution can legitimately open a new case.
CREATE UNIQUE INDEX IF NOT EXISTS leadflow_review_case_open_unique
  ON leadflow_review_case (tenant_id, case_type, dedupe_key)
  WHERE status = 'open';

-- The queue reads open cases by type and by risk, newest deadline first.
CREATE INDEX IF NOT EXISTS leadflow_review_case_open_by_type
  ON leadflow_review_case (tenant_id, status, case_type, opened_at DESC);

CREATE INDEX IF NOT EXISTS leadflow_review_case_by_entity
  ON leadflow_review_case (tenant_id, entity_ref);

-- ---------------------------------------------------------------------------
-- Every detector pass, scheduled or event-driven.

CREATE TABLE IF NOT EXISTS leadflow_detector_run (
  run_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT NOT NULL,

  -- Which detector, or 'all' for a full sweep.
  detector      TEXT NOT NULL,

  -- WHY IT RAN (AC3). 'schedule' for the sweep, 'event' for a domain event,
  -- 'manual' for an operator. Recorded because "the detector has not opened a
  -- case in two days" has two completely different explanations — nothing is
  -- wrong, or nothing has run — and no other column can tell them apart.
  trigger       TEXT NOT NULL,

  -- The event that provoked it, when there was one.
  trigger_ref   TEXT,

  -- What the pass did. `cases_opened` is the number that ACTUALLY INSERTED;
  -- `cases_suppressed` is the number the unique index refused because the case
  -- was already open. The second is the idempotence working, so it is counted
  -- rather than discarded — a run that suppressed everything it found is a
  -- healthy re-run, and a run that opened everything it found twice would be
  -- visible here first.
  cases_found      INTEGER NOT NULL DEFAULT 0,
  cases_opened     INTEGER NOT NULL DEFAULT 0,
  cases_suppressed INTEGER NOT NULL DEFAULT 0,
  cases_resolved   INTEGER NOT NULL DEFAULT 0,

  -- Which upstreams answered. A detector that could not read its source found
  -- nothing because it could not look, which is not the same as finding nothing.
  upstream_available JSONB NOT NULL DEFAULT '{}'::jsonb,

  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,

  CONSTRAINT leadflow_detector_run_trigger_known
    CHECK (trigger IN ('schedule', 'event', 'manual'))
);

CREATE INDEX IF NOT EXISTS leadflow_detector_run_recent
  ON leadflow_detector_run (tenant_id, detector, started_at DESC);
