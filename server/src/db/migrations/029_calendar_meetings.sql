-- 029 — Calendar readiness, meetings, the reminder ladder and no-show rescue.
-- SOP §09, §31, §45.
--
-- Checked the existing leadflow_* tables first: nothing here duplicates them.
-- sdk-scheduling owns the CALENDAR; this is the local state that decides whether
-- a rep may receive leads at all, and the rescue rules that must hold whether or
-- not that upstream is reachable.

CREATE TABLE IF NOT EXISTS leadflow_calendar_readiness (
  readiness_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT,
  rep_user_id   UUID NOT NULL,

  -- The checklist SOP §09 makes mandatory. Stored as separate columns rather
  -- than one `ready` flag because each fails for a different reason and is fixed
  -- by a different person - a single boolean tells a manager to "fix the
  -- calendar", which is not an instruction anybody can act on.
  link_connected      BOOLEAN NOT NULL DEFAULT FALSE,
  two_way_sync        BOOLEAN NOT NULL DEFAULT FALSE,
  working_hours_set   BOOLEAN NOT NULL DEFAULT FALSE,
  pto_and_holidays    BOOLEAN NOT NULL DEFAULT FALSE,
  buffer_configured   BOOLEAN NOT NULL DEFAULT FALSE,
  minimum_notice_set  BOOLEAN NOT NULL DEFAULT FALSE,
  daily_max_set       BOOLEAN NOT NULL DEFAULT FALSE,
  timezone_detection  BOOLEAN NOT NULL DEFAULT FALSE,

  booking_link  TEXT,
  connection_ref TEXT,
  last_checked_at TIMESTAMPTZ,
  last_synthetic_at TIMESTAMPTZ,
  last_synthetic_ok BOOLEAN,
  last_synthetic_detail TEXT,

  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT leadflow_calendar_readiness_once UNIQUE (tenant_id, rep_user_id)
);

-- ---------------------------------------------------------------------------
-- Meetings, their reminders and their no-show history.

CREATE TABLE IF NOT EXISTS leadflow_meeting (
  meeting_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT,
  subject_ref   TEXT NOT NULL,
  rep_user_id   UUID,

  meeting_type  TEXT NOT NULL,
  starts_at     TIMESTAMPTZ NOT NULL,
  duration_minutes INTEGER NOT NULL,

  -- ONE ACTIVE EVENT ID, which is the whole point of the reschedule rule. A
  -- reschedule REPLACES this and cancels the previous invite; two live event ids
  -- means the customer holds two invitations and turns up to neither.
  active_event_ref TEXT,
  previous_event_refs JSONB NOT NULL DEFAULT '[]'::jsonb,

  status        TEXT NOT NULL DEFAULT 'scheduled',
  no_show_count INTEGER NOT NULL DEFAULT 0,
  -- Set when a second no-show forces a manager decision rather than another
  -- automated rebook.
  manager_review_at TIMESTAMPTZ,

  -- The manual fallback SOP §09 requires when sync fails. Recorded BEFORE
  -- contact ends, so a customer is never left without an invitation because an
  -- integration was down.
  manual_invite_url TEXT,
  sync_incident_ref TEXT,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT leadflow_meeting_status_known
    CHECK (status IN ('scheduled','rescheduled','cancelled','completed','no_show'))
);

CREATE INDEX IF NOT EXISTS idx_meeting_upcoming ON leadflow_meeting (tenant_id, status, starts_at);
CREATE INDEX IF NOT EXISTS idx_meeting_subject ON leadflow_meeting (subject_ref, starts_at DESC);

CREATE TABLE IF NOT EXISTS leadflow_meeting_reminder (
  reminder_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT,
  meeting_id    UUID NOT NULL REFERENCES leadflow_meeting(meeting_id) ON DELETE CASCADE,

  -- Minutes before the meeting: 1440, 120 or 15.
  offset_minutes INTEGER NOT NULL,
  -- THE 15-MINUTE RUNG IS INTERNAL. Stored as an audience rather than inferred
  -- from the offset, so a future rung cannot accidentally inherit the wrong one -
  -- and a customer-facing 15-minute reminder is the one that reads as nagging.
  audience      TEXT NOT NULL,
  channel       TEXT NOT NULL,
  template_key  TEXT,

  due_at        TIMESTAMPTZ NOT NULL,
  sent_at       TIMESTAMPTZ,
  -- Suppressed when the meeting is cancelled or rescheduled, so a stale link can
  -- never reach the customer.
  suppressed_at TIMESTAMPTZ,
  suppressed_reason TEXT,
  -- Why the channel-decision gate refused it, when it did.
  gate_refusal  TEXT,

  CONSTRAINT leadflow_meeting_reminder_audience_known
    CHECK (audience IN ('customer','rep')),
  -- One reminder per rung per meeting. A reschedule regenerates the SET, and two
  -- 24-hour reminders means the customer is told twice.
  CONSTRAINT leadflow_meeting_reminder_once UNIQUE (meeting_id, offset_minutes)
);

CREATE INDEX IF NOT EXISTS idx_meeting_reminder_due
  ON leadflow_meeting_reminder (due_at) WHERE sent_at IS NULL AND suppressed_at IS NULL;

-- ---------------------------------------------------------------------------
-- No-show rescue. SOP §31.

CREATE TABLE IF NOT EXISTS leadflow_no_show (
  no_show_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT,
  meeting_id    UUID NOT NULL REFERENCES leadflow_meeting(meeting_id) ON DELETE CASCADE,
  subject_ref   TEXT NOT NULL,

  marked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  occurrence    INTEGER NOT NULL DEFAULT 1,

  -- THE HUMAN CALL COMES FIRST. SOP §31 requires the rep to call once within
  -- five minutes; the rescue message is permitted ONLY AFTER that attempt, and
  -- the endpoint refuses it until this is set. Automating the message first
  -- turns a missed meeting into a marketing touch, which is how a recoverable
  -- no-show becomes a lost one.
  human_call_attempt_id UUID,
  human_call_at TIMESTAMPTZ,

  rescue_sent_at TIMESTAMPTZ,
  rescue_channel TEXT,
  rebook_task_due_at TIMESTAMPTZ,

  -- ONE ROW PER MEETING. The scan runs on a timer and must never double-mark:
  -- two no-shows for one meeting would double-count the occurrence and push a
  -- first-time no-show straight to manager review.
  CONSTRAINT leadflow_no_show_once UNIQUE (meeting_id)
);

CREATE INDEX IF NOT EXISTS idx_no_show_subject ON leadflow_no_show (subject_ref, marked_at DESC);
