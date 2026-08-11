-- 021 — Operational suppression, the revocation cascade, and the daily
-- reconciliation against the provider.
--
-- THE LEDGER IS APPEND-ONLY BECAUSE A STOP IS EVIDENCE. Somebody texted STOP,
-- or clicked unsubscribe, or marked a message as spam. That happened. A design
-- that stores "currently suppressed: true/false" and flips it back on release
-- destroys the only record that they ever asked — and "when did they opt out,
-- and how" is the first question asked when a regulator or the person
-- themselves disputes a later message. So every signal INSERTs, a release
-- INSERTs too, and the current state is DERIVED.
--
-- SUPPRESSION IS NOT REVOCATION, and they are separate tables for a reason.
-- Revoking a receipt withdraws the LEGAL basis; suppressing a channel stops the
-- OPERATIONAL sending. They usually travel together but they are not the same
-- fact and they do not always coincide: a hard bounce suppresses email while
-- consent remains perfectly valid, and a revoked receipt still leaves the
-- evidence of what was once agreed. Collapsing them loses both distinctions.
--
-- Checked `.projexlight/schema/current-schema.json` before adding: no
-- suppression, stop-signal or opt-out table exists in the shared reference.
-- sdk-deliverability owns the PROVIDER-side suppression list; this is the local
-- operational state that must be true within one tick whether or not that
-- upstream is reachable, which is precisely why it cannot live only there.

-- ---------------------------------------------------------------------------
-- Every stop (and every release), exactly as it arrived.

CREATE TABLE IF NOT EXISTS leadflow_suppression_signal (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT,
  subject_ref   TEXT NOT NULL,

  -- Which channel this signal speaks for. 'all' is not a wildcard convenience:
  -- an SMS STOP is read as a refusal to be contacted AT ALL, so it is recorded
  -- against every channel rather than only the one it arrived on. Someone who
  -- says stop has not said "stop, but email is fine".
  channel       TEXT NOT NULL,

  -- What happened. Kept as the raw vocabulary of the source rather than
  -- normalised to a boolean, because "hard bounce" and "spam complaint" call
  -- for different operational responses even though both suppress email.
  signal        TEXT NOT NULL,
  CONSTRAINT leadflow_suppression_signal_kind CHECK (signal IN (
    'sms_stop', 'sms_help', 'email_unsubscribe', 'spam_complaint',
    'hard_bounce', 'dnc_registration', 'wrong_number', 'staff_revocation',
    'release'
  )),

  -- Who said so: 'provider' (a webhook), 'staff', 'subject' or 'reconciliation'.
  source        TEXT NOT NULL,
  reason        TEXT,

  -- The consent receipt this signal revoked, when there was one. NOT a foreign
  -- key: receipts live in sdk-consent, and a local FK to a remote row would
  -- either be unenforceable or block recording a stop for somebody whose
  -- receipt this deployment has never seen.
  receipt_ref   TEXT,

  -- When the SUBJECT acted, which is not when we heard about it. A provider
  -- webhook can arrive minutes late, and a reconciliation can surface a stop
  -- from yesterday; the gap between these two columns is the window in which
  -- we may have sent something we should not have.
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  correlation_id TEXT,
  recorded_by    TEXT
);

-- The lookup the channel-decision composer makes on EVERY send decision, so it
-- has to be the cheap one: newest signal per (subject, channel).
CREATE INDEX IF NOT EXISTS leadflow_suppression_signal_lookup_idx
  ON leadflow_suppression_signal (subject_ref, channel, occurred_at DESC);

CREATE INDEX IF NOT EXISTS leadflow_suppression_signal_tenant_idx
  ON leadflow_suppression_signal (tenant_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- What the cascade actually managed to stop.

CREATE TABLE IF NOT EXISTS leadflow_revocation_cascade (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id     UUID NOT NULL REFERENCES leadflow_suppression_signal (id),
  subject_ref   TEXT NOT NULL,

  -- Per-step outcome rather than one boolean. A cascade that cancelled the
  -- sequence but could not reach the campaign audience is a PARTIAL stop, and
  -- recording it as a success would hide the one channel still able to send.
  -- [{ step, outcome: done|unreachable|nothing_to_do, detail }]
  steps         JSONB NOT NULL DEFAULT '[]'::jsonb,
  complete      BOOLEAN NOT NULL DEFAULT FALSE,
  ran_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS leadflow_revocation_cascade_signal_idx
  ON leadflow_revocation_cascade (signal_id);

-- Incomplete cascades are the ones somebody has to look at, so they get their
-- own partial index rather than a scan of every cascade ever run.
CREATE INDEX IF NOT EXISTS leadflow_revocation_cascade_incomplete_idx
  ON leadflow_revocation_cascade (ran_at DESC)
  WHERE complete = FALSE;

-- ---------------------------------------------------------------------------
-- The daily comparison against the provider's own list.

CREATE TABLE IF NOT EXISTS leadflow_suppression_reconciliation (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT,
  ran_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Absent rather than zero when the provider could not be reached. A run that
  -- compared nothing must not read as a run that found nothing wrong — that is
  -- the failure mode this whole table exists to catch, and it would be silent.
  provider_reached BOOLEAN NOT NULL,
  provider_count   INTEGER,
  platform_count   INTEGER,

  -- [{ subject_ref, channel, provider_state, platform_state, direction }]
  divergences     JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- The Data Review case opened when the two sides disagreed. Null when they
  -- agreed, which is the only case in which no case is correct.
  case_ref        TEXT
);

CREATE INDEX IF NOT EXISTS leadflow_suppression_reconciliation_ran_idx
  ON leadflow_suppression_reconciliation (ran_at DESC);
