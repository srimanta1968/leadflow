-- Migration 011: canonical dedupe keys and the acknowledgement window.
--
-- NORMALISED COLUMNS, not normalisation at query time. `lower(email)` in a
-- WHERE clause cannot use a plain index, so dedupe would degrade into a scan
-- exactly as the lead table grows — and dedupe runs on every inbound signal,
-- which is the hottest path in intake. Storing the normalised form makes the
-- lookup an index probe and, more importantly, makes the normalisation itself
-- reviewable: it is one function with tests rather than an expression repeated
-- at each call site, each free to drift.
--
-- THREE KEYS, ANY OF WHICH MATCHES. SOP §03 dedupes on normalised email, E.164
-- phone, linked social id, AND an open opportunity. They are alternatives, not
-- a composite: the same person reaching us by web form and by DM shares neither
-- email nor phone, and requiring all four would create a second record for
-- somebody we can plainly see is the same human.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS canonical_email    VARCHAR(320);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS canonical_phone    VARCHAR(20);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS canonical_social_id VARCHAR(255);
-- When the acknowledgement was last sent. The 30-minute window is measured
-- from THIS, not from lead creation: a second signal 20 minutes after the first
-- must not trigger a second "thanks, we got it", and the thing that must not
-- repeat is the acknowledgement rather than the record.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS acknowledged_at    TIMESTAMPTZ;
-- Whether the record passed the activation gate, and when it was last checked.
-- Stored rather than computed on read so the manager's integrity queue is an
-- indexed filter instead of a full evaluation of every lead.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS activation_state   VARCHAR(24);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS activation_checked_at TIMESTAMPTZ;

-- The three dedupe probes. Partial, because most leads have only one or two of
-- the three and a NULL in a normal index would carry no information while still
-- costing space on every row.
CREATE INDEX IF NOT EXISTS leads_canonical_email_idx
  ON leads (canonical_email) WHERE canonical_email IS NOT NULL;
CREATE INDEX IF NOT EXISTS leads_canonical_phone_idx
  ON leads (canonical_phone) WHERE canonical_phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS leads_canonical_social_idx
  ON leads (canonical_social_id) WHERE canonical_social_id IS NOT NULL;

-- The manager's integrity queue: records that failed the gate, worst first.
CREATE INDEX IF NOT EXISTS leads_activation_failed_idx
  ON leads (activation_checked_at DESC)
  WHERE activation_state = 'blocked';

-- Every source event that contributed to a canonical record.
--
-- A SEPARATE TABLE because the acceptance case is "three simultaneous signals
-- produce ONE canonical record with THREE preserved source events". Folding
-- them into the lead row would force a choice about which one wins, and the
-- losers would be discarded — destroying the provenance that says why the
-- record exists and, with it, the consent captured alongside each signal.
CREATE TABLE IF NOT EXISTS lead_source_event (
  lead_id          UUID        NOT NULL,
  platform         VARCHAR(64) NOT NULL,
  source_event_id  VARCHAR(255) NOT NULL,
  -- Which dedupe key matched this event onto the record, or 'new' for the one
  -- that created it. An audit of a merge asks "why did you think these were the
  -- same person", and this is the answer.
  matched_on       VARCHAR(32) NOT NULL,
  -- The consent captured WITH this signal. Consent belongs to the event that
  -- collected it, not to the merged record: two signals can carry different
  -- permissions, and flattening them would silently upgrade the weaker one.
  consent_snapshot JSONB,
  occurred_at      TIMESTAMPTZ,
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One row per (platform, event) per lead. A replayed webhook must not add a
-- second contribution row for a signal already counted.
CREATE UNIQUE INDEX IF NOT EXISTS lead_source_event_key
  ON lead_source_event (lead_id, platform, source_event_id);

CREATE INDEX IF NOT EXISTS lead_source_event_lead_idx
  ON lead_source_event (lead_id, recorded_at);

COMMENT ON TABLE lead_source_event IS
  'Every source event that contributed to a canonical lead. Separate from the lead so a merge preserves all of them — the acceptance case is three signals, one record, three preserved events.';
COMMENT ON COLUMN lead_source_event.consent_snapshot IS
  'Consent as captured WITH this signal. Belongs to the event, not the merged record: two signals can carry different permissions and flattening them would upgrade the weaker one.';
COMMENT ON COLUMN leads.acknowledged_at IS
  'When the acknowledgement was last sent. The 30-minute dedup window is measured from here — what must not repeat is the acknowledgement, not the record.';
