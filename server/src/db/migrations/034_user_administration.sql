-- 034 — The user register: invite, activation and deactivation, on the existing
-- `users` projection.
--
-- EXTENDING 001 RATHER THAN CREATING A SECOND TABLE. `users` already carries
-- `is_active`, and a separate `user_invitations` table would immediately create
-- two answers to "is this person allowed in" — the exact shape of the bug the
-- credential-store comment in AuthService warns about. What 001 lacks is not a
-- place to record membership, it is the LIFECYCLE STAMPS: who invited whom, when
-- the account was opened for use, and when it was closed.
--
-- THREE STATES ARE DERIVED, NOT STORED. A `state` column would be a fourth thing
-- to keep in step with is_active, and the two would disagree the first time a row
-- was updated by anything that predates this migration:
--
--   deactivated_at IS NOT NULL          -> deactivated
--   is_active = TRUE                    -> active
--   otherwise                           -> pending
--
-- DEACTIVATION IS NEVER A DELETE, and that is the whole reason these are
-- timestamps rather than a boolean. Every audit entry, routing rule, lead
-- assignment and coverage window names a user id; removing the row would turn a
-- signed history into a page of dangling references, and the one question an
-- auditor asks about a departed colleague — what did they do while they were
-- here — would have no answer.

ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_at     TIMESTAMP WITH TIME ZONE;
-- The INVITER, kept as a plain uuid with no foreign key on purpose: the person
-- who issued an invitation may themselves be deactivated later, and a cascade or
-- a restrict would either erase the attribution or block the deactivation. The
-- attribution outlives the account.
ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_by     UUID;
ALTER TABLE users ADD COLUMN IF NOT EXISTS activated_at   TIMESTAMP WITH TIME ZONE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMP WITH TIME ZONE;
-- Who closed the account. Same reasoning as `invited_by`.
ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_by UUID;

-- Every user that predates this migration and is currently usable is ACTIVE, not
-- pending — they signed in before the register existed. Backfilled from
-- created_at rather than now(), so the column reports when the account became
-- usable rather than when this migration ran.
UPDATE users
   SET activated_at = created_at
 WHERE activated_at IS NULL
   AND is_active = TRUE;

-- The register lists pending invitations first and the roster is small, so the
-- index earns its place on the WHERE rather than on an ORDER BY.
CREATE INDEX IF NOT EXISTS idx_users_invited_at ON users (invited_at) WHERE invited_at IS NOT NULL;
