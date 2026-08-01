-- 003 — Lead ownership, routing decisions and the response clock.
--
-- STRICTLY ADDITIVE. `leads` and `routing_rules` are declared in
-- .projexlight/schemas/user-defined-schemas.sql, so this migration must not
-- recreate or redefine them (MUSTNOT-04) — it only adds columns those tables
-- need to carry an owner, a routing decision and an SLA deadline.
--
-- Note on `routing_rules.assigned_representative`: the provided column is
-- INTEGER, while `users.id` is UUID, so it cannot reference a user. It is left
-- untouched and `assigned_user_id UUID` is added alongside as the column the
-- application actually uses. Dropping or retyping the original would be a
-- destructive change to a schema this project does not own.

-- Lead ownership and the response clock ---------------------------------------

ALTER TABLE leads ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users (id);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS sla_due_at TIMESTAMP WITH TIME ZONE;

-- How the owner was chosen, so a routing decision is explainable after the fact
-- rather than being an unattributable assignment.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS routing_method VARCHAR(40);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS routing_reason TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS routing_rule_id UUID REFERENCES routing_rules (id);

-- The clock's terminal state. NULL means the clock is still running.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS first_response_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS sla_breached BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS sla_breach_reason VARCHAR(60);

COMMENT ON COLUMN leads.routing_method IS
  'Which step of the routing order chose the owner: rule_match, round_robin, sdk_assignment, or manual.';
COMMENT ON COLUMN leads.sla_due_at IS
  'Deadline for a valid human first response. Wall-clock for now; the business-calendar clock arrives with sdk-sla.';

CREATE INDEX IF NOT EXISTS idx_leads_owner      ON leads (owner_user_id);
CREATE INDEX IF NOT EXISTS idx_leads_sla_due    ON leads (sla_due_at) WHERE first_response_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_leads_unassigned ON leads (created_at DESC) WHERE owner_user_id IS NULL;

-- Routing rules ---------------------------------------------------------------

ALTER TABLE routing_rules ADD COLUMN IF NOT EXISTS name VARCHAR(160);
ALTER TABLE routing_rules ADD COLUMN IF NOT EXISTS source_channel VARCHAR(40);
ALTER TABLE routing_rules ADD COLUMN IF NOT EXISTS assigned_user_id UUID REFERENCES users (id);
ALTER TABLE routing_rules ADD COLUMN IF NOT EXISTS evaluation_order INTEGER NOT NULL DEFAULT 100;
ALTER TABLE routing_rules ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN routing_rules.assigned_user_id IS
  'The user this rule routes to. Added because the pre-existing assigned_representative column is INTEGER and cannot reference users.id (UUID); that column is retained untouched.';
COMMENT ON COLUMN routing_rules.evaluation_order IS
  'Lower runs first. Rules are evaluated in this order and the first match wins.';

CREATE INDEX IF NOT EXISTS idx_routing_rules_active
  ON routing_rules (evaluation_order) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_routing_rules_channel ON routing_rules (source_channel);
