-- 023 — Saved evidence queries, and the visibility that decides who may run them.
--
-- WHY THIS IS LOCAL AT ALL, given sdk-search already stores saved queries.
-- Because it stores them against ONE persona and lists them with
-- listSavedQueries(tenant_id, persona_id). There is no share flag, no team
-- scope, and no way to express one. Writing sharing into that store would mean
-- inventing a convention it does not enforce — and a query that LOOKS shared
-- while upstream still scopes it to a single persona is worse than one that is
-- honestly private.
--
-- So visibility lives here and the owner's copy is MIRRORED upstream, which
-- keeps the platform store populated without either side inventing semantics
-- the other does not have.
--
-- A SAVED QUERY IS A FILTER, NEVER A RESULT SET. That is what makes sharing
-- safe: running a shared query re-executes the search under the CALLER'S own
-- scopes, which sdk-search resolves from verified JWT claims and never from the
-- request body. A stored result set would freeze one person's access into a row
-- anybody could read, which is an access-control bypass wearing a cache.
--
-- Checked `.projexlight/schema/current-schema.json` before adding: no saved
-- query, audit query or search-query table exists in the shared reference.

CREATE TABLE IF NOT EXISTS leadflow_audit_saved_query (
  query_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT NOT NULL,

  -- The persona who saved it, and the role they held when they did. The ROLE is
  -- stored rather than resolved at read time on purpose: `role` visibility must
  -- keep meaning what the author intended even after they change roles or leave,
  -- and re-deriving it from their current persona would silently re-target the
  -- share.
  owner_persona_id TEXT NOT NULL,
  owner_role       TEXT,

  name          TEXT NOT NULL,

  -- The filter, exactly as the builder produced it. Stored as the LeadFlow
  -- filter shape rather than as an OpenSearch DSL, so a change in how we
  -- translate filters to sdk-search does not strand every saved query.
  filters       JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- private = the author alone. role = everyone holding owner_role. tenant =
  -- everybody here. Deliberately NO share-with-named-person: a per-person grant
  -- list is an access-control system, and this table is not the place to grow
  -- one.
  visibility    TEXT NOT NULL DEFAULT 'private',

  -- Whether sdk-search accepted the owner's mirror. Recorded rather than assumed
  -- so the two stores cannot silently diverge; a local save that could not reach
  -- the platform is still perfectly usable here.
  upstream_query_id TEXT,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT leadflow_audit_saved_query_visibility_known
    CHECK (visibility IN ('private', 'role', 'tenant')),
  -- A role-visible query with no role recorded would be visible to nobody, which
  -- is a silently broken share rather than a private query.
  CONSTRAINT leadflow_audit_saved_query_role_share_names_a_role
    CHECK (visibility <> 'role' OR owner_role IS NOT NULL)
);

-- One name per author. Saving twice under the same name is an EDIT, not a
-- second query — twenty near-identical entries is how a saved-query list stops
-- being used.
CREATE UNIQUE INDEX IF NOT EXISTS leadflow_audit_saved_query_name_per_owner
  ON leadflow_audit_saved_query (tenant_id, owner_persona_id, lower(name));

-- The read path filters on owner, role and tenant visibility together.
CREATE INDEX IF NOT EXISTS leadflow_audit_saved_query_visible
  ON leadflow_audit_saved_query (tenant_id, visibility, owner_role);
