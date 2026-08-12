-- 030 — Offer versions and the feature matrix, checkout sessions, verified
-- payments and the onboarding handoff. SOP §12, §13, §19, §22, §32, §44, §45, §50.
--
-- Checked the existing leadflow_* tables first. sdk-offer-catalog owns the
-- CANONICAL offer and sdk-payment owns the charge; what is local is the state
-- LeadFlow must be able to answer from even when those are unreachable - which
-- version a rep is allowed to quote, whether a checkout was paid, and whether a
-- paid licence has an accepted handoff.

CREATE TABLE IF NOT EXISTS leadflow_offer_version (
  offer_version_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT,
  offer_key     TEXT NOT NULL,
  version       INTEGER NOT NULL,

  -- The commercial fields SOP §12 makes mandatory. NOT NULL because an Offer
  -- Data Sheet missing any of them is the improvisation this table exists to
  -- prevent - a rep filling the gap on a call is exactly how two customers end
  -- up on different terms.
  price_cents        BIGINT NOT NULL,
  currency           TEXT NOT NULL DEFAULT 'USD',
  quantity_basis     TEXT NOT NULL,
  payment_options    JSONB NOT NULL DEFAULT '[]'::jsonb,
  license_limits     TEXT NOT NULL,
  implementation_expectations TEXT NOT NULL,
  refund_terms       TEXT NOT NULL,
  cancellation_terms TEXT NOT NULL,
  included_features  JSONB NOT NULL DEFAULT '[]'::jsonb,
  variable_charges   JSONB NOT NULL DEFAULT '[]'::jsonb,
  third_party_charges JSONB NOT NULL DEFAULT '[]'::jsonb,
  approved_scarcity_language TEXT,

  -- NULL until the multi-party route signs off. A rep may only quote an ACTIVE
  -- version, so an unapproved one is unquotable rather than merely unmarked.
  approved_at   TIMESTAMPTZ,
  approvals     JSONB NOT NULL DEFAULT '[]'::jsonb,
  activated_at  TIMESTAMPTZ,
  superseded_at TIMESTAMPTZ,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT leadflow_offer_version_once UNIQUE (tenant_id, offer_key, version),
  -- An activated version must have been approved. Activating an unapproved sheet
  -- would put unreviewed terms in front of a buyer.
  CONSTRAINT leadflow_offer_version_active_is_approved
    CHECK (activated_at IS NULL OR approved_at IS NOT NULL)
);

-- ONE ACTIVE VERSION PER OFFER. Two would mean two reps quoting different terms
-- and both believing they were current.
CREATE UNIQUE INDEX IF NOT EXISTS leadflow_offer_version_one_active
  ON leadflow_offer_version (tenant_id, offer_key) WHERE activated_at IS NOT NULL AND superseded_at IS NULL;

-- ---------------------------------------------------------------------------
-- The feature status matrix. SOP §12.

CREATE TABLE IF NOT EXISTS leadflow_feature_status (
  feature_status_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT,
  offer_key     TEXT NOT NULL,
  capability    TEXT NOT NULL,

  -- The five labels a rep is permitted to SAY. Anything outside this list is a
  -- claim nobody approved, which is what the constraint prevents.
  status        TEXT NOT NULL,

  -- OWNER AND UPDATE DATE PER CAPABILITY, both required. A matrix entry with no
  -- owner is a claim nobody is accountable for, and one with no date is a claim
  -- nobody can tell is stale - which is worse than no matrix, because it looks
  -- authoritative.
  owner_user_id UUID NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  note          TEXT,

  CONSTRAINT leadflow_feature_status_known
    CHECK (status IN ('LIVE','BETA','ROADMAP','USAGE_THIRD_PARTY','NOT_INCLUDED')),
  CONSTRAINT leadflow_feature_status_once UNIQUE (tenant_id, offer_key, capability)
);

-- ---------------------------------------------------------------------------
-- Checkout. SOP §13, §44.

CREATE TABLE IF NOT EXISTS leadflow_checkout_session (
  checkout_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT,
  subject_ref   TEXT NOT NULL,
  deal_ref      TEXT,

  -- THE EXACT VERSION THE BUYER WAS SHOWN, stamped at send. Without it a dispute
  -- about terms cannot be settled, because the offer may have changed since.
  offer_key     TEXT NOT NULL,
  offer_version INTEGER NOT NULL,

  checkout_url  TEXT,
  status        TEXT NOT NULL DEFAULT 'sent',
  sent_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at    TIMESTAMPTZ,
  paid_at       TIMESTAMPTZ,
  failed_at     TIMESTAMPTZ,
  failure_reason TEXT,

  -- The agreed decision time, recorded as a NEXT rather than left in a rep's head.
  decision_due_at TIMESTAMPTZ,
  assistance_task_at TIMESTAMPTZ,

  CONSTRAINT leadflow_checkout_status_known
    CHECK (status IN ('sent','started','paid','failed','expired','cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_checkout_open ON leadflow_checkout_session (tenant_id, status, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_checkout_subject ON leadflow_checkout_session (subject_ref, sent_at DESC);

-- ---------------------------------------------------------------------------
-- Verified payments. SOP §22, §50.

CREATE TABLE IF NOT EXISTS leadflow_payment_verification (
  verification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT,
  subject_ref   TEXT NOT NULL,
  checkout_id   UUID,

  -- The gateway's own identifier. THE IDEMPOTENCY KEY for everything downstream:
  -- replaying a webhook five times must produce one customer, one licence, one
  -- welcome and one onboarding, and this unique constraint is what guarantees it
  -- rather than five handlers each remembering to check.
  charge_ref    TEXT NOT NULL,

  -- gateway_confirmed | intent_only | failed. An INTENT is explicitly not a
  -- verification: SOP §22 names "payment success assumed from checkout intent"
  -- as the gap, so the two are different values rather than one boolean.
  verification  TEXT NOT NULL,
  amount_cents  BIGINT,
  currency      TEXT,
  verified_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  gateway_payload JSONB,

  -- Set when the webhook never arrived and the gateway was queried directly.
  reconciled_from_gateway BOOLEAN NOT NULL DEFAULT FALSE,
  finance_task_ref TEXT,

  CONSTRAINT leadflow_payment_verification_known
    CHECK (verification IN ('gateway_confirmed','intent_only','failed')),
  CONSTRAINT leadflow_payment_verification_once UNIQUE (tenant_id, charge_ref)
);

CREATE TABLE IF NOT EXISTS leadflow_refund_request (
  refund_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT,
  charge_ref    TEXT NOT NULL,
  amount_cents  BIGINT NOT NULL,
  reason        TEXT NOT NULL,

  -- Above the threshold a refund needs a second party. Recorded rather than
  -- inferred from the amount at read time, so a later change to the threshold
  -- cannot retroactively make a past refund look unapproved.
  requires_approval BOOLEAN NOT NULL,
  approval_ref  TEXT,
  approved_at   TIMESTAMPTZ,

  -- Expansion messaging is FROZEN from the moment a refund is requested. Asking
  -- somebody to buy more while they are asking for money back is the single
  -- most damaging automated message this system could send.
  expansion_frozen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ,
  requested_by  UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_refund_charge ON leadflow_refund_request (charge_ref, created_at DESC);

-- ---------------------------------------------------------------------------
-- The onboarding handoff. SOP §19, §45, §50.

CREATE TABLE IF NOT EXISTS leadflow_onboarding_handoff (
  handoff_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT,
  subject_ref   TEXT NOT NULL,
  deal_ref      TEXT,
  charge_ref    TEXT,

  -- The 24-hour clock runs from VERIFIED PAYMENT, not from the handoff being
  -- created - otherwise a handoff nobody creates never starts a clock, which is
  -- precisely the "Closed Won incomplete" failure SOP §50 names.
  paid_at       TIMESTAMPTZ NOT NULL,

  accepted_at   TIMESTAMPTZ,
  accepted_by   UUID,
  kickoff_meeting_id UUID,
  kickoff_at    TIMESTAMPTZ,

  alerted_at    TIMESTAMPTZ,
  -- A buyer-driven delay is legitimate, but it must still carry a named owner
  -- and a date. An exception with neither is just an unworked handoff wearing a
  -- label, so the CHECK refuses it.
  exception_reason TEXT,
  exception_owner_user_id UUID,
  exception_review_at TIMESTAMPTZ,

  thirty_day_task_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT leadflow_onboarding_handoff_once UNIQUE (tenant_id, subject_ref),
  CONSTRAINT leadflow_onboarding_exception_is_owned
    CHECK (exception_reason IS NULL OR (exception_owner_user_id IS NOT NULL AND exception_review_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_onboarding_pending
  ON leadflow_onboarding_handoff (tenant_id, accepted_at, paid_at);
