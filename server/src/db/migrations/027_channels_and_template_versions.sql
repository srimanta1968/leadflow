-- 027 — Channel state: template versions, SMS eligibility evidence, voice calls
-- and tracking numbers. SOP §07, §16, §17, §18, §29.
--
-- Checked the 39 existing leadflow_* tables first. leadflow_template_library
-- already holds ONE row per template with an approved_at stamp, which cannot
-- express version history or an approval GATE - approving in place overwrites
-- the copy that was live, so "what did we actually send in March" becomes
-- unanswerable. Versions are added beside it rather than replacing it.

-- ---------------------------------------------------------------------------
-- Template versions. SOP §16-18.

ALTER TABLE leadflow_template_library ADD COLUMN IF NOT EXISTS current_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE leadflow_template_library ADD COLUMN IF NOT EXISTS cta_count INTEGER;
ALTER TABLE leadflow_template_library ADD COLUMN IF NOT EXISTS owner_role TEXT NOT NULL DEFAULT 'revenue_operations';

CREATE TABLE IF NOT EXISTS leadflow_template_version (
  version_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT,
  template_id   UUID NOT NULL REFERENCES leadflow_template_library(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,

  subject       TEXT,
  body          TEXT NOT NULL,

  -- EXACTLY ONE CTA. SOP §16-18 is explicit and the reason is behavioural: a
  -- message asking for two things reliably gets neither. Counted at authoring
  -- time and stored, so the publish gate checks a number rather than re-parsing
  -- prose it may parse differently than the author did.
  cta_count     INTEGER NOT NULL DEFAULT 1,

  -- FEATURE-STATUS HONESTY. True when the copy describes a capability as
  -- available. The publish gate refuses it unless the capability really is, so
  -- a template cannot promise something the product does not do.
  claims_feature_available BOOLEAN NOT NULL DEFAULT FALSE,
  claimed_capability       TEXT,

  merge_fields  JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- NULL until published. The gate, not a label: an unpublished version is
  -- unusable rather than merely unmarked.
  published_at  TIMESTAMPTZ,
  published_by  TEXT,
  approval_ref  TEXT,

  authored_by   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT leadflow_template_version_once UNIQUE (template_id, version),
  -- One CTA. Zero leaves the reader with nothing to do; two splits the ask.
  CONSTRAINT leadflow_template_version_one_cta CHECK (cta_count = 1),
  -- A published version must name who published it. An anonymous publish is
  -- exactly the record an audit asks about.
  CONSTRAINT leadflow_template_version_publish_is_attributed
    CHECK (published_at IS NULL OR published_by IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_template_version_live
  ON leadflow_template_version (template_id, published_at DESC);

-- ---------------------------------------------------------------------------
-- SMS eligibility evidence. SOP §18.

CREATE TABLE IF NOT EXISTS leadflow_sms_eligibility (
  eligibility_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      TEXT,
  subject_ref    TEXT NOT NULL,

  -- WHAT MAKES THIS PERSON TEXTABLE. A phone number is NOT one of the options,
  -- and that is the whole point of the table: possessing a number is not
  -- permission to use it, and the incumbent behaviour of texting anybody with a
  -- mobile is what SOP §18 exists to stop.
  basis          TEXT NOT NULL,
  evidence_ref   TEXT,
  purpose_key    TEXT NOT NULL,

  granted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ,

  CONSTRAINT leadflow_sms_eligibility_basis_known
    CHECK (basis IN ('express_written_consent','existing_relationship','inbound_request')),
  -- Every basis must point at the evidence for it. A basis with nothing behind
  -- it reads as documented while resting on somebody's memory.
  CONSTRAINT leadflow_sms_eligibility_has_evidence
    CHECK (length(btrim(coalesce(evidence_ref, ''))) > 0)
);

CREATE INDEX IF NOT EXISTS idx_sms_eligibility_subject
  ON leadflow_sms_eligibility (tenant_id, subject_ref, purpose_key);

-- The one-automated-SMS-per-day cap and the 30-minute no-answer dedup window.
CREATE TABLE IF NOT EXISTS leadflow_sms_send_log (
  send_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    TEXT,
  subject_ref  TEXT NOT NULL,
  template_key TEXT,
  automated    BOOLEAN NOT NULL DEFAULT TRUE,
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The local day the cap is counted over, in the RECIPIENT's terms rather than
  -- ours. Stored rather than derived so the cap does not move when the server
  -- timezone does.
  local_day    DATE NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sms_send_cap
  ON leadflow_sms_send_log (tenant_id, subject_ref, local_day) WHERE automated = TRUE;
CREATE INDEX IF NOT EXISTS idx_sms_send_recent
  ON leadflow_sms_send_log (tenant_id, subject_ref, sent_at DESC);

-- ---------------------------------------------------------------------------
-- Voice. SOP §07, §29.

CREATE TABLE IF NOT EXISTS leadflow_voice_call (
  call_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      TEXT,
  subject_ref    TEXT NOT NULL,
  rep_user_id    UUID,

  -- The provisioned number the call went out from, so a callback lands back on
  -- the same source context rather than a switchboard.
  tracking_number TEXT,
  provider_call_ref TEXT,

  -- RECORDING IS NOT ASSUMED. The consent basis is checked BEFORE the call is
  -- placed and the verdict stored, so "was this call lawfully recorded" is
  -- answerable from the row rather than reconstructed from a policy that may
  -- have changed since.
  recording_requested BOOLEAN NOT NULL DEFAULT FALSE,
  recording_permitted BOOLEAN NOT NULL DEFAULT FALSE,
  recording_basis     TEXT,
  recording_refusal   TEXT,
  recording_ref       TEXT,

  -- machine detection, from the provider status webhook.
  answered_by    TEXT,
  disposition    TEXT,
  voicemail_transcript TEXT,
  -- Links the voicemail back to the attempt it belongs to, so the two are one
  -- event in the timeline rather than two unrelated rows.
  attempt_id     UUID,

  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at       TIMESTAMPTZ,

  CONSTRAINT leadflow_voice_call_recording_needs_basis
    CHECK (recording_permitted = FALSE OR recording_basis IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_voice_call_subject ON leadflow_voice_call (subject_ref, started_at DESC);

CREATE TABLE IF NOT EXISTS leadflow_tracking_number (
  number_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT,
  phone_number  TEXT NOT NULL,
  -- Which source or campaign this number represents, so an inbound call carries
  -- its own attribution rather than needing the caller to be asked.
  source_key    TEXT,
  campaign_ref  TEXT,
  provider_ref  TEXT,
  released_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT leadflow_tracking_number_once UNIQUE (tenant_id, phone_number)
);

-- ---------------------------------------------------------------------------
-- Email channel readiness. SOP §29.

CREATE TABLE IF NOT EXISTS leadflow_email_domain (
  domain_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT,
  domain        TEXT NOT NULL,

  -- THE THREE CHECKS THAT GATE SENDING. Stored separately rather than as one
  -- `verified` flag because they fail for different reasons and are fixed by
  -- different DNS records - a single boolean tells an operator to "fix DNS",
  -- which is not an instruction anybody can follow.
  spf_verified   BOOLEAN NOT NULL DEFAULT FALSE,
  dkim_verified  BOOLEAN NOT NULL DEFAULT FALSE,
  dmarc_verified BOOLEAN NOT NULL DEFAULT FALSE,
  last_checked_at TIMESTAMPTZ,

  -- The identity every commercial email must carry. NOT NULL because a
  -- commercial message without them is unlawful in most of the jurisdictions
  -- this product operates in, and a nullable column makes that state storable.
  from_name      TEXT NOT NULL,
  from_address   TEXT NOT NULL,
  business_name  TEXT NOT NULL,
  physical_address TEXT NOT NULL,

  provider_ref   TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT leadflow_email_domain_once UNIQUE (tenant_id, domain)
);
