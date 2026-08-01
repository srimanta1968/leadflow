-- 002 — Local lead capture projection.
--
-- The canonical contact record, its provenance assertion and its consent state
-- live in ProjexCloud. This table is the read projection the Capture Inbox and
-- dashboards serve from, so no screen fans out into per-row SDK reads.
--
-- Forward-only and additive: the base table ships in init-scripts/01-schema.sql,
-- so this migration only adds the columns capture needs on top of it.

CREATE TABLE IF NOT EXISTS leads (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       VARCHAR(255),
  email      VARCHAR(255),
  source     VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_email      ON leads (email);
CREATE INDEX IF NOT EXISTS idx_leads_source     ON leads (source);
