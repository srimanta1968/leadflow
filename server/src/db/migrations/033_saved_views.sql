-- 033 — Saved views for the contacts workspace.
--
-- EXTENDING migration 015's leadflow_saved_view rather than creating a second
-- one. 015 already got the important thing right — a saved view stores a
-- QUESTION, never an answer — and already holds owner, name, filters and a
-- shared flag. What the contacts workspace adds is a three-value SCOPE where
-- 015 has a boolean, pinning with an order, and the tenant column every other
-- leadflow_* table carries.
--
-- `shared` is left in place and NOT collapsed into `scope`. Something already
-- reads it, and rewriting a visibility flag underneath a live reader is how a
-- private view becomes an organisation-wide one silently.

ALTER TABLE leadflow_saved_view ADD COLUMN IF NOT EXISTS tenant_id     TEXT;
ALTER TABLE leadflow_saved_view ADD COLUMN IF NOT EXISTS description   TEXT;

-- private | team | organization. Defaulted rather than NOT NULL, because 015's
-- existing rows are real and a NOT NULL without a default would fail against
-- any database that already holds them.
ALTER TABLE leadflow_saved_view ADD COLUMN IF NOT EXISTS scope         TEXT NOT NULL DEFAULT 'private';
ALTER TABLE leadflow_saved_view ADD COLUMN IF NOT EXISTS pinned        BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE leadflow_saved_view ADD COLUMN IF NOT EXISTS pin_order     INTEGER;

-- Whether the view ships with the product. 015 expressed this as "NULL owner
-- means built-in", which is true but not readable — a caller has to know the
-- convention. The column states it, and backfills from the convention below.
ALTER TABLE leadflow_saved_view ADD COLUMN IF NOT EXISTS shipped       BOOLEAN NOT NULL DEFAULT FALSE;

-- 015 named the owner column owner_id and the contacts workspace reads
-- owner_user_id everywhere else in the schema. Adding the alias rather than
-- renaming, because a rename breaks whatever already selects owner_id.
ALTER TABLE leadflow_saved_view ADD COLUMN IF NOT EXISTS owner_user_id UUID;
UPDATE leadflow_saved_view SET owner_user_id = owner_id WHERE owner_user_id IS NULL AND owner_id IS NOT NULL;
UPDATE leadflow_saved_view SET shipped = TRUE WHERE owner_id IS NULL AND shipped = FALSE;
-- 015's `shared` rows are organisation-wide by the only reading that flag has.
UPDATE leadflow_saved_view SET scope = 'organization' WHERE shared = TRUE AND scope = 'private';

-- 015 made `subject` NOT NULL and the contacts workspace only ever saves contact
-- filters, so it is defaulted rather than supplied on every insert.
ALTER TABLE leadflow_saved_view ALTER COLUMN subject SET DEFAULT 'contacts';

ALTER TABLE leadflow_saved_view DROP CONSTRAINT IF EXISTS leadflow_saved_view_scope_known;
ALTER TABLE leadflow_saved_view ADD CONSTRAINT leadflow_saved_view_scope_known
  CHECK (scope IN ('private','team','organization'));

CREATE INDEX IF NOT EXISTS idx_saved_view_scope
  ON leadflow_saved_view (tenant_id, scope, pinned DESC, pin_order);
