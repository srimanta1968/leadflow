-- 024 — Ownership, acceptance clocks, backup takeover, and the fields the
-- zero-orphan validator asserts. SOP §02 and §30.
--
-- THE SOURCE TIMESTAMP IS IMMUTABLE, AND A TRIGGER ENFORCES IT.
--
-- The acceptance criterion is that reassignment and backup takeover never reset
-- the source timestamp. Every natural implementation breaks this by accident:
-- reassign sets assigned_at = now(), somebody later recomputes sla_due_at from
-- assigned_at "to keep it consistent", and the response clock silently restarts
-- every time a lead changes hands. A rep who takes over a breaching lead
-- inherits a fresh clock, the breach disappears from the report, and nobody can
-- see that it ever happened.
--
-- So `source_timestamp` is written once and a BEFORE UPDATE trigger RAISES on
-- any attempt to change it. Not a convention, not a code review item: an UPDATE
-- that touches it fails, whoever wrote it and whichever path it came through.
-- assigned_at is free to move — it SHOULD move, it records who holds the lead
-- now — and the two are deliberately different columns for exactly that reason.
--
-- Checked `.projexlight/schema/current-schema.json` before adding: no ownership,
-- acceptance or orphan table exists in the shared reference, and the columns
-- below extend the existing local `leads` projection rather than duplicating it.

-- ---------------------------------------------------------------------------
-- Ownership, on the lead itself.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS backup_user_id  UUID;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS manager_user_id UUID;

-- The acceptance clock. accepted_at and declined_at are separate columns rather
-- than one status: "accepted at 09:03" and "declined at 09:03" are different
-- facts about the same minute, and a lead that was declined and then reassigned
-- and accepted needs both to remain readable.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS accepted_at    TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS declined_at    TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS decline_reason TEXT;

-- THE INVARIANT. Defaulted from created_at for rows that already exist, so the
-- backfill preserves the clock every existing lead has actually been running on
-- rather than restarting all of them at migration time — which would be the very
-- bug this column exists to prevent, committed once, globally.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS source_timestamp TIMESTAMPTZ;
UPDATE leads SET source_timestamp = COALESCE(source_timestamp, created_at, now())
 WHERE source_timestamp IS NULL;
ALTER TABLE leads ALTER COLUMN source_timestamp SET DEFAULT now();

-- The six fields the zero-orphan validator asserts, beyond owner and backup.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS stage            VARCHAR(64);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS priority         VARCHAR(16);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS next_action      TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS next_due_at      TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS intended_outcome TEXT;

-- Closed leads are not orphans. Without this the validator would report every
-- won and lost record forever, and a report that is always red is a report
-- nobody reads.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

/*
 * The guard itself.
 *
 * RAISES rather than silently restoring the old value. A silent restore would
 * make the offending UPDATE look like it worked, and the caller would carry on
 * believing it had moved the clock — which is worse than a loud failure,
 * because the disagreement between what the code thinks and what the row says
 * would surface much later and somewhere else.
 */
CREATE OR REPLACE FUNCTION leadflow_source_timestamp_is_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.source_timestamp IS DISTINCT FROM OLD.source_timestamp THEN
    RAISE EXCEPTION
      'source_timestamp is immutable (lead %): reassignment and backup takeover must never reset the response clock',
      OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS leads_source_timestamp_immutable ON leads;
CREATE TRIGGER leads_source_timestamp_immutable
  BEFORE UPDATE ON leads
  FOR EACH ROW
  EXECUTE FUNCTION leadflow_source_timestamp_is_immutable();

CREATE INDEX IF NOT EXISTS idx_leads_backup   ON leads (backup_user_id) WHERE backup_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_open     ON leads (closed_at, owner_user_id) WHERE closed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Every ownership act, in order.

CREATE TABLE IF NOT EXISTS leadflow_ownership_event (
  event_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    TEXT,
  lead_id      UUID NOT NULL,

  -- assigned | accepted | declined | reassigned | backup_takeover | capacity_frozen
  kind         TEXT NOT NULL,

  from_user_id UUID,
  to_user_id   UUID,

  -- Required on a decline and on a manager reassign. An ownership change nobody
  -- explained is indistinguishable from a mistake, and this is the row somebody
  -- reads when a lead was missed.
  reason       TEXT,

  -- WHY THE CLOCK IS CARRIED HERE TOO. The lead row shows the CURRENT state; this
  -- shows what the clock was at each handover, which is what makes "the clock did
  -- not move when this was reassigned" checkable after the fact rather than only
  -- assertable at the time.
  source_timestamp TIMESTAMPTZ,
  sla_due_at       TIMESTAMPTZ,

  actor_user_id UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT leadflow_ownership_event_kind_known
    CHECK (kind IN ('assigned','accepted','declined','reassigned','backup_takeover','capacity_frozen')),
  -- A decline with no reason is refused at the database as well as in the
  -- handler: SOP §02 requires an immediate reason, and a rule enforced in one
  -- place is a rule that holds until somebody adds a second writer.
  CONSTRAINT leadflow_ownership_event_decline_has_reason
    CHECK (kind <> 'declined' OR (reason IS NOT NULL AND length(btrim(reason)) > 0))
);

CREATE INDEX IF NOT EXISTS idx_ownership_event_lead
  ON leadflow_ownership_event (lead_id, created_at DESC);
