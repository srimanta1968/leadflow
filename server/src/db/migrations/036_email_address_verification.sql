-- 036 — the address-verification cache.
--
-- WHY A TABLE AND NOT JUST A PROCESS CACHE. A DNS answer costs 20-200ms and an
-- SMTP probe costs seconds; a lead import of 5,000 rows that re-asks on every
-- boot is both slow and rude to the domains being asked. The in-process cache
-- handles the burst, this handles the restart — and it is the only place an
-- operator can answer "why did we refuse to email this person".
--
-- EVERY VERDICT EXPIRES, and they expire at different rates, which is why
-- expires_at is a column rather than a constant. "Deliverable" ages slowly:
-- mailboxes that exist usually keep existing. "Undeliverable" ages faster,
-- because a domain that had no MX record last week may have one today and a
-- permanently-cached refusal would make that unfixable from inside the product.
-- "Unknown" barely caches at all — a resolver timeout is a fact about our
-- network, not about the address.

CREATE TABLE IF NOT EXISTS leadflow_email_address_verification (
  -- The NORMALISED address is the key: trimmed, unwrapped, domain lowercased
  -- and punycoded. Two spellings of the same mailbox must not produce two rows
  -- with two different verdicts.
  address       VARCHAR(320) PRIMARY KEY,
  domain        VARCHAR(255) NOT NULL,
  -- 'deliverable' | 'undeliverable' | 'risky' | 'unknown'.
  verdict       VARCHAR(16)  NOT NULL,
  -- The machine code (NO_MAIL_EXCHANGER, MAILBOX_NOT_FOUND, ...). Kept beside
  -- the sentence because operators filter on the code and read the sentence.
  code          VARCHAR(32)  NOT NULL,
  reason        TEXT         NOT NULL,
  -- Which stages actually ran and what each concluded, as returned to the
  -- caller. Stored whole: a verdict without its stages cannot be re-judged
  -- later when the policy for what blocks a send changes.
  checks        JSONB        NOT NULL DEFAULT '{}'::JSONB,
  -- The mail exchangers found, in priority order. Empty for a domain that has
  -- none — which is the finding, not a missing value.
  mail_exchangers JSONB      NOT NULL DEFAULT '[]'::JSONB,
  is_role_address BOOLEAN    NOT NULL DEFAULT FALSE,
  is_disposable   BOOLEAN    NOT NULL DEFAULT FALSE,
  did_you_mean    VARCHAR(320),
  checked_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at    TIMESTAMP WITH TIME ZONE NOT NULL
);

-- The sweep that drops stale rows, and the lookup that ignores them.
CREATE INDEX IF NOT EXISTS idx_email_verification_expiry
  ON leadflow_email_address_verification (expires_at);

-- "Which domains are we refusing, and how many people does that affect" —
-- asked whenever a bulk import comes back with a block count nobody expected.
CREATE INDEX IF NOT EXISTS idx_email_verification_domain
  ON leadflow_email_address_verification (domain, verdict);

/*
 * The pre-send verdict, recorded against the send it gated.
 *
 * ADDED TO THE DELIVERY LEDGER rather than kept only in the cache, because the
 * cache holds the CURRENT verdict for an address while the ledger has to answer
 * a historical question: "we never emailed this person in March — why not". If
 * the address is re-verified in April the cache row is overwritten and that
 * answer is gone unless it was written down at the time.
 *
 * NULLABLE, deliberately. Rows written before this migration were not gated,
 * and a backfilled default would claim a check ran when none did.
 */
ALTER TABLE leadflow_email_delivery
  ADD COLUMN IF NOT EXISTS verification_verdict VARCHAR(16);
ALTER TABLE leadflow_email_delivery
  ADD COLUMN IF NOT EXISTS verification_code VARCHAR(32);

COMMENT ON TABLE leadflow_email_address_verification IS
  'Cached per-address deliverability verdicts: syntax, domain, MX and (when enabled) mailbox. Every row expires, at a rate set by its verdict.';
COMMENT ON COLUMN leadflow_email_delivery.verification_verdict IS
  'What the pre-send check concluded about the recipient at the moment of this send. NULL means no check ran.';
