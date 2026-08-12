-- 028 — Sequence enrolments, idempotent step execution, reactive stops and the
-- nurture track. SOP §08, §33, §47.
--
-- THE ACCEPTANCE CRITERION IS A UNIQUE CONSTRAINT. "Running the tick twice in
-- the same minute produces exactly one send per due step" cannot be achieved by
-- checking whether a step has run: two ticks a millisecond apart both read
-- "not sent" and both send. So a step execution is CLAIMED by INSERT against
-- UNIQUE (enrollment_id, step_number), and a refused insert means another tick
-- already owns it. Same shape as the escalation ladder and the detectors,
-- because it is the same problem.

CREATE TABLE IF NOT EXISTS leadflow_sequence_enrollment (
  enrollment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT,
  subject_ref   TEXT NOT NULL,
  sequence_key  TEXT NOT NULL,

  owner_user_id UUID,
  enrolled_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- active | paused | stopped | completed
  status        TEXT NOT NULL DEFAULT 'active',

  -- WHY IT STOPPED. Recorded on the enrolment rather than only in a log,
  -- because the first question about a stopped sequence is why, and a join to
  -- find out is a join somebody will forget.
  stop_reason   TEXT,
  stopped_at    TIMESTAMPTZ,

  -- The step the executor will consider next. Advanced only by a claimed
  -- execution, so a crashed tick cannot skip a step.
  next_step     INTEGER NOT NULL DEFAULT 1,

  completed_at  TIMESTAMPTZ,

  CONSTRAINT leadflow_sequence_enrollment_status_known
    CHECK (status IN ('active','paused','stopped','completed')),
  -- A stopped enrolment must say why. An unexplained stop is indistinguishable
  -- from a bug in the executor, which is exactly what somebody will assume.
  CONSTRAINT leadflow_sequence_enrollment_stop_has_reason
    CHECK (status <> 'stopped' OR (stop_reason IS NOT NULL AND length(btrim(stop_reason)) > 0)),
  -- One ACTIVE enrolment per subject per sequence. Two is a double send.
  CONSTRAINT leadflow_sequence_enrollment_once UNIQUE (tenant_id, subject_ref, sequence_key)
);

CREATE INDEX IF NOT EXISTS idx_sequence_enrollment_active
  ON leadflow_sequence_enrollment (tenant_id, status, next_step);

-- ---------------------------------------------------------------------------
-- One row per step actually executed. THE idempotence guarantee.

CREATE TABLE IF NOT EXISTS leadflow_sequence_execution (
  execution_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT,
  enrollment_id UUID NOT NULL REFERENCES leadflow_sequence_enrollment(enrollment_id) ON DELETE CASCADE,
  step_number   INTEGER NOT NULL,

  channel       TEXT NOT NULL,
  template_key  TEXT,
  -- The template VERSION actually sent. Without it, "what did this prospect
  -- receive" is answerable only if nobody has edited the template since.
  template_version INTEGER,

  -- Whether the send actually went out, as distinct from whether the step was
  -- claimed. A claimed step whose provider failed must not look like a send.
  dispatched    BOOLEAN NOT NULL DEFAULT FALSE,
  skipped_reason TEXT,

  next_action_id UUID,
  executed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT leadflow_sequence_execution_once UNIQUE (enrollment_id, step_number)
);

CREATE INDEX IF NOT EXISTS idx_sequence_execution_enrollment
  ON leadflow_sequence_execution (enrollment_id, step_number);

-- ---------------------------------------------------------------------------
-- The guard log: send windows, circuit breakers and every refusal.

CREATE TABLE IF NOT EXISTS leadflow_sequence_guard_log (
  log_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT,
  enrollment_id UUID,
  step_number   INTEGER,

  -- send_window | quiet_hours | circuit_open | eligibility | stop_rule
  guard         TEXT NOT NULL,
  outcome       TEXT NOT NULL,
  detail        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT leadflow_sequence_guard_outcome_known
    CHECK (outcome IN ('allowed','deferred','refused'))
);

CREATE INDEX IF NOT EXISTS idx_sequence_guard_recent
  ON leadflow_sequence_guard_log (tenant_id, created_at DESC);

-- The circuit breaker state per provider, so an outage stops the cadence
-- rather than burning every enrolment against a dead endpoint.
CREATE TABLE IF NOT EXISTS leadflow_sequence_circuit (
  circuit_key   TEXT PRIMARY KEY,
  tenant_id     TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  opened_at     TIMESTAMPTZ,
  -- NULL while open. Set when the breaker half-opens so a probe can run.
  retry_after   TIMESTAMPTZ,
  last_error    TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Nurture, segmented by REASON rather than by list. SOP §47.

CREATE TABLE IF NOT EXISTS leadflow_nurture_membership (
  membership_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT,
  subject_ref   TEXT NOT NULL,

  -- WHY they are in nurture, which decides the cadence. Segmenting by list
  -- instead produces one message stream for six different reasons, and the only
  -- thing that changes is the subject line.
  reason_segment TEXT NOT NULL,

  -- SOP §47: a no-fit record is not nurtured at all unless a SPECIFIC future
  -- change could create fit. Nullable for every other segment; required for
  -- no_fit_today by the CHECK below.
  future_change  TEXT,

  owner_user_id  UUID NOT NULL,
  entered_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  exited_at      TIMESTAMPTZ,
  exit_reason    TEXT,

  CONSTRAINT leadflow_nurture_reason_known CHECK (reason_segment IN (
    'timing_or_season','budget_or_approval','current_contract','product_gap',
    'trust_or_prelaunch','no_response','no_fit_today'
  )),
  -- The §47 rule, enforced rather than remembered: no_fit_today may only be
  -- nurtured when a specific future change is named.
  CONSTRAINT leadflow_nurture_no_fit_needs_change
    CHECK (reason_segment <> 'no_fit_today' OR (future_change IS NOT NULL AND length(btrim(future_change)) > 0)),
  -- AC2: one owner. NOT NULL above, and one live membership per subject here.
  CONSTRAINT leadflow_nurture_once UNIQUE (tenant_id, subject_ref)
);

CREATE INDEX IF NOT EXISTS idx_nurture_open
  ON leadflow_nurture_membership (tenant_id, exited_at, reason_segment);
