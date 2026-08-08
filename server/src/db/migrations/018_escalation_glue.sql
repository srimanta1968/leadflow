-- 018 — Escalation event ledger and the systemic-incident dedupe.
--
-- Two tables, and each exists to stop a specific kind of noise.
--
-- sdk-sla delivers at least once, so a rung that fires twice would notify twice
-- — and an escalation arriving in duplicate is how people learn to ignore
-- escalations. The event ledger makes handling idempotent on the producer's own
-- event id, so the second delivery does nothing at all.
--
-- The incident table answers the other half: a provider outage breaches forty
-- leads in ten minutes, and forty incidents is indistinguishable from none. The
-- one that matters is buried under thirty-nine duplicates and the on-call
-- engineer stops reading them.

-- ------------------------------------------------------- escalation events
CREATE TABLE IF NOT EXISTS leadflow_escalation_event (
  -- The PRODUCER's event id. A redelivery conflicts and no notification is sent.
  event_id      TEXT PRIMARY KEY,
  subject_ref   TEXT NOT NULL,
  rung          TEXT NOT NULL,
  minutes_late  INTEGER NOT NULL DEFAULT 0,
  tenant_id     UUID,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The systemic query: distinct subjects that breached inside the window. Ordered
-- by time because that is the only axis it is ever asked about.
CREATE INDEX IF NOT EXISTS leadflow_escalation_event_window_idx
  ON leadflow_escalation_event (received_at DESC)
  WHERE rung = 'breach';

CREATE INDEX IF NOT EXISTS leadflow_escalation_event_subject_idx
  ON leadflow_escalation_event (subject_ref, received_at DESC);

-- ------------------------------------------------------ systemic incidents
-- ONE ROW PER EPISODE, where an episode is a tenant plus a time bucket. Every
-- breach inside the same window maps to the same key, so the fortieth breach of
-- an outage attaches to the incident the fifth one opened.
CREATE TABLE IF NOT EXISTS leadflow_escalation_incident (
  episode_key   TEXT PRIMARY KEY,
  tenant_id     UUID,
  -- How wide the episode got. Refreshed upward as more subjects breach, so the
  -- incident says forty rather than freezing at the five that opened it.
  subject_count INTEGER NOT NULL DEFAULT 0,
  -- The upstream incident. NULL means sdk-incident could not be reached; the row
  -- still exists deliberately, because deleting it on failure would let the next
  -- breach open a second attempt and a flapping incident service would then
  -- produce exactly the duplicate storm this table prevents.
  incident_ref  TEXT,
  last_error    TEXT,
  opened_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS leadflow_escalation_incident_open_idx
  ON leadflow_escalation_incident (opened_at DESC);
