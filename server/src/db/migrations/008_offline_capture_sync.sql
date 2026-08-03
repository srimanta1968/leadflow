-- Migration 008: remember which client-generated capture ids have been synced.
--
-- WHY A TABLE AND NOT AN IN-MEMORY SET. The acceptance case is: capture five
-- contacts offline, FORCE-QUIT the app, reconnect, sync. The force-quit is the
-- point — and the same restart can happen on the server. An idempotency memory
-- held in process would be empty after a deploy, and the very next retry from a
-- device that had been offline for a day would create a second copy of every
-- record it was retrying. The duplicate would look exactly like a real capture.
--
-- The client mints `client_capture_id` at capture time, offline, before the
-- server has heard of the record. That is what makes it usable as the
-- idempotency key: it exists before the first attempt, so a retry after a
-- half-completed sync carries the same value as the attempt that may or may not
-- have landed.
--
-- SCOPED PER TENANT. The uniqueness that matters is (tenant, client id): two
-- devices belonging to different customers can mint the same id — a client-side
-- generator is not required to be globally unique, and assuming it is would let
-- one tenant's sync silently suppress another's capture as a "duplicate". That
-- failure would be invisible: the second tenant would simply never see a record
-- they were told was accepted.

CREATE TABLE IF NOT EXISTS offline_capture_sync (
  -- The id the DEVICE generated. Text rather than UUID: it comes from a client
  -- we do not control, and rejecting a perfectly serviceable non-UUID id at the
  -- database layer would fail a capture that has already been taken.
  client_capture_id  TEXT        NOT NULL,
  tenant_id          UUID,
  -- What the capture became. Returned again on a replay so the client can
  -- reconcile its queue against real records rather than just being told
  -- "duplicate" and having nothing to point at.
  source_record_id   TEXT        NOT NULL,
  capture_kind       VARCHAR(32) NOT NULL,
  -- When the DEVICE took it, not when it reached us. A capture made on Friday
  -- and synced on Monday is Friday's evidence, and the difference is exactly
  -- what an SLA or a consent window would be measured against.
  captured_at        TIMESTAMPTZ,
  synced_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The idempotency guarantee itself. A partial unique index rather than a
-- primary key because tenant_id is nullable while the tenancy migration is
-- still staged (see 007) — COALESCE keeps the pre-tenant rows in one bucket
-- instead of letting every NULL count as distinct, which would defeat the whole
-- constraint exactly when it matters most.
CREATE UNIQUE INDEX IF NOT EXISTS offline_capture_sync_key
  ON offline_capture_sync (COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), client_capture_id);

-- Draining a queue reads by recency to report what landed.
CREATE INDEX IF NOT EXISTS offline_capture_sync_synced_at_idx
  ON offline_capture_sync (synced_at DESC);

COMMENT ON TABLE offline_capture_sync IS
  'Client-generated capture ids already synced. The idempotency ledger for POST /api/leadflow/capture/sync-batch — a retry after a half-completed sync must not create a second P0.';
COMMENT ON COLUMN offline_capture_sync.captured_at IS
  'When the DEVICE took the capture, not when it reached the server. A capture taken offline on Friday and synced Monday is Friday evidence.';
