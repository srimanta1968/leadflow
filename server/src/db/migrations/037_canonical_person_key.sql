-- 037 — the canonical person id a lead is known by upstream.
--
-- WHY THIS COLUMN EXISTS. Every governed screen that reads ProjexCloud gets back
-- a canonical person id: the consent register names the subject of a receipt
-- that way, and Identity Review names both sides of a candidate link that way.
-- LeadFlow held no such key, so both screens rendered raw uuids at a steward and
-- at a privacy officer — the two people in the product least able to act on
-- "453eb8bd-cc7b-4461-af2a-5664cb75f82d" and most in need of knowing whose
-- consent, whose duplicate.
--
-- ON `leads`, BECAUSE THAT IS WHAT A CONTACT IS HERE. contactsService reads
-- `leads`; there is no separate contacts table. Naming the column
-- canonical_person_id rather than person_id keeps it obviously distinct from
-- users.id and from the local lead id, which are three different identities that
-- have been confused before.
--
-- NULLABLE, AND MOST ROWS WILL BE NULL FOR A WHILE. The id only exists once a
-- capture has been resolved upstream, and resolution has never once succeeded in
-- this deployment: Quick Capture posted a trait bundle to a route that reads
-- identity contexts, so every capture 400'd, stayed unlinked, and left
-- source_record.subject_ref null. That is fixed alongside this migration, but it
-- fixes captures from here on — a backfill would have to invent the link
-- decisions nobody made, which is the one thing an identity key must never do.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS canonical_person_id UUID;

COMMENT ON COLUMN leads.canonical_person_id IS
  'The ProjexCloud canonical person this lead resolved to. NULL until an exact crosswalk or a verified steward link says which person it is — never guessed, because a wrong id here misattributes somebody''s consent.';

-- PARTIAL, because the null case is the majority and is never searched: every
-- query using this column arrives holding a person id and asks which lead it is.
CREATE INDEX IF NOT EXISTS leads_canonical_person_idx
  ON leads (canonical_person_id) WHERE canonical_person_id IS NOT NULL;

-- Deliberately NOT unique. Two leads legitimately carry the same canonical
-- person while a candidate link is open — that is exactly the state Identity
-- Review exists to adjudicate — and a unique index would make the second capture
-- of a known person fail on write rather than surface as a case for review.
