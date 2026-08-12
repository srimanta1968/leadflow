-- 025 — The escalation ladder's fire ledger, valid human attempts, and breaches.
-- SOP §04, §05, §21, §30.
--
-- A DUPLICATED TICK MUST NOT DOUBLE-ALERT, and that is a uniqueness problem, not
-- a scheduling one. Ticks arrive from a timer, from a webhook and from an
-- operator, and two of them landing on the same lead a millisecond apart both
-- read "T+15 has not fired" and both send. So the ledger carries a UNIQUE
-- constraint on (lead_id, rung) and the ladder INSERTs rather than checking: the
-- second insert is refused by the database, and a refused insert means somebody
-- else already alerted.

CREATE TABLE IF NOT EXISTS leadflow_escalation_fire (
  fire_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   TEXT,
  lead_id     UUID NOT NULL,

  -- T+0, T+1, T+5, T+15, T+25, T+30, T+45 as minute offsets.
  rung        INTEGER NOT NULL,

  -- Who was told. Kept because "the manager was never warned" and "the manager
  -- was warned and did nothing" are different failures with different fixes.
  audience    TEXT NOT NULL,
  channels    JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Measured from the SOURCE timestamp, so a reassigned lead does not restart
  -- its ladder. Recorded per fire so the offset is auditable after the fact.
  source_timestamp TIMESTAMPTZ,
  fired_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered   BOOLEAN NOT NULL DEFAULT false,
  detail      TEXT,

  CONSTRAINT leadflow_escalation_fire_once UNIQUE (lead_id, rung)
);

CREATE INDEX IF NOT EXISTS idx_escalation_fire_lead ON leadflow_escalation_fire (lead_id, rung);

-- ---------------------------------------------------------------------------
-- Contact attempts, and whether each one actually counts.

CREATE TABLE IF NOT EXISTS leadflow_contact_attempt (
  attempt_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    TEXT,
  lead_id      UUID NOT NULL,
  rep_user_id  UUID,

  -- WHAT THE REP ACTUALLY DID. The whole SLA turns on this column: a tracked
  -- call from an approved number can satisfy the clock; a task click or a bulk
  -- email cannot, however many of them there are.
  kind         TEXT NOT NULL,

  -- The four things SOP §04 requires of a VALID HUMAN ATTEMPT. Stored
  -- individually rather than as one `valid` boolean, because a rep who called
  -- but logged no outcome needs a different conversation from one who never
  -- called, and a single flag cannot tell them apart.
  context_reviewed   BOOLEAN NOT NULL DEFAULT false,
  tracked_call_ref   TEXT,
  disposition        TEXT,
  next_action        TEXT,

  -- Derived once, at write time, from the four above plus kind. Stored so the
  -- attainment report does not re-derive the rule and risk drifting from the
  -- gate that enforced it.
  satisfies_sla BOOLEAN NOT NULL DEFAULT false,
  refusal_reason TEXT,

  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT leadflow_contact_attempt_kind_known
    CHECK (kind IN ('tracked_call','manual_call','task_click','bulk_email','individual_email','sms','voicemail')),
  -- An attempt cannot claim to satisfy the SLA without the call reference that
  -- makes it checkable. Enforced here as well as in the service so no writer can
  -- mint a satisfying attempt out of nothing.
  CONSTRAINT leadflow_contact_attempt_satisfy_needs_call
    CHECK (satisfies_sla = false OR (tracked_call_ref IS NOT NULL AND disposition IS NOT NULL AND next_action IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_contact_attempt_lead ON leadflow_contact_attempt (lead_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_contact_attempt_valid ON leadflow_contact_attempt (satisfies_sla, occurred_at);

-- ---------------------------------------------------------------------------
-- Breaches, with the reason and the recovery that SOP §04 makes mandatory.

CREATE TABLE IF NOT EXISTS leadflow_sla_breach (
  breach_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    TEXT,
  lead_id      UUID NOT NULL,

  -- Mandatory. A breach with no cause is a number on a report that teaches
  -- nobody anything, and the report exists to change what happens next.
  reason_code  TEXT NOT NULL,
  reason_detail TEXT,

  -- Mandatory. SOP §04 requires a recorded action taken FOR THE CUSTOMER, not
  -- merely an explanation given internally.
  recovery_action TEXT NOT NULL,
  recovered_by_user_id UUID,

  -- Set when the cause is a system failure rather than a person, which opens a
  -- management incident instead of coaching somebody who did nothing wrong.
  systemic     BOOLEAN NOT NULL DEFAULT false,
  incident_ref TEXT,

  source_timestamp TIMESTAMPTZ,
  due_at       TIMESTAMPTZ,
  breached_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT leadflow_sla_breach_reason_present
    CHECK (length(btrim(reason_code)) > 0 AND length(btrim(recovery_action)) > 0),
  -- One breach per lead. A lead does not breach the same 30-minute clock twice.
  CONSTRAINT leadflow_sla_breach_once UNIQUE (lead_id)
);

CREATE INDEX IF NOT EXISTS idx_sla_breach_when ON leadflow_sla_breach (breached_at DESC);

-- ---------------------------------------------------------------------------
-- The overnight queue: signals that arrived outside business hours.

CREATE TABLE IF NOT EXISTS leadflow_overnight_queue (
  entry_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    TEXT,
  lead_id      UUID NOT NULL,

  arrived_at   TIMESTAMPTZ NOT NULL,
  -- Why it is here, so the digest can group by cause: after_hours | weekend |
  -- holiday. Distinguished because a holiday backlog is a staffing decision and
  -- a nightly one is routine.
  reason       TEXT NOT NULL,

  -- The commitment actually made to the customer, and when it comes due.
  acknowledged_at    TIMESTAMPTZ,
  booking_link       TEXT,
  next_business_open TIMESTAMPTZ,
  owner_task_due_at  TIMESTAMPTZ,
  first_call_due_at  TIMESTAMPTZ,

  -- Set only when an approved on-call rep actually existed. NEVER set
  -- optimistically: promising a callback nobody can make is the failure SOP §04
  -- calls out by name.
  oncall_user_id     UUID,
  same_night_promised BOOLEAN NOT NULL DEFAULT false,

  released_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT leadflow_overnight_reason_known
    CHECK (reason IN ('after_hours','weekend','holiday')),
  CONSTRAINT leadflow_overnight_promise_needs_oncall
    CHECK (same_night_promised = false OR oncall_user_id IS NOT NULL),
  CONSTRAINT leadflow_overnight_once UNIQUE (lead_id)
);

CREATE INDEX IF NOT EXISTS idx_overnight_open ON leadflow_overnight_queue (released_at, arrived_at);
