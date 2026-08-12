-- 035 — email verification and invitation tokens, and the delivery ledger.
--
-- THE TOKEN IS STORED AS A HASH, never in plaintext. The same reasoning as an
-- API key: a verification link is a bearer credential for exactly one account,
-- and a database read — a backup, a support query, a leaked dump — must not
-- hand somebody the ability to verify or claim an account that is not theirs.
-- The plaintext exists only in the email that was sent.
--
-- ONE TABLE FOR BOTH KINDS. Verification and invitation differ in what they
-- permit on redemption, not in what they are: a single-use, expiring, hashed
-- pointer at one user. Two tables would duplicate the expiry, consumption and
-- lookup logic and let the two drift apart.

CREATE TABLE IF NOT EXISTS leadflow_email_token (
  token_hash   VARCHAR(64)  PRIMARY KEY,
  user_id      UUID         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- 'verify' proves the address is reachable; 'invite' additionally sets the
  -- first password and activates an account created with an unusable one.
  kind         VARCHAR(16)  NOT NULL,
  email        VARCHAR(255) NOT NULL,
  expires_at   TIMESTAMP WITH TIME ZONE NOT NULL,
  -- CONSUMED, NOT DELETED. A redeemed token that vanishes cannot answer "was
  -- this link used, and when" — which is the first question asked when somebody
  -- says they never received it, or received it twice.
  consumed_at  TIMESTAMP WITH TIME ZONE,
  created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by   UUID REFERENCES users (id)
);

-- The lookup every redemption makes: one live token of a kind for one user.
CREATE INDEX IF NOT EXISTS idx_email_token_user
  ON leadflow_email_token (user_id, kind) WHERE consumed_at IS NULL;

/*
 * The delivery ledger.
 *
 * SENDING IS RECORDED SEPARATELY FROM THE TOKEN because the two fail
 * independently: a token can be minted and the send fail, and an operator
 * asking "did this person ever get their invitation" needs the answer to that
 * question rather than to "was a token created". `provider_message_id` is what
 * makes a bounce traceable back to the account it was for.
 */
CREATE TABLE IF NOT EXISTS leadflow_email_delivery (
  delivery_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  to_email            VARCHAR(255) NOT NULL,
  template_key        VARCHAR(64)  NOT NULL,
  subject             TEXT         NOT NULL,
  provider            VARCHAR(32)  NOT NULL,
  provider_message_id TEXT,
  -- 'sent' | 'failed' | 'skipped'. `skipped` is deliberate and not an error:
  -- no provider configured is a valid deployment state, and it must be
  -- distinguishable from a send that was attempted and refused.
  status              VARCHAR(16)  NOT NULL,
  error               TEXT,
  user_id             UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_email_delivery_to
  ON leadflow_email_delivery (to_email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_delivery_status
  ON leadflow_email_delivery (status) WHERE status = 'failed';

COMMENT ON TABLE leadflow_email_token IS
  'Single-use, expiring, hashed tokens for address verification and invitation acceptance. The plaintext exists only in the email that carried it.';
COMMENT ON TABLE leadflow_email_delivery IS
  'What was sent, to whom, and whether the provider accepted it. Separate from the token because minting and sending fail independently.';
