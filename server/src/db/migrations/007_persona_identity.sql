-- Migration 007: key on persona_id, the ProjexCloud acting identity.
--
-- ProjexCloud's rule (mcp-server/data/AGENTS.md): "Everything downstream keys on
-- persona_id (L4), not on person_id and not on a user_id." LeadFlow currently
-- keys on a LOCAL users.id across five foreign keys, which is the parallel
-- identity model the same document warns breaks tenant isolation and the audit
-- chain.
--
-- ADDITIVE, DELIBERATELY. Every persona column is added ALONGSIDE its user
-- column rather than replacing it, and nothing is dropped here. A hard swap
-- would break five FKs across four tables in one step, strand every row whose
-- persona is not yet known, and take the auth producer that every api_definition
-- chains from offline in the same commit. The retirement is staged:
--
--   1. THIS migration           add persona columns, nullable, indexed
--   2. dual-write               populate persona_id on every new write while
--                               continuing to write user_id
--   3. backfill                 map existing users to personas once ProjexCloud
--                               identity is live for this tenant
--   4. switch reads             read persona_id, fall back to user_id
--   5. drop                     remove the user columns and the local
--                               credential table
--
-- Steps 3 to 5 need a reachable ProjexCloud tenant with the personas actually
-- provisioned. This migration is safe to apply before that exists: every column
-- is NULLABLE, so an unmigrated row is simply a row whose persona is not known
-- yet, which is the truth.
--
-- NO FOREIGN KEY on these columns. A persona lives in ProjexCloud, not in this
-- database, so there is nothing local to reference; the value is validated by
-- the platform session that supplies it, not by the schema. Adding a local
-- personas table to point at would recreate exactly the parallel model this
-- migration exists to remove.

-- Lead ownership. The persona is the acting identity: the same human working as
-- a Sales Rep and as a Data Steward is two personas, and which one owned a lead
-- is a fact the user id cannot express.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS owner_persona_id UUID;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS tenant_id UUID;

CREATE INDEX IF NOT EXISTS leads_owner_persona_idx
  ON leads (owner_persona_id)
  WHERE owner_persona_id IS NOT NULL;

-- Every scoped read filters on it, so it is indexed with the owner rather than
-- alone: "this tenant's leads for this persona" is the query the inbox makes.
CREATE INDEX IF NOT EXISTS leads_tenant_persona_idx
  ON leads (tenant_id, owner_persona_id)
  WHERE tenant_id IS NOT NULL;

-- Routing rules assign work TO a persona.
ALTER TABLE routing_rules ADD COLUMN IF NOT EXISTS assigned_persona_id UUID;
ALTER TABLE routing_rules ADD COLUMN IF NOT EXISTS tenant_id UUID;

CREATE INDEX IF NOT EXISTS routing_rules_tenant_idx
  ON routing_rules (tenant_id)
  WHERE tenant_id IS NOT NULL;

-- Who actually answered. Distinct from the owner: a backup rep responding on
-- someone else's lead is the case the SLA record has to be able to state.
ALTER TABLE sla_metrics ADD COLUMN IF NOT EXISTS responded_by_persona_id UUID;

-- Alert recipient and acknowledger.
ALTER TABLE sla_alerts ADD COLUMN IF NOT EXISTS recipient_persona_id UUID;
ALTER TABLE sla_alerts ADD COLUMN IF NOT EXISTS acknowledged_by_persona_id UUID;

CREATE INDEX IF NOT EXISTS sla_alerts_recipient_persona_idx
  ON sla_alerts (recipient_persona_id)
  WHERE recipient_persona_id IS NOT NULL;

-- The local user row a persona replaced, kept only for the backfill and for
-- reconciling the two models while both exist. Dropped with the user columns in
-- step 5; it is a migration aid, not a second identity store.
ALTER TABLE users ADD COLUMN IF NOT EXISTS platform_persona_id UUID;
ALTER TABLE users ADD COLUMN IF NOT EXISTS platform_person_id UUID;
ALTER TABLE users ADD COLUMN IF NOT EXISTS platform_tenant_id UUID;

-- One local user maps to at most one persona. Partial, so the many rows with no
-- persona yet do not collide with each other on NULL.
CREATE UNIQUE INDEX IF NOT EXISTS users_platform_persona_key
  ON users (platform_persona_id)
  WHERE platform_persona_id IS NOT NULL;

COMMENT ON COLUMN leads.owner_persona_id IS
  'ProjexCloud persona (L4) that owns this lead. Supersedes owner_user_id; both are written during the migration.';
COMMENT ON COLUMN users.platform_persona_id IS
  'Persona this local user maps to. Migration aid only — dropped with the local credential table.';
