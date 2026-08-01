-- 005 — Per-lead-type SLA policies.
--
-- `sla_policies` is a genuinely NEW table: it is absent from
-- .projexlight/schemas/user-defined-schemas.sql (which declares only leads,
-- routing_rules, sla_metrics and analytics_data), so creating it here is correct
-- rather than a duplicate of a shared table.
--
-- Why a table and not a config file: an SLA target is tenant configuration an
-- operator changes without a deploy, and a past deadline must stay explainable
-- after the target changes — which needs a durable, retirable row.
--
-- The shape deliberately mirrors `routing_rules`: name, an optional
-- source_channel where NULL is the catch-all, evaluation_order with the first
-- match winning, and a soft-delete is_active flag. One precedence model for an
-- operator to learn, not two.

CREATE TABLE IF NOT EXISTS sla_policies (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   VARCHAR(160) NOT NULL,

  -- The lead type this policy governs. NULL is a deliberate catch-all, not a
  -- missing value: a live_chat prospect waiting in the window and a csv_import
  -- row are not owed the same response time, and a tenant still wants a floor
  -- for everything it has not named explicitly.
  source_channel         VARCHAR(40),

  -- Minutes allowed for a valid human first response.
  first_response_minutes INTEGER NOT NULL,

  -- Records the INTENT that the target runs on the tenant's business calendar.
  -- LeadFlow's local wall-clock fallback cannot honour it; ProjexCloud sdk-sla
  -- applies it when the gateway is configured. Stored either way so the policy
  -- does not have to be rewritten once the gateway is connected.
  business_hours_only    BOOLEAN NOT NULL DEFAULT FALSE,

  -- Lower runs first; the first matching policy wins.
  evaluation_order       INTEGER NOT NULL DEFAULT 100,

  -- Soft delete. A retired policy still explains a past deadline.
  is_active              BOOLEAN NOT NULL DEFAULT TRUE,

  created_at             TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- A target of zero would breach on arrival; beyond a week is not an SLA
  -- anyone monitors. Enforced here as well as in the validator so a direct
  -- INSERT cannot create a policy the application would refuse.
  CONSTRAINT sla_policies_minutes_sane
    CHECK (first_response_minutes BETWEEN 1 AND 10080),
  CONSTRAINT sla_policies_order_sane
    CHECK (evaluation_order BETWEEN 0 AND 100000)
);

COMMENT ON TABLE sla_policies IS
  'Per-lead-type first-response SLA targets. Matched first-match-wins in ascending evaluation_order; source_channel NULL is the catch-all. When nothing matches, routing applies the 30-minute default in RoutingService.';
COMMENT ON COLUMN sla_policies.source_channel IS
  'Capture channel this policy governs. NULL is a deliberate catch-all.';
COMMENT ON COLUMN sla_policies.business_hours_only IS
  'Intent that the target runs on the business calendar. Honoured by ProjexCloud sdk-sla; the local wall-clock fallback cannot apply it.';

-- Two ACTIVE policies tying on (channel, order) would make the effective SLA
-- depend on insertion order, which an operator cannot reason about. Partial so
-- retired rows never block a new policy for the same channel.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sla_policies_active_channel_order
  ON sla_policies (COALESCE(source_channel, '*'), evaluation_order)
  WHERE is_active = TRUE;

-- The matcher's read path: active policies in evaluation order.
CREATE INDEX IF NOT EXISTS idx_sla_policies_active_order
  ON sla_policies (evaluation_order) WHERE is_active = TRUE;
