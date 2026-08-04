-- Migration 010: attribution that survives from intake to closed-won.
--
-- WHY COLUMNS AND NOT A JSONB BLOB. Attribution is what the revenue report
-- joins on — "which campaign produced the deals we closed" is a GROUP BY, and a
-- blob makes that a scan with JSON extraction on every row. These are also the
-- fields most likely to be filtered in an inbox or a dashboard, and an index on
-- a jsonb path is both slower and easier to forget than one on a column.
--
-- WHY ON THE LEAD AND NOT ONLY ON intake_event. The intake archive holds the
-- raw signal, which is the evidence. But a lead can be created by hand, by
-- import, or through the offline queue, and the attribution question is asked of
-- the LEAD regardless of how it arrived. Keeping it only on the archive would
-- answer the question for webhook-sourced leads and silently return nothing for
-- every other path — the worst kind of reporting gap, because the number still
-- renders.
--
-- NOT NULLABLE-BY-ACCIDENT. Every column is nullable on purpose: most leads
-- genuinely have no campaign, and a NOT NULL with a '' default would make
-- "no campaign" and "campaign unknown" indistinguishable in exactly the report
-- this exists to serve.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS attribution_platform   VARCHAR(64);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS attribution_campaign_id VARCHAR(255);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS attribution_ad_id       VARCHAR(255);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS attribution_creative_id VARCHAR(255);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS attribution_form_id     VARCHAR(255);
-- The click identifier the platform issued (gclid, fbclid, ttclid, li_fat_id).
-- One column rather than one per platform: they are the same concept, and a
-- column per network means a schema change every time marketing adds a channel.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS attribution_click_id    VARCHAR(255);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS utm_source              VARCHAR(255);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS utm_medium              VARCHAR(255);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS utm_campaign            VARCHAR(255);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS utm_content             VARCHAR(255);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS utm_term                VARCHAR(255);
-- The intake event this lead came from, when it came from one. The join back to
-- the raw evidence: a disputed attribution is settled by reading what the
-- platform actually sent, not by trusting the columns above.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS source_event_id         VARCHAR(255);

-- The revenue question, in index form: campaign performance over a window.
CREATE INDEX IF NOT EXISTS leads_attribution_campaign_idx
  ON leads (attribution_campaign_id, created_at DESC)
  WHERE attribution_campaign_id IS NOT NULL;

-- Joining a lead back to the signal that produced it.
CREATE INDEX IF NOT EXISTS leads_source_event_idx
  ON leads (source_event_id)
  WHERE source_event_id IS NOT NULL;

COMMENT ON COLUMN leads.attribution_click_id IS
  'Platform click identifier — gclid, fbclid, ttclid, li_fat_id. One column, not one per network: the same concept, and a column per network means a migration every time a channel is added.';
COMMENT ON COLUMN leads.source_event_id IS
  'The intake_event this lead came from, when it came from one. A disputed attribution is settled against the archived raw payload, not against these columns.';
