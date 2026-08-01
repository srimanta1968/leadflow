-- 006 — SLA escalation alerts.
--
-- `sla_alerts` is a genuinely NEW table: it is absent from
-- .projexlight/schemas/user-defined-schemas.sql (which declares only leads,
-- routing_rules, sla_metrics and analytics_data), so creating it here is correct
-- rather than duplicating a shared table.
--
-- Why a table rather than fire-and-forget notifications: an escalation that
-- exists only as an outbound message cannot be audited ("was Priya actually told
-- before this deal went cold?"), cannot be retried after a gateway outage, and
-- cannot be shown in-app to a manager who missed the email. The row is written
-- FIRST and the notification attempted second, so a gateway outage degrades the
-- CHANNEL without silencing the escalation.

CREATE TABLE IF NOT EXISTS sla_alerts (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id                 UUID NOT NULL REFERENCES leads (id),

  -- Who is being told. One row per recipient, because a breach escalates to
  -- every manager and each of them acknowledges their own copy.
  recipient_user_id       UUID NOT NULL REFERENCES users (id),

  -- Escalation tier. owner_warning fires while the clock is still running so
  -- somebody can still save the lead; manager_breach fires after the deadline.
  -- Separate tiers with separate recipients is the whole point — notifying a
  -- manager BEFORE a violation is what the playbook asks for.
  kind                    VARCHAR(30) NOT NULL,

  state                   VARCHAR(20) NOT NULL DEFAULT 'pending',
  channel                 VARCHAR(20) NOT NULL DEFAULT 'in_app',

  -- Evidence captured at the moment the alert was raised, so the ledger explains
  -- itself later even after the lead's clock has moved on.
  reason                  TEXT,
  minutes_to_due          INTEGER,

  raised_at               TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivered_at            TIMESTAMP WITH TIME ZONE,
  acknowledged_at         TIMESTAMP WITH TIME ZONE,
  acknowledged_by_user_id UUID REFERENCES users (id),

  -- Outbound attempt bookkeeping, so a permanently undeliverable address cannot
  -- stall the retry queue for everyone else.
  attempts                INTEGER NOT NULL DEFAULT 0,
  last_error              TEXT,
  correlation_id          UUID,

  created_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT sla_alerts_kind_known
    CHECK (kind IN ('owner_warning', 'manager_breach')),
  CONSTRAINT sla_alerts_state_known
    CHECK (state IN ('pending', 'delivered', 'acknowledged', 'failed'))
);

COMMENT ON TABLE sla_alerts IS
  'Durable SLA escalation ledger. One row per (lead, recipient, tier). Raised by the monitoring sweep; the outbound notification is a separate retryable step so a gateway outage cannot silence an escalation.';
COMMENT ON COLUMN sla_alerts.kind IS
  'Escalation tier: owner_warning (at_risk, to the lead owner) or manager_breach (deadline passed, to every active manager).';
COMMENT ON COLUMN sla_alerts.state IS
  'pending (row exists, outbound send not yet succeeded), delivered, acknowledged (recipient has seen it), failed (retry budget exhausted; still readable in-app).';

-- THE anti-spam invariant: a sweep runs repeatedly, so without this every pass
-- would raise the same escalation again and managers would learn to ignore them.
-- One alert per recipient per lead per tier, for ever.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sla_alerts_lead_recipient_kind
  ON sla_alerts (lead_id, recipient_user_id, kind);

-- The retry sweep's read path: oldest pending first.
CREATE INDEX IF NOT EXISTS idx_sla_alerts_pending
  ON sla_alerts (raised_at ASC) WHERE state = 'pending';

-- A manager's own queue.
CREATE INDEX IF NOT EXISTS idx_sla_alerts_recipient
  ON sla_alerts (recipient_user_id, raised_at DESC);

CREATE INDEX IF NOT EXISTS idx_sla_alerts_lead ON sla_alerts (lead_id);
